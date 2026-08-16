#!/usr/bin/env python3
"""Create render ablations by replacing selected exact tracks with compact decoded tracks."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from codec import extract_track, load_rows, property_indices, read_raw4d_layout, write_decoded_raw4d
from compact40 import morton_codes


#WDD-gpt 2026-08-14 - 用单属性真实渲染消融分配紧凑码率，避免仅凭数值残差猜视觉权重。
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("compact_decoded", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument(
        "--decoded-order",
        choices=["source", "morton"],
        default="morton",
        help="Row order used by the decoded RAW4D file.",
    )
    parser.add_argument(
        "--modes",
        nargs="+",
        choices=["source_reference", "reference", "position", "rotation", "color", "scale", "opacity", "lifetime"],
        default=["reference", "position", "rotation", "color", "scale", "opacity", "lifetime"],
    )
    args = parser.parse_args()

    source_layout = read_raw4d_layout(args.source)
    source_rows = load_rows(source_layout)
    compact_layout = read_raw4d_layout(args.compact_decoded)
    compact_rows = load_rows(compact_layout)
    source_tracks = {
        "position": extract_track(source_rows, source_layout, "xyz_bank", ("x", "y", "z"))[0],
        "rotation": extract_track(source_rows, source_layout, "rot_bank", ("w", "x", "y", "z"))[0],
        "color": extract_track(source_rows, source_layout, "f_dc_bank", ("0", "1", "2"))[0],
        "scale": extract_track(source_rows, source_layout, "scale_bank", ("0", "1", "2"))[0],
        "opacity": extract_track(source_rows, source_layout, "opacity_bank", ("",))[0],
    }
    compact_tracks = {
        "position": extract_track(compact_rows, compact_layout, "xyz_bank", ("x", "y", "z"))[0],
        "rotation": extract_track(compact_rows, compact_layout, "rot_bank", ("w", "x", "y", "z"))[0],
        "color": extract_track(compact_rows, compact_layout, "f_dc_bank", ("0", "1", "2"))[0],
        "scale": extract_track(compact_rows, compact_layout, "scale_bank", ("0", "1", "2"))[0],
        "opacity": extract_track(compact_rows, compact_layout, "opacity_bank", ("",))[0],
    }
    # WDD-gpt 2026-08-14 - 同时支持源顺序安全码流与 Morton 顺序紧凑码流，防止错误行配对污染消融结论。
    order = np.arange(source_layout.vertex_count)
    if args.decoded_order == "morton":
        minimum = np.min(source_tracks["position"], axis=(0, 1))
        maximum = np.max(source_tracks["position"], axis=(0, 1))
        scale_xyz = (maximum - minimum) / np.float32(1023)
        #WDD-gpt 2026-08-15 - Morton重排必须逐位复现编码器除法式，乘法等价式会在FP16边界造成错行。
        q0 = np.rint((source_tracks["position"][:, 0] - minimum) / scale_xyz).clip(0, 1023).astype(np.uint16)
        order = np.argsort(morton_codes(q0), kind="stable")
    source_tracks = {name: values[order] for name, values in source_tracks.items()}

    source_mu = np.asarray(source_rows[:, property_indices(source_layout, ["lifetime_mu"])[0]], dtype=np.float32)[order]
    source_width = np.asarray(source_rows[:, property_indices(source_layout, ["lifetime_w"])[0]], dtype=np.float32)[order]
    compact_mu = np.asarray(compact_rows[:, property_indices(compact_layout, ["lifetime_mu"])[0]], dtype=np.float32)
    compact_width = np.asarray(compact_rows[:, property_indices(compact_layout, ["lifetime_w"])[0]], dtype=np.float32)
    source_sh = np.asarray(
        source_rows[:, property_indices(source_layout, [f"f_rest_{index}" for index in range(45)])],
        dtype=np.float32,
    )[order]
    compact_sh = np.asarray(
        compact_rows[:, property_indices(compact_layout, [f"f_rest_{index}" for index in range(45)])],
        dtype=np.float32,
    )
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
    for mode in args.modes:
        #WDD-gpt 2026-08-14 - 增加原始 SH 基准，单独量出 CoReSH-5R 的真实渲染损失。
        sh = source_sh if mode == "source_reference" else compact_sh
        tracks = {
            name: compact_tracks[name] if mode == name else source_tracks[name]
            for name in source_tracks
        }
        mu = compact_mu if mode == "lifetime" else source_mu
        width = compact_width if mode == "lifetime" else source_width
        write_decoded_raw4d(
            args.output_dir / f"{mode}.raw4d",
            manifest,
            sh,
            tracks["position"],
            tracks["rotation"],
            tracks["color"],
            tracks["scale"],
            tracks["opacity"],
            mu,
            width,
        )


if __name__ == "__main__":
    main()
