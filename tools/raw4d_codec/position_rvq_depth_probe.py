#!/usr/bin/env python3
"""Probe deeper shared trajectory RVQ banks with a high-precision Morton base."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import zstandard as zstd

from codec import extract_track, load_rows, property_indices, read_raw4d_layout, write_decoded_raw4d
from compact40 import encode_unsigned_varints, morton_codes, pack_bits, train_codebook


#WDD-gpt 2026-08-14 - 扫描共享轨迹残差 Bank 深度，用确定性逐级拟合替代逐高斯高精度视频残差。
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("sh_reference", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--depths", nargs="+", type=int, default=[4, 6, 8, 10])
    parser.add_argument("--position-bits", type=int, default=13)
    parser.add_argument("--coarse-bits", type=int, default=10)
    parser.add_argument(
        "--selection-fractions",
        nargs="+",
        type=float,
        help="Optional per-level highest-importance fractions; one value per level.",
    )
    parser.add_argument(
        "--selection-score",
        choices=["importance", "error_importance"],
        default="importance",
    )
    args = parser.parse_args()

    layout = read_raw4d_layout(args.source)
    rows = load_rows(layout)
    positions, position_frames = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    rotations, rotation_frames = extract_track(rows, layout, "rot_bank", ("w", "x", "y", "z"))
    colors, color_frames = extract_track(rows, layout, "f_dc_bank", ("0", "1", "2"))
    scales, scale_frames = extract_track(rows, layout, "scale_bank", ("0", "1", "2"))
    opacities, opacity_frames = extract_track(rows, layout, "opacity_bank", ("",))
    mu = np.asarray(rows[:, property_indices(layout, ["lifetime_mu"])[0]], dtype=np.float32)
    lifetime_width = np.asarray(rows[:, property_indices(layout, ["lifetime_w"])[0]], dtype=np.float32)
    minimum = np.min(positions, axis=(0, 1)).astype(np.float32)
    maximum = np.max(positions, axis=(0, 1)).astype(np.float32)
    coarse_levels = np.float32((1 << args.coarse_bits) - 1)
    position_levels = np.float32((1 << args.position_bits) - 1)
    coarse = np.rint((positions[:, 0] - minimum) / (maximum - minimum) * coarse_levels).clip(
        0, int(coarse_levels)
    ).astype(np.uint16)
    order = np.argsort(morton_codes(coarse), kind="stable")
    positions = positions[order]
    coarse = coarse[order]
    rotations = rotations[order]
    colors = colors[order]
    scales = scales[order]
    opacities = opacities[order]
    mu = mu[order]
    lifetime_width = lifetime_width[order]
    alpha = 1 / (1 + np.exp(-np.clip(opacities, -16, 16)))
    radius = np.exp(np.clip(np.max(scales, axis=(1, 2)), -16, 2))
    importance = np.max(alpha, axis=(1, 2)) * radius
    importance_order = np.argsort(-importance, kind="stable")

    morton = morton_codes(coarse)
    morton_delta = np.empty(layout.vertex_count, dtype=np.uint32)
    morton_delta[0] = morton[0]
    morton_delta[1:] = morton[1:] - morton[:-1]
    compressor = zstd.ZstdCompressor(level=19, threads=0)
    base_morton = compressor.compress(encode_unsigned_varints(morton_delta))
    base_quantized = np.rint(
        (positions[:, 0] - minimum) / (maximum - minimum) * position_levels
    ).astype(np.int32)
    reconstructed_coarse = np.rint(coarse.astype(np.float32) / coarse_levels * position_levels).astype(np.int32)
    fine = base_quantized - reconstructed_coarse
    fine_minimum = np.min(fine, axis=0).astype(np.int32)
    fine_unsigned = (fine - fine_minimum).astype(np.uint32)
    fine_bits = int(math.ceil(math.log2(int(np.max(fine_unsigned)) + 1)))
    base_fine = compressor.compress(pack_bits(fine_unsigned, fine_bits))
    base = minimum + base_quantized.astype(np.float32) / position_levels * (maximum - minimum)

    global_order = np.argsort(morton_codes(np.rint(
        (extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))[0][:, 0] - minimum)
        / (maximum - minimum) * coarse_levels
    ).astype(np.uint16)), kind="stable")
    source_to_sh = np.empty(layout.vertex_count, dtype=np.int64)
    source_to_sh[global_order] = np.arange(layout.vertex_count)
    sh_layout = read_raw4d_layout(args.sh_reference)
    sh_rows = load_rows(sh_layout)
    sh_morton = np.asarray(
        sh_rows[:, property_indices(sh_layout, [f"f_rest_{index}" for index in range(45)])], dtype=np.float32
    )
    sh = sh_morton[source_to_sh[order]]

    motion = (positions[:, 1:] - positions[:, :1]).reshape(layout.vertex_count, -1)
    residual = motion.copy()
    reconstructed_motion = np.zeros_like(motion)
    rng = np.random.default_rng(20260814)
    sample_indices = rng.choice(layout.vertex_count, size=min(layout.vertex_count, 65536), replace=False)
    codebooks: list[np.ndarray] = []
    labels: list[np.ndarray] = []
    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "gaussian_count": layout.vertex_count,
        "total_frames": layout.total_frames,
        "attributes": {
            "position": {"keyframes": position_frames},
            "rotation": {"keyframes": rotation_frames},
            "color_dc": {"keyframes": color_frames},
            "scale": {"keyframes": scale_frames},
            "opacity": {"keyframes": opacity_frames},
        },
    }
    report: dict[str, object] = {
        "base_morton_zstd_bytes": len(base_morton),
        "base_fine_zstd_bytes": len(base_fine),
        "depths": {},
    }
    requested = set(args.depths)
    if args.selection_fractions and len(args.selection_fractions) != max(args.depths):
        raise ValueError("selection-fractions must contain exactly max(depths) values")
    for level in range(1, max(args.depths) + 1):
        selection_fraction = args.selection_fractions[level - 1] if args.selection_fractions else 1.0
        selected_count = max(1, int(round(layout.vertex_count * selection_fraction)))
        if args.selection_score == "error_importance" and selected_count < layout.vertex_count:
            track_error = np.max(
                np.linalg.norm(residual.reshape(layout.vertex_count, 10, 3), axis=2), axis=1
            )
            selection_order = np.argsort(-(track_error * importance), kind="stable")
        else:
            selection_order = importance_order
        selected = selection_order[:selected_count]
        if selected_count == layout.vertex_count:
            level_sample = sample_indices
        else:
            level_sample = rng.choice(selected_count, size=min(selected_count, 65536), replace=False)
        codebook, selected_labels = train_codebook(
            residual[selected], 256, 20260840 + level - 1, level_sample, reserve_zero=True
        )
        current_labels = np.zeros(layout.vertex_count, dtype=np.uint16)
        current_labels[selected] = selected_labels
        codebooks.append(codebook.astype(np.float16))
        labels.append(current_labels.astype(np.uint8))
        contribution = codebook[current_labels]
        reconstructed_motion += contribution
        residual -= contribution
        if level not in requested:
            continue
        codebook_array = np.stack(codebooks).astype("<f2")
        label_array = np.stack(labels, axis=1).astype(np.uint8)
        codebook_stored = compressor.compress(codebook_array.tobytes())
        label_stored = compressor.compress(label_array.tobytes())
        map_width = 576
        map_height = math.ceil(layout.vertex_count / map_width)
        label_frames = np.zeros((level, map_height * map_width), dtype=np.uint8)
        label_frames[:, :layout.vertex_count] = label_array.T
        label_video_raw = args.output_dir / f"position_rvq{level}_labels_gray8.raw"
        label_video_raw.write_bytes(label_frames.tobytes())
        decoded_position = np.concatenate([
            base[:, None, :],
            base[:, None, :] + reconstructed_motion.reshape(layout.vertex_count, 10, 3),
        ], axis=1)
        output = args.output_dir / f"position_rvq{level}.raw4d"
        write_decoded_raw4d(
            output, manifest, sh, decoded_position, rotations, colors, scales, opacities, mu, lifetime_width
        )
        error = decoded_position - positions
        report["depths"][str(level)] = {
            "codebook_zstd_bytes": len(codebook_stored),
            "labels_zstd_bytes": len(label_stored),
            "label_map_size": [map_width, map_height],
            "label_video_raw": str(label_video_raw),
            "encoded_position_bytes": len(base_morton) + len(base_fine) + len(codebook_stored) + len(label_stored),
            "position_rmse": float(np.sqrt(np.mean(np.square(error), dtype=np.float64))),
            "position_vector_p99": float(np.percentile(np.linalg.norm(error, axis=2), 99)),
            "position_vector_maximum": float(np.max(np.linalg.norm(error, axis=2))),
            "last_level_selection_fraction": selection_fraction,
            "output": str(output),
        }
        print(json.dumps({str(level): report["depths"][str(level)]}, ensure_ascii=False), flush=True)
    (args.output_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
