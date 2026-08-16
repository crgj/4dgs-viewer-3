#!/usr/bin/env python3
"""TSOG-RAW4D-PL16 encoder, decoder, inspector, and measured report generator."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import shlex
import struct
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image

from codec import (
    extract_track,
    load_rows,
    property_indices,
    read_raw4d_layout,
)


#WDD-gpt 2026-08-15 - 按 TSOG 论文的索引对齐图像约束实现可独立编解码的 RAW4D 稀疏关键帧档。
PROFILE_NAME = "TSOG-RAW4D-PL16"
PROFILE_VERSION = 1
DEFAULT_TRANSFORM_COMMAND = "npx -y @playcanvas/splat-transform@3.3.0"
STANDARD_PLY_PROPERTIES = (
    ("x", "position", 0),
    ("y", "position", 1),
    ("z", "position", 2),
    ("nx", "zero", 0),
    ("ny", "zero", 0),
    ("nz", "zero", 0),
    ("f_dc_0", "color_dc", 0),
    ("f_dc_1", "color_dc", 1),
    ("f_dc_2", "color_dc", 2),
    *((f"f_rest_{index}", "sh_rest", index) for index in range(45)),
    ("opacity", "opacity", 0),
    ("scale_0", "scale", 0),
    ("scale_1", "scale", 1),
    ("scale_2", "scale", 2),
    ("rot_0", "rotation", 0),
    ("rot_1", "rotation", 1),
    ("rot_2", "rotation", 2),
    ("rot_3", "rotation", 3),
)


def sha256_file(path: Path, chunk_bytes: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_bytes):
            digest.update(chunk)
    return digest.hexdigest()


def stable_sigmoid(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    result = np.empty_like(values)
    positive = values >= 0
    result[positive] = 1 / (1 + np.exp(-values[positive]))
    exponential = np.exp(values[~positive])
    result[~positive] = exponential / (1 + exponential)
    result[np.isneginf(values)] = 0
    return result


def stable_logit(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(np.asarray(values, dtype=np.float32), np.float32(1e-7), np.float32(1 - 1e-7))
    return np.log(clipped / (1 - clipped)).astype(np.float32)


def normalize_quaternions(values: np.ndarray) -> np.ndarray:
    result = np.asarray(values, dtype=np.float32).copy()
    lengths = np.linalg.norm(result, axis=-1, keepdims=True)
    result /= np.maximum(lengths, np.float32(1e-12))
    invalid = lengths[..., 0] <= np.float32(1e-12)
    result[invalid] = np.asarray([1, 0, 0, 0], dtype=np.float32)
    if result.ndim == 3:
        for key in range(1, result.shape[1]):
            flip = np.sum(result[:, key - 1] * result[:, key], axis=1) < 0
            result[flip, key] *= -1
    return result


def quaternion_multiply(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    lw, lx, ly, lz = np.moveaxis(np.asarray(left, dtype=np.float32), -1, 0)
    rw, rx, ry, rz = np.moveaxis(np.asarray(right, dtype=np.float32), -1, 0)
    return np.stack(
        [
            lw * rw - lx * rx - ly * ry - lz * rz,
            lw * rx + lx * rw + ly * rz - lz * ry,
            lw * ry - lx * rz + ly * rw + lz * rx,
            lw * rz + lx * ry - ly * rx + lz * rw,
        ],
        axis=-1,
    ).astype(np.float32)


def quaternion_conjugate(values: np.ndarray) -> np.ndarray:
    result = np.asarray(values, dtype=np.float32).copy()
    result[..., 1:] *= -1
    return result


def quaternion_log(values: np.ndarray) -> np.ndarray:
    quaternions = normalize_quaternions(values)
    quaternions = np.where((quaternions[..., :1] < 0), -quaternions, quaternions)
    vector = quaternions[..., 1:]
    length = np.linalg.norm(vector, axis=-1, keepdims=True)
    angle = 2 * np.arctan2(length, np.clip(quaternions[..., :1], -1, 1))
    scale = np.divide(angle, length, out=np.full_like(length, 2), where=length > np.float32(1e-8))
    return (vector * scale).astype(np.float32)


def quaternion_exp(vectors: np.ndarray) -> np.ndarray:
    vectors = np.asarray(vectors, dtype=np.float32)
    angle = np.linalg.norm(vectors, axis=-1, keepdims=True)
    half = angle * np.float32(0.5)
    scale = np.divide(np.sin(half), angle, out=np.full_like(angle, 0.5), where=angle > np.float32(1e-8))
    result = np.concatenate([np.cos(half), vectors * scale], axis=-1)
    return normalize_quaternions(result)


def relative_rotation_vectors(quaternions: np.ndarray) -> np.ndarray:
    quaternions = normalize_quaternions(quaternions)
    base_inverse = quaternion_conjugate(quaternions[:, :1])
    relative = quaternion_multiply(np.broadcast_to(base_inverse, quaternions.shape), quaternions)
    return quaternion_log(relative[:, 1:])


def _part1by2(values: np.ndarray) -> np.ndarray:
    values = values.astype(np.uint32, copy=False) & np.uint32(0x000003FF)
    values = (values ^ (values << np.uint32(16))) & np.uint32(0xFF0000FF)
    values = (values ^ (values << np.uint32(8))) & np.uint32(0x0300F00F)
    values = (values ^ (values << np.uint32(4))) & np.uint32(0x030C30C3)
    values = (values ^ (values << np.uint32(2))) & np.uint32(0x09249249)
    return values


def morton_order(positions: np.ndarray) -> np.ndarray:
    """Match splat-transform's recursive 10-bit Morton ordering."""
    positions = np.asarray(positions, dtype=np.float32)
    order = np.arange(positions.shape[0], dtype=np.uint32)

    def refine(view: np.ndarray) -> None:
        if view.size == 0:
            return
        selected = positions[view]
        minimum = np.min(selected, axis=0).astype(np.float64)
        maximum = np.max(selected, axis=0).astype(np.float64)
        extent = maximum - minimum
        if not np.all(np.isfinite(extent)) or np.all(extent == 0):
            return
        multiplier = np.divide(1024.0, extent, out=np.zeros(3, dtype=np.float64), where=extent != 0)
        integer = np.minimum(1023, (selected.astype(np.float64) - minimum) * multiplier).astype(np.uint32)
        code = _part1by2(integer[:, 0]) + (_part1by2(integer[:, 1]) << np.uint32(1))
        code += _part1by2(integer[:, 2]) << np.uint32(2)
        local = np.argsort(code, kind="stable")
        view[:] = view[local]
        sorted_code = code[local]
        starts = np.r_[0, np.flatnonzero(sorted_code[1:] != sorted_code[:-1]) + 1]
        ends = np.r_[starts[1:], view.size]
        for start, end in zip(starts, ends, strict=True):
            if end - start > 256:
                refine(view[start:end])

    refine(order)
    return order


