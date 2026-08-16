#!/usr/bin/env python3
"""Build block-adaptive 8/9-bit opacity candidates."""

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

from codec import decode_sh_rvq5, read_container, write_decoded_raw4d  # noqa: E402
from compact40 import morton_codes, pack_bits  # noqa: E402
from make_hybrid39_rate_candidates import load_tracks  # noqa: E402


def alpha_to_logit(alpha: np.ndarray) -> np.ndarray:
    lower = np.float32(1 / (1 + math.exp(16)))
    upper = np.float32(1 / (1 + math.exp(-16)))
    clipped = np.clip(alpha, lower, upper)
    return np.log(clipped / (1 - clipped)).astype(np.float32)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("container", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--high-fractions", default="0.25,0.5,0.75")
    parser.add_argument("--block-size", default=64, type=int)
    args = parser.parse_args()
    layout, source, _, _ = load_tracks(args.source)
    _, candidate, candidate_mu, candidate_width = load_tracks(args.candidate)
    minimum = np.min(source["position"], axis=(0, 1)).astype(np.float32)
    maximum = np.max(source["position"], axis=(0, 1)).astype(np.float32)
    coarse = np.rint(
        (source["position"][:, 0] - minimum) / (maximum - minimum) * 1023
    ).clip(0, 1023).astype(np.uint16)
    order = np.argsort(morton_codes(coarse), kind="stable")
    source = {name: value[order] for name, value in source.items()}
    alpha = 1 / (1 + np.exp(-np.clip(np.nan_to_num(source["opacity"], neginf=-16), -16, 16)))
    footprint = np.square(np.exp(np.clip(np.max(source["scale"], axis=(1, 2)), -16, 2)))
    contribution = np.max(alpha, axis=(1, 2)) * footprint
    block_count = math.ceil(layout.vertex_count / args.block_size)
    padding = block_count * args.block_size - layout.vertex_count
    scores = np.percentile(
        np.pad(contribution, (0, padding), mode="edge").reshape(block_count, args.block_size),
        90,
        axis=1,
    )
    manifest, streams = read_container(args.container)
    sh = decode_sh_rvq5(streams["coresh5r"])
    compressor = zstd.ZstdCompressor(level=8)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {"candidates": {}}
    for high_fraction in (float(value) for value in args.high_fractions.split(",")):
        threshold = np.quantile(scores, 1 - high_fraction)
        high_blocks = scores >= threshold
        high = np.repeat(high_blocks, args.block_size)[:layout.vertex_count]
        decoded_alpha = np.empty_like(alpha, dtype=np.float32)
        stored_bytes = len(compressor.compress(np.packbits(high_blocks, bitorder="little").tobytes()))
        group_bytes: dict[int, int] = {}
        for bits, selected in ((8, ~high), (9, high)):
            levels = np.float32((1 << bits) - 1)
            quantized = np.rint(alpha[selected] * levels).clip(0, int(levels)).astype(np.uint16)
            decoded_alpha[selected] = quantized.astype(np.float32) / levels
            payload = quantized.astype(np.uint8).tobytes() if bits == 8 else pack_bits(quantized, bits)
            group_bytes[bits] = len(compressor.compress(payload))
            stored_bytes += group_bytes[bits]
        decoded_opacity = alpha_to_logit(decoded_alpha)
        label = f"{args.candidate.stem}_opacity_h{round(high_fraction * 100):02d}"
        output = args.output_dir / f"{label}.raw4d"
        #WDD-gpt 2026-08-15 - 透明度按空间块的最大投影贡献选择8或9bit，集中位宽而不逐点保存模式。
        write_decoded_raw4d(
            output,
            manifest,
            sh,
            candidate["position"],
            candidate["rotation"],
            candidate["color"],
            candidate["scale"],
            decoded_opacity,
            candidate_mu,
            candidate_width,
        )
        report["candidates"][label] = {
            "output": str(output),
            "block_size": args.block_size,
            "high_fraction": float(np.mean(high_blocks)),
            "estimated_bytes": stored_bytes,
            "group_bytes": group_bytes,
            "mean_alpha_error": float(np.mean(np.abs(decoded_alpha - alpha))),
            "maximum_alpha_error": float(np.max(np.abs(decoded_alpha - alpha))),
        }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
