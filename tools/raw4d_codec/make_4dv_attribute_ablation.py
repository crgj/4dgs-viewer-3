#!/usr/bin/env python3
"""Build 4DV-style rotation and DC-color render ablations."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import zstandard as zstd

from codec import (
    C0,
    decode_quaternions,
    encode_quaternions,
    extract_track,
    load_rows,
    property_indices,
    read_raw4d_layout,
    write_decoded_raw4d,
)
from compact40 import morton_codes


BLOCK_SIZE = 256


def quantize_color_4dv(values: np.ndarray) -> tuple[np.ndarray, dict[str, float | int]]:
    count = values.shape[0]
    chunks = (count + BLOCK_SIZE - 1) // BLOCK_SIZE
    padding = chunks * BLOCK_SIZE - count
    padded = np.pad(values, ((0, padding), (0, 0), (0, 0)), mode="edge")
    blocks = padded.reshape(chunks, BLOCK_SIZE, 2, 3)
    minimum = np.min(blocks, axis=1)
    maximum = np.max(blocks, axis=1)
    step = np.where(maximum > minimum, (maximum - minimum) / 255, 1).astype(np.float32)
    quantized = np.rint((blocks - minimum[:, None]) / step[:, None]).clip(0, 255).astype(np.uint8)
    decoded = minimum[:, None] + quantized.astype(np.float32) * step[:, None]
    decoded = decoded.reshape(-1, 2, 3)[:count]
    #WDD-gpt 2026-08-14 - 按4DV的256高斯块局部范围量化DC，实测质量和真实zstd字节。
    raw = np.stack([minimum, maximum], axis=1).astype("<f2").tobytes()
    raw += quantized.reshape(-1, 2, 3)[:count].tobytes()
    error = np.abs(decoded - values) * C0
    return decoded, {
        "chunks": chunks,
        "raw_bytes": len(raw),
        "zstd_bytes": len(zstd.ZstdCompressor(level=8).compress(raw)),
        "mean_rgb_error": float(np.mean(error)),
        "p99_rgb_error": float(np.percentile(error, 99)),
        "maximum_rgb_error": float(np.max(error)),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("compact_decoded", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()

    source_layout = read_raw4d_layout(args.source)
    source_rows = load_rows(source_layout)
    compact_layout = read_raw4d_layout(args.compact_decoded)
    compact_rows = load_rows(compact_layout)
    tracks = {
        "position": extract_track(source_rows, source_layout, "xyz_bank", ("x", "y", "z"))[0],
        "rotation": extract_track(source_rows, source_layout, "rot_bank", ("w", "x", "y", "z"))[0],
        "color": extract_track(source_rows, source_layout, "f_dc_bank", ("0", "1", "2"))[0],
        "scale": extract_track(source_rows, source_layout, "scale_bank", ("0", "1", "2"))[0],
        "opacity": extract_track(source_rows, source_layout, "opacity_bank", ("",))[0],
    }
    compact_tracks = {
        "position": extract_track(compact_rows, compact_layout, "xyz_bank", ("x", "y", "z"))[0],
        "scale": extract_track(compact_rows, compact_layout, "scale_bank", ("0", "1", "2"))[0],
        "opacity": extract_track(compact_rows, compact_layout, "opacity_bank", ("",))[0],
    }
    minimum = np.min(tracks["position"], axis=(0, 1))
    maximum = np.max(tracks["position"], axis=(0, 1))
    q0 = np.rint((tracks["position"][:, 0] - minimum) / (maximum - minimum) * 1023)
    q0 = q0.clip(0, 1023).astype(np.uint16)
    order = np.argsort(morton_codes(q0), kind="stable")
    tracks = {name: values[order] for name, values in tracks.items()}

    packed_rotation, rotation_metrics = encode_quaternions(tracks["rotation"], bits=10)
    decoded_rotation = decode_quaternions(packed_rotation, tracks["rotation"].shape[:-1], bits=10)
    rotation_raw = packed_rotation.tobytes()
    rotation_metrics.update({
        "raw_bytes": len(rotation_raw),
        "zstd_bytes": len(zstd.ZstdCompressor(level=8).compress(rotation_raw)),
    })
    decoded_color, color_metrics = quantize_color_4dv(tracks["color"])

    source_mu = np.asarray(
        source_rows[:, property_indices(source_layout, ["lifetime_mu"])[0]], dtype=np.float32
    )[order]
    source_width = np.asarray(
        source_rows[:, property_indices(source_layout, ["lifetime_w"])[0]], dtype=np.float32
    )[order]
    compact_sh = np.asarray(
        compact_rows[:, property_indices(compact_layout, [f"f_rest_{index}" for index in range(45)])],
        dtype=np.float32,
    )
    compact_mu = np.asarray(
        compact_rows[:, property_indices(compact_layout, ["lifetime_mu"])[0]], dtype=np.float32
    )
    compact_width = np.asarray(
        compact_rows[:, property_indices(compact_layout, ["lifetime_w"])[0]], dtype=np.float32
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
    variants = {
        "rotation_4dv": (decoded_rotation, tracks["color"]),
        "color_4dv": (tracks["rotation"], decoded_color),
        "rotation_color_4dv": (decoded_rotation, decoded_color),
    }
    for name, (rotation, color) in variants.items():
        write_decoded_raw4d(
            args.output_dir / f"{name}.raw4d",
            manifest,
            compact_sh,
            tracks["position"],
            rotation,
            color,
            tracks["scale"],
            tracks["opacity"],
            source_mu,
            source_width,
        )
    #WDD-gpt 2026-08-14 - 将4DV旋转和DC替换进完整Compact解码属性，验证组合后的端到端质量。
    write_decoded_raw4d(
        args.output_dir / "hybrid_full_4dv.raw4d",
        manifest,
        compact_sh,
        compact_tracks["position"],
        decoded_rotation,
        decoded_color,
        compact_tracks["scale"],
        compact_tracks["opacity"],
        compact_mu,
        compact_width,
    )
    (args.output_dir / "metrics.json").write_text(json.dumps(
        {"rotation": rotation_metrics, "color_dc": color_metrics},
        indent=2,
        sort_keys=True,
    ))


if __name__ == "__main__":
    main()
