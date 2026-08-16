#!/usr/bin/env python3
"""Quality-oriented rotation and DC streams for SparseTraj 4CGS."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np

import sparse_traj512
from codec import C0, compress_stream, decode_quaternions, encode_quaternions, read_container
from compact40 import (
    decode as decode_compact,
    encode as encode_compact,
    pack_bits,
    unpack_bits,
)


#WDD-gpt 2026-08-14 - 新质量档保留SparseTraj512x8和CoReSH-5R，只替换旋转与DC瓶颈。
PROFILE_NAME = "CoRe4D-SparseTraj512x8-RotSTA678-BlockDCYCoCg"
ROTATION_BITS = (6, 7, 8, 10)
COLOR_BLOCK_SIZE = 256
COLOR_MODE_BITS = ((5, 4, 4), (6, 5, 5), (7, 6, 6))


def _rotation_modes(scales: np.ndarray, opacities: np.ndarray) -> tuple[np.ndarray, dict[str, float]]:
    physical_scale = np.exp(np.clip(scales, -16, 2))
    maximum_scale = np.max(physical_scale, axis=(1, 2))
    minimum_scale = np.min(physical_scale, axis=(1, 2))
    contrast = (
        np.square(maximum_scale) - np.square(minimum_scale)
    ) / np.maximum(np.square(maximum_scale) + np.square(minimum_scale), 1e-12)
    maximum_alpha = np.max(
        1 / (1 + np.exp(-np.clip(opacities.reshape(opacities.shape[0], -1), -16, 16))),
        axis=1,
    )
    contribution = maximum_alpha * np.square(maximum_scale) * np.maximum(contrast, 0)
    finite = contribution[np.isfinite(contribution)]
    q30, q80, q97 = np.percentile(finite, [30, 80, 97])
    modes = np.ones(contribution.shape[0], dtype=np.uint8)
    modes[(contribution <= q30) | (maximum_alpha < 0.02) | (contrast < 0.05)] = 0
    modes[contribution >= q80] = 2
    modes[contribution >= q97] = 3
    return modes, {
        "q30": float(q30),
        "q80": float(q80),
        "q97": float(q97),
    }


def encode_rotation(
    streams: list[Any],
    rotations: np.ndarray,
    scales: np.ndarray,
    opacities: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    count = rotations.shape[0]
    modes, thresholds = _rotation_modes(scales, opacities)
    streams.append(compress_stream("rotation_st_modes", pack_bits(modes, 2), zstd_level))
    decoded = np.empty_like(rotations, dtype=np.float32)
    groups: list[dict[str, Any]] = []
    for mode, bits in enumerate(ROTATION_BITS):
        selected = modes == mode
        selected_count = int(np.count_nonzero(selected))
        group = {
            "mode": mode,
            "bits_per_component": bits,
            "packed_bits_per_quaternion": 2 + 3 * bits,
            "gaussian_count": selected_count,
        }
        groups.append(group)
        if selected_count == 0:
            continue
        packed, _ = encode_quaternions(rotations[selected], bits=bits)
        streams.append(compress_stream(
            f"rotation_st_b{bits}",
            pack_bits(packed, 2 + 3 * bits),
            zstd_level,
        ))
        decoded[selected] = decode_quaternions(packed, (selected_count, 2), bits=bits)
    #WDD-gpt 2026-08-14 - 位宽由协方差各向异性、尺度和透明度共同决定，不依赖数据集固定阈值。
    return decoded, {
        "codec": "adaptive-smallest-three-6-7-8-10",
        "mode_bits": 2,
        "groups": groups,
        "selection_thresholds": thresholds,
    }


def decode_rotation(
    streams: dict[str, bytes],
    metadata: dict[str, Any],
    count: int,
) -> np.ndarray:
    modes = unpack_bits(streams["rotation_st_modes"], count, int(metadata["mode_bits"]))
    decoded = np.empty((count, 2, 4), dtype=np.float32)
    for group in metadata["groups"]:
        mode = int(group["mode"])
        bits = int(group["bits_per_component"])
        selected = modes == mode
        selected_count = int(np.count_nonzero(selected))
        if selected_count != int(group["gaussian_count"]):
            raise ValueError("RotST mode count mismatch")
        if selected_count == 0:
            continue
        packed = unpack_bits(
            streams[f"rotation_st_b{bits}"],
            selected_count * 2,
            int(group["packed_bits_per_quaternion"]),
        )
        decoded[selected] = decode_quaternions(packed, (selected_count, 2), bits=bits)
    return decoded


def _rgb_to_ycocg(rgb: np.ndarray) -> np.ndarray:
    red, green, blue = np.moveaxis(rgb, -1, 0)
    co = red - blue
    temporary = blue + co * 0.5
    cg = green - temporary
    luminance = temporary + cg * 0.5
    return np.stack([luminance, co, cg], axis=-1).astype(np.float32)


def _ycocg_to_rgb(ycocg: np.ndarray) -> np.ndarray:
    luminance, co, cg = np.moveaxis(ycocg, -1, 0)
    temporary = luminance - cg * 0.5
    green = cg + temporary
    blue = temporary - co * 0.5
    red = blue + co
    return np.stack([red, green, blue], axis=-1).astype(np.float32)


def _color_block_modes(importance: np.ndarray, block_count: int) -> np.ndarray:
    padding = block_count * COLOR_BLOCK_SIZE - importance.shape[0]
    padded = np.pad(importance, (0, padding), mode="edge")
    scores = np.percentile(padded.reshape(block_count, COLOR_BLOCK_SIZE), 90, axis=1)
    q25, q85 = np.percentile(scores, [25, 85])
    modes = np.ones(block_count, dtype=np.uint8)
    modes[scores <= q25] = 0
    modes[scores >= q85] = 2
    return modes


def encode_color(
    streams: list[Any],
    colors: np.ndarray,
    importance: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    count = colors.shape[0]
    block_count = (count + COLOR_BLOCK_SIZE - 1) // COLOR_BLOCK_SIZE
    padding = block_count * COLOR_BLOCK_SIZE - count
    rgb = np.float32(0.5) + np.float32(C0) * colors
    ycocg = _rgb_to_ycocg(rgb)
    padded = np.pad(ycocg, ((0, padding), (0, 0), (0, 0)), mode="edge")
    blocks = padded.reshape(block_count, COLOR_BLOCK_SIZE, 2, 3)
    minimum = np.min(blocks, axis=1).astype(np.float16).astype(np.float32)
    maximum = np.max(blocks, axis=1).astype(np.float16).astype(np.float32)
    ranges = np.stack([minimum, maximum], axis=1).astype("<f2")
    modes = _color_block_modes(importance, block_count)
    streams.append(compress_stream("color_block_modes", pack_bits(modes, 2), zstd_level))
    streams.append(compress_stream("color_block_ranges", ranges.tobytes(), zstd_level))

    decoded_blocks = np.empty_like(blocks, dtype=np.float32)
    mode_metadata: list[dict[str, Any]] = []
    for mode, component_bits in enumerate(COLOR_MODE_BITS):
        selected = modes == mode
        selected_count = int(np.count_nonzero(selected))
        mode_metadata.append({
            "mode": mode,
            "component_bits": list(component_bits),
            "block_count": selected_count,
        })
        if selected_count == 0:
            continue
        selected_values = blocks[selected]
        selected_minimum = minimum[selected]
        selected_maximum = maximum[selected]
        for component, bits in enumerate(component_bits):
            levels = np.float32((1 << bits) - 1)
            low = selected_minimum[:, None, :, component]
            high = selected_maximum[:, None, :, component]
            step = np.where(high > low, (high - low) / levels, np.float32(1.0))
            quantized = np.rint(
                (selected_values[..., component] - low) / step
            ).clip(0, int(levels)).astype(np.uint16)
            streams.append(compress_stream(
                f"color_block_m{mode}_c{component}",
                pack_bits(quantized, bits),
                zstd_level,
            ))
            decoded_blocks[selected, ..., component] = low + quantized.astype(np.float32) * step

    decoded_ycocg = decoded_blocks.reshape(-1, 2, 3)[:count]
    decoded_rgb = _ycocg_to_rgb(decoded_ycocg)
    decoded_color = (decoded_rgb - np.float32(0.5)) / np.float32(C0)
    rgb_error = np.abs(decoded_rgb - rgb)
    #WDD-gpt 2026-08-14 - DC使用块局部范围提供有界误差，避免全局VQ少数离群点产生大色差。
    return decoded_color.astype(np.float32), {
        "codec": "block-local-ycocg-adaptive-544-655-766",
        "block_size": COLOR_BLOCK_SIZE,
        "block_count": block_count,
        "mode_bits": 2,
        "range_shape": list(ranges.shape),
        "modes": mode_metadata,
        "mean_render_rgb_error": float(np.mean(rgb_error)),
        "p99_render_rgb_error": float(np.percentile(rgb_error, 99)),
        "maximum_render_rgb_error": float(np.max(rgb_error)),
    }


def decode_color(
    streams: dict[str, bytes],
    metadata: dict[str, Any],
    count: int,
) -> np.ndarray:
    block_count = int(metadata["block_count"])
    block_size = int(metadata["block_size"])
    modes = unpack_bits(streams["color_block_modes"], block_count, int(metadata["mode_bits"]))
    ranges = np.frombuffer(streams["color_block_ranges"], dtype="<f2").astype(np.float32)
    ranges = ranges.reshape(metadata["range_shape"])
    minimum = ranges[:, 0]
    maximum = ranges[:, 1]
    decoded = np.empty((block_count, block_size, 2, 3), dtype=np.float32)
    for mode_meta in metadata["modes"]:
        mode = int(mode_meta["mode"])
        component_bits = tuple(int(value) for value in mode_meta["component_bits"])
        selected = modes == mode
        selected_count = int(np.count_nonzero(selected))
        if selected_count != int(mode_meta["block_count"]):
            raise ValueError("BlockDC mode count mismatch")
        if selected_count == 0:
            continue
        for component, bits in enumerate(component_bits):
            quantized = unpack_bits(
                streams[f"color_block_m{mode}_c{component}"],
                selected_count * block_size * 2,
                bits,
            ).reshape(selected_count, block_size, 2)
            levels = np.float32((1 << bits) - 1)
            low = minimum[selected, None, :, component]
            high = maximum[selected, None, :, component]
            step = np.where(high > low, (high - low) / levels, np.float32(0.0))
            decoded[selected, ..., component] = low + quantized.astype(np.float32) * step
    rgb = _ycocg_to_rgb(decoded.reshape(-1, 2, 3)[:count])
    return ((rgb - np.float32(0.5)) / np.float32(C0)).astype(np.float32)


def encode(source: Path, output: Path, sh_stream: Path, zstd_level: int) -> dict[str, Any]:
    sparse_traj512.ACTIVE_SPARSE_ATOMS = 8
    return encode_compact(
        source,
        output,
        sh_stream,
        zstd_level,
        profile_name=PROFILE_NAME,
        position_encoder=sparse_traj512._encode_position,
        rotation_encoder=encode_rotation,
        color_encoder=encode_color,
    )


def decode(source: Path, output: Path) -> dict[str, Any]:
    manifest, _ = read_container(source)
    if manifest.get("codec_name") != PROFILE_NAME:
        raise ValueError(f"Not a {PROFILE_NAME} stream")
    return decode_compact(
        source,
        output,
        profile_name=PROFILE_NAME,
        position_decoder=sparse_traj512._decode_position,
        rotation_decoder=decode_rotation,
        color_decoder=decode_color,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Quality rotation/DC SparseTraj 4CGS codec")
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
