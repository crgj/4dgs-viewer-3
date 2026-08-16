#!/usr/bin/env python3
"""Create variable-step importance-conditioned position correction ablations."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import zstandard as zstd

from codec import extract_track, load_rows, property_indices, read_raw4d_layout, write_decoded_raw4d
from compact40 import morton_codes


def parse_profile(value: str) -> tuple[str, list[tuple[float, int]]]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("profile must be NAME=CUMULATIVE_FRACTION:STEP,...")
    name, payload = value.split("=", 1)
    tiers = [(float(fraction), int(step)) for fraction, step in (part.split(":", 1) for part in payload.split(","))]
    if not name or tiers[-1][0] != 1.0 or any(step <= 0 for _, step in tiers):
        raise argparse.ArgumentTypeError("profile must end at cumulative fraction 1.0 and use positive steps")
    if any(tiers[index][0] <= tiers[index - 1][0] for index in range(1, len(tiers))):
        raise argparse.ArgumentTypeError("profile fractions must be strictly increasing")
    return name, tiers


#WDD-gpt 2026-08-14 - 按透明度乘尺度的渲染敏感度分配残差步长，难压缩点自动使用更多码率而不删除高斯。
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("video_decoded", type=Path)
    parser.add_argument("probe_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--crf", type=int, required=True)
    parser.add_argument("--position-bits", type=int, default=13)
    parser.add_argument("--profile", action="append", type=parse_profile, required=True)
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

    source_scale, _ = extract_track(source_rows, source_layout, "scale_bank", ("0", "1", "2"))
    source_opacity, _ = extract_track(source_rows, source_layout, "opacity_bank", ("",))
    alpha = 1 / (1 + np.exp(-np.clip(source_opacity, -16, 16)))
    radius = np.exp(np.clip(np.max(source_scale, axis=(1, 2)), -16, 2))
    importance = (np.max(alpha, axis=(1, 2)) * radius)[order]
    importance_order = np.argsort(-importance, kind="stable")

    levels = np.float32((1 << args.position_bits) - 1)
    exact_quantized = np.rint((source_position - minimum) / (maximum - minimum) * levels).astype(np.int32)
    decoded_quantized = np.rint((decoded_position - minimum) / (maximum - minimum) * levels).astype(np.int32)
    absolute_error = exact_quantized[:, 1:] - decoded_quantized[:, 1:]

    rotations, rotation_frames = extract_track(decoded_rows, decoded_layout, "rot_bank", ("w", "x", "y", "z"))
    colors, color_frames = extract_track(decoded_rows, decoded_layout, "f_dc_bank", ("0", "1", "2"))
    scales, scale_frames = extract_track(decoded_rows, decoded_layout, "scale_bank", ("0", "1", "2"))
    opacities, opacity_frames = extract_track(decoded_rows, decoded_layout, "opacity_bank", ("",))
    mu = np.asarray(decoded_rows[:, property_indices(decoded_layout, ["lifetime_mu"])[0]], dtype=np.float32)
    lifetime_width = np.asarray(decoded_rows[:, property_indices(decoded_layout, ["lifetime_w"])[0]], dtype=np.float32)
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
    report: dict[str, object] = {"base_bytes": base_bytes, "profiles": {}}
    count = source_layout.vertex_count
    for name, tiers in args.profile:
        steps = np.empty(count, dtype=np.int32)
        tier_ids = np.empty(count, dtype=np.uint8)
        first = 0
        for tier_id, (fraction, step) in enumerate(tiers):
            last = int(round(count * fraction))
            selected = importance_order[first:last]
            steps[selected] = step
            tier_ids[selected] = tier_id
            first = last
        correction = np.rint(absolute_error / steps[:, None, None]).astype(np.int16)
        temporal_delta = np.diff(np.pad(correction, ((0, 0), (1, 0), (0, 0))), axis=1).astype("<i2")
        correction_stored = compressor.compress(temporal_delta.tobytes())
        tier_bits = max(1, int(np.ceil(np.log2(len(tiers)))))
        tier_planes = ((tier_ids[:, None] >> np.arange(tier_bits, dtype=np.uint8)) & 1).astype(np.uint8)
        tier_stored = compressor.compress(np.packbits(tier_planes.reshape(-1), bitorder="little").tobytes())
        corrected = decoded_quantized.copy()
        corrected[:, 1:] += correction.astype(np.int32) * steps[:, None, None]
        positions = minimum + corrected.astype(np.float32) / levels * (maximum - minimum)
        output = args.output_dir / f"position_{name}.raw4d"
        write_decoded_raw4d(
            output, manifest, sh, positions, rotations, colors, scales, opacities, mu, lifetime_width
        )
        (args.output_dir / f"position_{name}_correction.zst").write_bytes(correction_stored)
        (args.output_dir / f"position_{name}_tiers.zst").write_bytes(tier_stored)
        remaining = exact_quantized - corrected
        report["profiles"][name] = {
            "tiers": tiers,
            "correction_zstd_bytes": len(correction_stored),
            "tier_zstd_bytes": len(tier_stored),
            "encoded_position_bytes": base_bytes + len(correction_stored) + len(tier_stored),
            "remaining_integer_rmse": float(np.sqrt(np.mean(np.square(remaining), dtype=np.float64))),
            "remaining_integer_maximum": int(np.max(np.abs(remaining))),
            "output": str(output),
        }
    (args.output_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
