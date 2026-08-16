#!/usr/bin/env python3
"""VisualRate39: offline-first 4CGS codec with tiered AV1 position tracks."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np

import quality_attrs
from codec import (
    StreamPayload,
    compress_stream,
    read_container,
)
from compact40 import (
    add_vq_stream,
    decode as decode_compact,
    decode_vq_stream,
    encode as encode_compact,
    pack_bits,
    unpack_bits,
)
from video_motion_tier_probe import encode_lossless_gray, padded_plane_height


PROFILE_NAME = "CoRe4D-VisualRate39-TieredAV1Traj"
POSITION_BITS = 12
POSITION_COARSE_BITS = 10
POSITION_VIDEO_BITS = 10
POSITION_VIDEO_WIDTH = 576
POSITION_VIDEO_CPU_USED = 6
POSITION_TIERS = ((0.60, 1), (1.00, 4))
SCALE_BASE_CLUSTERS = 512
SCALE_RESIDUAL_LEVELS = 1
OPACITY_BLOCK_SIZE = 64
OPACITY_HIGH_FRACTION = 0.25
LIFETIME_DENOMINATOR = 2


def _run(command: list[str]) -> float:
    started = time.perf_counter()
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace")[-4000:])
    return time.perf_counter() - started


def _position_quantization(values: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    minimum = np.min(values, axis=(0, 1)).astype(np.float32)
    maximum = np.max(values, axis=(0, 1)).astype(np.float32)
    levels = np.float32((1 << POSITION_BITS) - 1)
    quantized = np.rint((values - minimum) / (maximum - minimum) * levels).astype(np.int32)
    return quantized, minimum, maximum


#WDD-gpt 2026-08-15 - 位置按渲染贡献分为无损细轨迹与4倍粗轨迹，两层分别用AV1保存绝对位移，避免时间累计漂移。
def encode_position(
    streams: list[StreamPayload],
    positions: np.ndarray,
    importance: np.ndarray,
    sample_indices: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any], np.ndarray]:
    del sample_indices
    count, keys, channels = positions.shape
    if channels != 3 or keys < 2:
        raise ValueError("VisualRate39 position track must contain at least two XYZ keys")
    quantized, minimum, maximum = _position_quantization(positions)
    coarse_levels = np.float32((1 << POSITION_COARSE_BITS) - 1)
    position_levels = np.float32((1 << POSITION_BITS) - 1)
    coarse = np.rint(
        (positions[:, 0] - minimum) / (maximum - minimum) * coarse_levels
    ).clip(0, int(coarse_levels)).astype(np.uint16)
    reconstructed_coarse = np.rint(
        coarse.astype(np.float32) / coarse_levels * position_levels
    ).astype(np.int32)
    fine = quantized[:, 0] - reconstructed_coarse
    fine_minimum = np.min(fine, axis=0).astype(np.int32)
    fine_unsigned = (fine - fine_minimum).astype(np.uint32)
    fine_bits = max(1, int(np.max(fine_unsigned)).bit_length())
    streams.append(compress_stream("position_base_fine", pack_bits(fine_unsigned, fine_bits), zstd_level))

    importance_order = np.argsort(-importance, kind="stable")
    tier_modes = np.empty(count, dtype=np.uint8)
    first = 0
    tier_indices: list[np.ndarray] = []
    for tier_index, (fraction, _) in enumerate(POSITION_TIERS):
        last = int(round(count * fraction))
        selected = np.sort(importance_order[first:last])
        tier_modes[selected] = tier_index
        tier_indices.append(selected)
        first = last
    streams.append(compress_stream("position_tier_modes", pack_bits(tier_modes, 1), zstd_level))

    reconstructed = np.empty_like(quantized)
    reconstructed[:, 0] = reconstructed_coarse + fine_unsigned.astype(np.int32) + fine_minimum
    tier_metadata: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="visualrate39-position-") as temp_name:
        temp = Path(temp_name)
        for tier_index, ((_, step), selected) in enumerate(zip(POSITION_TIERS, tier_indices)):
            displacement = quantized[selected, 1:] - quantized[selected, :1]
            quantized_displacement = np.rint(displacement / step).astype(np.int32)
            center = 1 << (POSITION_VIDEO_BITS - 1)
            mapped_wide = quantized_displacement + center
            mapped = np.clip(mapped_wide, 0, (1 << POSITION_VIDEO_BITS) - 1).astype(np.uint16)
            overflow = (mapped_wide - mapped.astype(np.int32)).astype("<i2")
            video_path = temp / f"tier{tier_index}.ivf"
            decoded_mapped, video_report = encode_lossless_gray(
                mapped,
                video_path,
                POSITION_VIDEO_WIDTH,
                POSITION_VIDEO_BITS,
                POSITION_VIDEO_CPU_USED,
                temp,
            )
            codec_correction = (mapped.astype(np.int32) - decoded_mapped.astype(np.int32)).astype("<i2")
            streams.append(compress_stream(f"position_tier{tier_index}_av1", video_path.read_bytes(), zstd_level, "raw"))
            streams.append(compress_stream(f"position_tier{tier_index}_overflow", overflow.tobytes(), zstd_level))
            streams.append(compress_stream(
                f"position_tier{tier_index}_codec_correction",
                codec_correction.tobytes(),
                zstd_level,
            ))
            reconstructed[selected, 1:] = (
                reconstructed[selected, :1]
                + (
                    decoded_mapped.astype(np.int32)
                    + codec_correction.astype(np.int32)
                    + overflow.astype(np.int32)
                    - center
                ) * step
            )
            tier_metadata.append({
                "tier": tier_index,
                "count": int(selected.size),
                "step": step,
                "video_bytes": int(video_report["bytes"]),
                "encode_seconds": float(video_report["encode_seconds"]),
                "decode_seconds_during_encode": float(video_report["decode_seconds"]),
                "overflow_count": int(np.count_nonzero(overflow)),
                "codec_correction_count": int(np.count_nonzero(codec_correction)),
            })

    decoded_positions = minimum + reconstructed.astype(np.float32) / position_levels * (maximum - minimum)
    base_10 = minimum + coarse.astype(np.float32) / coarse_levels * (maximum - minimum)
    base_adjustment = decoded_positions[:, 0] - base_10
    motion = decoded_positions[:, 1:] - decoded_positions[:, :1]
    integer_error = reconstructed - quantized
    return motion, {
        "codec": "importance-tiered-absolute-displacement-av1",
        "position_bits": POSITION_BITS,
        "coarse_bits": POSITION_COARSE_BITS,
        "minimum": minimum.tolist(),
        "maximum": maximum.tolist(),
        "video_bits": POSITION_VIDEO_BITS,
        "video_width": POSITION_VIDEO_WIDTH,
        "fine_bits": fine_bits,
        "fine_minimum": fine_minimum.tolist(),
        "tier_mode_bits": 1,
        "tiers": tier_metadata,
        "integer_rmse": float(np.sqrt(np.mean(np.square(integer_error), dtype=np.float64))),
        "integer_maximum": int(np.max(np.abs(integer_error))),
    }, base_adjustment


def _decode_av1_luma(payload: bytes, count: int, frames: int, bits: int, width: int) -> tuple[np.ndarray, float]:
    #WDD-gpt 2026-08-15 - 解码端复用编码端偶数I420高度规则，保证任意Gaussian数量的时间帧闭环。
    height = padded_plane_height(count, width, 3)
    luma_samples = 3 * height * width
    chroma_samples = (3 * height // 2) * (width // 2)
    with tempfile.TemporaryDirectory(prefix="visualrate39-decode-") as temp_name:
        temp = Path(temp_name)
        video_path = temp / "motion.ivf"
        raw_path = temp / "motion.raw"
        video_path.write_bytes(payload)
        elapsed = _run([
            "aomdec", "--rawvideo", "--i420", f"--output-bit-depth={bits}",
            "-o", str(raw_path), str(video_path),
        ])
        decoded_frames = np.fromfile(raw_path, dtype="<u2").reshape(
            frames, luma_samples + 2 * chroma_samples
        )
    decoded_luma = decoded_frames[:, :luma_samples].reshape(frames, 3, height * width)
    return decoded_luma[:, :, :count].transpose(2, 0, 1).astype(np.int32), elapsed


def decode_position(
    streams: dict[str, bytes],
    metadata: dict[str, Any],
    count: int,
    keys: int,
    base: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    fine = unpack_bits(
        streams["position_base_fine"],
        count * 3,
        int(metadata["fine_bits"]),
    ).reshape(count, 3).astype(np.int32)
    fine += np.asarray(metadata["fine_minimum"], dtype=np.int32)
    position_levels = np.float32((1 << int(metadata["position_bits"])) - 1)
    coarse_levels = np.float32((1 << int(metadata["coarse_bits"])) - 1)
    minimum = np.asarray(metadata["minimum"], dtype=np.float32)
    maximum = np.asarray(metadata["maximum"], dtype=np.float32)
    coarse = np.rint((base - minimum) / (maximum - minimum) * coarse_levels).astype(np.int32)
    quantized_base = np.rint(coarse.astype(np.float32) / coarse_levels * position_levels).astype(np.int32) + fine
    quantized = np.empty((count, keys, 3), dtype=np.int32)
    quantized[:, 0] = quantized_base
    tier_modes = unpack_bits(streams["position_tier_modes"], count, int(metadata["tier_mode_bits"]))
    decode_seconds = 0.0
    for tier in metadata["tiers"]:
        tier_index = int(tier["tier"])
        selected = np.flatnonzero(tier_modes == tier_index)
        if selected.size != int(tier["count"]):
            raise ValueError("Position tier count mismatch")
        mapped, elapsed = _decode_av1_luma(
            streams[f"position_tier{tier_index}_av1"],
            int(selected.size),
            keys - 1,
            int(metadata["video_bits"]),
            int(metadata["video_width"]),
        )
        decode_seconds += elapsed
        shape = (selected.size, keys - 1, 3)
        overflow = np.frombuffer(streams[f"position_tier{tier_index}_overflow"], dtype="<i2").reshape(shape)
        correction = np.frombuffer(
            streams[f"position_tier{tier_index}_codec_correction"], dtype="<i2"
        ).reshape(shape)
        displacement = (
            mapped + overflow.astype(np.int32) + correction.astype(np.int32)
            - (1 << (int(metadata["video_bits"]) - 1))
        ) * int(tier["step"])
        quantized[selected, 1:] = quantized_base[selected, None, :] + displacement
    decoded = minimum + quantized.astype(np.float32) / position_levels * (maximum - minimum)
    metadata["measured_av1_decode_seconds"] = decode_seconds
    return decoded[:, 1:] - decoded[:, :1], decoded[:, 0] - base


#WDD-gpt 2026-08-15 - 尺度在log域先做三轴时间PQ，再用一层全轨迹残差VQ修正共享码本无法表达的形变。
def encode_scale(
    streams: list[StreamPayload],
    scales: np.ndarray,
    importance: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    del importance
    count = scales.shape[0]
    flat = np.clip(scales, -16, 2).reshape(count, 12).astype(np.float32)
    decoded = np.empty_like(flat)
    rng = np.random.default_rng(20260815)
    sample_indices = rng.choice(count, min(count, 65536), replace=False)
    groups = ([0, 3, 6, 9], [1, 4, 7, 10], [2, 5, 8, 11])
    base_metadata: list[dict[str, Any]] = []
    for group, indices in enumerate(groups):
        reconstructed, group_meta = add_vq_stream(
            streams,
            f"visual_scale_base_{group}",
            flat[:, indices],
            SCALE_BASE_CLUSTERS,
            20260890 + group,
            sample_indices,
            zstd_level,
        )
        decoded[:, indices] = reconstructed
        group_meta["indices"] = list(indices)
        base_metadata.append(group_meta)
    residual = flat - decoded
    residual_metadata: list[dict[str, Any]] = []
    for level in range(SCALE_RESIDUAL_LEVELS):
        reconstructed, level_meta = add_vq_stream(
            streams,
            f"visual_scale_residual_{level}",
            residual,
            256,
            20260900 + level,
            sample_indices,
            zstd_level,
            reserve_zero=True,
        )
        decoded += reconstructed
        residual -= reconstructed
        residual_metadata.append(level_meta)
    relative_error = np.abs(np.expm1(decoded - flat))
    return decoded.reshape(scales.shape), {
        "codec": "log-domain-axis-pq512-plus-rvq1",
        "base_groups": base_metadata,
        "residual_levels": residual_metadata,
        "p99_relative_linear_error": float(np.percentile(relative_error, 99)),
        "maximum_relative_linear_error": float(np.max(relative_error)),
    }


def decode_scale(streams: dict[str, bytes], metadata: dict[str, Any], count: int) -> np.ndarray:
    decoded = np.empty((count, 12), dtype=np.float32)
    for group, group_meta in enumerate(metadata["base_groups"]):
        decoded[:, group_meta["indices"]] = decode_vq_stream(
            streams, group_meta, f"visual_scale_base_{group}", count
        )
    for level, level_meta in enumerate(metadata["residual_levels"]):
        decoded += decode_vq_stream(streams, level_meta, f"visual_scale_residual_{level}", count)
    return decoded.reshape(count, 4, 3)


def _alpha_to_logit(alpha: np.ndarray) -> np.ndarray:
    lower = np.float32(1 / (1 + math.exp(16)))
    upper = np.float32(1 / (1 + math.exp(-16)))
    clipped = np.clip(alpha, lower, upper)
    return np.log(clipped / (1 - clipped)).astype(np.float32)


#WDD-gpt 2026-08-15 - 透明度按连续Morton空间块分配8或9bit，块级模式代替逐点模式以降低侧信息。
def encode_opacity(
    streams: list[StreamPayload],
    opacities: np.ndarray,
    importance: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    count = opacities.shape[0]
    block_count = math.ceil(count / OPACITY_BLOCK_SIZE)
    padding = block_count * OPACITY_BLOCK_SIZE - count
    scores = np.percentile(
        np.pad(importance, (0, padding), mode="edge").reshape(block_count, OPACITY_BLOCK_SIZE),
        90,
        axis=1,
    )
    threshold = np.quantile(scores, 1 - OPACITY_HIGH_FRACTION)
    high_blocks = scores >= threshold
    high = np.repeat(high_blocks, OPACITY_BLOCK_SIZE)[:count]
    streams.append(compress_stream("opacity_high_blocks", pack_bits(high_blocks, 1), zstd_level))
    alpha = 1 / (1 + np.exp(-np.clip(np.nan_to_num(opacities, neginf=-16), -16, 16)))
    decoded_alpha = np.empty_like(alpha, dtype=np.float32)
    groups: list[dict[str, Any]] = []
    for bits, selected in ((8, ~high), (9, high)):
        levels = np.float32((1 << bits) - 1)
        quantized = np.rint(alpha[selected] * levels).clip(0, int(levels)).astype(np.uint16)
        streams.append(compress_stream(f"opacity_alpha_b{bits}", pack_bits(quantized, bits), zstd_level))
        decoded_alpha[selected] = quantized.astype(np.float32) / levels
        groups.append({"bits": bits, "count": int(np.count_nonzero(selected))})
    return _alpha_to_logit(decoded_alpha), {
        "codec": "morton-block-adaptive-alpha-8-9bit",
        "block_size": OPACITY_BLOCK_SIZE,
        "block_count": block_count,
        "high_fraction": float(np.mean(high_blocks)),
        "groups": groups,
        "mean_alpha_error": float(np.mean(np.abs(decoded_alpha - alpha))),
        "maximum_alpha_error": float(np.max(np.abs(decoded_alpha - alpha))),
    }


def decode_opacity(streams: dict[str, bytes], metadata: dict[str, Any], count: int) -> np.ndarray:
    high_blocks = unpack_bits(streams["opacity_high_blocks"], int(metadata["block_count"]), 1).astype(bool)
    high = np.repeat(high_blocks, int(metadata["block_size"]))[:count]
    alpha = np.empty((count, 4, 1), dtype=np.float32)
    for group in metadata["groups"]:
        bits = int(group["bits"])
        selected = high if bits == 9 else ~high
        selected_count = int(np.count_nonzero(selected))
        if selected_count != int(group["count"]):
            raise ValueError("Opacity group count mismatch")
        quantized = unpack_bits(streams[f"opacity_alpha_b{bits}"], selected_count * 4, bits)
        alpha[selected] = quantized.reshape(selected_count, 4, 1).astype(np.float32) / np.float32((1 << bits) - 1)
    return _alpha_to_logit(alpha)


#WDD-gpt 2026-08-15 - 生命周期单独量化起止边界到半帧精度，防止极小VQ在末帧错误关闭高斯。
def encode_lifetime(
    streams: list[StreamPayload],
    mu: np.ndarray,
    width: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    bounds = np.stack([mu - width, mu + width], axis=1)
    quantized = np.rint(bounds * LIFETIME_DENOMINATOR).astype(np.int32)
    minimum = int(np.min(quantized))
    shifted = (quantized.astype(np.int64) - minimum).astype(np.uint32)
    bits = max(1, int(np.max(shifted)).bit_length())
    streams.append(compress_stream("lifetime_boundary_q", pack_bits(shifted, bits), zstd_level))
    decoded = quantized.astype(np.float32) / np.float32(LIFETIME_DENOMINATOR)
    decoded_mu = np.mean(decoded, axis=1)
    decoded_width = (decoded[:, 1] - decoded[:, 0]) * np.float32(0.5)
    return decoded_mu, decoded_width, {
        "codec": "fixed-step-start-end-boundaries",
        "denominator": LIFETIME_DENOMINATOR,
        "bits": bits,
        "minimum_quantized": minimum,
        "mean_boundary_error": float(np.mean(np.abs(decoded - bounds))),
        "maximum_boundary_error": float(np.max(np.abs(decoded - bounds))),
    }


def decode_lifetime(streams: dict[str, bytes], metadata: dict[str, Any], count: int) -> tuple[np.ndarray, np.ndarray]:
    shifted = unpack_bits(streams["lifetime_boundary_q"], count * 2, int(metadata["bits"]))
    quantized = shifted.reshape(count, 2).astype(np.int64) + int(metadata["minimum_quantized"])
    bounds = quantized.astype(np.float32) / np.float32(metadata["denominator"])
    return np.mean(bounds, axis=1), (bounds[:, 1] - bounds[:, 0]) * np.float32(0.5)


def _stream_category(name: str) -> str:
    if name.startswith("position_"):
        return "position"
    if name.startswith("rotation_"):
        return "rotation"
    if name.startswith("color_"):
        return "color_dc"
    if name.startswith("visual_scale_"):
        return "scale"
    if name.startswith("opacity_"):
        return "opacity"
    if name.startswith("lifetime_"):
        return "lifetime"
    if name == "coresh5r":
        return "sh"
    return "other"


def _add_actual_stream_sizes(result: dict[str, Any], output: Path) -> None:
    manifest, _ = read_container(output)
    by_attribute: dict[str, int] = {}
    for stream in manifest["streams"]:
        category = _stream_category(stream["name"])
        by_attribute[category] = by_attribute.get(category, 0) + int(stream["stored_bytes"])
    result["actual_stored_bytes_by_attribute"] = by_attribute
    result["container_overhead_bytes"] = output.stat().st_size - sum(by_attribute.values())


def encode(source: Path, output: Path, sh_source: Path, zstd_level: int) -> dict[str, Any]:
    if sh_source.suffix.lower() == ".4cgs":
        _, existing_streams = read_container(sh_source)
        sh_payload = existing_streams["coresh5r"]
        with tempfile.TemporaryDirectory(prefix="visualrate39-sh-") as temp_name:
            sh_path = Path(temp_name) / "coresh5r.rvq"
            sh_path.write_bytes(sh_payload)
            result = _encode_with_sh(source, output, sh_path, zstd_level)
    else:
        result = _encode_with_sh(source, output, sh_source, zstd_level)
    _add_actual_stream_sizes(result, output)
    return result


def _encode_with_sh(source: Path, output: Path, sh_path: Path, zstd_level: int) -> dict[str, Any]:
    previous_rotation_bits = quality_attrs.ROTATION_BITS
    previous_color_bits = quality_attrs.COLOR_MODE_BITS
    try:
        quality_attrs.ROTATION_BITS = (5, 6, 7, 9)
        quality_attrs.COLOR_MODE_BITS = ((4, 3, 3), (5, 4, 4), (6, 5, 5))
        return encode_compact(
            source,
            output,
            sh_path,
            zstd_level,
            profile_name=PROFILE_NAME,
            position_encoder=encode_position,
            rotation_encoder=quality_attrs.encode_rotation,
            color_encoder=quality_attrs.encode_color,
            scale_encoder=encode_scale,
            opacity_encoder=encode_opacity,
            lifetime_encoder=encode_lifetime,
        )
    finally:
        quality_attrs.ROTATION_BITS = previous_rotation_bits
        quality_attrs.COLOR_MODE_BITS = previous_color_bits


def decode(source: Path, output: Path) -> dict[str, Any]:
    result = decode_compact(
        source,
        output,
        profile_name=PROFILE_NAME,
        position_decoder=decode_position,
        rotation_decoder=quality_attrs.decode_rotation,
        color_decoder=quality_attrs.decode_color,
        scale_decoder=decode_scale,
        opacity_decoder=decode_opacity,
        lifetime_decoder=decode_lifetime,
    )
    manifest, _ = read_container(source)
    result["container_bytes"] = source.stat().st_size
    result["compression_ratio_vs_source_raw4d"] = int(manifest["source_bytes"]) / source.stat().st_size
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="VisualRate39 4CGS codec: tiered AV1 trajectories plus attribute-specific quantizers"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    encoder = subparsers.add_parser("encode")
    encoder.add_argument("source", type=Path)
    encoder.add_argument("output", type=Path)
    encoder.add_argument("--reuse-sh", type=Path, required=True, help="CoReSH-5R payload or existing .4cgs")
    encoder.add_argument("--zstd-level", type=int, default=8)
    decoder = subparsers.add_parser("decode")
    decoder.add_argument("source", type=Path)
    decoder.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.command == "encode":
        if args.output.suffix.lower() != ".4cgs":
            raise ValueError("Output must use the .4cgs suffix")
        result = encode(args.source, args.output, args.reuse_sh, args.zstd_level)
    else:
        result = decode(args.source, args.output)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
