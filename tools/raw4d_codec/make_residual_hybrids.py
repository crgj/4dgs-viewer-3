#!/usr/bin/env python3
"""Create decoded RAW4D hybrids that repair only the highest-impact residuals."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from codec import extract_track, load_rows, property_indices, read_raw4d_layout, write_decoded_raw4d
from compact40 import morton_codes


def sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(values, -16, 16)))


# WDD-gpt 2026-08-14 - 用实际解码残差乘渲染贡献选择逃逸项，验证可变码率是否能在少量高斯上恢复质量。
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("compact_decoded", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--fractions", nargs="+", type=float, default=[0.05, 0.1, 0.2, 0.4, 0.6])
    args = parser.parse_args()

    source_layout = read_raw4d_layout(args.source)
    source_rows = load_rows(source_layout)
    compact_layout = read_raw4d_layout(args.compact_decoded)
    compact_rows = load_rows(compact_layout)
    track_specs = {
        "position": ("xyz_bank", ("x", "y", "z")),
        "rotation": ("rot_bank", ("w", "x", "y", "z")),
        "color": ("f_dc_bank", ("0", "1", "2")),
        "scale": ("scale_bank", ("0", "1", "2")),
        "opacity": ("opacity_bank", ("",)),
    }
    source_tracks = {
        name: extract_track(source_rows, source_layout, prefix, components)[0]
        for name, (prefix, components) in track_specs.items()
    }
    compact_tracks = {
        name: extract_track(compact_rows, compact_layout, prefix, components)[0]
        for name, (prefix, components) in track_specs.items()
    }

    minimum = np.min(source_tracks["position"], axis=(0, 1))
    maximum = np.max(source_tracks["position"], axis=(0, 1))
    q0 = np.rint((source_tracks["position"][:, 0] - minimum) / (maximum - minimum) * 1023).clip(0, 1023).astype(np.uint16)
    order = np.argsort(morton_codes(q0), kind="stable")
    source_tracks = {name: values[order] for name, values in source_tracks.items()}

    source_mu = np.asarray(source_rows[:, property_indices(source_layout, ["lifetime_mu"])[0]], dtype=np.float32)[order]
    source_width = np.asarray(source_rows[:, property_indices(source_layout, ["lifetime_w"])[0]], dtype=np.float32)[order]
    compact_mu = np.asarray(compact_rows[:, property_indices(compact_layout, ["lifetime_mu"])[0]], dtype=np.float32)
    compact_width = np.asarray(compact_rows[:, property_indices(compact_layout, ["lifetime_w"])[0]], dtype=np.float32)
    sh = np.asarray(compact_rows[:, property_indices(compact_layout, [f"f_rest_{index}" for index in range(45)])], dtype=np.float32)

    alpha = np.max(sigmoid(source_tracks["opacity"]), axis=(1, 2))
    radius = np.exp(np.clip(np.max(source_tracks["scale"], axis=(1, 2)), -16, 2))
    contribution = np.maximum(alpha * radius, 1e-8)
    position_error = np.max(np.linalg.norm(compact_tracks["position"] - source_tracks["position"], axis=2), axis=1)
    source_rot = source_tracks["rotation"] / np.maximum(np.linalg.norm(source_tracks["rotation"], axis=2, keepdims=True), 1e-12)
    compact_rot = compact_tracks["rotation"] / np.maximum(np.linalg.norm(compact_tracks["rotation"], axis=2, keepdims=True), 1e-12)
    rotation_error = np.max(2 * np.arccos(np.abs(np.sum(source_rot * compact_rot, axis=2)).clip(0, 1)), axis=1)
    color_error = np.max(np.abs(compact_tracks["color"] - source_tracks["color"]), axis=(1, 2))
    scale_error = np.max(np.abs(np.expm1(compact_tracks["scale"] - source_tracks["scale"])), axis=(1, 2))
    opacity_error = np.max(np.abs(sigmoid(compact_tracks["opacity"]) - sigmoid(source_tracks["opacity"])), axis=(1, 2))
    lifetime_error = np.maximum(np.abs(compact_mu - source_mu), np.abs(compact_width - source_width))
    scores = {
        "position": contribution * position_error,
        "rotation": contribution * rotation_error,
        "color": contribution * color_error,
        "scale": contribution * scale_error,
        "opacity": np.maximum(radius, 1e-8) * opacity_error,
        "lifetime": contribution * lifetime_error,
    }
    rankings = {name: np.argsort(score)[::-1] for name, score in scores.items()}

    manifest = {
        "gaussian_count": source_layout.vertex_count,
        "total_frames": source_layout.total_frames,
        "attributes": {
            "position": {"keyframes": list(range(0, 31, 3))},
            "rotation": {"keyframes": [0, 30]},
            "color_dc": {"keyframes": [0, 30]},
            "scale": {"keyframes": [0, 10, 20, 30]},
            "opacity": {"keyframes": [0, 10, 20, 30]},
        },
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {"fractions": {}}
    count = source_layout.vertex_count
    for fraction in args.fractions:
        selected_count = min(count, max(0, int(round(count * fraction))))
        repaired = {name: values.copy() for name, values in compact_tracks.items()}
        for name in repaired:
            selected = rankings[name][:selected_count]
            repaired[name][selected] = source_tracks[name][selected]
        repaired_mu = compact_mu.copy()
        repaired_width = compact_width.copy()
        selected_life = rankings["lifetime"][:selected_count]
        repaired_mu[selected_life] = source_mu[selected_life]
        repaired_width[selected_life] = source_width[selected_life]
        label = f"repair_{int(round(fraction * 100)):02d}pct"
        output = args.output_dir / f"{label}.raw4d"
        write_decoded_raw4d(
            output,
            manifest,
            sh,
            repaired["position"],
            repaired["rotation"],
            repaired["color"],
            repaired["scale"],
            repaired["opacity"],
            repaired_mu,
            repaired_width,
        )
        report["fractions"][label] = {
            "fraction": fraction,
            "selected_per_attribute": selected_count,
            "output": str(output),
        }
    (args.output_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
