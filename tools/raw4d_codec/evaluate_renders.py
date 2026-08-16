#!/usr/bin/env python3
"""Evaluate matching rendered frame directories and create visual comparisons."""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from skimage.metrics import structural_similarity


#WDD-gpt 2026-08-14 - 指标只裁切固定三维视口，排除文件名、检查器和时间轴造成的伪差异。
def evaluate(
    original_dir: Path,
    decoded_dir: Path,
    output_dir: Path,
    crop: tuple[int, int, int, int],
    allow_subset: bool = False,
) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    original_crop_dir = output_dir / "original_render"
    decoded_crop_dir = output_dir / "decoded_render"
    comparison_dir = output_dir / "comparison"
    for directory in [original_crop_dir, decoded_crop_dir, comparison_dir]:
        directory.mkdir(parents=True, exist_ok=True)

    original_paths = sorted(original_dir.glob("frame_*.png"))
    # WDD-gpt 2026-08-14 - 调参消融允许评估指定帧子集，最终验收仍默认严格要求全部匹配帧。
    if allow_subset:
        original_paths = [path for path in original_paths if (decoded_dir / path.name).exists()]
    if not original_paths:
        raise ValueError(f"No original frames found in {original_dir}")
    metrics: list[dict] = []
    overview_rows: list[Image.Image] = []
    for original_path in original_paths:
        decoded_path = decoded_dir / original_path.name
        if not decoded_path.exists():
            raise ValueError(f"Missing decoded frame {decoded_path}")
        original_image = Image.open(original_path).convert("RGB").crop(crop)
        decoded_image = Image.open(decoded_path).convert("RGB").crop(crop)
        original_image.save(original_crop_dir / original_path.name)
        decoded_image.save(decoded_crop_dir / decoded_path.name)
        original = np.asarray(original_image, dtype=np.float32)
        decoded = np.asarray(decoded_image, dtype=np.float32)
        difference = np.abs(original - decoded)
        mse = float(np.mean(np.square(difference), dtype=np.float64))
        psnr = math.inf if mse == 0 else 10 * math.log10(255 * 255 / mse)
        foreground = np.maximum(np.max(original, axis=2), np.max(decoded, axis=2)) > 25
        foreground_mse = float(np.mean(np.square(difference[foreground]), dtype=np.float64)) if np.any(foreground) else 0
        foreground_psnr = math.inf if foreground_mse == 0 else 10 * math.log10(255 * 255 / foreground_mse)
        ssim = float(structural_similarity(original, decoded, channel_axis=2, data_range=255))
        name_parts = original_path.stem.split("_")
        frame = int(name_parts[1])
        camera_index = int(name_parts[3]) if len(name_parts) >= 4 and name_parts[2] == "camera" else None
        item = {
            "frame": frame,
            "render_psnr_db": psnr,
            "foreground_psnr_db": foreground_psnr,
            "render_ssim": ssim,
            "rgb_mae": float(np.mean(difference)),
            "max_rgb_error": int(np.max(difference)),
            "foreground_pixels": int(np.count_nonzero(foreground)),
        }
        if camera_index is not None:
            item["camera_index"] = camera_index
        metrics.append(item)
        amplified = np.clip(difference * 8, 0, 255).astype(np.uint8)
        strip = Image.new("RGB", (original_image.width * 3, original_image.height + 28), "#101318")
        strip.paste(original_image, (0, 28))
        strip.paste(decoded_image, (original_image.width, 28))
        strip.paste(Image.fromarray(amplified), (original_image.width * 2, 28))
        draw = ImageDraw.Draw(strip)
        draw.text((8, 7), f"Original frame {frame}", fill="white")
        draw.text((original_image.width + 8, 7), f"Decoded  PSNR {psnr:.3f} dB", fill="white")
        draw.text((original_image.width * 2 + 8, 7), "8x absolute difference", fill="white")
        strip.save(comparison_dir / original_path.name)
        if (
            (camera_index is None and frame in {0, 10, 20, 30})
            or (camera_index is not None and len(overview_rows) < 8)
        ):
            overview_rows.append(strip)

    overview = Image.new("RGB", (max(row.width for row in overview_rows), sum(row.height for row in overview_rows)), "black")
    y = 0
    for row in overview_rows:
        overview.paste(row, (0, y))
        y += row.height
    overview.save(output_dir / "comparison_overview.png")
    result = {
        "crop_xyxy": list(crop),
        "frame_count": len(metrics),
        "mean_render_psnr_db": float(np.mean([item["render_psnr_db"] for item in metrics])),
        "minimum_render_psnr_db": float(np.min([item["render_psnr_db"] for item in metrics])),
        "mean_foreground_psnr_db": float(np.mean([item["foreground_psnr_db"] for item in metrics])),
        "minimum_foreground_psnr_db": float(np.min([item["foreground_psnr_db"] for item in metrics])),
        "mean_render_ssim": float(np.mean([item["render_ssim"] for item in metrics])),
        "per_frame": metrics,
    }
    camera_indices = sorted({item["camera_index"] for item in metrics if "camera_index" in item})
    if camera_indices:
        #WDD-gpt 2026-08-15 - 多视角报告同时给出每台训练相机统计，防止平均值掩盖单一坏视角。
        result["camera_count"] = len(camera_indices)
        result["per_camera"] = [
            {
                "camera_index": camera_index,
                "sample_count": len(selected),
                "mean_render_psnr_db": float(np.mean([item["render_psnr_db"] for item in selected])),
                "minimum_render_psnr_db": float(np.min([item["render_psnr_db"] for item in selected])),
            }
            for camera_index in camera_indices
            for selected in [[item for item in metrics if item.get("camera_index") == camera_index]]
        ]
    (output_dir / "metrics.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    with (output_dir / "metrics.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(metrics[0]))
        writer.writeheader()
        writer.writerows(metrics)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("original_dir", type=Path)
    parser.add_argument("decoded_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--crop", nargs=4, type=int, default=(90, 70, 950, 620), metavar=("X0", "Y0", "X1", "Y1"))
    parser.add_argument("--allow-subset", action="store_true")
    args = parser.parse_args()
    print(json.dumps(evaluate(args.original_dir, args.decoded_dir, args.output_dir, tuple(args.crop), args.allow_subset), indent=2))


if __name__ == "__main__":
    main()
