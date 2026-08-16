#!/usr/bin/env python3
"""Create error-bounded absolute correction layers over a decoded position video."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import zstandard as zstd

from codec import extract_track, load_rows, property_indices, read_raw4d_layout, write_decoded_raw4d
from compact40 import morton_codes


#WDD-gpt 2026-08-14 - 修补每个绝对关键帧而非运动增量，使残差误差不随时间累计并可设置确定上限。
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("video_decoded", type=Path)
    parser.add_argument("probe_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--crf", type=int, required=True)
    parser.add_argument("--steps", nargs="+", type=int, default=[4, 8, 16, 32])
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
    levels = np.float32((1 << args.position_bits) - 1)
    exact_quantized = np.rint((source_position - minimum) / (maximum - minimum) * levels).astype(np.int32)
    decoded_quantized = np.rint((decoded_position - minimum) / (maximum - minimum) * levels).astype(np.int32)

    rotations, rotation_frames = extract_track(decoded_rows, decoded_layout, "rot_bank", ("w", "x", "y", "z"))
    colors, color_frames = extract_track(decoded_rows, decoded_layout, "f_dc_bank", ("0", "1", "2"))
    scales, scale_frames = extract_track(decoded_rows, decoded_layout, "scale_bank", ("0", "1", "2"))
    opacities, opacity_frames = extract_track(decoded_rows, decoded_layout, "opacity_bank", ("",))
    mu = np.asarray(decoded_rows[:, property_indices(decoded_layout, ["lifetime_mu"])[0]], dtype=np.float32)
    width = np.asarray(decoded_rows[:, property_indices(decoded_layout, ["lifetime_w"])[0]], dtype=np.float32)
    sh = np.asarray(
        decoded_rows[:, property_indices(decoded_layout, [f"f_rest_{index}" for index in range(45)])], dtype=np.float32
    )
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
    probe = json.loads((args.probe_dir / "report.json").read_text(encoding="utf-8"))
    base_bytes = (
        int(probe["base"]["morton_zstd_bytes"])
        + int(probe["base"]["fine_zstd_bytes"])
        + int(probe["motion"]["videos"][str(args.crf)]["bytes"])
    )
    compressor = zstd.ZstdCompressor(level=19, threads=0)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {"crf": args.crf, "base_bytes": base_bytes, "steps": {}}
    absolute_error = exact_quantized[:, 1:] - decoded_quantized[:, 1:]
    for step in args.steps:
        correction = np.rint(absolute_error / step).astype(np.int16)
        temporal_delta = np.diff(np.pad(correction, ((0, 0), (1, 0), (0, 0))), axis=1).astype("<i2")
        stored = compressor.compress(temporal_delta.tobytes())
        residual_path = args.output_dir / f"position_residual_step{step}.zst"
        residual_path.write_bytes(stored)
        corrected = decoded_quantized.copy()
        corrected[:, 1:] += correction.astype(np.int32) * step
        positions = minimum + corrected.astype(np.float32) / levels * (maximum - minimum)
        output = args.output_dir / f"position_step{step}.raw4d"
        write_decoded_raw4d(
            output, manifest, sh, positions, rotations, colors, scales, opacities, mu, width
        )
        remaining = exact_quantized - corrected
        report["steps"][str(step)] = {
            "residual_zstd_bytes": len(stored),
            "encoded_position_bytes": base_bytes + len(stored),
            "remaining_integer_rmse": float(np.sqrt(np.mean(np.square(remaining), dtype=np.float64))),
            "remaining_integer_maximum": int(np.max(np.abs(remaining))),
            "output": str(output),
        }
    (args.output_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
