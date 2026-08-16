#!/usr/bin/env python3
"""Quality-bounded 4CGS profile using shared motion and bounded scalar attributes."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import numpy as np

import motion_grid
from codec import compress_stream, read_container
from compact40 import decode as decode_compact
from compact40 import encode as encode_compact
from compact40 import pack_bits, unpack_bits
from quality_attrs import decode_color, decode_rotation, encode_color, encode_rotation


#WDD-gpt 2026-08-15 - 工程质量档用9级共享运动残差和显式误差界属性，困难数据自动增加位宽或修正量。
PROFILE_NAME = "CoRe4D-SharedMotion9-Bounded39"
POSITION_RVQ_LEVELS = 9
POSITION_MAXIMUM_RATIO = 0.00018
SCALE_BLOCK_SIZE = 64
SCALE_TARGET_RELATIVE_ERROR = 0.01
SCALE_MINIMUM_BITS = 8
SCALE_MAXIMUM_BITS = 15
OPACITY_BITS = 8
LIFETIME_STEP = 1 / 128


def _encode_position(
    streams: list[Any],
    positions: np.ndarray,
    importance: np.ndarray,
    sample_indices: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any], np.ndarray]:
    previous_levels = motion_grid.RVQ_LEVELS
    previous_ratio = motion_grid.POSITION_MAXIMUM_RATIO
    motion_grid.RVQ_LEVELS = POSITION_RVQ_LEVELS
    motion_grid.POSITION_MAXIMUM_RATIO = POSITION_MAXIMUM_RATIO
    try:
        return motion_grid._encode_position(
            streams,
            positions,
            importance,
            sample_indices,
            zstd_level,
        )
    finally:
        motion_grid.RVQ_LEVELS = previous_levels
        motion_grid.POSITION_MAXIMUM_RATIO = previous_ratio


def _decode_position(
    streams: dict[str, bytes],
    metadata: dict[str, Any],
    count: int,
    keys: int,
    base: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    return motion_grid._decode_position(streams, metadata, count, keys, base)


def encode_scale(
    streams: list[Any],
    scales: np.ndarray,
    importance: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    del importance
    count = scales.shape[0]
    block_count = (count + SCALE_BLOCK_SIZE - 1) // SCALE_BLOCK_SIZE
    padding = block_count * SCALE_BLOCK_SIZE - count
    padded = np.pad(scales.astype(np.float32), ((0, padding), (0, 0), (0, 0)), mode="edge")
    blocks = padded.reshape(block_count, SCALE_BLOCK_SIZE, 4, 3)
    minimum = np.min(blocks, axis=1).astype(np.float32)
    maximum = np.max(blocks, axis=1).astype(np.float32)
    ranges = np.stack([minimum, maximum], axis=1).astype("<f4")
    maximum_span = np.max(maximum - minimum, axis=(1, 2))
    half_step_limit = np.float32(math.log1p(SCALE_TARGET_RELATIVE_ERROR))
    required_levels = np.maximum(1, np.ceil(maximum_span / (2 * half_step_limit))).astype(np.uint32)
    bits = np.ceil(np.log2(required_levels.astype(np.float64) + 1)).astype(np.uint8)
    bits = np.clip(bits, SCALE_MINIMUM_BITS, SCALE_MAXIMUM_BITS).astype(np.uint8)
    streams.append(compress_stream("scale_block_bits", bits.tobytes(), zstd_level))
    streams.append(compress_stream("scale_block_ranges", ranges.tobytes(), zstd_level))

    decoded = np.empty_like(blocks, dtype=np.float32)
    groups: list[dict[str, int]] = []
    for bit_count in range(SCALE_MINIMUM_BITS, SCALE_MAXIMUM_BITS + 1):
        selected = bits == bit_count
        selected_count = int(np.count_nonzero(selected))
        if selected_count == 0:
            continue
        low = minimum[selected, None]
        high = maximum[selected, None]
        levels = np.float32((1 << bit_count) - 1)
        step = np.where(high > low, (high - low) / levels, np.float32(1.0))
        quantized = np.rint((blocks[selected] - low) / step).clip(0, int(levels)).astype(np.uint16)
        streams.append(compress_stream(
            f"scale_block_q{bit_count}",
            pack_bits(quantized, bit_count),
            zstd_level,
        ))
        decoded[selected] = low + quantized.astype(np.float32) * step
        groups.append({"bits": bit_count, "block_count": selected_count})

    decoded = decoded.reshape(-1, 4, 3)[:count]
    relative_error = np.abs(np.expm1(decoded - scales))
    return decoded, {
        "codec": "morton-local-log-scale-bounded-block-quantization",
        "block_size": SCALE_BLOCK_SIZE,
        "block_count": block_count,
        "range_shape": list(ranges.shape),
        "target_maximum_relative_error": SCALE_TARGET_RELATIVE_ERROR,
        "minimum_bits": SCALE_MINIMUM_BITS,
        "maximum_bits": SCALE_MAXIMUM_BITS,
        "groups": groups,
        "mean_relative_linear_error": float(np.mean(relative_error)),
        "p99_relative_linear_error": float(np.percentile(relative_error, 99)),
        "maximum_relative_linear_error": float(np.max(relative_error)),
    }


def decode_scale(streams: dict[str, bytes], metadata: dict[str, Any], count: int) -> np.ndarray:
    block_size = int(metadata["block_size"])
    block_count = int(metadata["block_count"])
    bits = np.frombuffer(streams["scale_block_bits"], dtype=np.uint8)
    if bits.size != block_count:
        raise ValueError("Scale block mode count mismatch")
    ranges = np.frombuffer(streams["scale_block_ranges"], dtype="<f4").reshape(metadata["range_shape"])
    minimum = ranges[:, 0]
    maximum = ranges[:, 1]
    decoded = np.empty((block_count, block_size, 4, 3), dtype=np.float32)
    for group in metadata["groups"]:
        bit_count = int(group["bits"])
        selected = bits == bit_count
        selected_count = int(np.count_nonzero(selected))
        if selected_count != int(group["block_count"]):
            raise ValueError("Scale block bit group count mismatch")
        value_count = selected_count * block_size * 4 * 3
        quantized = unpack_bits(
            streams[f"scale_block_q{bit_count}"],
            value_count,
            bit_count,
        ).reshape(selected_count, block_size, 4, 3)
        low = minimum[selected, None]
        high = maximum[selected, None]
        levels = np.float32((1 << bit_count) - 1)
        step = np.where(high > low, (high - low) / levels, np.float32(0.0))
        decoded[selected] = low + quantized.astype(np.float32) * step
    return decoded.reshape(-1, 4, 3)[:count]


def _alpha_to_logit(alpha: np.ndarray) -> np.ndarray:
    lower = np.float32(1 / (1 + math.exp(16)))
    upper = np.float32(1 / (1 + math.exp(-16)))
    clipped = np.clip(alpha, lower, upper)
    return np.log(clipped / (1 - clipped)).astype(np.float32)


def encode_opacity(
    streams: list[Any],
    opacities: np.ndarray,
    importance: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    del importance
    source_alpha = 1 / (1 + np.exp(-np.clip(np.nan_to_num(opacities, neginf=-16), -16, 16)))
    levels = np.float32((1 << OPACITY_BITS) - 1)
    quantized = np.rint(source_alpha * levels).clip(0, int(levels)).astype(np.uint8)
    streams.append(compress_stream("opacity_alpha", quantized.tobytes(), zstd_level))
    decoded_alpha = quantized.astype(np.float32) / levels
    decoded = _alpha_to_logit(decoded_alpha)
    error = np.abs(decoded_alpha - source_alpha)
    return decoded, {
        "codec": "bounded-alpha-domain-uniform",
        "bits": OPACITY_BITS,
        "shape": list(opacities.shape),
        "mean_alpha_error": float(np.mean(error)),
        "p99_alpha_error": float(np.percentile(error, 99)),
        "maximum_alpha_error": float(np.max(error)),
    }


def decode_opacity(streams: dict[str, bytes], metadata: dict[str, Any], count: int) -> np.ndarray:
    shape = tuple(int(value) for value in metadata["shape"])
    quantized = np.frombuffer(streams["opacity_alpha"], dtype=np.uint8).reshape(shape)
    levels = np.float32((1 << int(metadata["bits"])) - 1)
    return _alpha_to_logit(quantized.astype(np.float32) / levels)


def encode_lifetime(
    streams: list[Any],
    mu: np.ndarray,
    width: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    bounds = np.stack([mu - width, mu + width], axis=1)
    quantized = np.rint(bounds / np.float32(LIFETIME_STEP)).astype(np.int32)
    minimum = int(np.min(quantized))
    shifted = (quantized.astype(np.int64) - minimum).astype(np.uint32)
    maximum = int(np.max(shifted))
    bits = max(1, maximum.bit_length())
    streams.append(compress_stream("lifetime_fixed_bounds", pack_bits(shifted, bits), zstd_level))
    decoded_bounds = quantized.astype(np.float32) * np.float32(LIFETIME_STEP)
    decoded_mu = np.mean(decoded_bounds, axis=1)
    decoded_width = (decoded_bounds[:, 1] - decoded_bounds[:, 0]) * np.float32(0.5)
    error = np.abs(decoded_bounds - bounds)
    return decoded_mu, decoded_width, {
        "codec": "fixed-step-lifetime-start-end",
        "step": LIFETIME_STEP,
        "bits": bits,
        "minimum_quantized": minimum,
        "shape": list(bounds.shape),
        "mean_bound_error": float(np.mean(error)),
        "p99_bound_error": float(np.percentile(error, 99)),
        "maximum_bound_error": float(np.max(error)),
    }


def decode_lifetime(
    streams: dict[str, bytes],
    metadata: dict[str, Any],
    count: int,
) -> tuple[np.ndarray, np.ndarray]:
    shape = tuple(int(value) for value in metadata["shape"])
    if shape != (count, 2):
        raise ValueError("Lifetime shape mismatch")
    shifted = unpack_bits(
        streams["lifetime_fixed_bounds"],
        count * 2,
        int(metadata["bits"]),
    ).reshape(shape)
    quantized = shifted.astype(np.int64) + int(metadata["minimum_quantized"])
    bounds = quantized.astype(np.float32) * np.float32(metadata["step"])
    return np.mean(bounds, axis=1), (bounds[:, 1] - bounds[:, 0]) * np.float32(0.5)


def encode(source: Path, output: Path, sh_stream: Path, zstd_level: int) -> dict[str, Any]:
    return encode_compact(
        source,
        output,
        sh_stream,
        zstd_level,
        profile_name=PROFILE_NAME,
        position_encoder=_encode_position,
        rotation_encoder=encode_rotation,
        color_encoder=encode_color,
        scale_encoder=encode_scale,
        opacity_encoder=encode_opacity,
        lifetime_encoder=encode_lifetime,
    )


def decode(source: Path, output: Path) -> dict[str, Any]:
    manifest, _ = read_container(source)
    if manifest.get("codec_name") != PROFILE_NAME:
        raise ValueError(f"Not a {PROFILE_NAME} stream")
    return decode_compact(
        source,
        output,
        profile_name=PROFILE_NAME,
        position_decoder=_decode_position,
        rotation_decoder=decode_rotation,
        color_decoder=decode_color,
        scale_decoder=decode_scale,
        opacity_decoder=decode_opacity,
        lifetime_decoder=decode_lifetime,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="SharedMotion9 bounded-quality 4CGS codec")
    sub = parser.add_subparsers(dest="command", required=True)
    enc = sub.add_parser("encode")
    enc.add_argument("source", type=Path)
    enc.add_argument("output", type=Path)
    enc.add_argument("--reuse-sh", type=Path, required=True)
    enc.add_argument("--zstd-level", type=int, default=8)
    dec = sub.add_parser("decode")
    dec.add_argument("source", type=Path)
    dec.add_argument("output", type=Path)
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
