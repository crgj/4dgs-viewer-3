#!/usr/bin/env python3
"""Encode one 11-key RAW4D window with MINT/SANT-inspired residual VQ streams."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path
from typing import Any

import numpy as np

import motion_grid
from codec import (
    C0,
    compress_stream,
    encode_sh_rvq5,
    extract_track,
    load_rows,
    property_indices,
    read_container,
    read_raw4d_layout,
)
from compact40 import (
    assign_codebook,
    decode as decode_compact,
    encode as encode_compact,
    morton_codes,
    train_codebook,
)
from mint_like_nonsh35 import (
    alpha_to_logit,
    canonical_quaternions,
    decode_rotation_features,
    encode_rotation_features,
    stable_sigmoid,
)


#WDD-gpt  2026-08-15 - 将11个XYZ关键帧作为一个连续时间窗口，以分属性残差VQ和可校验Zstd外层生成完整独立码流。
PROFILE_NAME = "MINT-LIKE-SINGLE-WINDOW-RVQ-SANT-ZSTD"
SOURCE_POSITION_KEYS = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30]
WINDOW_FRAMES = list(range(11))
RVQ_LEVELS = {
    "rotation": 5,
    "color_dc": 5,
    "scale": 6,
    "opacity": 4,
    "lifetime": 3,
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _window_position_encoder(
    streams: list[Any],
    positions: np.ndarray,
    importance: np.ndarray,
    sample_indices: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any], np.ndarray]:
    motion, metadata, adjustment = motion_grid._encode_position(
        streams,
        positions,
        importance,
        sample_indices,
        zstd_level,
    )
    metadata["temporal_window"] = {
        "window_index": 0,
        "stored_frame_count": len(WINDOW_FRAMES),
        "continuous_window_frames": WINDOW_FRAMES,
        "source_keyframes": SOURCE_POSITION_KEYS,
        "interpretation": "the 11 stored keys are consecutive descriptors inside one window",
        "trajectory_dimensions": 30,
        "cross_window_identity": False,
    }
    return motion, metadata, adjustment


def _normalize(values: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    values = np.asarray(values, dtype=np.float32)
    center = np.median(values, axis=0).astype(np.float32)
    spread = np.percentile(np.abs(values - center), 95, axis=0).astype(np.float32)
    spread = np.maximum(spread, np.float32(1e-6))
    return ((values - center) / spread).astype(np.float32), center, spread


def _encode_rvq(
    streams: list[Any],
    name: str,
    values: np.ndarray,
    levels: int,
    sample_indices: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    normalized, center, spread = _normalize(values)
    residual = normalized.copy()
    decoded = np.zeros_like(normalized)
    codebooks = np.empty((levels, 256, normalized.shape[1]), dtype=np.float32)
    labels = np.empty((normalized.shape[0], levels), dtype=np.uint8)
    per_level: list[dict[str, float]] = []
    for level in range(levels):
        codebook, _ = train_codebook(
            residual,
            256,
            20261100 + sum(name.encode("utf-8")) + level,
            sample_indices,
            reserve_zero=True,
        )
        codebook = codebook.astype(np.float16).astype(np.float32)
        assigned = assign_codebook(residual, codebook).astype(np.uint8)
        stage = codebook[assigned]
        decoded += stage
        residual -= stage
        codebooks[level] = codebook
        labels[:, level] = assigned
        per_level.append({
            "level": level + 1,
            "normalized_rmse": float(np.sqrt(np.mean(np.square(residual), dtype=np.float64))),
            "zero_label_fraction": float(np.mean(assigned == 0)),
        })
        print(json.dumps({"attribute": name, **per_level[-1]}), flush=True)
    streams.append(compress_stream(
        f"mint_{name}_codebooks",
        codebooks.astype("<f2").tobytes(),
        zstd_level,
    ))
    streams.append(compress_stream(
        f"mint_{name}_labels",
        labels.tobytes(),
        zstd_level,
    ))
    reconstructed = decoded * spread + center
    difference = reconstructed - values
    return reconstructed.astype(np.float32), {
        "codec": "additive-residual-vector-quantization",
        "clusters": 256,
        "levels": levels,
        "dimensions": int(values.shape[1]),
        "codebook_shape": list(codebooks.shape),
        "center": center.tolist(),
        "spread": spread.tolist(),
        "per_level": per_level,
        "rmse": float(np.sqrt(np.mean(np.square(difference), dtype=np.float64))),
        "mae": float(np.mean(np.abs(difference))),
        "maximum_absolute_error": float(np.max(np.abs(difference))),
    }


def _decode_rvq(
    streams: dict[str, bytes],
    metadata: dict[str, Any],
    name: str,
    count: int,
) -> np.ndarray:
    levels = int(metadata["levels"])
    codebooks = np.frombuffer(streams[f"mint_{name}_codebooks"], dtype="<f2").astype(np.float32)
    codebooks = codebooks.reshape(metadata["codebook_shape"])
    labels = np.frombuffer(streams[f"mint_{name}_labels"], dtype=np.uint8).reshape(count, levels)
    normalized = codebooks[np.arange(levels)[None, :], labels].sum(axis=1, dtype=np.float32)
    center = np.asarray(metadata["center"], dtype=np.float32)
    spread = np.asarray(metadata["spread"], dtype=np.float32)
    return normalized * spread + center


def encode_rotation(
    streams: list[Any],
    rotations: np.ndarray,
    scales: np.ndarray,
    opacities: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    del scales, opacities
    count = rotations.shape[0]
    rng = np.random.default_rng(20261101)
    sample = rng.choice(count, min(count, 65536), replace=False)
    features = encode_rotation_features(rotations)
    decoded_features, metadata = _encode_rvq(
        streams, "rotation", features, RVQ_LEVELS["rotation"], sample, zstd_level
    )
    decoded = decode_rotation_features(decoded_features)
    dot = np.abs(np.sum(canonical_quaternions(rotations) * decoded, axis=2)).clip(0, 1)
    angular = np.degrees(2 * np.arccos(dot))
    metadata.update({
        "representation": "first quaternion log plus relative quaternion log",
        "mean_angular_error_degrees": float(np.mean(angular)),
        "p99_angular_error_degrees": float(np.percentile(angular, 99)),
        "maximum_angular_error_degrees": float(np.max(angular)),
    })
    return decoded, metadata


def decode_rotation(streams: dict[str, bytes], metadata: dict[str, Any], count: int) -> np.ndarray:
    return decode_rotation_features(_decode_rvq(streams, metadata, "rotation", count))


def encode_color(
    streams: list[Any],
    colors: np.ndarray,
    importance: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    del importance
    count = colors.shape[0]
    rng = np.random.default_rng(20261102)
    sample = rng.choice(count, min(count, 65536), replace=False)
    flat = colors.reshape(count, -1).astype(np.float32)
    decoded_flat, metadata = _encode_rvq(
        streams, "color_dc", flat, RVQ_LEVELS["color_dc"], sample, zstd_level
    )
    decoded = decoded_flat.reshape(colors.shape)
    rgb_error = np.abs(decoded - colors) * np.float32(C0)
    metadata.update({
        "representation": "two-key DC trajectory",
        "mean_render_rgb_error": float(np.mean(rgb_error)),
        "p99_render_rgb_error": float(np.percentile(rgb_error, 99)),
        "maximum_render_rgb_error": float(np.max(rgb_error)),
    })
    return decoded, metadata


def decode_color(streams: dict[str, bytes], metadata: dict[str, Any], count: int) -> np.ndarray:
    return _decode_rvq(streams, metadata, "color_dc", count).reshape(count, 2, 3)


def encode_scale(
    streams: list[Any],
    scales: np.ndarray,
    importance: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    del importance
    count = scales.shape[0]
    source = np.clip(np.nan_to_num(scales, neginf=-16, posinf=2), -16, 2).reshape(count, -1)
    rng = np.random.default_rng(20261103)
    sample = rng.choice(count, min(count, 65536), replace=False)
    decoded_flat, metadata = _encode_rvq(
        streams, "scale", source, RVQ_LEVELS["scale"], sample, zstd_level
    )
    decoded = decoded_flat.reshape(scales.shape)
    relative = np.abs(np.expm1(decoded - source.reshape(scales.shape)))
    metadata.update({
        "representation": "four-key log-scale trajectory",
        "mean_relative_linear_error": float(np.mean(relative)),
        "p99_relative_linear_error": float(np.percentile(relative, 99)),
        "maximum_relative_linear_error": float(np.max(relative)),
    })
    return decoded, metadata


def decode_scale(streams: dict[str, bytes], metadata: dict[str, Any], count: int) -> np.ndarray:
    return _decode_rvq(streams, metadata, "scale", count).reshape(count, 4, 3)


def encode_opacity(
    streams: list[Any],
    opacities: np.ndarray,
    importance: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    del importance
    count = opacities.shape[0]
    source_alpha = stable_sigmoid(np.nan_to_num(opacities, neginf=-16, posinf=16)).reshape(count, -1)
    rng = np.random.default_rng(20261104)
    sample = rng.choice(count, min(count, 65536), replace=False)
    decoded_alpha, metadata = _encode_rvq(
        streams, "opacity", source_alpha, RVQ_LEVELS["opacity"], sample, zstd_level
    )
    decoded_alpha = np.clip(decoded_alpha, 0, 1)
    error = np.abs(decoded_alpha - source_alpha)
    metadata.update({
        "representation": "four-key alpha trajectory",
        "mean_alpha_error": float(np.mean(error)),
        "p99_alpha_error": float(np.percentile(error, 99)),
        "maximum_alpha_error": float(np.max(error)),
    })
    return alpha_to_logit(decoded_alpha).reshape(opacities.shape), metadata


def decode_opacity(streams: dict[str, bytes], metadata: dict[str, Any], count: int) -> np.ndarray:
    alpha = np.clip(_decode_rvq(streams, metadata, "opacity", count), 0, 1)
    return alpha_to_logit(alpha).reshape(count, 4, 1)


def encode_lifetime(
    streams: list[Any],
    mu: np.ndarray,
    width: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    count = mu.shape[0]
    bounds = np.stack([mu - width, mu + width], axis=1).astype(np.float32)
    rng = np.random.default_rng(20261105)
    sample = rng.choice(count, min(count, 65536), replace=False)
    decoded, metadata = _encode_rvq(
        streams, "lifetime", bounds, RVQ_LEVELS["lifetime"], sample, zstd_level
    )
    error = np.abs(decoded - bounds)
    metadata.update({
        "representation": "lifetime start and end",
        "mean_bound_error": float(np.mean(error)),
        "p99_bound_error": float(np.percentile(error, 99)),
        "maximum_bound_error": float(np.max(error)),
    })
    return np.mean(decoded, axis=1), (decoded[:, 1] - decoded[:, 0]) * np.float32(0.5), metadata


def decode_lifetime(
    streams: dict[str, bytes],
    metadata: dict[str, Any],
    count: int,
) -> tuple[np.ndarray, np.ndarray]:
    bounds = _decode_rvq(streams, metadata, "lifetime", count)
    return np.mean(bounds, axis=1), (bounds[:, 1] - bounds[:, 0]) * np.float32(0.5)


def train_sh_stream(source: Path, output: Path) -> dict[str, Any]:
    started = time.perf_counter()
    layout = read_raw4d_layout(source)
    rows = load_rows(layout)
    sh = np.asarray(
        rows[:, property_indices(layout, [f"f_rest_{index}" for index in range(45)])],
        dtype=np.float32,
    )
    payload = encode_sh_rvq5(sh)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(payload)
    return {
        "path": str(output),
        "bytes": output.stat().st_size,
        "seconds": time.perf_counter() - started,
        "sha256": sha256_file(output),
    }


def encode(source: Path, output: Path, sh_stream: Path, zstd_level: int) -> dict[str, Any]:
    return encode_compact(
        source,
        output,
        sh_stream,
        zstd_level,
        profile_name=PROFILE_NAME,
        position_encoder=_window_position_encoder,
        rotation_encoder=encode_rotation,
        color_encoder=encode_color,
        scale_encoder=encode_scale,
        opacity_encoder=encode_opacity,
        lifetime_encoder=encode_lifetime,
        codec_metadata={
            "official_mint_sant_compatible": False,
            "reason": "Braindance encoder and complete SANT descriptor schema are private",
            "inner_codec": "separate residual-vector-quantized attribute descriptors",
            "outer_codec": "verified 4CGS v2 streams with Zstandard payloads",
            "window_count": 1,
            "window_stored_frames": len(WINDOW_FRAMES),
            "window_frames": WINDOW_FRAMES,
            "source_keyframes": SOURCE_POSITION_KEYS,
        },
    )


def decode(source: Path, output: Path) -> dict[str, Any]:
    return decode_compact(
        source,
        output,
        profile_name=PROFILE_NAME,
        position_decoder=motion_grid._decode_position,
        rotation_decoder=decode_rotation,
        color_decoder=decode_color,
        scale_decoder=decode_scale,
        opacity_decoder=decode_opacity,
        lifetime_decoder=decode_lifetime,
    )


def _source_order(source: Path) -> tuple[Any, np.ndarray, np.ndarray]:
    layout = read_raw4d_layout(source)
    rows = load_rows(layout)
    positions, frames = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    if frames != SOURCE_POSITION_KEYS:
        raise ValueError(f"Expected one 11-key window, found {frames}")
    minimum = np.min(positions, axis=(0, 1)).astype(np.float32)
    maximum = np.max(positions, axis=(0, 1)).astype(np.float32)
    scale = (maximum - minimum) / np.float32(1023)
    q0 = np.rint((positions[:, 0] - minimum) / scale).clip(0, 1023).astype(np.uint16)
    order = np.argsort(morton_codes(q0), kind="stable")
    return layout, rows, order


def evaluate(source: Path, decoded_path: Path) -> dict[str, Any]:
    source_layout, source_rows, order = _source_order(source)
    decoded_layout = read_raw4d_layout(decoded_path)
    decoded_rows = load_rows(decoded_layout)
    metrics: dict[str, Any] = {}

    source_position, _ = extract_track(source_rows, source_layout, "xyz_bank", ("x", "y", "z"))
    decoded_position, _ = extract_track(decoded_rows, decoded_layout, "xyz_bank", ("x", "y", "z"))
    position_error = np.linalg.norm(decoded_position - source_position[order], axis=2)
    metrics["position_vector"] = {
        "mean": float(np.mean(position_error)),
        "p99": float(np.percentile(position_error, 99)),
        "maximum": float(np.max(position_error)),
    }

    source_rotation, _ = extract_track(source_rows, source_layout, "rot_bank", ("w", "x", "y", "z"))
    decoded_rotation, _ = extract_track(decoded_rows, decoded_layout, "rot_bank", ("w", "x", "y", "z"))
    dot = np.abs(np.sum(
        canonical_quaternions(source_rotation[order]) * canonical_quaternions(decoded_rotation),
        axis=2,
    )).clip(0, 1)
    angular = np.degrees(2 * np.arccos(dot))
    metrics["rotation_angular_degrees"] = {
        "mean": float(np.mean(angular)),
        "p99": float(np.percentile(angular, 99)),
        "maximum": float(np.max(angular)),
    }

    source_color, _ = extract_track(source_rows, source_layout, "f_dc_bank", ("0", "1", "2"))
    decoded_color, _ = extract_track(decoded_rows, decoded_layout, "f_dc_bank", ("0", "1", "2"))
    color_error = np.abs(decoded_color - source_color[order]) * np.float32(C0)
    metrics["color_render_rgb"] = {
        "mean": float(np.mean(color_error)),
        "p99": float(np.percentile(color_error, 99)),
        "maximum": float(np.max(color_error)),
    }

    source_scale, _ = extract_track(source_rows, source_layout, "scale_bank", ("0", "1", "2"))
    decoded_scale, _ = extract_track(decoded_rows, decoded_layout, "scale_bank", ("0", "1", "2"))
    clipped_scale = np.clip(np.nan_to_num(source_scale[order], neginf=-16, posinf=2), -16, 2)
    scale_error = np.abs(np.expm1(decoded_scale - clipped_scale))
    metrics["scale_relative_linear"] = {
        "mean": float(np.mean(scale_error)),
        "p99": float(np.percentile(scale_error, 99)),
        "maximum": float(np.max(scale_error)),
    }

    source_opacity, _ = extract_track(source_rows, source_layout, "opacity_bank", ("",))
    decoded_opacity, _ = extract_track(decoded_rows, decoded_layout, "opacity_bank", ("",))
    alpha_error = np.abs(
        stable_sigmoid(decoded_opacity)
        - stable_sigmoid(np.nan_to_num(source_opacity[order], neginf=-16, posinf=16))
    )
    metrics["opacity_alpha"] = {
        "mean": float(np.mean(alpha_error)),
        "p99": float(np.percentile(alpha_error, 99)),
        "maximum": float(np.max(alpha_error)),
    }

    source_mu = np.asarray(
        source_rows[:, property_indices(source_layout, ["lifetime_mu"])[0]], dtype=np.float32
    )[order]
    source_width = np.asarray(
        source_rows[:, property_indices(source_layout, ["lifetime_w"])[0]], dtype=np.float32
    )[order]
    decoded_mu = np.asarray(
        decoded_rows[:, property_indices(decoded_layout, ["lifetime_mu"])[0]], dtype=np.float32
    )
    decoded_width = np.asarray(
        decoded_rows[:, property_indices(decoded_layout, ["lifetime_w"])[0]], dtype=np.float32
    )
    lifetime_error = np.abs(
        np.stack([decoded_mu - decoded_width, decoded_mu + decoded_width], axis=1)
        - np.stack([source_mu - source_width, source_mu + source_width], axis=1)
    )
    metrics["lifetime_bounds"] = {
        "mean": float(np.mean(lifetime_error)),
        "p99": float(np.percentile(lifetime_error, 99)),
        "maximum": float(np.max(lifetime_error)),
    }

    sh_names = [f"f_rest_{index}" for index in range(45)]
    source_sh = np.asarray(source_rows[:, property_indices(source_layout, sh_names)], dtype=np.float32)[order]
    decoded_sh = np.asarray(decoded_rows[:, property_indices(decoded_layout, sh_names)], dtype=np.float32)
    sh_error = np.abs(decoded_sh - source_sh)
    metrics["sh_absolute"] = {
        "mean": float(np.mean(sh_error)),
        "rmse": float(np.sqrt(np.mean(np.square(decoded_sh - source_sh), dtype=np.float64))),
        "p99": float(np.percentile(sh_error, 99)),
        "maximum": float(np.max(sh_error)),
    }
    return metrics


def stream_breakdown(container: Path) -> dict[str, int]:
    manifest, _ = read_container(container)
    return {entry["name"]: int(entry["stored_bytes"]) for entry in manifest["streams"]}


def run(source: Path, output_dir: Path, zstd_level: int) -> dict[str, Any]:
    started = time.perf_counter()
    output_dir.mkdir(parents=True, exist_ok=True)
    container = output_dir / "test.single_window.mintlike.4cgs"
    sh_stream = output_dir / "test.coresh5r.bin"
    decoded = output_dir / "test.single_window.decoded.raw4d"
    sh_report = train_sh_stream(source, sh_stream)
    encode_report = encode(source, container, sh_stream, zstd_level)
    decode_report = decode(container, decoded)
    metrics = evaluate(source, decoded)
    manifest, _ = read_container(container)
    equivalent_ply_bytes = int(manifest["gaussian_count"]) * int(manifest["total_frames"]) * 59 * 4
    report = {
        "format": PROFILE_NAME,
        "official_mint_sant_compatible": False,
        "source": str(source),
        "source_encoding": read_raw4d_layout(source).scalar_encoding,
        "source_bytes": source.stat().st_size,
        "gaussian_count": int(manifest["gaussian_count"]),
        "playback_frames": int(manifest["total_frames"]),
        "temporal_window": {
            "window_count": 1,
            "stored_frame_count": 11,
            "continuous_window_frames": WINDOW_FRAMES,
            "source_keyframes": SOURCE_POSITION_KEYS,
        },
        "container": str(container),
        "container_bytes": container.stat().st_size,
        "container_sha256": sha256_file(container),
        "compression_ratio_vs_quantized_raw4d": source.stat().st_size / container.stat().st_size,
        "equivalent_float32_ply_sequence_bytes": equivalent_ply_bytes,
        "compression_ratio_vs_equivalent_ply_sequence": equivalent_ply_bytes / container.stat().st_size,
        "sh_training": sh_report,
        "encode_seconds_excluding_sh_training": float(encode_report["measured_encode_seconds"]),
        "total_encode_seconds": float(sh_report["seconds"] + encode_report["measured_encode_seconds"]),
        "decode_seconds": float(decode_report["measured_decode_seconds"]),
        "decoded_raw4d": str(decoded),
        "decoded_raw4d_bytes": decoded.stat().st_size,
        "numeric_quality": metrics,
        "stream_stored_bytes": stream_breakdown(container),
        "independent_decoder_validated": True,
        "total_wall_seconds": time.perf_counter() - started,
    }
    report_path = output_dir / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report["report"] = str(report_path)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Encode one 11-key RAW4D window with MINT/SANT-like RVQ")
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("source", type=Path)
    run_parser.add_argument("output_dir", type=Path)
    run_parser.add_argument("--zstd-level", type=int, default=8)
    decode_parser = subparsers.add_parser("decode")
    decode_parser.add_argument("source", type=Path)
    decode_parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.command == "run":
        result = run(args.source, args.output_dir, args.zstd_level)
    else:
        result = decode(args.source, args.output)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
