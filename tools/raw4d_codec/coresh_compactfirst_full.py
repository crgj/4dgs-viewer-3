#!/usr/bin/env python3
"""Complete 4CGS container for compact-first non-SH plus fixed CoReSH-5R."""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np

import quality_attrs
from codec import (
    compress_stream,
    decode_sh_rvq5,
    extract_track,
    load_rows,
    property_indices,
    read_container,
    read_raw4d_layout,
    sha256_file,
    write_container,
    write_decoded_raw4d,
)
from coerattr5r_compactfirst import decode_archive as decode_nonsh_archive
from compact40 import reorder_sh_rvq5
from learnable_anchor_rate_sweep import encode_base
from visualrate39 import decode_lifetime, encode_lifetime


#WDD-gpt 2026-08-15 - 把紧凑首帧非SH、固定CoReSH-5R、DC与Lifetime封装为可独立解码完整码流。
PROFILE_NAME = "CoReAttr-5R-CompactFirst-Full-CoReSH-5R"
COLOR_BITS = ((4, 3, 3), (5, 4, 4), (6, 5, 5))


def _source_tracks(source: Path) -> tuple[Any, np.ndarray, dict[str, np.ndarray], dict[str, list[int]]]:
    layout = read_raw4d_layout(source)
    rows = load_rows(layout)
    values: dict[str, np.ndarray] = {}
    frames: dict[str, list[int]] = {}
    specs = {
        "position": ("xyz_bank", ("x", "y", "z")),
        "rotation": ("rot_bank", ("w", "x", "y", "z")),
        "color_dc": ("f_dc_bank", ("0", "1", "2")),
        "scale": ("scale_bank", ("0", "1", "2")),
        "opacity": ("opacity_bank", ("",)),
    }
    for name, (prefix, components) in specs.items():
        values[name], frames[name] = extract_track(rows, layout, prefix, components)
    values["mu"] = np.asarray(
        rows[:, property_indices(layout, ["lifetime_mu"])[0]], dtype=np.float32
    )
    values["width"] = np.asarray(
        rows[:, property_indices(layout, ["lifetime_w"])[0]], dtype=np.float32
    )
    return layout, rows, values, frames


def _nonsh_order(
    source_positions: np.ndarray,
    nonsh_manifest: dict[str, Any],
    decoded_positions: np.ndarray,
) -> np.ndarray:
    ratio = float(nonsh_manifest["position_laf"]["base_codec"]["correction_ratio"])
    base = encode_base(source_positions, ratio)
    if not np.array_equal(base.decoded, decoded_positions[:, 0]):
        raise ValueError("Compact-first non-SH archive does not match the source Morton base")
    return base.order


def _importance(scales: np.ndarray, opacities: np.ndarray) -> np.ndarray:
    alpha = np.max(
        np.float32(1) / (np.float32(1) + np.exp(-np.clip(opacities.reshape(-1, 4), -16, 16))),
        axis=1,
    )
    radius = np.exp(np.clip(np.max(scales, axis=(1, 2)), -16, 2))
    return (alpha * radius).astype(np.float32)


def decode_arrays(path: Path) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    manifest, streams = read_container(path)
    if manifest.get("codec_name") != PROFILE_NAME:
        raise ValueError("Unsupported compact-first complete container")
    count = int(manifest["gaussian_count"])
    with tempfile.TemporaryDirectory(prefix="coresh-compactfirst-full-") as temp_name:
        nonsh_path = Path(temp_name) / "nonsh.npz"
        nonsh_path.write_bytes(streams["coerattr5r_nonsh"])
        _, nonsh = decode_nonsh_archive(nonsh_path)
    color_meta = manifest["attributes"]["color_dc"]
    if color_meta.get("codec") == "lossless-native-fp16":
        color = np.frombuffer(streams["color_dc_lossless_f16"], dtype="<f2").astype(np.float32)
        color = color.reshape(color_meta["shape"])
    else:
        color = quality_attrs.decode_color(streams, color_meta, count)
    lifetime_meta = manifest["attributes"]["lifetime"]
    if lifetime_meta.get("codec") == "lossless-native-fp16":
        lifetime = np.frombuffer(streams["lifetime_lossless_f16"], dtype="<f2").astype(np.float32)
        lifetime = lifetime.reshape(count, 2)
        mu, width = lifetime[:, 0], lifetime[:, 1]
    else:
        mu, width = decode_lifetime(streams, lifetime_meta, count)
    sh = decode_sh_rvq5(streams["coresh5r"])
    arrays = dict(nonsh)
    arrays.update({"color_dc": color, "mu": mu, "width": width, "sh": sh})
    return manifest, arrays


