#!/usr/bin/env python3
"""Offline CUDA renderer and pairwise quality evaluator for RAW4D files."""

from __future__ import annotations

import argparse
import csv
import gc
import json
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
import torch
from gsplat.rendering import rasterization
from PIL import Image, ImageDraw
from skimage.metrics import structural_similarity

from codec import extract_track, load_rows, property_indices, read_raw4d_layout


@dataclass(frozen=True)
class Track:
    values: np.ndarray
    keyframes: np.ndarray


@dataclass(frozen=True)
class SampledFrame:
    means: np.ndarray
    quaternions: np.ndarray
    scales: np.ndarray
    opacities: np.ndarray
    sh_coefficients: np.ndarray
    sh_degree: int


def parse_indices(value: str) -> list[int]:
    result: list[int] = []
    for part in value.split(","):
        if ":" in part:
            first, last = (int(number) for number in part.split(":", 1))
            result.extend(range(first, last + 1))
        else:
            result.append(int(part))
    return result


def track_span(keyframes: np.ndarray, frame: float) -> tuple[int, int, float]:
    if keyframes.size == 1 or frame <= float(keyframes[0]):
        return 0, 0, 0.0
    last = keyframes.size - 1
    if frame >= float(keyframes[last]):
        return last, last, 0.0
    right = int(np.searchsorted(keyframes, frame, side="left"))
    left = right - 1
    alpha = (frame - float(keyframes[left])) / float(keyframes[right] - keyframes[left])
    return left, right, alpha


def interpolate_track(track: Track, frame: float) -> np.ndarray:
    left, right, alpha = track_span(track.keyframes, frame)
    if left == right:
        return track.values[:, left].copy()
    left_values = track.values[:, left]
    right_values = track.values[:, right]
    with np.errstate(invalid="ignore"):
        result = left_values + (right_values - left_values) * np.float32(alpha)
    result[np.isneginf(left_values) | np.isneginf(right_values)] = -np.inf
    return result


def normalize_rotation_track(values: np.ndarray) -> np.ndarray:
    rotations = values.copy()
    lengths = np.linalg.norm(rotations, axis=2, keepdims=True)
    rotations = rotations / np.maximum(lengths, np.float32(1e-12))
    invalid = lengths[..., 0] <= np.float32(1e-12)
    rotations[invalid] = np.asarray([1, 0, 0, 0], dtype=np.float32)
    for key in range(1, rotations.shape[1]):
        flip = np.sum(rotations[:, key - 1] * rotations[:, key], axis=1) < 0
        rotations[flip, key] *= -1
    return rotations


def interpolate_rotation(track: Track, frame: float) -> np.ndarray:
    left, right, alpha = track_span(track.keyframes, frame)
    if left == right:
        return track.values[:, left].copy()
    q0 = track.values[:, left]
    q1 = track.values[:, right]
    dot = np.clip(np.sum(q0 * q1, axis=1), -1, 1)
    theta = np.arccos(dot)
    sine = np.sin(theta)
    linear = sine <= np.float32(1e-5)
    left_weight = np.empty_like(dot)
    right_weight = np.empty_like(dot)
    left_weight[linear] = np.float32(1 - alpha)
    right_weight[linear] = np.float32(alpha)
    left_weight[~linear] = np.sin((1 - alpha) * theta[~linear]) / sine[~linear]
    right_weight[~linear] = np.sin(alpha * theta[~linear]) / sine[~linear]
    result = q0 * left_weight[:, None] + q1 * right_weight[:, None]
    return result / np.maximum(np.linalg.norm(result, axis=1, keepdims=True), np.float32(1e-12))


