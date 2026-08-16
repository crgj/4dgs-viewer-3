#!/usr/bin/env python3
"""Encode tiered absolute position displacement maps with lossless AV1."""

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

from codec import extract_track, load_rows, property_indices, read_raw4d_layout, write_decoded_raw4d
from compact40 import encode_unsigned_varints, morton_codes, morton_xyz, pack_bits


def parse_profile(value: str) -> tuple[str, list[tuple[float, int]]]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("profile must be NAME=CUMULATIVE_FRACTION:STEP,...")
    name, payload = value.split("=", 1)
    tiers = [(float(fraction), int(step)) for fraction, step in (part.split(":", 1) for part in payload.split(","))]
    if not name or tiers[-1][0] != 1.0 or any(step <= 0 for _, step in tiers):
        raise argparse.ArgumentTypeError("profile must end at fraction 1.0 with positive steps")
    return name, tiers


def run(command: list[str]) -> float:
    started = time.perf_counter()
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace")[-4000:])
    return time.perf_counter() - started


def padded_plane_height(count: int, width: int, channels: int) -> int:
    height = math.ceil(count / width)
    if (height * channels) % 2:
        height += 1
    return height


def encode_lossless_gray(
    mapped: np.ndarray,
    path: Path,
    width: int,
    bits: int,
    cpu_used: int,
    temp: Path,
) -> tuple[np.ndarray, dict[str, object]]:
    count, frames, channels = mapped.shape
    #WDD-gpt 2026-08-15 - I420要求总luma高度为偶数，奇数轨迹块高度需补一行以防末帧被吞。
    height = padded_plane_height(count, width, channels)
    raw_path = temp / f"{path.stem}.raw"
    with raw_path.open("wb") as handle:
        for frame in range(frames):
            planes = np.zeros((channels, height * width), dtype="<u2")
            planes[:, :count] = mapped[:, frame, :].T
            handle.write(planes.tobytes())
            chroma = np.full((height * channels // 2, width // 2), 1 << (bits - 1), dtype="<u2")
            handle.write(chroma.tobytes())
            handle.write(chroma.tobytes())
    pixel_format = f"gray{bits}le"
    profile_args = ["--profile=0"] if bits <= 10 else ["--profile=2", "--use-16bit-internal"]
    encode_seconds = run([
        "aomenc", "--good", f"--cpu-used={cpu_used}", "--threads=8", "--passes=1",
        "--lossless=1", f"--bit-depth={bits}", f"--input-bit-depth={bits}",
        *profile_args,
        "--monochrome", "--i420", f"--width={width}", f"--height={height * channels}",
        "--fps=1/1", "--ivf", "-o", str(path), str(raw_path),
    ])
    decoded_path = temp / f"{path.stem}.decoded.raw"
    decode_seconds = run([
        "aomdec", "--rawvideo", "--i420", f"--output-bit-depth={bits}",
        "-o", str(decoded_path), str(path),
    ])
    luma_samples = channels * height * width
    chroma_samples = (channels * height // 2) * (width // 2)
    decoded_frames = np.fromfile(decoded_path, dtype="<u2").reshape(
        frames, luma_samples + 2 * chroma_samples
    )
    decoded_luma = decoded_frames[:, :luma_samples].reshape(frames, channels, height * width)
    decoded = decoded_luma[:, :, :count].transpose(2, 0, 1)
    return decoded, {
        "bytes": path.stat().st_size,
        "encode_seconds": encode_seconds,
        "decode_seconds": decode_seconds,
        "exact": bool(np.array_equal(decoded, mapped)),
    }


#WDD-gpt 2026-08-14 - 高贡献层和低贡献层分别视频编码，层内使用量化坐标排序并直接量化绝对位移，避免累计漂移。
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("sh_reference", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--profile", action="append", type=parse_profile, required=True)
    parser.add_argument("--position-bits", type=int, default=13)
    parser.add_argument("--coarse-bits", type=int, default=10)
    parser.add_argument("--video-bits", type=int, default=12)
    parser.add_argument("--width", type=int, default=576)
    parser.add_argument("--cpu-used", type=int, default=4)
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
    position_levels = np.float32((1 << args.position_bits) - 1)
    coarse_levels = np.float32((1 << args.coarse_bits) - 1)
    quantized = np.rint((positions - minimum) / (maximum - minimum) * position_levels).astype(np.int32)
    coarse = np.rint((positions[:, 0] - minimum) / (maximum - minimum) * coarse_levels).clip(
        0, int(coarse_levels)
    ).astype(np.uint16)
    morton = morton_codes(coarse)
    alpha = 1 / (1 + np.exp(-np.clip(opacities, -16, 16)))
    radius = np.exp(np.clip(np.max(scales, axis=(1, 2)), -16, 2))
    importance = np.max(alpha, axis=(1, 2)) * radius
    importance_order = np.argsort(-importance, kind="stable")

    global_order = np.argsort(morton, kind="stable")
    source_to_sh = np.empty(layout.vertex_count, dtype=np.int64)
    source_to_sh[global_order] = np.arange(layout.vertex_count)
    sh_layout = read_raw4d_layout(args.sh_reference)
    sh_rows = load_rows(sh_layout)
    sh_morton = np.asarray(
        sh_rows[:, property_indices(sh_layout, [f"f_rest_{index}" for index in range(45)])], dtype=np.float32
    )

    compressor = zstd.ZstdCompressor(level=19, threads=0)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {"profiles": {}}
    count = layout.vertex_count
    with tempfile.TemporaryDirectory(prefix="tier-position-video-") as temp_name:
        temp = Path(temp_name)
        for name, tiers in args.profile:
            tier_source_indices: list[np.ndarray] = []
            first = 0
            for fraction, _ in tiers:
                last = int(round(count * fraction))
                selected = importance_order[first:last]
                tier_source_indices.append(selected[np.argsort(morton[selected], kind="stable")])
                first = last
            final_order = np.concatenate(tier_source_indices)
            q = quantized[final_order]
            q_coarse = coarse[final_order]
            coarse_chunks: list[bytes] = []
            first = 0
            for selected in tier_source_indices:
                codes = morton_codes(q_coarse[first:first + selected.size])
                deltas = np.empty(selected.size, dtype=np.uint32)
                deltas[0] = codes[0]
                deltas[1:] = codes[1:] - codes[:-1]
                coarse_chunks.append(encode_unsigned_varints(deltas))
                first += selected.size
            coarse_stored = compressor.compress(b"".join(coarse_chunks))
            reconstructed_coarse = np.rint(
                q_coarse.astype(np.float32) / coarse_levels * position_levels
            ).astype(np.int32)
            fine = q[:, 0] - reconstructed_coarse
            fine_minimum = np.min(fine, axis=0).astype(np.int32)
            fine_unsigned = (fine - fine_minimum).astype(np.uint32)
            fine_bits = int(math.ceil(math.log2(int(np.max(fine_unsigned)) + 1)))
            fine_stored = compressor.compress(pack_bits(fine_unsigned, fine_bits))
            (args.output_dir / f"position_{name}_base_morton.zst").write_bytes(coarse_stored)
            (args.output_dir / f"position_{name}_base_fine.zst").write_bytes(fine_stored)

            reconstructed = np.empty_like(q)
            reconstructed[:, 0] = reconstructed_coarse + fine_unsigned.astype(np.int32) + fine_minimum
            tier_reports: list[dict[str, object]] = []
            first = 0
            for tier_index, ((_, step), selected) in enumerate(zip(tiers, tier_source_indices)):
                last = first + selected.size
                displacement = q[first:last, 1:] - q[first:last, :1]
                quantized_displacement = np.rint(displacement / step).astype(np.int32)
                center = 1 << (args.video_bits - 1)
                mapped_wide = quantized_displacement + center
                mapped = np.clip(mapped_wide, 0, (1 << args.video_bits) - 1).astype(np.uint16)
                overflow = (mapped_wide - mapped.astype(np.int32)).astype("<i2")
                overflow_stored = compressor.compress(overflow.tobytes())
                overflow_path = args.output_dir / f"position_{name}_tier{tier_index}_overflow.zst"
                overflow_path.write_bytes(overflow_stored)
                video_path = args.output_dir / f"position_{name}_tier{tier_index}.mkv"
                decoded_mapped, video_report = encode_lossless_gray(
                    mapped, video_path, args.width, args.video_bits, args.cpu_used, temp
                )
                codec_correction = (mapped.astype(np.int32) - decoded_mapped.astype(np.int32)).astype("<i2")
                codec_correction_stored = compressor.compress(codec_correction.tobytes())
                codec_correction_path = args.output_dir / f"position_{name}_tier{tier_index}_codec_correction.zst"
                codec_correction_path.write_bytes(codec_correction_stored)
                reconstructed[first:last, 1:] = (
                    reconstructed[first:last, :1]
                    + (
                        decoded_mapped.astype(np.int32)
                        + codec_correction.astype(np.int32)
                        + overflow.astype(np.int32)
                        - center
                    ) * step
                )
                video_report.update({
                    "step": step,
                    "count": selected.size,
                    "overflow_count": int(np.count_nonzero(overflow)),
                    "overflow_zstd_bytes": len(overflow_stored),
                    "codec_correction_count": int(np.count_nonzero(codec_correction)),
                    "codec_correction_zstd_bytes": len(codec_correction_stored),
                })
                tier_reports.append(video_report)
                first = last
            decoded_positions = minimum + reconstructed.astype(np.float32) / position_levels * (maximum - minimum)
            output = args.output_dir / f"position_{name}.raw4d"
            manifest = {
                "gaussian_count": count,
                "total_frames": layout.total_frames,
                "attributes": {
                    "position": {"keyframes": position_frames},
                    "rotation": {"keyframes": rotation_frames},
                    "color_dc": {"keyframes": color_frames},
                    "scale": {"keyframes": scale_frames},
                    "opacity": {"keyframes": opacity_frames},
                },
            }
            write_decoded_raw4d(
                output, manifest, sh_morton[source_to_sh[final_order]], decoded_positions,
                rotations[final_order], colors[final_order], scales[final_order], opacities[final_order],
                mu[final_order], lifetime_width[final_order],
            )
            error = reconstructed - q
            total_bytes = len(coarse_stored) + len(fine_stored) + sum(
                int(tier["bytes"])
                + int(tier["overflow_zstd_bytes"])
                + int(tier["codec_correction_zstd_bytes"])
                for tier in tier_reports
            )
            report["profiles"][name] = {
                "tiers": tiers,
                "tier_counts": [selected.size for selected in tier_source_indices],
                "base_morton_zstd_bytes": len(coarse_stored),
                "base_fine_zstd_bytes": len(fine_stored),
                "fine_bits": fine_bits,
                "fine_minimum": fine_minimum.tolist(),
                "videos": tier_reports,
                "encoded_position_bytes": total_bytes,
                "integer_rmse": float(np.sqrt(np.mean(np.square(error), dtype=np.float64))),
                "integer_maximum": int(np.max(np.abs(error))),
                "output": str(output),
            }
            print(json.dumps({name: report["profiles"][name]}, ensure_ascii=False), flush=True)
    (args.output_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
