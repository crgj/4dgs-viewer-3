#!/usr/bin/env python3
"""Replace candidate lifetimes with fixed-step boundary streams for rate tests."""

from __future__ import annotations

import argparse
import json
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("container", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--denominators", default="2,4,8,16,32")
    args = parser.parse_args()
    layout, source, source_mu, source_width = load_tracks(args.source)
    _, candidate, _, _ = load_tracks(args.candidate)
    minimum = np.min(source["position"], axis=(0, 1)).astype(np.float32)
    maximum = np.max(source["position"], axis=(0, 1)).astype(np.float32)
    coarse = np.rint(
        (source["position"][:, 0] - minimum) / (maximum - minimum) * 1023
    ).clip(0, 1023).astype(np.uint16)
    order = np.argsort(morton_codes(coarse), kind="stable")
    bounds = np.stack([
        source_mu[order] - source_width[order],
        source_mu[order] + source_width[order],
    ], axis=1)
    manifest, streams = read_container(args.container)
    sh = decode_sh_rvq5(streams["coresh5r"])
    compressor = zstd.ZstdCompressor(level=8)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {"candidates": {}}
    for denominator in (int(value) for value in args.denominators.split(",")):
        quantized = np.rint(bounds * denominator).astype(np.int32)
        minimum_quantized = int(np.min(quantized))
        shifted = (quantized.astype(np.int64) - minimum_quantized).astype(np.uint32)
        bits = max(1, int(np.max(shifted)).bit_length())
        stored_bytes = len(compressor.compress(pack_bits(shifted, bits)))
        decoded_bounds = quantized.astype(np.float32) / np.float32(denominator)
        lifetime_mu = np.mean(decoded_bounds, axis=1)
        lifetime_width = (decoded_bounds[:, 1] - decoded_bounds[:, 0]) * np.float32(0.5)
        label = f"{args.candidate.stem}_lifetime_q{denominator}"
        output = args.output_dir / f"{label}.raw4d"
        #WDD-gpt 2026-08-15 - 生命周期直接量化起止边界，避免少中心VQ把末帧存活区间归到错误类别。
        write_decoded_raw4d(
            output,
            manifest,
            sh,
            candidate["position"],
            candidate["rotation"],
            candidate["color"],
            candidate["scale"],
            candidate["opacity"],
            lifetime_mu,
            lifetime_width,
        )
        error = np.abs(decoded_bounds - bounds)
        report["candidates"][label] = {
            "output": str(output),
            "denominator": denominator,
            "bits": bits,
            "estimated_bytes": stored_bytes,
            "mean_boundary_error": float(np.mean(error)),
            "maximum_boundary_error": float(np.max(error)),
        }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
