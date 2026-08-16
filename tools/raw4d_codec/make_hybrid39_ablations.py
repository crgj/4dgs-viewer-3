#!/usr/bin/env python3
"""Create exact-attribute repair ablations for a decoded SharedMotion9 stream."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from codec import (  # noqa: E402
    decode_sh_rvq5,
    extract_track,
    load_rows,
    property_indices,
    read_container,
    read_raw4d_layout,
    write_decoded_raw4d,
)
from compact40 import morton_codes  # noqa: E402


def tracks(path: Path) -> tuple[object, object, dict[str, np.ndarray], np.ndarray, np.ndarray]:
    layout = read_raw4d_layout(path)
    rows = load_rows(layout)
    values = {
        "position": extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))[0],
        "rotation": extract_track(rows, layout, "rot_bank", ("w", "x", "y", "z"))[0],
        "color": extract_track(rows, layout, "f_dc_bank", ("0", "1", "2"))[0],
        "scale": extract_track(rows, layout, "scale_bank", ("0", "1", "2"))[0],
        "opacity": extract_track(rows, layout, "opacity_bank", ("",))[0],
    }
    mu = np.asarray(rows[:, property_indices(layout, ["lifetime_mu"])[0]], dtype=np.float32)
    width = np.asarray(rows[:, property_indices(layout, ["lifetime_w"])[0]], dtype=np.float32)
    return layout, rows, values, mu, width


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("container", type=Path)
    parser.add_argument("decoded", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()

    source_layout, _, source, source_mu, source_width = tracks(args.source)
    _, _, decoded, decoded_mu, decoded_width = tracks(args.decoded)
    minimum = np.min(source["position"], axis=(0, 1)).astype(np.float32)
    maximum = np.max(source["position"], axis=(0, 1)).astype(np.float32)
    base_step = (maximum - minimum) / np.float32(1023)
    quantized = np.rint((source["position"][:, 0] - minimum) / base_step).clip(0, 1023).astype(np.uint16)
    order = np.argsort(morton_codes(quantized), kind="stable")
    source = {name: value[order] for name, value in source.items()}
    source_mu = source_mu[order]
    source_width = source_width[order]

    manifest, streams = read_container(args.container)
    sh = decode_sh_rvq5(streams["coresh5r"])
    repairs = {
        "exact_position": {"position"},
        "exact_rotation": {"rotation"},
        "exact_color": {"color"},
        "exact_scale": {"scale"},
        "exact_opacity": {"opacity"},
        "exact_lifetime": {"lifetime"},
        "exact_nonposition": {"rotation", "color", "scale", "opacity", "lifetime"},
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, str] = {}
    for label, repaired in repairs.items():
        selected = {
            name: source[name] if name in repaired else decoded[name]
            for name in decoded
        }
        mu = source_mu if "lifetime" in repaired else decoded_mu
        width = source_width if "lifetime" in repaired else decoded_width
        output = args.output_dir / f"{label}.raw4d"
        #WDD-gpt 2026-08-15 - 每个消融只精确回填一个属性，直接定位39 dB门限的真实渲染瓶颈。
        write_decoded_raw4d(
            output,
            manifest,
            sh,
            selected["position"],
            selected["rotation"],
            selected["color"],
            selected["scale"],
            selected["opacity"],
            mu,
            width,
        )
        report[label] = str(output)
    print(json.dumps({"gaussian_count": source_layout.vertex_count, "outputs": report}, indent=2))


if __name__ == "__main__":
    main()