def rgba_webp(data: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(np.asarray(data, dtype=np.uint8)).save(
        buffer,
        format="WEBP",
        lossless=True,
        quality=100,
        method=6,
        exact=True,
    )
    return buffer.getvalue()


def decode_rgba(data: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(data)) as image:
        return np.asarray(image.convert("RGBA"), dtype=np.uint8)


def quantize16(values: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    values = np.asarray(values, dtype=np.float32)
    axes = tuple(range(values.ndim - 1))
    minimum = np.min(values, axis=axes).astype(np.float32)
    maximum = np.max(values, axis=axes).astype(np.float32)
    scale = np.divide(
        maximum - minimum,
        np.float32(65535),
        out=np.ones_like(minimum),
        where=maximum > minimum,
    )
    quantized = np.rint((values - minimum) / scale).clip(0, 65535).astype(np.uint16)
    return quantized, minimum, maximum


def dequantize16(quantized: np.ndarray, minimum: np.ndarray, maximum: np.ndarray) -> np.ndarray:
    minimum = np.asarray(minimum, dtype=np.float32)
    maximum = np.asarray(maximum, dtype=np.float32)
    scale = np.divide(
        maximum - minimum,
        np.float32(65535),
        out=np.zeros_like(minimum),
        where=maximum > minimum,
    )
    return minimum + np.asarray(quantized, dtype=np.float32) * scale


def encode_image_pair(
    values: np.ndarray,
    order: np.ndarray,
    width: int,
    height: int,
) -> tuple[bytes, bytes, list[float], list[float]]:
    quantized, minimum, maximum = quantize16(values)
    components = quantized.shape[-1]
    lower = np.zeros((height, width, 4), dtype=np.uint8)
    upper = np.zeros((height, width, 4), dtype=np.uint8)
    lower[..., 3] = 255
    upper[..., 3] = 255
    flat_lower = lower.reshape(-1, 4)
    flat_upper = upper.reshape(-1, 4)
    sorted_values = quantized[order]
    flat_lower[: order.size, :components] = (sorted_values & np.uint16(255)).astype(np.uint8)
    flat_upper[: order.size, :components] = (sorted_values >> np.uint16(8)).astype(np.uint8)
    return rgba_webp(lower), rgba_webp(upper), minimum.tolist(), maximum.tolist()


def decode_image_pair(
    files: dict[str, bytes],
    lower_name: str,
    upper_name: str,
    count: int,
    components: int,
    minimum: Iterable[float],
    maximum: Iterable[float],
) -> np.ndarray:
    lower = decode_rgba(files[lower_name]).reshape(-1, 4)[:count, :components].astype(np.uint16)
    upper = decode_rgba(files[upper_name]).reshape(-1, 4)[:count, :components].astype(np.uint16)
    return dequantize16(lower | (upper << np.uint16(8)), np.asarray(minimum), np.asarray(maximum))


def make_temporal_images(
    name: str,
    values: np.ndarray,
    frames: list[int],
    order: np.ndarray,
    width: int,
    height: int,
    files: dict[str, bytes],
    *,
    representation: str,
    interpolation: str,
    include_base: bool = False,
) -> dict[str, Any]:
    first = 0 if include_base else 1
    mins: list[list[float]] = []
    maxs: list[list[float]] = []
    image_names: list[str] = []
    for key in range(first, values.shape[1]):
        coefficient = key - first + 1
        lower_name = f"temporal_{name}_{coefficient}_l.webp"
        upper_name = f"temporal_{name}_{coefficient}_u.webp"
        lower, upper, minimum, maximum = encode_image_pair(values[:, key], order, width, height)
        files[lower_name] = lower
        files[upper_name] = upper
        image_names.extend([lower_name, upper_name])
        mins.append(minimum)
        maxs.append(maximum)
    return {
        "parameterization": "piecewise_keyframes",
        "interpolation": interpolation,
        "representation": representation,
        "precision_bits": 16,
        "frames": frames[first:],
        "mins": mins,
        "maxs": maxs,
        "files": image_names,
    }


def decode_temporal_images(
    files: dict[str, bytes],
    metadata: dict[str, Any],
    count: int,
    components: int,
) -> np.ndarray:
    keys = len(metadata["frames"])
    result = np.empty((count, keys, components), dtype=np.float32)
    for key in range(keys):
        result[:, key] = decode_image_pair(
            files,
            metadata["files"][key * 2],
            metadata["files"][key * 2 + 1],
            count,
            components,
            metadata["mins"][key],
            metadata["maxs"][key],
        )
    return result


def collect_source(path: Path) -> tuple[Any, np.ndarray, dict[str, np.ndarray], dict[str, list[int]]]:
    layout = read_raw4d_layout(path)
    if layout.scalar_encoding != "float32":
        raise ValueError(f"{PROFILE_NAME} currently requires a float32 RAW4D source")
    rows = load_rows(layout)
    tracks: dict[str, np.ndarray] = {}
    frames: dict[str, list[int]] = {}
    definitions = {
        "position": ("xyz_bank", ("x", "y", "z")),
        "rotation": ("rot_bank", ("w", "x", "y", "z")),
        "color_dc": ("f_dc_bank", ("0", "1", "2")),
        "scale": ("scale_bank", ("0", "1", "2")),
        "opacity": ("opacity_bank", ("",)),
    }
    for name, (prefix, components) in definitions.items():
        tracks[name], frames[name] = extract_track(rows, layout, prefix, components)
    tracks["rotation"] = normalize_quaternions(tracks["rotation"])
    lifetime_indices = property_indices(layout, ["lifetime_mu", "lifetime_w"])
    tracks["lifetime"] = np.asarray(rows[:, lifetime_indices], dtype=np.float32)
    sh_names = [f"f_rest_{index}" for index in range(45)]
    tracks["sh_rest"] = np.asarray(rows[:, property_indices(layout, sh_names)], dtype=np.float32)
    return layout, rows, tracks, frames


def write_base_ply(path: Path, layout: Any, tracks: dict[str, np.ndarray]) -> None:
    count = layout.vertex_count
    columns = np.empty((count, len(STANDARD_PLY_PROPERTIES)), dtype="<f4")
    for column, (_, source, component) in enumerate(STANDARD_PLY_PROPERTIES):
        if source == "zero":
            columns[:, column] = 0
        elif source == "sh_rest":
            columns[:, column] = tracks[source][:, component]
        elif source == "opacity":
            #WDD-gpt 2026-08-15 - 用非透明 carrier 阻止标准 WebP 丢弃 alpha=0 像素的 DC 标签，编码后再写回真实 opacity。
            columns[:, column] = 0
        else:
            columns[:, column] = tracks[source][:, 0, component]
    header = ["ply", "format binary_little_endian 1.0", f"element vertex {count}"]
    header.extend(f"property float {name}" for name, _, _ in STANDARD_PLY_PROPERTIES)
    header.append("end_header")
    with path.open("wb") as handle:
        handle.write(("\n".join(header) + "\n").encode("ascii"))
        columns.tofile(handle)


def read_zip_files(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path, "r") as archive:
        return {name: archive.read(name) for name in archive.namelist() if not name.endswith("/")}


def write_stored_zip(path: Path, files: dict[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o644 << 16
            archive.writestr(info, files[name])
    temporary.replace(path)


def patch_codebook(codebook: list[Any]) -> np.ndarray:
    result = np.asarray([np.nan if value is None else value for value in codebook], dtype=np.float32)
    if np.isnan(result[0]) and result.size > 1:
        result[0] = result[1] + (result[1] - result[-1]) / np.float32(result.size - 1)
    return result


def decode_sog_base(files: dict[str, bytes], meta: dict[str, Any]) -> dict[str, np.ndarray]:
    count = int(meta["count"])
    means_lower = decode_rgba(files[meta["means"]["files"][0]]).reshape(-1, 4)[:count, :3].astype(np.uint16)
    means_upper = decode_rgba(files[meta["means"]["files"][1]]).reshape(-1, 4)[:count, :3].astype(np.uint16)
    normalized = (means_lower | (means_upper << np.uint16(8))).astype(np.float32) / np.float32(65535)
    means_min = np.asarray(meta["means"]["mins"], dtype=np.float32)
    means_max = np.asarray(meta["means"]["maxs"], dtype=np.float32)
    transformed = means_min + normalized * (means_max - means_min)
    position = np.sign(transformed) * np.expm1(np.abs(transformed))

    quat_data = decode_rgba(files[meta["quats"]["files"][0]]).reshape(-1, 4)[:count]
    abc = (quat_data[:, :3].astype(np.float32) / np.float32(255) - np.float32(0.5)) * np.float32(math.sqrt(2))
    missing = np.sqrt(np.maximum(0, 1 - np.sum(abc * abc, axis=1)))
    mode = quat_data[:, 3].astype(np.int16) - 252
    rotation = np.empty((count, 4), dtype=np.float32)
    for dropped in range(4):
        mask = mode == dropped
        keep = [index for index in range(4) if index != dropped]
        rotation[mask, dropped] = missing[mask]
        rotation[np.ix_(mask, keep)] = abc[mask]
    rotation = normalize_quaternions(rotation)

    scale_labels = decode_rgba(files[meta["scales"]["files"][0]]).reshape(-1, 4)[:count, :3]
    scale = patch_codebook(meta["scales"]["codebook"])[scale_labels]
    sh0_data = decode_rgba(files[meta["sh0"]["files"][0]]).reshape(-1, 4)[:count]
    color_dc = patch_codebook(meta["sh0"]["codebook"])[sh0_data[:, :3]]
    alpha = sh0_data[:, 3].astype(np.float32) / np.float32(255)

    sh_rest = np.empty((count, 0), dtype=np.float32)
    if "shN" in meta:
        sh_meta = meta["shN"]
        labels_rgba = decode_rgba(files[sh_meta["files"][1]]).reshape(-1, 4)[:count]
        labels = labels_rgba[:, 0].astype(np.uint16) | (labels_rgba[:, 1].astype(np.uint16) << np.uint16(8))
        centroids = decode_rgba(files[sh_meta["files"][0]])
        codebook = patch_codebook(sh_meta["codebook"])
        coefficients = {1: 3, 2: 8, 3: 15}[int(sh_meta["bands"])]
        sh_rest = np.empty((count, coefficients * 3), dtype=np.float32)
        for channel in range(3):
            for coefficient in range(coefficients):
                x = (labels.astype(np.int64) % 64) * coefficients + coefficient
                y = labels.astype(np.int64) // 64
                sh_rest[:, channel * coefficients + coefficient] = codebook[centroids[y, x, channel]]
    return {
        "position": position.astype(np.float32),
        "rotation": rotation,
        "scale": scale.astype(np.float32),
        "color_dc": color_dc.astype(np.float32),
        "alpha": alpha,
        "sh_rest": sh_rest,
    }


def encode_archive(
    source: Path,
    output: Path,
    transform_command: str,
    sh_iterations: int,
    max_workers: int,
    gpu: str | None,
) -> dict[str, Any]:
    total_started = time.perf_counter()
    layout, _, tracks, frames = collect_source(source)
    order_started = time.perf_counter()
    order = morton_order(tracks["position"][:, 0])
    order_seconds = time.perf_counter() - order_started
    with tempfile.TemporaryDirectory(prefix="raw4d-tsog-") as temporary_string:
        temporary = Path(temporary_string)
        base_ply = temporary / "base.ply"
        base_sog = temporary / "base.sog"
        write_started = time.perf_counter()
        write_base_ply(base_ply, layout, tracks)
        base_ply_seconds = time.perf_counter() - write_started
        command = shlex.split(transform_command)
        command.extend(["-q", "--sh-iterations", str(sh_iterations), "--max-workers", str(max_workers)])
        if gpu is not None:
            command.extend(["--gpu", gpu])
        command.extend([str(base_ply), str(base_sog)])
        sog_started = time.perf_counter()
        process = subprocess.run(command, check=False, text=True, capture_output=True)
        sog_seconds = time.perf_counter() - sog_started
        if process.returncode != 0:
            raise RuntimeError(
                f"splat-transform failed with exit code {process.returncode}:\n{process.stdout}\n{process.stderr}"
            )
        files = read_zip_files(base_sog)

    meta = json.loads(files.pop("meta.json"))
    if int(meta.get("count", 0)) != layout.vertex_count:
        raise ValueError("SOG encoder changed the Gaussian count")
    means_image = decode_rgba(files[meta["means"]["files"][0]])
    height, width = means_image.shape[:2]
    sh0_name = meta["sh0"]["files"][0]
    sh0_image = decode_rgba(files[sh0_name]).copy()
    sh0_flat = sh0_image.reshape(-1, 4)
    source_alpha = stable_sigmoid(tracks["opacity"][:, 0, 0])
    sh0_flat[: layout.vertex_count, 3] = np.clip(source_alpha[order] * 255, 0, 255).astype(np.uint8)
    files[sh0_name] = rgba_webp(sh0_image)
    temporal_started = time.perf_counter()

    position_delta = tracks["position"] - tracks["position"][:, :1]
    color_delta = tracks["color_dc"] - tracks["color_dc"][:, :1]
    scale_delta = tracks["scale"] - tracks["scale"][:, :1]
    rotation_vector = relative_rotation_vectors(tracks["rotation"])
    rotation_values = np.concatenate(
        [np.zeros((layout.vertex_count, 1, 3), dtype=np.float32), rotation_vector], axis=1
    )
    opacity_alpha = stable_sigmoid(tracks["opacity"])

    temporal = {
        "means": make_temporal_images(
            "means", position_delta, frames["position"], order, width, height, files,
            representation="delta_from_base", interpolation="linear",
        ),
        "quats": make_temporal_images(
            "quats", rotation_values, frames["rotation"], order, width, height, files,
            representation="relative_rotation_vector", interpolation="slerp",
        ),
        "sh0": make_temporal_images(
            "sh0", color_delta, frames["color_dc"], order, width, height, files,
            representation="delta_from_base", interpolation="linear",
        ),
        "scales": make_temporal_images(
            "scales", scale_delta, frames["scale"], order, width, height, files,
            representation="log_scale_delta_from_base", interpolation="linear",
        ),
        "opacities": make_temporal_images(
            "opacities", opacity_alpha, frames["opacity"], order, width, height, files,
            representation="absolute_sigmoid_alpha", interpolation="linear", include_base=False,
        ),
    }
    timeline_lower, timeline_upper, timeline_min, timeline_max = encode_image_pair(
        tracks["lifetime"], order, width, height
    )
    files["timeline_l.webp"] = timeline_lower
    files["timeline_u.webp"] = timeline_upper
    timeline = {
        "type": 2,
        "semantics": "center_and_scale",
        "scene_length": layout.total_frames - 1,
        "precision_bits": 16,
        "mins": timeline_min,
        "maxs": timeline_max,
        "files": ["timeline_l.webp", "timeline_u.webp"],
    }
    temporal_seconds = time.perf_counter() - temporal_started
    meta["asset"] = {
        **meta.get("asset", {}),
        "tsog_profile": PROFILE_NAME,
        "tsog_profile_version": PROFILE_VERSION,
    }
    meta["timeline"] = timeline
    meta["temporal"] = temporal
    meta["tsog"] = {
        "version": PROFILE_VERSION,
        "profile": PROFILE_NAME,
        "paper": "arXiv:2607.28049v1",
        "source_format": "RAW4D",
        "source_name": source.name,
        "source_size_bytes": source.stat().st_size,
        "source_sha256": sha256_file(source),
        "source_header_bytes": layout.header_bytes,
        "source_scalar_encoding": layout.scalar_encoding,
        "total_frames": layout.total_frames,
        "gaussian_count": layout.vertex_count,
        "raw4d_properties": list(layout.properties),
        "raw4d_comments": layout.comments,
        "ordering": "recursive_morton_10bit_from_base_means",
        "temporal_model": "source_sparse_piecewise_keyframes",
        "timeline_gate": "RAW4D symmetric sigmoid bounds",
        "encode": {
            "transform_command": transform_command,
            "sh_iterations": sh_iterations,
            "max_workers": max_workers,
            "gpu": gpu,
            "morton_seconds": order_seconds,
            "base_ply_seconds": base_ply_seconds,
            "sog_seconds": sog_seconds,
            "temporal_seconds": temporal_seconds,
        },
    }
    files["meta.json"] = json.dumps(meta, separators=(",", ":"), allow_nan=False).encode("utf-8")
    zip_started = time.perf_counter()
    write_stored_zip(output, files)
    zip_seconds = time.perf_counter() - zip_started
    total_seconds = time.perf_counter() - total_started
    return {
        "source": str(source),
        "output": str(output),
        "source_bytes": source.stat().st_size,
        "output_bytes": output.stat().st_size,
        "compression_ratio": source.stat().st_size / output.stat().st_size,
        "seconds": {
            "morton": order_seconds,
            "base_ply": base_ply_seconds,
            "sog": sog_seconds,
            "temporal": temporal_seconds,
            "zip": zip_seconds,
            "total": total_seconds,
        },
        "sha256": sha256_file(output),
    }


def decode_archive(input_path: Path, output: Path) -> dict[str, Any]:
    started = time.perf_counter()
    files = read_zip_files(input_path)
    meta = json.loads(files["meta.json"])
    tsog = meta.get("tsog", {})
    if tsog.get("profile") != PROFILE_NAME:
        raise ValueError(f"Unsupported TSOG profile: {tsog.get('profile')}")
    count = int(meta["count"])
    base = decode_sog_base(files, meta)
    temporal = meta["temporal"]

    position_delta = decode_temporal_images(files, temporal["means"], count, 3)
    position = np.concatenate(
        [base["position"][:, None], base["position"][:, None] + position_delta], axis=1
    )
    rotation_vector = decode_temporal_images(files, temporal["quats"], count, 3)
    relative = quaternion_exp(rotation_vector)
    rotation_tail = quaternion_multiply(np.broadcast_to(base["rotation"][:, None], relative.shape[:-1] + (4,)), relative)
    rotation = np.concatenate([base["rotation"][:, None], normalize_quaternions(rotation_tail)], axis=1)
    color_delta = decode_temporal_images(files, temporal["sh0"], count, 3)
    color_dc = np.concatenate(
        [base["color_dc"][:, None], base["color_dc"][:, None] + color_delta], axis=1
    )
    scale_delta = decode_temporal_images(files, temporal["scales"], count, 3)
    scale = np.concatenate([base["scale"][:, None], base["scale"][:, None] + scale_delta], axis=1)
    opacity_tail = decode_temporal_images(files, temporal["opacities"], count, 1)
    opacity_alpha = np.concatenate([base["alpha"][:, None, None], opacity_tail], axis=1)
    opacity = stable_logit(opacity_alpha)
    lifetime = decode_image_pair(
        files,
        meta["timeline"]["files"][0],
        meta["timeline"]["files"][1],
        count,
        2,
        meta["timeline"]["mins"],
        meta["timeline"]["maxs"],
    )

    properties = list(tsog["raw4d_properties"])
    comments = dict(tsog["raw4d_comments"])
    rows = np.empty((count, len(properties)), dtype="<f4")
    lookup = {name: index for index, name in enumerate(properties)}
    rows[:, property_indices_from_lookup(lookup, ["x", "y", "z"])] = position[:, 0]
    rows[:, property_indices_from_lookup(lookup, ["nx", "ny", "nz"])] = 0
    rows[:, property_indices_from_lookup(lookup, ["f_dc_0", "f_dc_1", "f_dc_2"])] = color_dc[:, 0]
    rows[:, property_indices_from_lookup(lookup, [f"f_rest_{index}" for index in range(base["sh_rest"].shape[1])])] = base["sh_rest"]
    rows[:, lookup["opacity"]] = opacity[:, 0, 0]
    rows[:, property_indices_from_lookup(lookup, ["scale_0", "scale_1", "scale_2"])] = scale[:, 0]
    rows[:, property_indices_from_lookup(lookup, ["lifetime_mu", "lifetime_w"])] = lifetime
    assign_track(rows, lookup, "xyz_bank", ("x", "y", "z"), position)
    assign_track(rows, lookup, "rot_bank", ("w", "x", "y", "z"), rotation)
    assign_track(rows, lookup, "f_dc_bank", ("0", "1", "2"), color_dc)
    assign_track(rows, lookup, "scale_bank", ("0", "1", "2"), scale)
    assign_track(rows, lookup, "opacity_bank", ("",), opacity)

    header = ["ply", "format binary_little_endian 1.0"]
    header.extend(f"comment {name} {value}" for name, value in comments.items())
    header.append(f"comment tsog_profile {PROFILE_NAME}")
    header.append(f"comment tsog_source_sha256 {tsog['source_sha256']}")
    header.append(f"element vertex {count}")
    header.extend(f"property float {name}" for name in properties)
    header.append("end_header")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    with temporary.open("wb") as handle:
        handle.write(("\n".join(header) + "\n").encode("ascii"))
        rows.tofile(handle)
    temporary.replace(output)
    seconds = time.perf_counter() - started
    return {
        "input": str(input_path),
        "output": str(output),
        "output_bytes": output.stat().st_size,
        "seconds": seconds,
        "sha256": sha256_file(output),
    }


def property_indices_from_lookup(lookup: dict[str, int], names: Iterable[str]) -> list[int]:
    missing = [name for name in names if name not in lookup]
    if missing:
        raise ValueError(f"TSOG RAW4D schema is missing {missing[0]}")
    return [lookup[name] for name in names]


def assign_track(
    rows: np.ndarray,
    lookup: dict[str, int],
    prefix: str,
    components: tuple[str, ...],
    values: np.ndarray,
) -> None:
    for key in range(values.shape[1]):
        for component_index, component in enumerate(components):
            name = f"{prefix}_{key}_{component}" if component else f"{prefix}_{key}"
            rows[:, lookup[name]] = values[:, key, component_index]


def error_stats(reference: np.ndarray, decoded: np.ndarray) -> dict[str, float]:
    error = np.abs(np.asarray(decoded, dtype=np.float64) - np.asarray(reference, dtype=np.float64)).reshape(-1)
    return {
        "mae": float(np.mean(error)),
        "rmse": float(np.sqrt(np.mean(error * error))),
        "p95": float(np.quantile(error, 0.95)),
        "max": float(np.max(error)),
    }


def vector_l2_stats(reference: np.ndarray, decoded: np.ndarray) -> dict[str, float]:
    distance = np.linalg.norm(
        np.asarray(decoded, dtype=np.float64) - np.asarray(reference, dtype=np.float64), axis=-1
    ).reshape(-1)
    return {
        "mean": float(np.mean(distance)),
        "rmse": float(np.sqrt(np.mean(distance * distance))),
        "p95": float(np.quantile(distance, 0.95)),
        "max": float(np.max(distance)),
    }


def rotation_error_stats(reference: np.ndarray, decoded: np.ndarray) -> dict[str, float]:
    reference = normalize_quaternions(reference)
    decoded = normalize_quaternions(decoded)
    dot = np.abs(np.sum(reference * decoded, axis=-1)).clip(0, 1)
    degrees = np.degrees(2 * np.arccos(dot.astype(np.float64))).reshape(-1)
    return {
        "mean_degrees": float(np.mean(degrees)),
        "rmse_degrees": float(np.sqrt(np.mean(degrees * degrees))),
        "p95_degrees": float(np.quantile(degrees, 0.95)),
        "max_degrees": float(np.max(degrees)),
    }


def archive_parameter_sizes(path: Path) -> tuple[dict[str, int], dict[str, int]]:
    with zipfile.ZipFile(path, "r") as archive:
        entries = {info.filename: info.compress_size for info in archive.infolist() if not info.is_dir()}
    groups = {
        "position": sum(size for name, size in entries.items() if name in {"means_l.webp", "means_u.webp"} or name.startswith("temporal_means_")),
        "rotation": sum(size for name, size in entries.items() if name == "quats.webp" or name.startswith("temporal_quats_")),
        "scale": sum(size for name, size in entries.items() if name == "scales.webp" or name.startswith("temporal_scales_")),
        "dc_opacity": sum(size for name, size in entries.items() if name == "sh0.webp" or name.startswith("temporal_sh0_") or name.startswith("temporal_opacities_")),
        "sh_rest": sum(size for name, size in entries.items() if name.startswith("shN_")),
        "lifetime": sum(size for name, size in entries.items() if name.startswith("timeline_")),
    }
    groups["metadata_container"] = path.stat().st_size - sum(groups.values())
    return entries, groups


def analyze_archive(reference_path: Path, tsog_path: Path, decoded_path: Path) -> dict[str, Any]:
    reference_layout, _, reference_tracks, frames = collect_source(reference_path)
    decoded_layout, _, decoded_tracks, decoded_frames = collect_source(decoded_path)
    if reference_layout.vertex_count != decoded_layout.vertex_count:
        raise ValueError("Decoded Gaussian count does not match the source")
    if frames != decoded_frames:
        raise ValueError("Decoded keyframe layout does not match the source")
    order = morton_order(reference_tracks["position"][:, 0])
    reference_sorted = {name: values[order] for name, values in reference_tracks.items()}
    position_range = np.ptp(reference_tracks["position"].reshape(-1, 3), axis=0)
    scene_diagonal = float(np.linalg.norm(position_range.astype(np.float64)))
    opacity_reference_alpha = stable_sigmoid(reference_sorted["opacity"])
    opacity_decoded_alpha = stable_sigmoid(decoded_tracks["opacity"])
    residuals = {
        "position_components_world": error_stats(reference_sorted["position"], decoded_tracks["position"]),
        "position_l2_world": vector_l2_stats(reference_sorted["position"], decoded_tracks["position"]),
        "position_scene_diagonal": scene_diagonal,
        "rotation_geodesic": rotation_error_stats(reference_sorted["rotation"], decoded_tracks["rotation"]),
        "dc_coefficients": error_stats(reference_sorted["color_dc"], decoded_tracks["color_dc"]),
        "scale_log_domain": error_stats(reference_sorted["scale"], decoded_tracks["scale"]),
        "scale_linear_domain": error_stats(np.exp(reference_sorted["scale"]), np.exp(decoded_tracks["scale"])),
        "opacity_alpha": error_stats(opacity_reference_alpha, opacity_decoded_alpha),
        "sh_rest_coefficients": error_stats(reference_sorted["sh_rest"], decoded_tracks["sh_rest"]),
        "lifetime_frames": error_stats(reference_sorted["lifetime"], decoded_tracks["lifetime"]),
    }
    entries, compressed = archive_parameter_sizes(tsog_path)
    count = reference_layout.vertex_count
    raw = {
        "position": count * 33 * 4,
        "rotation": count * 8 * 4,
        "scale": count * 12 * 4,
        "dc_opacity": count * 10 * 4,
        "sh_rest": count * 45 * 4,
        "lifetime": count * 2 * 4,
        "redundant_legacy_base_and_normals": count * 13 * 4,
        "header": reference_layout.header_bytes,
    }
    ratios = {
        name: raw[name] / compressed[name]
        for name in ("position", "rotation", "scale", "dc_opacity", "sh_rest", "lifetime")
        if compressed[name] > 0
    }
    return {
        "profile": PROFILE_NAME,
        "reference": str(reference_path),
        "tsog": str(tsog_path),
        "decoded": str(decoded_path),
        "gaussian_count": count,
        "total_frames": reference_layout.total_frames,
        "keyframes": frames,
        "bytes": {
            "source_file": reference_path.stat().st_size,
            "source_payload": count * len(reference_layout.properties) * 4,
            "tsog_file": tsog_path.stat().st_size,
            "decoded_file": decoded_path.stat().st_size,
            "raw_by_parameter": raw,
            "tsog_by_parameter": compressed,
            "archive_entries": entries,
        },
        "compression": {
            "source_to_tsog_ratio": reference_path.stat().st_size / tsog_path.stat().st_size,
            "source_savings_percent": (1 - tsog_path.stat().st_size / reference_path.stat().st_size) * 100,
            "per_parameter_ratio": ratios,
        },
        "residuals": residuals,
        "sha256": {
            "source": sha256_file(reference_path),
            "tsog": sha256_file(tsog_path),
            "decoded": sha256_file(decoded_path),
        },
    }


def format_bytes(value: int) -> str:
    return f"{value / (1024 * 1024):.3f} MiB ({value:,} B)"


def write_markdown_report(report: dict[str, Any], path: Path) -> None:
    raw = report["bytes"]["raw_by_parameter"]
    compressed = report["bytes"]["tsog_by_parameter"]
    ratios = report["compression"]["per_parameter_ratio"]
    labels = {
        "position": "Position (11x3)",
        "rotation": "Rotation (2x4)",
        "scale": "Log-scale (4x3)",
        "dc_opacity": "DC + opacity (2x3 + 4x1)",
        "sh_rest": "SH rest (45)",
        "lifetime": "Lifetime center + scale (2)",
    }
    lines = [
        f"# {PROFILE_NAME} master.raw4d 实测报告",
        "",
        "<!-- #WDD-gpt 2026-08-15 - 记录 TSOG 实际码流、独立解码残差和逐参数字节归属。 -->",
        "",
        "## 总结",
        "",
        f"- Gaussian: {report['gaussian_count']:,}; playback frames: {report['total_frames']}.",
        f"- Source: {format_bytes(report['bytes']['source_file'])}.",
        f"- TSOG: {format_bytes(report['bytes']['tsog_file'])}.",
        f"- 实测压缩比: **{report['compression']['source_to_tsog_ratio']:.3f}:1**; 节省 **{report['compression']['source_savings_percent']:.2f}%**.",
        "- Position/Rotation/DC/Scale/Opacity 继续使用源 RAW4D 的稀疏关键帧，不展开为 31 份完整帧。",
        "- 静态基础层由 PlayCanvas 官方 SOG 编码器生成；动态层为论文允许扩展的 16-bit piecewise-keyframe 参数化。",
        "",
        "## 分参数大小",
        "",
        "| 参数 | RAW4D float32 | TSOG 文件字节 | 压缩比 |",
        "|---|---:|---:|---:|",
    ]
    for name, label in labels.items():
        lines.append(f"| {label} | {format_bytes(raw[name])} | {format_bytes(compressed[name])} | {ratios[name]:.3f}:1 |")
    lines.extend(
        [
            f"| RAW4D 重复基础列 + normals | {format_bytes(raw['redundant_legacy_base_and_normals'])} | 0（不重复保存） | — |",
            f"| Metadata + ZIP/file headers | — | {format_bytes(compressed['metadata_container'])} | — |",
            "",
            "`sh0.webp` 同时承载 DC 基础值与 opacity 基础值，因此二者合并统计，避免人为拆分共享 WebP 字节。",
        ]
    )
    if "timing" in report:
        encode = report["timing"]["encode"]
        lines.extend(
            [
                "",
                "## 实测耗时",
                "",
                f"- Encode total: {encode['total']:.3f} s（SOG {encode['sog']:.3f} s; temporal WebP {encode['temporal']:.3f} s）.",
                f"- Independent decode: {report['timing']['decode_seconds']:.3f} s.",
            ]
        )
    lines.extend(["", "## 独立解码残差", ""])
    residuals = report["residuals"]
    rows = [
        ("Position component (world)", residuals["position_components_world"], "mae", "rmse", "max"),
        ("Position L2 (world)", residuals["position_l2_world"], "mean", "rmse", "max"),
        ("Rotation geodesic (deg)", residuals["rotation_geodesic"], "mean_degrees", "rmse_degrees", "max_degrees"),
        ("DC coefficient", residuals["dc_coefficients"], "mae", "rmse", "max"),
        ("Log-scale", residuals["scale_log_domain"], "mae", "rmse", "max"),
        ("Opacity alpha", residuals["opacity_alpha"], "mae", "rmse", "max"),
        ("SH rest coefficient", residuals["sh_rest_coefficients"], "mae", "rmse", "max"),
        ("Lifetime (frames)", residuals["lifetime_frames"], "mae", "rmse", "max"),
    ]
    lines.extend(["| 参数域 | Mean/MAE | RMSE | Max |", "|---|---:|---:|---:|"])
    for label, values, mean_key, rmse_key, max_key in rows:
        lines.append(f"| {label} | {values[mean_key]:.8g} | {values[rmse_key]:.8g} | {values[max_key]:.8g} |")
    if "render_validation" in report:
        render = report["render_validation"]
        quality = render["quality"]
        lines.extend(
            [
                "",
                "## CUDA 渲染验证",
                "",
                f"- {render['renderer']} / {render['device']}; {render['resolution'][0]}x{render['resolution'][1]}.",
                f"- {render['image_count']} 对图（{len(render['camera_indices'])} 相机 x {len(render['frames'])} 帧）; 总耗时 {render['total_seconds']:.3f} s.",
                f"- 全图 PSNR: mean **{quality['mean_render_psnr_db']:.3f} dB**, min **{quality['minimum_render_psnr_db']:.3f} dB**.",
                f"- 前景 PSNR: mean **{quality['mean_foreground_psnr_db']:.3f} dB**, min **{quality['minimum_foreground_psnr_db']:.3f} dB**.",
                f"- Mean SSIM: **{quality['mean_render_ssim']:.6f}**.",
                "",
                "| Frame | Mean PSNR | Min PSNR | Mean foreground PSNR | Min foreground PSNR | Mean SSIM |",
                "|---:|---:|---:|---:|---:|---:|",
            ]
        )
        for frame, values in render["per_frame"].items():
            lines.append(
                f"| {frame} | {values['mean_render_psnr_db']:.3f} | {values['minimum_render_psnr_db']:.3f} | "
                f"{values['mean_foreground_psnr_db']:.3f} | {values['minimum_foreground_psnr_db']:.3f} | "
                f"{values['mean_render_ssim']:.6f} |"
            )
    lines.extend(
        [
            "",
            "## 格式边界",
            "",
            "论文 v1 定义的是可扩展表示格式，并未公开作者编码器或固定 `.tsog` 二进制规范。本产物使用 ZIP bundle、SOG v2 基础层和论文顶层 `timeline` / `temporal` 结构；库存 PlayCanvas 能读取其中的静态 SOG 图，但动态播放仍需 TSOG 扩展解析器。`tools/raw4d_codec/tsog.py` 是本产物的独立参考解码器。",
            "",
            (
                "渲染指标来自该 `.tsog` 的独立解码 RAW4D，而不是编码器内存值。"
                if "render_validation" in report
                else "本表仅证明参数码流与独立解码残差；渲染 PSNR/SSIM 必须以从该 `.tsog` 解码出的 RAW4D 另行实测，不能由参数误差替代。"
            ),
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def inspect_archive(path: Path) -> dict[str, Any]:
    files = read_zip_files(path)
    meta = json.loads(files["meta.json"])
    entries, groups = archive_parameter_sizes(path)
    return {
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "profile": meta.get("tsog", {}).get("profile"),
        "count": meta.get("count"),
        "total_frames": meta.get("tsog", {}).get("total_frames"),
        "keyframes": {name: value.get("frames") for name, value in meta.get("temporal", {}).items()},
        "groups": groups,
        "entries": entries,
    }


def attach_render_validation(report: dict[str, Any], summary: dict[str, Any], summary_path: Path) -> dict[str, Any]:
    per_image = summary["quality"]["per_image"]
    per_frame: dict[str, dict[str, float]] = {}
    for frame in summary["frames"]:
        selected = [item for item in per_image if int(item["frame"]) == int(frame)]
        per_frame[str(frame)] = {
            "mean_render_psnr_db": float(np.mean([item["render_psnr_db"] for item in selected])),
            "minimum_render_psnr_db": float(np.min([item["render_psnr_db"] for item in selected])),
            "mean_foreground_psnr_db": float(np.mean([item["foreground_psnr_db"] for item in selected])),
            "minimum_foreground_psnr_db": float(np.min([item["foreground_psnr_db"] for item in selected])),
            "mean_render_ssim": float(np.mean([item["render_ssim"] for item in selected])),
        }
    worst = min(per_image, key=lambda item: item["render_psnr_db"])
    report["render_validation"] = {
        "summary_path": str(summary_path),
        "renderer": summary["renderer"],
        "device": summary["device"],
        "resolution": summary["resolution"],
        "frames": summary["frames"],
        "camera_indices": summary["camera_indices"],
        "image_count": summary["quality"]["image_count"],
        "total_seconds": summary["total_seconds"],
        "quality": {name: value for name, value in summary["quality"].items() if name != "per_image"},
        "per_frame": per_frame,
        "worst_full_image": worst,
    }
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    encode = subparsers.add_parser("encode", help="encode RAW4D to a TSOG bundle")
    encode.add_argument("source", type=Path)
    encode.add_argument("output", type=Path)
    encode.add_argument("--transform-command", default=DEFAULT_TRANSFORM_COMMAND)
    encode.add_argument("--sh-iterations", type=int, default=10)
    encode.add_argument("--max-workers", type=int, default=4)
    encode.add_argument("--gpu", default=None)

    decode = subparsers.add_parser("decode", help="decode TSOG to a standalone RAW4D")
    decode.add_argument("input", type=Path)
    decode.add_argument("output", type=Path)

    inspect = subparsers.add_parser("inspect", help="inspect TSOG metadata and parameter bytes")
    inspect.add_argument("input", type=Path)

    analyze = subparsers.add_parser("analyze", help="compare a decoded RAW4D with its source")
    analyze.add_argument("reference", type=Path)
    analyze.add_argument("tsog", type=Path)
    analyze.add_argument("decoded", type=Path)
    analyze.add_argument("report_json", type=Path)
    analyze.add_argument("--report-markdown", type=Path)

    benchmark = subparsers.add_parser("benchmark", help="encode, decode, and write measured reports")
    benchmark.add_argument("source", type=Path)
    benchmark.add_argument("tsog", type=Path)
    benchmark.add_argument("decoded", type=Path)
    benchmark.add_argument("report_json", type=Path)
    benchmark.add_argument("--report-markdown", type=Path)
    benchmark.add_argument("--transform-command", default=DEFAULT_TRANSFORM_COMMAND)
    benchmark.add_argument("--sh-iterations", type=int, default=10)
    benchmark.add_argument("--max-workers", type=int, default=4)
    benchmark.add_argument("--gpu", default=None)

    attach = subparsers.add_parser("attach-render", help="attach an offline-render summary to a measured report")
    attach.add_argument("report_json", type=Path)
    attach.add_argument("render_summary", type=Path)
    attach.add_argument("--report-markdown", type=Path)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "encode":
        result = encode_archive(
            args.source, args.output, args.transform_command, args.sh_iterations, args.max_workers, args.gpu
        )
    elif args.command == "decode":
        result = decode_archive(args.input, args.output)
    elif args.command == "inspect":
        result = inspect_archive(args.input)
    elif args.command == "analyze":
        result = analyze_archive(args.reference, args.tsog, args.decoded)
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        if args.report_markdown:
            write_markdown_report(result, args.report_markdown)
    elif args.command == "benchmark":
        encode_result = encode_archive(
            args.source, args.tsog, args.transform_command, args.sh_iterations, args.max_workers, args.gpu
        )
        decode_result = decode_archive(args.tsog, args.decoded)
        result = analyze_archive(args.source, args.tsog, args.decoded)
        result["timing"] = {"encode": encode_result["seconds"], "decode_seconds": decode_result["seconds"]}
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        if args.report_markdown:
            write_markdown_report(result, args.report_markdown)
    elif args.command == "attach-render":
        result = json.loads(args.report_json.read_text(encoding="utf-8"))
        summary = json.loads(args.render_summary.read_text(encoding="utf-8"))
        attach_render_validation(result, summary, args.render_summary)
        args.report_json.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        if args.report_markdown:
            write_markdown_report(result, args.report_markdown)
    else:
        raise AssertionError(args.command)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