def _assert_arrays_equal(expected: dict[str, np.ndarray], actual: dict[str, np.ndarray]) -> None:
    for name, left in expected.items():
        right = actual[name]
        if not np.array_equal(left, right, equal_nan=True):
            maximum = float(np.nanmax(np.abs(left - right)))
            raise AssertionError(f"Independent complete decode differs for {name}: {maximum}")


def _stored_components(manifest: dict[str, Any]) -> dict[str, int]:
    result = {"nonsh": 0, "sh": 0, "color_dc": 0, "lifetime": 0}
    for stream in manifest["streams"]:
        name = stream["name"]
        if name == "coerattr5r_nonsh":
            category = "nonsh"
        elif name == "coresh5r":
            category = "sh"
        elif name.startswith("color_"):
            category = "color_dc"
        elif name.startswith("lifetime_"):
            category = "lifetime"
        else:
            raise ValueError(f"Unclassified complete stream: {name}")
        result[category] += int(stream["stored_bytes"])
    return result


def encode(
    source: Path,
    nonsh_archive: Path,
    sh_stream: Path,
    output: Path,
    zstd_level: int,
    lossless_dc_lifetime: bool,
) -> dict[str, Any]:
    started = time.perf_counter()
    layout, _, source_values, frames = _source_tracks(source)
    nonsh_manifest, nonsh_decoded = decode_nonsh_archive(nonsh_archive)
    if int(nonsh_manifest["gaussian_count"]) != layout.vertex_count:
        raise ValueError("Non-SH Gaussian count does not match source")
    order = _nonsh_order(source_values["position"], nonsh_manifest, nonsh_decoded["position"])
    sorted_values = {name: values[order] for name, values in source_values.items()}

    streams = [compress_stream(
        "coerattr5r_nonsh", nonsh_archive.read_bytes(), zstd_level, compression="raw"
    )]
    if lossless_dc_lifetime:
        decoded_color = sorted_values["color_dc"].astype(np.float16).astype(np.float32)
        streams.append(compress_stream(
            "color_dc_lossless_f16", decoded_color.astype("<f2").tobytes(), zstd_level
        ))
        color_meta = {
            "codec": "lossless-native-fp16",
            "shape": list(decoded_color.shape),
            "keyframes": frames["color_dc"],
        }
        decoded_mu = sorted_values["mu"].astype(np.float16).astype(np.float32)
        decoded_width = sorted_values["width"].astype(np.float16).astype(np.float32)
        lifetime = np.stack([decoded_mu, decoded_width], axis=1)
        streams.append(compress_stream(
            "lifetime_lossless_f16", lifetime.astype("<f2").tobytes(), zstd_level
        ))
        lifetime_meta = {"codec": "lossless-native-fp16", "shape": list(lifetime.shape)}
        #WDD-gpt 2026-08-15 - FP16新格式的DC与Lifetime按原生位模式无损保存，避免组合PSNR被旧量化器消耗。
    else:
        previous_color_bits = quality_attrs.COLOR_MODE_BITS
        try:
            quality_attrs.COLOR_MODE_BITS = COLOR_BITS
            decoded_color, color_meta = quality_attrs.encode_color(
                streams,
                sorted_values["color_dc"],
                _importance(sorted_values["scale"], sorted_values["opacity"]),
                zstd_level,
            )
        finally:
            quality_attrs.COLOR_MODE_BITS = previous_color_bits
        color_meta["keyframes"] = frames["color_dc"]
        decoded_mu, decoded_width, lifetime_meta = encode_lifetime(
            streams, sorted_values["mu"], sorted_values["width"], zstd_level
        )

    #WDD-gpt 2026-08-15 - 仅重排已验证CoReSH-5R标签以匹配LAF Morton顺序，码本与五级残差模型保持不变。
    reordered_sh = reorder_sh_rvq5(sh_stream.read_bytes(), order)
    decoded_sh = decode_sh_rvq5(reordered_sh)
    if decoded_sh.shape != (layout.vertex_count, 45):
        raise ValueError("CoReSH-5R shape does not match source")
    streams.append(compress_stream("coresh5r", reordered_sh, zstd_level, compression="raw"))

    opacity_codec = str(
        nonsh_manifest.get("first_keyframes", {}).get("opacity", {}).get(
            "codec", "embedded CoReAttr-5R"
        )
    )
    attributes = {
        "position": {"keyframes": frames["position"], "codec": "embedded compact-first LAF"},
        "rotation": {"keyframes": frames["rotation"], "codec": "embedded CoReAttr-5R"},
        "color_dc": color_meta,
        "scale": {"keyframes": frames["scale"], "codec": "embedded CoReAttr-5R"},
        #WDD-gpt 2026-08-15 - 完整容器继承非SH子码流的真实Opacity策略，避免清单误报为5R。
        "opacity": {"keyframes": frames["opacity"], "codec": opacity_codec},
        "lifetime": lifetime_meta,
        "sh": {"codec": "CoReSH-5R", "shape": [layout.vertex_count, 45]},
    }
    manifest = {
        "format": "4CGS",
        "version": 3,
        "codec_name": PROFILE_NAME,
        "gaussian_pruning": False,
        "gaussian_count": layout.vertex_count,
        "total_frames": layout.total_frames,
        "source_name": source.name,
        "source_bytes": source.stat().st_size,
        "source_sha256": sha256_file(source),
        "nonsh_sha256": sha256_file(nonsh_archive),
        "sh_source_sha256": sha256_file(sh_stream),
        "lossless_dc_lifetime": lossless_dc_lifetime,
        "attributes": attributes,
    }
    write_container(output, manifest, streams)
    decoded_manifest, independently_decoded = decode_arrays(output)
    expected = dict(nonsh_decoded)
    expected.update({
        "color_dc": decoded_color,
        "mu": decoded_mu,
        "width": decoded_width,
        "sh": decoded_sh,
    })
    _assert_arrays_equal(expected, independently_decoded)
    components = _stored_components(decoded_manifest)
    equivalent_ply_bytes = layout.vertex_count * layout.total_frames * 59 * 4
    result = {
        "container": str(output),
        "container_bytes": output.stat().st_size,
        "container_sha256": sha256_file(output),
        "source": str(source),
        "source_bytes": source.stat().st_size,
        "compression_ratio_vs_source_raw4d": source.stat().st_size / output.stat().st_size,
        "equivalent_float32_ply_sequence_bytes": equivalent_ply_bytes,
        "compression_ratio_vs_equivalent_ply_sequence": equivalent_ply_bytes / output.stat().st_size,
        "gaussian_count": layout.vertex_count,
        "gaussian_pruning": False,
        "stored_bytes_by_component": components,
        "container_overhead_bytes": output.stat().st_size - sum(components.values()),
        "independent_decoder_validated": decoded_manifest["codec_name"] == PROFILE_NAME,
        "measured_encode_and_validation_seconds": time.perf_counter() - started,
    }
    report_path = output.with_suffix(".encode.json")
    report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    result["report"] = str(report_path)
    return result