def stable_sigmoid(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    result = np.empty_like(values)
    positive = values >= 0
    result[positive] = 1 / (1 + np.exp(-values[positive]))
    exponential = np.exp(values[~positive])
    result[~positive] = exponential / (1 + exponential)
    return result


class Raw4DScene:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.layout = read_raw4d_layout(path)
        rows = load_rows(self.layout)
        self.position = self._track(rows, "xyz_bank", ("x", "y", "z"))
        rotation = self._track(rows, "rot_bank", ("w", "x", "y", "z"))
        self.rotation = Track(normalize_rotation_track(rotation.values), rotation.keyframes)
        self.color = self._track(rows, "f_dc_bank", ("0", "1", "2"))
        self.scale = self._track(rows, "scale_bank", ("0", "1", "2"))
        self.opacity = self._track(rows, "opacity_bank", ("",))
        lifetime_indices = property_indices(self.layout, ["lifetime_mu", "lifetime_w"])
        self.lifetime = np.asarray(rows[:, lifetime_indices], dtype=np.float32)
        sh_names = sorted(
            (name for name in self.layout.properties if name.startswith("f_rest_")),
            key=lambda name: int(name.removeprefix("f_rest_")),
        )
        sh_indices = property_indices(self.layout, sh_names) if sh_names else []
        self.sh_rest = (
            np.asarray(rows[:, sh_indices], dtype=np.float32)
            if sh_indices else np.empty((self.layout.vertex_count, 0), dtype=np.float32)
        )
        del rows
        rest_counts = {0: 0, 9: 1, 24: 2, 45: 3}
        if self.sh_rest.shape[1] not in rest_counts:
            raise ValueError(f"Unsupported SH rest count: {self.sh_rest.shape[1]}")
        self.sh_degree = rest_counts[self.sh_rest.shape[1]]

    def _track(self, rows: np.ndarray, prefix: str, components: tuple[str, ...]) -> Track:
        values, keyframes = extract_track(rows, self.layout, prefix, components)
        return Track(values, np.asarray(keyframes, dtype=np.float32))

    def sample(self, frame: float) -> SampledFrame:
        if not 0 <= frame <= self.layout.total_frames - 1:
            raise ValueError(f"Frame {frame} is outside [0, {self.layout.total_frames - 1}]")
        means = interpolate_track(self.position, frame)
        quaternions = interpolate_rotation(self.rotation, frame)
        scales = np.exp(interpolate_track(self.scale, frame)).astype(np.float32)
        logit = interpolate_track(self.opacity, frame)[:, 0]
        mu = self.lifetime[:, 0]
        width = self.lifetime[:, 1]
        gate = stable_sigmoid(10 * (frame - (mu - width)))
        gate *= stable_sigmoid(10 * ((mu + width) - frame))
        opacities = stable_sigmoid(logit) * gate
        dc = interpolate_track(self.color, frame)[:, None, :]
        if self.sh_rest.shape[1]:
            rest = self.sh_rest.reshape(self.layout.vertex_count, 3, -1).transpose(0, 2, 1)
            sh = np.concatenate([dc, rest], axis=1)
        else:
            sh = dc
        return SampledFrame(
            means=np.ascontiguousarray(means),
            quaternions=np.ascontiguousarray(quaternions),
            scales=np.ascontiguousarray(scales),
            opacities=np.ascontiguousarray(opacities),
            sh_coefficients=np.ascontiguousarray(sh),
            sh_degree=self.sh_degree,
        )


def camera_tensors(
    camera: dict,
    width: int,
    height: int,
    device: torch.device,
) -> tuple[torch.Tensor, torch.Tensor]:
    rotation = np.asarray(camera["rotation"], dtype=np.float32)
    position = np.asarray(camera["position"], dtype=np.float32)
    camera_to_world = np.eye(4, dtype=np.float32)
    camera_to_world[:3, :3] = rotation
    camera_to_world[:3, 3] = position
    view = np.linalg.inv(camera_to_world).astype(np.float32)
    scale_x = width / int(camera["width"])
    scale_y = height / int(camera["height"])
    intrinsic = np.asarray([
        [float(camera["fx"]) * scale_x, 0, width * 0.5],
        [0, float(camera["fy"]) * scale_y, height * 0.5],
        [0, 0, 1],
    ], dtype=np.float32)
    return (
        torch.from_numpy(view).to(device=device).unsqueeze(0),
        torch.from_numpy(intrinsic).to(device=device).unsqueeze(0),
    )


def render_frame(
    sampled: SampledFrame,
    camera: dict,
    width: int,
    height: int,
    device: torch.device,
) -> tuple[np.ndarray, float]:
    view, intrinsic = camera_tensors(camera, width, height, device)
    started = time.perf_counter()
    with torch.inference_mode():
        rendered, _, _ = rasterization(
            means=torch.from_numpy(sampled.means).to(device),
            quats=torch.from_numpy(sampled.quaternions).to(device),
            scales=torch.from_numpy(sampled.scales).to(device),
            opacities=torch.from_numpy(sampled.opacities).to(device),
            colors=torch.from_numpy(sampled.sh_coefficients).to(device),
            viewmats=view,
            Ks=intrinsic,
            width=width,
            height=height,
            near_plane=0.01,
            far_plane=100.0,
            packed=True,
            render_mode="RGB",
            sh_degree=sampled.sh_degree,
        )
    torch.cuda.synchronize(device)
    seconds = time.perf_counter() - started
    image = rendered[0].clamp(0, 1).mul(255).round().to(torch.uint8).cpu().numpy()
    return image, seconds


def render_asset(
    path: Path,
    output_dir: Path,
    cameras: Sequence[tuple[int, dict]],
    frames: Sequence[int],
    width: int,
    height: int,
    device: torch.device,
) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    load_started = time.perf_counter()
    scene = Raw4DScene(path)
    load_seconds = time.perf_counter() - load_started
    render_seconds = 0.0
    for frame in frames:
        sampled = scene.sample(frame)
        for camera_index, camera in cameras:
            image, seconds = render_frame(sampled, camera, width, height, device)
            render_seconds += seconds
            Image.fromarray(image).save(
                output_dir / f"frame_{frame:03d}_camera_{camera_index:03d}.png"
            )
        del sampled
        torch.cuda.empty_cache()
    del scene
    gc.collect()
    torch.cuda.empty_cache()
    return {
        "path": str(path),
        "load_seconds": load_seconds,
        "render_seconds": render_seconds,
        "image_count": len(frames) * len(cameras),
    }


def evaluate_pairs(
    reference_dir: Path,
    decoded_dir: Path,
    output_dir: Path,
    write_comparisons: bool = True,
) -> dict:
    comparison_dir = output_dir / "comparison"
    if write_comparisons:
        comparison_dir.mkdir(parents=True, exist_ok=True)
    metrics: list[dict] = []
    for reference_path in sorted(reference_dir.glob("frame_*.png")):
        decoded_path = decoded_dir / reference_path.name
        if not decoded_path.exists():
            raise ValueError(f"Missing decoded render: {decoded_path}")
        reference = np.asarray(Image.open(reference_path).convert("RGB"), dtype=np.float32)
        decoded = np.asarray(Image.open(decoded_path).convert("RGB"), dtype=np.float32)
        difference = np.abs(reference - decoded)
        mse = float(np.mean(np.square(difference), dtype=np.float64))
        psnr = math.inf if mse == 0 else 10 * math.log10(255 * 255 / mse)
        foreground = np.maximum(np.max(reference, axis=2), np.max(decoded, axis=2)) > 25
        foreground_mse = float(np.mean(np.square(difference[foreground]), dtype=np.float64))
        foreground_psnr = math.inf if foreground_mse == 0 else 10 * math.log10(255 * 255 / foreground_mse)
        parts = reference_path.stem.split("_")
        item = {
            "frame": int(parts[1]),
            "camera_index": int(parts[3]),
            "render_psnr_db": psnr,
            "foreground_psnr_db": foreground_psnr,
            "render_ssim": float(structural_similarity(reference, decoded, channel_axis=2, data_range=255)),
            "rgb_mae": float(np.mean(difference)),
            "maximum_rgb_error": int(np.max(difference)),
            "foreground_pixels": int(np.count_nonzero(foreground)),
        }
        metrics.append(item)
        if write_comparisons:
            amplified = np.clip(difference * 8, 0, 255).astype(np.uint8)
            width, height = reference.shape[1], reference.shape[0]
            strip = Image.new("RGB", (width * 3, height + 28), "#101318")
            strip.paste(Image.fromarray(reference.astype(np.uint8)), (0, 28))
            strip.paste(Image.fromarray(decoded.astype(np.uint8)), (width, 28))
            strip.paste(Image.fromarray(amplified), (width * 2, 28))
            draw = ImageDraw.Draw(strip)
            draw.text((8, 7), f"RAW4D frame {item['frame']} camera {item['camera_index']}", fill="white")
            draw.text((width + 8, 7), f"Decoded PSNR {psnr:.3f} dB", fill="white")
            draw.text((width * 2 + 8, 7), "8x absolute difference", fill="white")
            strip.save(comparison_dir / reference_path.name)
    if not metrics:
        raise ValueError(f"No offline renders found in {reference_dir}")
    result = {
        "image_count": len(metrics),
        "mean_render_psnr_db": float(np.mean([item["render_psnr_db"] for item in metrics])),
        "minimum_render_psnr_db": float(np.min([item["render_psnr_db"] for item in metrics])),
        "mean_foreground_psnr_db": float(np.mean([item["foreground_psnr_db"] for item in metrics])),
        "minimum_foreground_psnr_db": float(np.min([item["foreground_psnr_db"] for item in metrics])),
        "mean_render_ssim": float(np.mean([item["render_ssim"] for item in metrics])),
        "per_image": metrics,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "metrics.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    with (output_dir / "metrics.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(metrics[0]))
        writer.writeheader()
        writer.writerows(metrics)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Offline CUDA RAW4D renderer and PSNR evaluator")
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--decoded", type=Path)
    parser.add_argument("--cameras-json", required=True, type=Path)
    parser.add_argument("--camera-indices", default="0", type=parse_indices)
    parser.add_argument("--frames", default="0,10,20,30", type=parse_indices)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--reuse-reference-dir", type=Path)
    parser.add_argument("--width", default=1280, type=int)
    parser.add_argument("--height", default=720, type=int)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--skip-comparisons", action="store_true")
    args = parser.parse_args()
    if not torch.cuda.is_available() or not args.device.startswith("cuda"):
        raise RuntimeError("The offline RAW4D evaluator requires a CUDA device")
    camera_data = json.loads(args.cameras_json.read_text(encoding="utf-8"))
    if any(index < 0 or index >= len(camera_data) for index in args.camera_indices):
        raise ValueError("Camera index is outside cameras.json")
    cameras = [(index, camera_data[index]) for index in args.camera_indices]
    device = torch.device(args.device)
    args.output_root.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    reference_dir = args.reuse_reference_dir or (args.output_root / "reference")
    summary = {
        "renderer": "gsplat-1.5.3-cuda-offline",
        "device": torch.cuda.get_device_name(device),
        "resolution": [args.width, args.height],
        "frames": args.frames,
        "camera_indices": args.camera_indices,
    }
    #WDD-gpt 2026-08-15 - 多码率候选复用完全相同的原始渲染，避免重复生成248张参考PNG。
    if args.reuse_reference_dir:
        expected = len(cameras) * len(args.frames)
        actual = len(list(reference_dir.glob("*.png")))
        if actual != expected:
            raise ValueError(f"Reusable reference render count mismatch: {actual} != {expected}")
        summary["reference"] = {
            "path": str(args.reference),
            "reused_render_dir": str(reference_dir),
            "image_count": actual,
        }
    else:
        summary["reference"] = render_asset(
            args.reference, reference_dir, cameras, args.frames,
            args.width, args.height, device,
        )
    if args.decoded:
        summary["decoded"] = render_asset(
            args.decoded, args.output_root / "decoded", cameras, args.frames,
            args.width, args.height, device,
        )
        summary["quality"] = evaluate_pairs(
            reference_dir,
            args.output_root / "decoded",
            args.output_root / "evaluation",
            write_comparisons=not args.skip_comparisons,
        )
    summary["total_seconds"] = time.perf_counter() - started
    (args.output_root / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
