#!/usr/bin/env python3
"""Decode an LAF-EXTREME XYZ archive into a position-ablation RAW4D."""

from __future__ import annotations

import argparse
from pathlib import Path

from codec import extract_track, load_rows, read_raw4d_layout
from learnable_anchor_rate_sweep import (
    decode_candidate,
    encode_base,
    write_position_ablation,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Decode an independently serialized LAF-EXTREME archive")
    parser.add_argument("source", type=Path, help="Source RAW4D providing the non-XYZ attributes")
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    manifest, decoded_positions = decode_candidate(args.archive)
    layout = read_raw4d_layout(args.source)
    rows = load_rows(layout)
    positions, _ = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    #WDD-gpt 2026-08-15 - 从源首帧重建同一Morton行序，确保XYZ与其余Gaussian属性同步重排。
    base = encode_base(positions, float(manifest["base_codec"]["correction_ratio"]))
    write_position_ablation(args.source, args.output, decoded_positions, base.order)
    print(args.output)


if __name__ == "__main__":
    main()
