#!/usr/bin/env python3
"""Probe local affine motion banks before quantized residual entropy coding."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import zstandard as zstd

from codec import extract_track, load_rows, read_raw4d_layout
from compact40 import encode_unsigned_varints, morton_codes, morton_xyz, pack_bits


def parse_profile(value: str) -> list[tuple[float, int]]:
    tiers = [(float(fraction), int(step)) for fraction, step in (part.split(":", 1) for part in value.split(","))]
    if tiers[-1][0] != 1.0 or any(step <= 0 for _, step in tiers):
        raise argparse.ArgumentTypeError("profile must end at fraction 1.0 with positive steps")
    return tiers


def local_design(base: np.ndarray) -> np.ndarray:
    center = np.mean(base, axis=0)
    scale = float(np.max(np.ptp(base, axis=0)))
    if scale <= 0:
        scale = 1.0
    normalized = (base.astype(np.float32) - center) / scale
    return np.concatenate([normalized, np.ones((base.shape[0], 1), dtype=np.float32)], axis=1)


#WDD-gpt 2026-08-14 - 在量化坐标的 Morton 区域上最小二乘拟合共享仿射曲线 Bank，只编码不可解释的绝对残差。
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--block-sizes", nargs="+", type=int, default=[64, 128, 256, 512, 1024])
    parser.add_argument("--position-bits", type=int, default=13)
    parser.add_argument("--coarse-bits", type=int, default=10)
    parser.add_argument("--profile", type=parse_profile, default="0.2:1,0.6:2,1.0:8")
    args = parser.parse_args()

    layout = read_raw4d_layout(args.source)
    rows = load_rows(layout)
    positions, frames = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    scales, _ = extract_track(rows, layout, "scale_bank", ("0", "1", "2"))
    opacities, _ = extract_track(rows, layout, "opacity_bank", ("",))
    minimum = np.min(positions, axis=(0, 1)).astype(np.float32)
    maximum = np.max(positions, axis=(0, 1)).astype(np.float32)
    position_levels = np.float32((1 << args.position_bits) - 1)
    coarse_levels = np.float32((1 << args.coarse_bits) - 1)
    quantized = np.rint((positions - minimum) / (maximum - minimum) * position_levels).astype(np.int32)
    coarse = np.rint((positions[:, 0] - minimum) / (maximum - minimum) * coarse_levels).clip(
        0, int(coarse_levels)
    ).astype(np.uint16)
    order = np.argsort(morton_codes(coarse), kind="stable")
    quantized = quantized[order]
    coarse = coarse[order]
    scales = scales[order]
    opacities = opacities[order]

    morton = morton_codes(coarse)
    morton_delta = np.empty(layout.vertex_count, dtype=np.uint32)
    morton_delta[0] = morton[0]
    morton_delta[1:] = morton[1:] - morton[:-1]
    compressor = zstd.ZstdCompressor(level=19, threads=0)
    base_morton = compressor.compress(encode_unsigned_varints(morton_delta))
    reconstructed_coarse = np.rint(coarse.astype(np.float32) / coarse_levels * position_levels).astype(np.int32)
    fine = quantized[:, 0] - reconstructed_coarse
    fine_minimum = np.min(fine, axis=0).astype(np.int32)
    fine_unsigned = (fine - fine_minimum).astype(np.uint32)
    fine_bits = int(math.ceil(math.log2(int(np.max(fine_unsigned)) + 1)))
    base_fine = compressor.compress(pack_bits(fine_unsigned, fine_bits))

    alpha = 1 / (1 + np.exp(-np.clip(opacities, -16, 16)))
    radius = np.exp(np.clip(np.max(scales, axis=(1, 2)), -16, 2))
    importance = np.max(alpha, axis=(1, 2)) * radius
    importance_order = np.argsort(-importance, kind="stable")
    steps = np.empty(layout.vertex_count, dtype=np.int32)
    tier_ids = np.empty(layout.vertex_count, dtype=np.uint8)
    first = 0
    for tier_id, (fraction, step) in enumerate(args.profile):
        last = int(round(layout.vertex_count * fraction))
        selected = importance_order[first:last]
        steps[selected] = step
        tier_ids[selected] = tier_id
        first = last
    tier_bits = max(1, int(math.ceil(math.log2(len(args.profile)))))
    tier_planes = ((tier_ids[:, None] >> np.arange(tier_bits, dtype=np.uint8)) & 1).astype(np.uint8)
    tier_stored = compressor.compress(np.packbits(tier_planes.reshape(-1), bitorder="little").tobytes())

    displacement = quantized[:, 1:] - quantized[:, :1]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {
        "profile": args.profile,
        "base_morton_zstd_bytes": len(base_morton),
        "base_fine_zstd_bytes": len(base_fine),
        "tier_zstd_bytes": len(tier_stored),
        "block_sizes": {},
    }
    for block_size in args.block_sizes:
        affine_coefficients: list[np.ndarray] = []
        translation_coefficients: list[np.ndarray] = []
        affine_residual = np.empty_like(displacement)
        translation_residual = np.empty_like(displacement)
        for start in range(0, layout.vertex_count, block_size):
            stop = min(layout.vertex_count, start + block_size)
            design = local_design(quantized[start:stop, 0])
            target = displacement[start:stop].reshape(stop - start, -1).astype(np.float32)
            coefficient = np.linalg.lstsq(design, target, rcond=None)[0].astype(np.float16)
            predicted = np.rint(design @ coefficient.astype(np.float32)).astype(np.int32)
            affine_coefficients.append(coefficient)
            affine_residual[start:stop] = displacement[start:stop] - predicted.reshape(stop - start, 10, 3)
            translation = np.mean(target, axis=0).astype(np.float16)
            translation_coefficients.append(translation)
            translation_residual[start:stop] = displacement[start:stop] - np.rint(
                translation.astype(np.float32)
            ).astype(np.int32).reshape(1, 10, 3)

        modes: dict[str, object] = {}
        for mode, residual, coefficients in [
            ("affine", affine_residual, np.stack(affine_coefficients)),
            ("translation", translation_residual, np.stack(translation_coefficients)),
        ]:
            correction = np.rint(residual / steps[:, None, None]).astype(np.int16)
            temporal_delta = np.diff(np.pad(correction, ((0, 0), (1, 0), (0, 0))), axis=1).astype("<i2")
            residual_stored = compressor.compress(temporal_delta.tobytes())
            coefficient_stored = compressor.compress(coefficients.astype("<f2").tobytes())
            remaining = residual - correction.astype(np.int32) * steps[:, None, None]
            modes[mode] = {
                "coefficient_shape": list(coefficients.shape),
                "coefficient_zstd_bytes": len(coefficient_stored),
                "residual_zstd_bytes": len(residual_stored),
                "encoded_position_bytes": len(base_morton)
                + len(base_fine)
                + len(tier_stored)
                + len(coefficient_stored)
                + len(residual_stored),
                "prediction_integer_rmse": float(np.sqrt(np.mean(np.square(residual), dtype=np.float64))),
                "prediction_integer_p99": float(np.percentile(np.abs(residual), 99)),
                "remaining_integer_rmse": float(np.sqrt(np.mean(np.square(remaining), dtype=np.float64))),
                "remaining_integer_maximum": int(np.max(np.abs(remaining))),
            }
        report["block_sizes"][str(block_size)] = modes
        print(json.dumps({str(block_size): modes}, ensure_ascii=False), flush=True)
    (args.output_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
