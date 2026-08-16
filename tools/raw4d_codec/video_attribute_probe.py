#!/usr/bin/env python3
"""Measure conventional video codecs on spatially ordered RAW4D attribute maps."""

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
from compact40 import morton_codes


ATTRIBUTE_SPECS = {
    "position": ("xyz_bank", ("x", "y", "z"), 14),
    "scale": ("scale_bank", ("0", "1", "2"), 14),
    "color": ("f_dc_bank", ("0", "1", "2"), 12),
    "opacity": ("opacity_bank", ("",), 14),
}


def run(command: list[str]) -> float:
    started = time.perf_counter()
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace")[-4000:])
    return time.perf_counter() - started


# WDD-gpt 2026-08-14 - 将Morton排序后的属性关键帧视为高位深视频，实测传统视频预测和熵编码的可用码率。
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--attributes", nargs="+", choices=sorted(ATTRIBUTE_SPECS), default=sorted(ATTRIBUTE_SPECS))
    parser.add_argument("--width", type=int, default=576)
    parser.add_argument("--av1-crfs", nargs="+", type=int, default=[10, 20, 30, 40, 50])
    parser.add_argument("--tile-size", type=int, default=0)
    parser.add_argument("--bits", nargs="*", default=[])
    args = parser.parse_args()

    layout = read_raw4d_layout(args.source)
    rows = load_rows(layout)
    positions = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))[0]
    minimum_xyz = np.min(positions, axis=(0, 1))
    maximum_xyz = np.max(positions, axis=(0, 1))
    q0 = np.rint((positions[:, 0] - minimum_xyz) / (maximum_xyz - minimum_xyz) * 1023).clip(0, 1023).astype(np.uint16)
    order = np.argsort(morton_codes(q0), kind="stable")
    height = math.ceil(layout.vertex_count / args.width)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {
        "map_size": [args.width, height],
        "gaussian_count": layout.vertex_count,
        "attributes": {},
    }
    bit_overrides = {name: int(value) for name, value in (entry.split("=", 1) for entry in args.bits)}

    with tempfile.TemporaryDirectory(prefix="raw4d-video-") as temp_name:
        temp = Path(temp_name)
        for name in args.attributes:
            prefix, components, default_bits = ATTRIBUTE_SPECS[name]
            bits = bit_overrides.get(name, default_bits)
            values, frames = extract_track(rows, layout, prefix, components)
            values = values[order]
            levels = np.float32((1 << bits) - 1)
            if args.tile_size:
                tile = args.tile_size
                padded_height = math.ceil(height / tile) * tile
                padded_width = math.ceil(args.width / tile) * tile
                mapped_base = np.pad(
                    values.transpose(1, 0, 2),
                    ((0, 0), (0, height * args.width - layout.vertex_count), (0, 0)),
                    mode="edge",
                ).reshape(values.shape[1], height, args.width, len(components))
                mapped = np.pad(
                    mapped_base,
                    ((0, 0), (0, padded_height - height), (0, padded_width - args.width), (0, 0)),
                    mode="edge",
                )
                blocks = mapped.reshape(
                    values.shape[1], padded_height // tile, tile, padded_width // tile, tile, len(components)
                ).transpose(1, 3, 0, 2, 4, 5)
                minimum = np.min(blocks, axis=(2, 3, 4)).astype(np.float32)
                maximum = np.max(blocks, axis=(2, 3, 4)).astype(np.float32)
                step = np.where(maximum > minimum, (maximum - minimum) / levels, 1).astype(np.float32)
                quantized_blocks = np.rint(
                    (blocks - minimum[:, :, None, None, None, :]) / step[:, :, None, None, None, :]
                ).clip(0, levels).astype(np.uint16)
                reconstructed_blocks = minimum[:, :, None, None, None, :] + quantized_blocks.astype(np.float32) * step[:, :, None, None, None, :]
                quantized_map = quantized_blocks.transpose(2, 0, 3, 1, 4, 5).reshape(
                    values.shape[1], padded_height, padded_width, len(components)
                )[:, :height, :args.width]
                reconstructed_map = reconstructed_blocks.transpose(2, 0, 3, 1, 4, 5).reshape(
                    values.shape[1], padded_height, padded_width, len(components)
                )[:, :height, :args.width]
                quantized = quantized_map.reshape(values.shape[1], height * args.width, len(components))[:, :layout.vertex_count].transpose(1, 0, 2)
                reconstructed = reconstructed_map.reshape(values.shape[1], height * args.width, len(components))[:, :layout.vertex_count].transpose(1, 0, 2)
                range_payload = np.stack([minimum, maximum], axis=-1).astype("<f2").tobytes()
            else:
                minimum = np.min(values, axis=(0, 1)).astype(np.float32)
                maximum = np.max(values, axis=(0, 1)).astype(np.float32)
                step = np.where(maximum > minimum, (maximum - minimum) / levels, 1).astype(np.float32)
                quantized = np.rint((values - minimum) / step).clip(0, levels).astype(np.uint16)
                reconstructed = minimum + quantized.astype(np.float32) * step
                range_payload = np.stack([minimum, maximum], axis=-1).astype("<f2").tobytes()
            range_stored = zstd.ZstdCompressor(level=19, threads=0).compress(range_payload)
            range_path = args.output_dir / f"{name}.ranges.zst"
            range_path.write_bytes(range_stored)
            container_bits = 10 if bits <= 10 else 12
            low_bits = max(0, bits - container_bits)
            high = quantized >> low_bits
            low = quantized & ((1 << low_bits) - 1) if low_bits else np.zeros(0, dtype=np.uint16)
            channels = len(components)
            if channels not in {1, 3}:
                raise ValueError(f"Unsupported channel count: {channels}")
            pixel_format = f"gray{container_bits}le" if channels == 1 else f"yuv444p{container_bits}le"
            frame_bytes = args.width * height * channels * 2
            raw_path = temp / f"{name}.raw"
            with raw_path.open("wb") as handle:
                for key in range(values.shape[1]):
                    frame = np.zeros((channels, height * args.width), dtype="<u2")
                    frame[:, :layout.vertex_count] = high[:, key, :].T
                    handle.write(frame.reshape(-1).tobytes())
            if raw_path.stat().st_size != frame_bytes * values.shape[1]:
                raise AssertionError("Attribute video raw size mismatch")

            low_payload = b""
            if low_bits:
                planes = ((low.reshape(-1, 1) >> np.arange(low_bits, dtype=np.uint16)) & 1).astype(np.uint8)
                packed = np.packbits(planes.reshape(-1), bitorder="little").tobytes()
                low_payload = zstd.ZstdCompressor(level=19, threads=0).compress(packed)
            low_path = args.output_dir / f"{name}.low{low_bits}.zst"
            low_path.write_bytes(low_payload)

            common_input = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "rawvideo", "-pixel_format", pixel_format,
                "-video_size", f"{args.width}x{height}", "-framerate", "1",
                "-i", str(raw_path),
            ]
            outputs: dict[str, object] = {}
            codec_commands = {
                "av1": ["-c:v", "libaom-av1", "-crf", "0", "-b:v", "0", "-cpu-used", "6", "-row-mt", "1", "-pix_fmt", pixel_format, "-f", "matroska"],
                "hevc": ["-c:v", "libx265", "-preset", "medium", "-x265-params", "lossless=1:log-level=error", "-pix_fmt", pixel_format, "-f", "hevc"],
                "ffv1": ["-c:v", "ffv1", "-level", "3", "-coder", "1", "-context", "1", "-pix_fmt", pixel_format, "-f", "matroska"],
            }
            extensions = {"av1": "mkv", "hevc": "hevc", "ffv1": "mkv"}
            for codec_name, codec_args in codec_commands.items():
                output_path = args.output_dir / f"{name}.{codec_name}.{extensions[codec_name]}"
                seconds = run(common_input + codec_args + [str(output_path)])
                outputs[codec_name] = {"bytes": output_path.stat().st_size, "encode_seconds": seconds}

            decoded_path = temp / f"{name}.decoded.raw"
            av1_path = args.output_dir / f"{name}.av1.mkv"
            decode_seconds = run([
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(av1_path),
                "-f", "rawvideo", "-pix_fmt", pixel_format, str(decoded_path),
            ])
            exact_high = raw_path.read_bytes() == decoded_path.read_bytes()
            lossy_outputs: dict[str, object] = {}
            for crf in args.av1_crfs:
                lossy_path = args.output_dir / f"{name}.av1_crf{crf}.mkv"
                encode_seconds = run(common_input + [
                    "-c:v", "libaom-av1", "-crf", str(crf), "-b:v", "0", "-cpu-used", "6",
                    "-row-mt", "1", "-pix_fmt", pixel_format, "-f", "matroska", str(lossy_path),
                ])
                lossy_raw = temp / f"{name}.crf{crf}.raw"
                current_decode_seconds = run([
                    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(lossy_path),
                    "-f", "rawvideo", "-pix_fmt", pixel_format, str(lossy_raw),
                ])
                decoded_frames = np.fromfile(lossy_raw, dtype="<u2").reshape(values.shape[1], channels, height * args.width)
                decoded_high = decoded_frames[:, :, :layout.vertex_count].transpose(2, 0, 1)
                midpoint = (1 << (low_bits - 1)) if low_bits else 0
                decoded_quantized = np.minimum((decoded_high.astype(np.uint32) << low_bits) + midpoint, int(levels))
                if args.tile_size:
                    decoded_base = np.pad(
                        decoded_quantized.transpose(1, 0, 2),
                        ((0, 0), (0, height * args.width - layout.vertex_count), (0, 0)),
                        mode="edge",
                    ).reshape(values.shape[1], height, args.width, len(components))
                    decoded_map = np.pad(
                        decoded_base,
                        ((0, 0), (0, padded_height - height), (0, padded_width - args.width), (0, 0)),
                        mode="edge",
                    )
                    decoded_blocks = decoded_map.reshape(
                        values.shape[1], padded_height // tile, tile, padded_width // tile, tile, len(components)
                    ).transpose(1, 3, 0, 2, 4, 5)
                    decoded_value_blocks = minimum[:, :, None, None, None, :] + decoded_blocks.astype(np.float32) * step[:, :, None, None, None, :]
                    decoded_value_map = decoded_value_blocks.transpose(2, 0, 3, 1, 4, 5).reshape(
                        values.shape[1], padded_height, padded_width, len(components)
                    )[:, :height, :args.width]
                    decoded_values = decoded_value_map.reshape(values.shape[1], height * args.width, len(components))[:, :layout.vertex_count].transpose(1, 0, 2)
                else:
                    decoded_values = minimum + decoded_quantized.astype(np.float32) * step
                absolute_error = np.abs(decoded_values - values)
                lossy_outputs[str(crf)] = {
                    "bytes": lossy_path.stat().st_size,
                    "encode_seconds": encode_seconds,
                    "decode_seconds": current_decode_seconds,
                    "rmse": float(np.sqrt(np.mean(np.square(decoded_values - values), dtype=np.float64))),
                    "maximum_absolute_error": float(np.max(absolute_error)),
                }
                if channels == 3:
                    vector_error = np.linalg.norm(decoded_values - values, axis=2)
                    lossy_outputs[str(crf)]["vector_p99"] = float(np.percentile(vector_error, 99))
                    lossy_outputs[str(crf)]["vector_maximum"] = float(np.max(vector_error))
            report["attributes"][name] = {
                "shape": list(values.shape),
                "bits": bits,
                "keyframes": frames,
                "minimum": minimum.tolist(),
                "maximum": maximum.tolist(),
                "tile_size": args.tile_size,
                "range_raw_bytes": len(range_payload),
                "range_zstd_bytes": len(range_stored),
                "quantization_rmse": float(np.sqrt(np.mean(np.square(reconstructed - values), dtype=np.float64))),
                "quantization_maximum_absolute_error": float(np.max(np.abs(reconstructed - values))),
                "high_raw_bytes": raw_path.stat().st_size,
                "low_zstd_bytes": len(low_payload),
                "av1_decode_seconds": decode_seconds,
                "av1_high_exact": exact_high,
                "codecs": outputs,
                "av1_lossy": lossy_outputs,
            }
            print(json.dumps({name: report["attributes"][name]}, indent=2), flush=True)

    (args.output_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
