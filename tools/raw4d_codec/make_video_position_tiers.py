#!/usr/bin/env python3
"""Create importance-tiered position-video render ablations and measure repair bytes."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import zstandard as zstd

from codec import extract_track, load_rows, property_indices, read_raw4d_layout, write_decoded_raw4d
from compact40 import morton_codes


#WDD-gpt 2026-08-14 - 用透明度和投影尺度构造确定性的视觉敏感度层，重要高斯保存近无损运动，低层允许更大残差。
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("video_decoded", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--fractions", nargs="+", type=float, default=[0.1, 0.2, 0.4, 0.6, 0.8])
    parser.add_argument("--position-bits", type=int, default=13)
    args = parser.parse_args()

    source_layout = read_raw4d_layout(args.source)
    source_rows = load_rows(source_layout)
    decoded_layout = read_raw4d_layout(args.video_decoded)
    decoded_rows = load_rows(decoded_layout)
    source_position, position_frames = extract_track(source_rows, source_layout, "xyz_bank", ("x", "y", "z"))
    minimum = np.min(source_position, axis=(0, 1))
    maximum = np.max(source_position, axis=(0, 1))
    q0 = np.rint((source_position[:, 0] - minimum) / (maximum - minimum) * 1023).clip(0, 1023).astype(np.uint16)
    order = np.argsort(morton_codes(q0), kind="stable")
    source_position = source_position[order]
    decoded_position, _ = extract_track(decoded_rows, decoded_layout, "xyz_bank", ("x", "y", "z"))

    rotations, rotation_frames = extract_track(decoded_rows, decoded_layout, "rot_bank", ("w", "x", "y", "z"))
    colors, color_frames = extract_track(decoded_rows, decoded_layout, "f_dc_bank", ("0", "1", "2"))
    scales, scale_frames = extract_track(decoded_rows, decoded_layout, "scale_bank", ("0", "1", "2"))
    opacities, opacity_frames = extract_track(decoded_rows, decoded_layout, "opacity_bank", ("",))
    mu = np.asarray(decoded_rows[:, property_indices(decoded_layout, ["lifetime_mu"])[0]], dtype=np.float32)
    width = np.asarray(decoded_rows[:, property_indices(decoded_layout, ["lifetime_w"])[0]], dtype=np.float32)
    sh = np.asarray(
        decoded_rows[:, property_indices(decoded_layout, [f"f_rest_{index}" for index in range(45)])], dtype=np.float32
    )

    source_scales, _ = extract_track(source_rows, source_layout, "scale_bank", ("0", "1", "2"))
    source_opacity, _ = extract_track(source_rows, source_layout, "opacity_bank", ("",))
    alpha = 1 / (1 + np.exp(-np.clip(source_opacity, -16, 16)))
    radius = np.exp(np.clip(np.max(source_scales, axis=(1, 2)), -16, 2))
    importance = (np.max(alpha, axis=(1, 2)) * radius)[order]

    levels = np.float32((1 << args.position_bits) - 1)
    exact_quantized = np.rint((source_position - minimum) / (maximum - minimum) * levels).clip(0, levels).astype(np.int32)
    decoded_quantized = np.rint((decoded_position - minimum) / (maximum - minimum) * levels).clip(0, levels).astype(np.int32)
    motion_correction = np.diff(exact_quantized, axis=1) - np.diff(decoded_quantized, axis=1)
    compressor = zstd.ZstdCompressor(level=19, threads=0)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "gaussian_count": source_layout.vertex_count,
        "total_frames": source_layout.total_frames,
        "attributes": {
            "position": {"keyframes": position_frames},
            "rotation": {"keyframes": rotation_frames},
            "color_dc": {"keyframes": color_frames},
            "scale": {"keyframes": scale_frames},
            "opacity": {"keyframes": opacity_frames},
        },
    }
    report: dict[str, object] = {"tiers": {}}
    count = source_layout.vertex_count
    for fraction in args.fractions:
        selected_count = int(round(count * fraction))
        selected = np.argpartition(importance, count - selected_count)[count - selected_count:]
        repaired = decoded_position.copy()
        repaired[selected] = minimum + exact_quantized[selected].astype(np.float32) / levels * (maximum - minimum)
        mask = np.zeros(count, dtype=np.uint8)
        mask[selected] = 1
        mask_stored = compressor.compress(np.packbits(mask, bitorder="little").tobytes())
        correction_stored = compressor.compress(motion_correction[selected].astype("<i2").tobytes())
        label = f"tier_{int(round(fraction * 100)):02d}"
        output = args.output_dir / f"{label}.raw4d"
        write_decoded_raw4d(
            output, manifest, sh, repaired, rotations, colors, scales, opacities, mu, width
        )
        report["tiers"][label] = {
            "fraction": fraction,
            "selected_count": selected_count,
            "mask_zstd_bytes": len(mask_stored),
            "motion_correction_zstd_bytes": len(correction_stored),
            "additional_bytes": len(mask_stored) + len(correction_stored),
            "output": str(output),
        }
    (args.output_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
