#!/usr/bin/env python3
"""Probe quantize-first, video-coded RAW4D position motion layers."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np
import zstandard as zstd

from codec import extract_track, load_rows, read_raw4d_layout
from compact40 import encode_unsigned_varints, morton_codes, morton_xyz, pack_bits


def run(command: list[str]) -> float:
    started = time.perf_counter()
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace")[-4000:])
    return time.perf_counter() - started


def encode_gray_video(
    values: np.ndarray,
    output: Path,
    width: int,
    bits: int,
    crf: int,
    temp: Path,
) -> dict[str, object]:
    count, frames, channels = values.shape
    height = math.ceil(count / width)
    video_height = height * channels
    raw_path = temp / f"{output.stem}.raw"
    with raw_path.open("wb") as handle:
        for key in range(frames):
            planes = np.zeros((channels, height * width), dtype="<u2")
            planes[:, :count] = values[:, key, :].T
            handle.write(planes.tobytes())
    pixel_format = f"gray{bits}le"
    command = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pixel_format", pixel_format,
        "-video_size", f"{width}x{video_height}", "-framerate", "1",
        "-i", str(raw_path), "-c:v", "libaom-av1", "-crf", str(crf),
        "-b:v", "0", "-cpu-used", "6", "-row-mt", "1",
        "-pix_fmt", pixel_format, "-f", "matroska", str(output),
    ]
    encode_seconds = run(command)
    decoded_path = temp / f"{output.stem}.decoded.raw"
    decode_seconds = run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(output),
        "-f", "rawvideo", "-pix_fmt", pixel_format, str(decoded_path),
    ])
    decoded_frames = np.fromfile(decoded_path, dtype="<u2").reshape(frames, channels, height * width)
    decoded = decoded_frames[:, :, :count].transpose(2, 0, 1)
    delta = decoded.astype(np.int32) - values.astype(np.int32)
    return {
        "path": str(output),
        "bytes": output.stat().st_size,
        "encode_seconds": encode_seconds,
        "decode_seconds": decode_seconds,
        "exact": bool(np.all(delta == 0)),
        "integer_rmse": float(np.sqrt(np.mean(np.square(delta), dtype=np.float64))),
        "integer_p99": float(np.percentile(np.abs(delta), 99)),
        "integer_maximum": int(np.max(np.abs(delta))),
    }


#WDD-gpt 2026-08-14 - 先量化和稳定排序，再把首帧粗坐标与有符号运动层分开交给视频编码器。
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--position-bits", type=int, default=13)
    parser.add_argument("--coarse-bits", type=int, default=10)
    parser.add_argument("--video-bits", type=int, default=12)
    parser.add_argument("--width", type=int, default=576)
    parser.add_argument("--crfs", nargs="+", type=int, default=[0, 1, 2, 4, 8])
    args = parser.parse_args()

    if args.position_bits <= args.coarse_bits:
        raise ValueError("position-bits must exceed coarse-bits")
    layout = read_raw4d_layout(args.source)
    rows = load_rows(layout)
    positions, frames = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    minimum = np.min(positions, axis=(0, 1)).astype(np.float32)
    maximum = np.max(positions, axis=(0, 1)).astype(np.float32)
    position_levels = np.float32((1 << args.position_bits) - 1)
    position_step = (maximum - minimum) / position_levels
    quantized = np.rint((positions - minimum) / position_step).clip(0, int(position_levels)).astype(np.int32)

    coarse_levels = np.float32((1 << args.coarse_bits) - 1)
    coarse = np.rint((positions[:, 0] - minimum) / (maximum - minimum) * coarse_levels).clip(
        0, int(coarse_levels)
    ).astype(np.uint16)
    order = np.argsort(morton_codes(coarse), kind="stable")
    quantized = quantized[order]
    coarse = coarse[order]

    morton = morton_codes(coarse)
    morton_delta = np.empty(layout.vertex_count, dtype=np.uint32)
    morton_delta[0] = morton[0]
    morton_delta[1:] = morton[1:] - morton[:-1]
    coarse_payload = encode_unsigned_varints(morton_delta)
    reconstructed_coarse = morton_xyz(morton).astype(np.float32)
    reconstructed_coarse = np.rint(reconstructed_coarse / coarse_levels * position_levels).astype(np.int32)
    fine = quantized[:, 0] - reconstructed_coarse
    fine_minimum = np.min(fine, axis=0).astype(np.int32)
    fine_unsigned = (fine - fine_minimum).astype(np.uint32)
    fine_bits = int(math.ceil(math.log2(int(np.max(fine_unsigned)) + 1)))
    fine_payload = pack_bits(fine_unsigned, fine_bits)

    motion = np.diff(quantized, axis=1)
    center = 1 << (args.video_bits - 1)
    mapped_motion = motion + center
    if np.min(mapped_motion) < 0 or np.max(mapped_motion) >= (1 << args.video_bits):
        raise ValueError(
            f"Motion [{motion.min()}, {motion.max()}] does not fit signed {args.video_bits}-bit video"
        )

    compressor = zstd.ZstdCompressor(level=19, threads=0)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    coarse_stored = compressor.compress(coarse_payload)
    fine_stored = compressor.compress(fine_payload)
    (args.output_dir / "position_base_morton.zst").write_bytes(coarse_stored)
    (args.output_dir / "position_base_fine.zst").write_bytes(fine_stored)

    report: dict[str, object] = {
        "source": str(args.source),
        "gaussian_count": layout.vertex_count,
        "keyframes": frames,
        "position_bits": args.position_bits,
        "coarse_bits": args.coarse_bits,
        "video_bits": args.video_bits,
        "minimum": minimum.tolist(),
        "maximum": maximum.tolist(),
        "quantization_rmse": float(np.sqrt(np.mean(np.square(minimum + quantized / position_levels * (maximum - minimum) - positions[order]), dtype=np.float64))),
        "quantization_maximum_absolute_error": float(np.max(np.abs(minimum + quantized / position_levels * (maximum - minimum) - positions[order]))),
        "base": {
            "morton_zstd_bytes": len(coarse_stored),
            "fine_bits": fine_bits,
            "fine_minimum": fine_minimum.tolist(),
            "fine_zstd_bytes": len(fine_stored),
        },
        "motion": {
            "minimum": int(np.min(motion)),
            "maximum": int(np.max(motion)),
            "zero_fraction": float(np.mean(motion == 0)),
            "absolute_p99": float(np.percentile(np.abs(motion), 99)),
            "videos": {},
        },
    }
    with tempfile.TemporaryDirectory(prefix="raw4d-motion-video-") as temp_name:
        temp = Path(temp_name)
        for crf in args.crfs:
            output = args.output_dir / f"position_motion_av1_crf{crf}.mkv"
            result = encode_gray_video(
                mapped_motion.astype(np.uint16), output, args.width, args.video_bits, crf, temp
            )
            report["motion"]["videos"][str(crf)] = result  # type: ignore[index]
            print(json.dumps({str(crf): result}, ensure_ascii=False), flush=True)

    (args.output_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
