#!/usr/bin/env python3
"""Build one-attribute RAW4D ablations from a MINT-like non-SH archive."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from codec import extract_track, load_rows, read_raw4d_layout
from learnable_anchor_rate_sweep import encode_base
from mint_like_nonsh35 import write_ablation
from mint_like_nonsh35_attr import decode_archive


def main() -> None:
    parser = argparse.ArgumentParser(description="Create MINT-like non-SH attribute ablations")
    parser.add_argument("source", type=Path)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()

    manifest, decoded = decode_archive(args.archive)
    layout = read_raw4d_layout(args.source)
    rows = load_rows(layout)
    source = {
        "position": extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))[0],
        "rotation": extract_track(rows, layout, "rot_bank", ("w", "x", "y", "z"))[0],
        "scale": extract_track(rows, layout, "scale_bank", ("0", "1", "2"))[0],
        "opacity": extract_track(rows, layout, "opacity_bank", ("",))[0],
    }
    regenerated = encode_base(source["position"], float(manifest["base_codec"]["correction_ratio"]))
    order = regenerated.order
    source = {name: values[order] for name, values in source.items()}
    if not np.array_equal(regenerated.decoded, decoded["position"][:, 0]):
        raise AssertionError("Source and archive Morton base order do not match")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    outputs: dict[str, str] = {}
    for attribute in decoded:
        selected = {
            name: decoded[name] if name == attribute else source[name]
            for name in decoded
        }
        output = args.output_dir / f"{attribute}.raw4d"
        #WDD-gpt 2026-08-15 - 每次只替换一个MINT-like解码属性，其余属性保持源值，用真实渲染定位3.5MB码流瓶颈。
        write_ablation(args.source, output, selected, order)
        outputs[attribute] = str(output)

    report = {
        "source": str(args.source),
        "archive": str(args.archive),
        "profile_revision": manifest.get("profile_revision"),
        "outputs": outputs,
    }
    report_path = args.output_dir / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(report_path), **report}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
