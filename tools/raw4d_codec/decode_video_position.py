#!/usr/bin/env python3
"""Decode a video-motion position probe into a renderable RAW4D ablation."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import zstandard as zstd

from codec import (
    extract_track,
    load_rows,
    property_indices,
    read_raw4d_layout,
    write_decoded_raw4d,
)
from compact40 import (
    decode_unsigned_varints,
    morton_xyz,
    unpack_bits,
)


#WDD-gpt 2026-08-14 - 从实际 AV1 解码结果累计运动，生成可渲染消融文件，禁止用编码端原值代替解码验收。
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("probe_dir", type=Path)
    parser.add_argument("sh_reference", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--crf", type=int, required=True)
    parser.add_argument("--width", type=int, default=576)
    args = parser.parse_args()

    report = json.loads((args.probe_dir / "report.json").read_text(encoding="utf-8"))
    count = int(report["gaussian_count"])
    keys = len(report["keyframes"])
    position_bits = int(report["position_bits"])
    coarse_bits = int(report["coarse_bits"])
    video_bits = int(report["video_bits"])
    fine_bits = int(report["base"]["fine_bits"])
    fine_minimum = np.asarray(report["base"]["fine_minimum"], dtype=np.int32)

    decompressor = zstd.ZstdDecompressor()
    morton_payload = decompressor.decompress((args.probe_dir / "position_base_morton.zst").read_bytes())
    morton_delta = decode_unsigned_varints(morton_payload, count)
    morton = np.cumsum(morton_delta.astype(np.uint64), dtype=np.uint64).astype(np.uint32)
    coarse = morton_xyz(morton).astype(np.float32)
    coarse_levels = np.float32((1 << coarse_bits) - 1)
    position_levels = np.float32((1 << position_bits) - 1)
    base = np.rint(coarse / coarse_levels * position_levels).astype(np.int32)
    fine_payload = decompressor.decompress((args.probe_dir / "position_base_fine.zst").read_bytes())
    fine = unpack_bits(fine_payload, count * 3, fine_bits).reshape(count, 3).astype(np.int32)
    base += fine + fine_minimum

    height = math.ceil(count / args.width)
    video_height = height * 3
    video_path = args.probe_dir / f"position_motion_av1_crf{args.crf}.mkv"
    with tempfile.TemporaryDirectory(prefix="decode-position-video-") as temp_name:
        raw_path = Path(temp_name) / "motion.raw"
        result = subprocess.run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(video_path),
            "-f", "rawvideo", "-pix_fmt", f"gray{video_bits}le", str(raw_path),
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if result.returncode:
            raise RuntimeError(result.stderr.decode("utf-8", errors="replace")[-4000:])
        decoded_frames = np.fromfile(raw_path, dtype="<u2").reshape(keys - 1, 3, height * args.width)
    mapped_motion = decoded_frames[:, :, :count].transpose(2, 0, 1).astype(np.int32)
    motion = mapped_motion - (1 << (video_bits - 1))
    quantized = np.empty((count, keys, 3), dtype=np.int32)
    quantized[:, 0] = base
    quantized[:, 1:] = base[:, None, :] + np.cumsum(motion, axis=1)
    minimum = np.asarray(report["minimum"], dtype=np.float32)
    maximum = np.asarray(report["maximum"], dtype=np.float32)
    positions = minimum + quantized.astype(np.float32) / position_levels * (maximum - minimum)

    source_layout = read_raw4d_layout(args.source)
    source_rows = load_rows(source_layout)
    source_positions = extract_track(source_rows, source_layout, "xyz_bank", ("x", "y", "z"))[0]
    minimum_source = np.min(source_positions, axis=(0, 1))
    maximum_source = np.max(source_positions, axis=(0, 1))
    coarse_source = np.rint(
        (source_positions[:, 0] - minimum_source) / (maximum_source - minimum_source) * ((1 << coarse_bits) - 1)
    ).clip(0, (1 << coarse_bits) - 1).astype(np.uint16)
    from compact40 import morton_codes

    order = np.argsort(morton_codes(coarse_source), kind="stable")
    rotations, _ = extract_track(source_rows, source_layout, "rot_bank", ("w", "x", "y", "z"))
    colors, _ = extract_track(source_rows, source_layout, "f_dc_bank", ("0", "1", "2"))
    scales, _ = extract_track(source_rows, source_layout, "scale_bank", ("0", "1", "2"))
    opacities, _ = extract_track(source_rows, source_layout, "opacity_bank", ("",))
    mu = np.asarray(source_rows[:, property_indices(source_layout, ["lifetime_mu"])[0]], dtype=np.float32)[order]
    lifetime_width = np.asarray(
        source_rows[:, property_indices(source_layout, ["lifetime_w"])[0]], dtype=np.float32
    )[order]

    sh_layout = read_raw4d_layout(args.sh_reference)
    sh_rows = load_rows(sh_layout)
    sh = np.asarray(
        sh_rows[:, property_indices(sh_layout, [f"f_rest_{index}" for index in range(45)])], dtype=np.float32
    )
    manifest = {
        "gaussian_count": count,
        "total_frames": source_layout.total_frames,
        "attributes": {
            "position": {"keyframes": report["keyframes"]},
            "rotation": {"keyframes": [0, 30]},
            "color_dc": {"keyframes": [0, 30]},
            "scale": {"keyframes": [0, 10, 20, 30]},
            "opacity": {"keyframes": [0, 10, 20, 30]},
        },
    }
    write_decoded_raw4d(
        args.output,
        manifest,
        sh,
        positions,
        rotations[order],
        colors[order],
        scales[order],
        opacities[order],
        mu,
        lifetime_width,
    )
    source_sorted = source_positions[order]
    error = positions - source_sorted
    result = {
        "output": str(args.output),
        "bytes": args.output.stat().st_size,
        "position_rmse": float(np.sqrt(np.mean(np.square(error), dtype=np.float64))),
        "position_maximum_absolute_error": float(np.max(np.abs(error))),
        "position_vector_p99": float(np.percentile(np.linalg.norm(error, axis=2), 99)),
        "video_bytes": video_path.stat().st_size,
        "encoded_position_bytes": video_path.stat().st_size
        + (args.probe_dir / "position_base_morton.zst").stat().st_size
        + (args.probe_dir / "position_base_fine.zst").stat().st_size,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
