#!/usr/bin/env python3
"""Create rate-quality candidates after Hybrid39 attribute ablation."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import zstandard as zstd

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from codec import (  # noqa: E402
    decode_sh_rvq5,
    extract_track,
    load_rows,
    property_indices,
    read_container,
    read_raw4d_layout,
    write_decoded_raw4d,
)
from compact40 import morton_codes, pack_bits  # noqa: E402
import quality_attrs  # noqa: E402


def load_tracks(path: Path) -> tuple[object, dict[str, np.ndarray], np.ndarray, np.ndarray]:
    layout = read_raw4d_layout(path)
    rows = load_rows(layout)
    values = {
        "position": extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))[0],
        "rotation": extract_track(rows, layout, "rot_bank", ("w", "x", "y", "z"))[0],
        "color": extract_track(rows, layout, "f_dc_bank", ("0", "1", "2"))[0],
        "scale": extract_track(rows, layout, "scale_bank", ("0", "1", "2"))[0],
        "opacity": extract_track(rows, layout, "opacity_bank", ("",))[0],
    }
    mu = np.asarray(rows[:, property_indices(layout, ["lifetime_mu"])[0]], dtype=np.float32)
    width = np.asarray(rows[:, property_indices(layout, ["lifetime_w"])[0]], dtype=np.float32)
    return layout, values, mu, width


def quantized_scale(values: np.ndarray, bits: int, block_size: int = 64) -> tuple[np.ndarray, int]:
    count = values.shape[0]
    block_count = math.ceil(count / block_size)
    padding = block_count * block_size - count
    blocks = np.pad(values, ((0, padding), (0, 0), (0, 0)), mode="edge").reshape(
        block_count, block_size, 4, 3
    )
    minimum = np.min(blocks, axis=1).astype(np.float32)
    maximum = np.max(blocks, axis=1).astype(np.float32)
    levels = np.float32((1 << bits) - 1)
    step = np.where(maximum > minimum, (maximum - minimum) / levels, np.float32(1.0))
    quantized = np.rint((blocks - minimum[:, None]) / step[:, None]).clip(0, int(levels)).astype(np.uint16)
    decoded = minimum[:, None] + quantized.astype(np.float32) * step[:, None]
    compressor = zstd.ZstdCompressor(level=8)
    stored = len(compressor.compress(pack_bits(quantized, bits))) + len(
        compressor.compress(np.stack([minimum, maximum], axis=1).astype("<f4").tobytes())
    )
    return decoded.reshape(-1, 4, 3)[:count], stored


def quantized_opacity(values: np.ndarray, bits: int) -> tuple[np.ndarray, int]:
    alpha = 1 / (1 + np.exp(-np.clip(np.nan_to_num(values, neginf=-16), -16, 16)))
    levels = np.float32((1 << bits) - 1)
    quantized = np.rint(alpha * levels).clip(0, int(levels)).astype(np.uint16)
    decoded_alpha = quantized.astype(np.float32) / levels
    lower = np.float32(1 / (1 + math.exp(16)))
    upper = np.float32(1 / (1 + math.exp(-16)))
    decoded_alpha = np.clip(decoded_alpha, lower, upper)
    decoded = np.log(decoded_alpha / (1 - decoded_alpha)).astype(np.float32)
    stored = len(zstd.ZstdCompressor(level=8).compress(pack_bits(quantized, bits)))
    return decoded, stored


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("container", type=Path)
    parser.add_argument("decoded", type=Path)
    parser.add_argument("p12", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--labels", help="Comma-separated candidate labels to materialize")
    args = parser.parse_args()

    layout, source, source_mu, source_width = load_tracks(args.source)
    _, decoded, _, _ = load_tracks(args.decoded)
    _, p12_tracks, _, _ = load_tracks(args.p12)
    minimum = np.min(source["position"], axis=(0, 1)).astype(np.float32)
    maximum = np.max(source["position"], axis=(0, 1)).astype(np.float32)
    coarse = np.rint((source["position"][:, 0] - minimum) / (maximum - minimum) * 1023).clip(0, 1023).astype(np.uint16)
    morton = morton_codes(coarse)
    global_order = np.argsort(morton, kind="stable")
    alpha = 1 / (1 + np.exp(-np.clip(source["opacity"], -16, 16)))
    radius = np.exp(np.clip(np.max(source["scale"], axis=(1, 2)), -16, 2))
    importance_order = np.argsort(-(np.max(alpha, axis=(1, 2)) * radius), kind="stable")
    p12_tiers = [importance_order[:round(layout.vertex_count * 0.6)], importance_order[round(layout.vertex_count * 0.6):]]
    p12_order = np.concatenate([selected[np.argsort(morton[selected], kind="stable")] for selected in p12_tiers])
    p12_source = np.empty_like(p12_tracks["position"])
    p12_source[p12_order] = p12_tracks["position"]
    p12_global = p12_source[global_order]

    source = {name: value[global_order] for name, value in source.items()}
    opacity_variants = {bits: quantized_opacity(source["opacity"], bits) for bits in (9, 10)}
    scale_variants = {bits: quantized_scale(source["scale"], bits) for bits in range(2, 9)}
    lifetime_bounds = np.stack([source_mu[global_order] - source_width[global_order], source_mu[global_order] + source_width[global_order]], axis=1)
    lifetime_q = np.rint(lifetime_bounds * 32).astype(np.int32)
    lifetime_decoded = lifetime_q.astype(np.float32) / np.float32(32)
    lifetime_mu = np.mean(lifetime_decoded, axis=1)
    lifetime_width = (lifetime_decoded[:, 1] - lifetime_decoded[:, 0]) * np.float32(0.5)

    importance = (
        np.max(alpha, axis=(1, 2)) * radius
    )[global_order].astype(np.float32)
    previous_rotation_bits = quality_attrs.ROTATION_BITS
    previous_color_bits = quality_attrs.COLOR_MODE_BITS
    try:
        quality_attrs.ROTATION_BITS = (5, 6, 7, 9)
        rotation_streams: list[object] = []
        aggressive_rotation, _ = quality_attrs.encode_rotation(
            rotation_streams,
            source["rotation"],
            source["scale"],
            source["opacity"],
            8,
        )
        quality_attrs.COLOR_MODE_BITS = ((4, 3, 3), (5, 4, 4), (6, 5, 5))
        color_streams: list[object] = []
        aggressive_color, _ = quality_attrs.encode_color(
            color_streams,
            source["color"],
            importance,
            8,
        )
    finally:
        quality_attrs.ROTATION_BITS = previous_rotation_bits
        quality_attrs.COLOR_MODE_BITS = previous_color_bits
    aggressive_rotation_bytes = sum(len(stream.stored) for stream in rotation_streams)
    aggressive_color_bytes = sum(len(stream.stored) for stream in color_streams)

    manifest, streams = read_container(args.container)
    sh = decode_sh_rvq5(streams["coresh5r"])
    candidates = {
        "op9": (decoded["position"], 9, None, decoded["rotation"], decoded["color"]),
        "op10": (decoded["position"], 10, None, decoded["rotation"], decoded["color"]),
        **{
            f"op10_scale{bits}": (
                decoded["position"], 10, bits, decoded["rotation"], decoded["color"]
            )
            for bits in range(2, 9)
        },
        **{
            f"p12_op10_scale{bits}": (
                p12_global, 10, bits, decoded["rotation"], decoded["color"]
            )
            for bits in range(2, 9)
        },
        **{
            f"p12_aggressive_op10_scale{bits}": (
                p12_global, 10, bits, aggressive_rotation, aggressive_color
            )
            for bits in range(2, 7)
        },
        **{
            f"q18_aggressive_op10_scale{bits}": (
                decoded["position"], 10, bits, aggressive_rotation, aggressive_color
            )
            for bits in range(2, 7)
        },
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {"candidates": {}}
    selected_labels = set(args.labels.split(",")) if args.labels else None
    for label, (position, opacity_bits, scale_bits, rotation, color) in candidates.items():
        if selected_labels is not None and label not in selected_labels:
            continue
        scale = decoded["scale"] if scale_bits is None else scale_variants[scale_bits][0]
        output = args.output_dir / f"{label}.raw4d"
        #WDD-gpt 2026-08-15 - 组合主瓶颈透明度与降码尺度/视频位置，搜索15至20倍的可行质量前沿。
        write_decoded_raw4d(
            output,
            manifest,
            sh,
            position,
            rotation,
            color,
            scale,
            opacity_variants[opacity_bits][0],
            lifetime_mu,
            lifetime_width,
        )
        report["candidates"][label] = {
            "output": str(output),
            "position": "p12-video" if position is p12_global else "ldmg9-q18",
            "opacity_bits": opacity_bits,
            "opacity_estimated_bytes": opacity_variants[opacity_bits][1],
            "scale_bits": scale_bits,
            "scale_estimated_bytes": None if scale_bits is None else scale_variants[scale_bits][1],
            "rotation": "aggressive-5679" if rotation is aggressive_rotation else "quality-67810",
            "rotation_estimated_bytes": aggressive_rotation_bytes if rotation is aggressive_rotation else None,
            "color": "aggressive-433-544-655" if color is aggressive_color else "quality-544-655-766",
            "color_estimated_bytes": aggressive_color_bytes if color is aggressive_color else None,
        }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