def decode(source: Path, output: Path) -> dict[str, Any]:
    started = time.perf_counter()
    manifest, arrays = decode_arrays(source)
    write_decoded_raw4d(
        output,
        manifest,
        arrays["sh"],
        arrays["position"],
        arrays["rotation"],
        arrays["color_dc"],
        arrays["scale"],
        arrays["opacity"],
        arrays["mu"],
        arrays["width"],
    )
    result = {
        "container": str(source),
        "decoded_raw4d": str(output),
        "decoded_raw4d_bytes": output.stat().st_size,
        "gaussian_count": int(manifest["gaussian_count"]),
        "total_frames": int(manifest["total_frames"]),
        "measured_decode_seconds": time.perf_counter() - started,
    }
    report_path = source.with_suffix(".decode.json")
    report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    result["report"] = str(report_path)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Complete compact-first + CoReSH-5R 4CGS codec")
    subparsers = parser.add_subparsers(dest="command", required=True)
    encoder = subparsers.add_parser("encode")
    encoder.add_argument("source", type=Path)
    encoder.add_argument("nonsh_archive", type=Path)
    encoder.add_argument("sh_stream", type=Path)
    encoder.add_argument("output", type=Path)
    encoder.add_argument("--zstd-level", type=int, default=8)
    encoder.add_argument("--lossless-dc-lifetime", action="store_true")
    decoder = subparsers.add_parser("decode")
    decoder.add_argument("source", type=Path)
    decoder.add_argument("output", type=Path)
    inspector = subparsers.add_parser("inspect")
    inspector.add_argument("source", type=Path)
    args = parser.parse_args()
    if args.command == "encode":
        if args.output.suffix.lower() != ".4cgs":
            raise ValueError("Output must use the .4cgs suffix")
        result = encode(
            args.source,
            args.nonsh_archive,
            args.sh_stream,
            args.output,
            args.zstd_level,
            args.lossless_dc_lifetime,
        )
    elif args.command == "decode":
        result = decode(args.source, args.output)
    else:
        result, _ = read_container(args.source)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
