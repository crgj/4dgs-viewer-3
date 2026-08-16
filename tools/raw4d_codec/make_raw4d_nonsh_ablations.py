#!/usr/bin/env python3
"""Create one-attribute RAW4D ablations from a decoded RAW4D candidate."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from codec import extract_track, load_rows, read_raw4d_layout
from learnable_anchor_rate_sweep import decode_candidate, encode_base
from mint_like_nonsh35 import write_ablation


TRACKS = {
    "position": ("xyz_bank", ("x", "y", "z")),
    "rotation": ("rot_bank", ("w", "x", "y", "z")),
    "scale": ("scale_bank", ("0", "1", "2")),
    "opacity": ("opacity_bank", ("",)),
}


def load_nonsh(path: Path) -> tuple[dict[str, np.ndarray], dict[str, list[int]]]:
    layout = read_raw4d_layout(path)
    rows = load_rows(layout)
    values: dict[str, np.ndarray] = {}
    frames: dict[str, list[int]] = {}
    for name, (prefix, components) in TRACKS.items():
        values[name], frames[name] = extract_track(rows, layout, prefix, components)
    return values, frames


def main() -> None:
    parser = argparse.ArgumentParser(description="Create one-non-SH-attribute RAW4D ablations")
    parser.add_argument("source", type=Path)
    parser.add_argument("decoded", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument(
        "--position-laf",
        type=Path,
        help="LAF archive whose deterministic Morton order is used by the decoded RAW4D",
    )
    args = parser.parse_args()

    source, source_frames = load_nonsh(args.source)
    decoded, decoded_frames = load_nonsh(args.decoded)
    if source_frames != decoded_frames:
        raise ValueError("Source and decoded sparse keyframes differ")
    if any(source[name].shape != decoded[name].shape for name in TRACKS):
        raise ValueError("Source and decoded non-SH shapes differ")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    order = np.arange(source["position"].shape[0], dtype=np.int64)
    if args.position_laf:
        laf_manifest, laf_positions = decode_candidate(args.position_laf)
        regenerated = encode_base(
            source["position"],
            float(laf_manifest["base_codec"]["correction_ratio"]),
        )
        if not np.array_equal(regenerated.decoded, laf_positions[:, 0]):
            raise ValueError("Position LAF does not match the source Morton base")
        order = regenerated.order
        #WDD-gpt 2026-08-15 - LAF候选按Morton重排，单属性消融必须同步重排所有源属性与静态SH。
        source = {name: values[order] for name, values in source.items()}
    outputs: dict[str, str] = {}
    for attribute in TRACKS:
        selected = {
            name: decoded[name] if name == attribute else source[name]
            for name in TRACKS
        }
        output = args.output_dir / f"{attribute}.raw4d"
        #WDD-gpt 2026-08-15 - 每个资产只替换一个候选非SH属性，用同一渲染器定位最低PSNR责任流。
        write_ablation(args.source, output, selected, order)
        outputs[attribute] = str(output)

    report = {
        "source": str(args.source),
        "decoded": str(args.decoded),
        "position_laf": None if args.position_laf is None else str(args.position_laf),
        "source_order": "identity" if args.position_laf is None else "laf_morton",
        "keyframes": source_frames,
        "outputs": outputs,
    }
    report_path = args.output_dir / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(report_path), **report}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
