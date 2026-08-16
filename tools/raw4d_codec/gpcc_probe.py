#!/usr/bin/env python3
"""Prepare and validate deterministic TMC13 probes for RAW4D Gaussian data."""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path
from typing import Any

import numpy as np


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from codec import extract_track, load_rows, read_container, read_raw4d_layout  # noqa: E402
from compact40 import morton_codes  # noqa: E402


PLY_DTYPES = {
    "char": "i1",
    "int8": "i1",
    "uchar": "u1",
    "uint8": "u1",
    "short": "<i2",
    "int16": "<i2",
    "ushort": "<u2",
    "uint16": "<u2",
    "int": "<i4",
    "int32": "<i4",
    "uint": "<u4",
    "uint32": "<u4",
    "float": "<f4",
    "float32": "<f4",
    "double": "<f8",
    "float64": "<f8",
}


def quantized_base(source: Path) -> tuple[np.ndarray, dict[str, Any]]:
    layout = read_raw4d_layout(source)
    rows = load_rows(layout)
    positions, _ = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    minimum = np.min(positions, axis=(0, 1)).astype(np.float32)
    maximum = np.max(positions, axis=(0, 1)).astype(np.float32)
    step = (maximum - minimum) / np.float32(1023)
    quantized = np.rint((positions[:, 0] - minimum) / step).clip(0, 1023).astype(np.uint16)
    return quantized, {
        "gaussian_count": layout.vertex_count,
        "minimum": minimum.tolist(),
        "maximum": maximum.tolist(),
        "step": step.tolist(),
    }


#WDD-gpt 2026-08-15 - 探针PLY附带24-bit源ID，验证G-PCC重排和重复点不会破坏高斯属性对应。
def write_geometry_ply(path: Path, xyz: np.ndarray, with_ids: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = [
        "ply",
        "format binary_little_endian 1.0",
        f"element vertex {xyz.shape[0]}",
        "property float x",
        "property float y",
        "property float z",
    ]
    if with_ids:
        header.extend(["property uchar red", "property uchar green", "property uchar blue"])
    header.extend(["element face 0", "property list uchar int vertex_index", "end_header"])
    dtype_fields: list[tuple[str, str]] = [("x", "<f4"), ("y", "<f4"), ("z", "<f4")]
    if with_ids:
        dtype_fields.extend([("red", "u1"), ("green", "u1"), ("blue", "u1")])
    packed = np.empty(xyz.shape[0], dtype=np.dtype(dtype_fields, align=False))
    for axis, name in enumerate(("x", "y", "z")):
        packed[name] = xyz[:, axis]
    if with_ids:
        ids = np.arange(xyz.shape[0], dtype=np.uint32)
        packed["red"] = ids & np.uint32(255)
        packed["green"] = (ids >> np.uint32(8)) & np.uint32(255)
        packed["blue"] = (ids >> np.uint32(16)) & np.uint32(255)
    with path.open("wb") as handle:
        handle.write(("\n".join(header) + "\n").encode("ascii"))
        handle.write(packed.tobytes())


def write_attribute_ply(path: Path, xyz: np.ndarray, values: np.ndarray) -> None:
    if values.shape != xyz.shape or values.dtype != np.uint8:
        raise ValueError("G-PCC color probe expects an Nx3 uint8 attribute")
    path.parent.mkdir(parents=True, exist_ok=True)
    header = [
        "ply",
        "format binary_little_endian 1.0",
        f"element vertex {xyz.shape[0]}",
        "property float x",
        "property float y",
        "property float z",
        "property uchar red",
        "property uchar green",
        "property uchar blue",
        "element face 0",
        "property list uchar int vertex_index",
        "end_header",
    ]
    packed = np.empty(xyz.shape[0], dtype=np.dtype([
        ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
        ("red", "u1"), ("green", "u1"), ("blue", "u1"),
    ], align=False))
    for axis, name in enumerate(("x", "y", "z")):
        packed[name] = xyz[:, axis]
    for axis, name in enumerate(("red", "green", "blue")):
        packed[name] = values[:, axis]
    with path.open("wb") as handle:
        handle.write(("\n".join(header) + "\n").encode("ascii"))
        handle.write(packed.tobytes())


def read_vertex_ply(path: Path) -> dict[str, np.ndarray]:
    header = bytearray()
    with path.open("rb") as handle:
        while b"end_header\n" not in header:
            chunk = handle.read(65536)
            if not chunk:
                raise ValueError(f"PLY header is incomplete: {path}")
            header.extend(chunk)
            if len(header) > 1024 * 1024:
                raise ValueError(f"PLY header exceeds 1 MiB: {path}")
    header_bytes = header.index(b"end_header\n") + len(b"end_header\n")
    lines = bytes(header[:header_bytes]).decode("ascii").splitlines()
    if "format binary_little_endian 1.0" not in lines:
        raise ValueError(f"Only binary little-endian PLY is supported: {path}")
    count = int(next(line.split()[2] for line in lines if line.startswith("element vertex ")))
    properties: list[tuple[str, str]] = []
    in_vertex = False
    for line in lines:
        if line.startswith("element "):
            in_vertex = line.startswith("element vertex ")
            continue
        if in_vertex and line.startswith("property ") and " list " not in f" {line} ":
            _, kind, name = line.split()
            if kind not in PLY_DTYPES:
                raise ValueError(f"Unsupported PLY property type {kind}: {path}")
            properties.append((name, PLY_DTYPES[kind]))
    dtype = np.dtype(properties, align=False)
    rows = np.memmap(path, dtype=dtype, mode="r", offset=header_bytes, shape=(count,))
    return {name: np.asarray(rows[name]) for name, _ in properties}


def prepare_geometry(source: Path, output: Path, with_ids: bool) -> dict[str, Any]:
    xyz, metadata = quantized_base(source)
    write_geometry_ply(output, xyz.astype(np.float32), with_ids)
    keys = np.ascontiguousarray(xyz).view(np.dtype((np.void, xyz.dtype.itemsize * 3))).reshape(-1)
    metadata.update({
        "output": str(output),
        "output_bytes": output.stat().st_size,
        "with_ids": with_ids,
        "unique_positions": int(np.unique(keys).size),
        "duplicate_points": int(xyz.shape[0] - np.unique(keys).size),
    })
    return metadata


def decoded_source_ids(path: Path) -> np.ndarray:
    rows = read_vertex_ply(path)
    if not all(name in rows for name in ("red", "green", "blue")):
        raise ValueError(f"Decoded ID PLY has no RGB attribute: {path}")
    return (
        rows["red"].astype(np.uint32)
        | (rows["green"].astype(np.uint32) << np.uint32(8))
        | (rows["blue"].astype(np.uint32) << np.uint32(16))
    )


def ply_colors(path: Path) -> np.ndarray:
    rows = read_vertex_ply(path)
    return np.stack([rows[name] for name in ("red", "green", "blue")], axis=1).astype(np.uint8)


def prepare_scale(source: Path, output_pattern: str) -> dict[str, Any]:
    layout = read_raw4d_layout(source)
    rows = load_rows(layout)
    scales, frames = extract_track(rows, layout, "scale_bank", ("0", "1", "2"))
    xyz, geometry_meta = quantized_base(source)
    low = np.float32(-16)
    high = np.float32(2)
    levels = np.float32(255)
    quantized = np.rint((np.clip(scales, low, high) - low) / (high - low) * levels).clip(0, 255).astype(np.uint8)
    outputs: list[str] = []
    for key in range(scales.shape[1]):
        path = Path(output_pattern % key)
        write_attribute_ply(path, xyz.astype(np.float32), quantized[:, key])
        outputs.append(str(path))
    return {
        "attribute": "log_scale",
        "frames": frames,
        "outputs": outputs,
        "quantization_low": float(low),
        "quantization_high": float(high),
        "quantization_step": float((high - low) / levels),
        **geometry_meta,
    }


def analyze_scale(
    source: Path,
    decoded_pattern: str,
    id_mapping: Path,
) -> dict[str, Any]:
    layout = read_raw4d_layout(source)
    rows = load_rows(layout)
    scales, _ = extract_track(rows, layout, "scale_bank", ("0", "1", "2"))
    ids = decoded_source_ids(id_mapping)
    decoded_q = np.stack([ply_colors(Path(decoded_pattern % key)) for key in range(scales.shape[1])], axis=1)
    decoded = np.float32(-16) + decoded_q.astype(np.float32) * np.float32(18 / 255)
    source_values = np.clip(scales[ids], -16, 2)
    log_error = np.abs(decoded - source_values)
    relative = np.abs(np.expm1(decoded - source_values))
    return {
        "attribute": "log_scale",
        "gaussian_count": int(ids.size),
        "log_error_mean": float(np.mean(log_error)),
        "log_error_p99": float(np.percentile(log_error, 99)),
        "log_error_maximum": float(np.max(log_error)),
        "linear_relative_error_mean": float(np.mean(relative)),
        "linear_relative_error_p99": float(np.percentile(relative, 99)),
        "linear_relative_error_maximum": float(np.max(relative)),
    }


def normalize_quaternions(values: np.ndarray) -> np.ndarray:
    return values / np.maximum(np.linalg.norm(values, axis=-1, keepdims=True), np.float32(1e-12))


def canonical_quaternions(values: np.ndarray) -> np.ndarray:
    result = normalize_quaternions(values.astype(np.float32))
    return result * np.where(result[..., :1] < 0, np.float32(-1), np.float32(1))


def multiply_quaternions(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    lw, lx, ly, lz = np.moveaxis(left, -1, 0)
    rw, rx, ry, rz = np.moveaxis(right, -1, 0)
    return np.stack([
        lw * rw - lx * rx - ly * ry - lz * rz,
        lw * rx + lx * rw + ly * rz - lz * ry,
        lw * ry - lx * rz + ly * rw + lz * rx,
        lw * rz + lx * ry - ly * rx + lz * rw,
    ], axis=-1).astype(np.float32)


def quaternion_log(values: np.ndarray) -> np.ndarray:
    values = canonical_quaternions(values)
    vector = values[..., 1:]
    length = np.linalg.norm(vector, axis=-1, keepdims=True)
    angle = np.float32(2) * np.arctan2(length, np.clip(values[..., :1], 0, 1))
    scale = np.divide(angle, length, out=np.zeros_like(angle), where=length > 1e-8)
    return (vector * scale).astype(np.float32)


def quaternion_exp(values: np.ndarray) -> np.ndarray:
    angle = np.linalg.norm(values, axis=-1, keepdims=True)
    half = angle * np.float32(0.5)
    scale = np.divide(np.sin(half), angle, out=np.full_like(angle, np.float32(0.5)), where=angle > 1e-8)
    return canonical_quaternions(np.concatenate([np.cos(half), values * scale], axis=-1))


def prepare_rotation(source: Path, output_pattern: str) -> dict[str, Any]:
    layout = read_raw4d_layout(source)
    rows = load_rows(layout)
    rotations, frames = extract_track(rows, layout, "rot_bank", ("w", "x", "y", "z"))
    rotations = canonical_quaternions(rotations)
    inverse0 = rotations[:, 0].copy()
    inverse0[:, 1:] *= np.float32(-1)
    delta = canonical_quaternions(multiply_quaternions(rotations[:, 1], inverse0))
    vectors = np.stack([quaternion_log(rotations[:, 0]), quaternion_log(delta)], axis=1)
    xyz, geometry_meta = quantized_base(source)
    quantized = np.rint((vectors + np.float32(np.pi)) / np.float32(2 * np.pi) * np.float32(255)).clip(0, 255).astype(np.uint8)
    outputs: list[str] = []
    for key in range(2):
        path = Path(output_pattern % key)
        write_attribute_ply(path, xyz.astype(np.float32), quantized[:, key])
        outputs.append(str(path))
    return {
        "attribute": "rotation_log_q0_delta",
        "frames": frames,
        "outputs": outputs,
        "quantization_low": float(-np.pi),
        "quantization_high": float(np.pi),
        "quantization_step": float(2 * np.pi / 255),
        **geometry_meta,
    }


def analyze_rotation(source: Path, decoded_pattern: str, id_mapping: Path) -> dict[str, Any]:
    layout = read_raw4d_layout(source)
    rows = load_rows(layout)
    rotations, _ = extract_track(rows, layout, "rot_bank", ("w", "x", "y", "z"))
    source_rotation = canonical_quaternions(rotations)
    ids = decoded_source_ids(id_mapping)
    decoded_q = np.stack([ply_colors(Path(decoded_pattern % key)) for key in range(2)], axis=1)
    vectors = np.float32(-np.pi) + decoded_q.astype(np.float32) * np.float32(2 * np.pi / 255)
    decoded0 = quaternion_exp(vectors[:, 0])
    decoded_delta = quaternion_exp(vectors[:, 1])
    decoded1 = canonical_quaternions(multiply_quaternions(decoded_delta, decoded0))
    decoded = np.stack([decoded0, decoded1], axis=1)
    dot = np.abs(np.sum(source_rotation[ids] * decoded, axis=2)).clip(0, 1)
    angular = np.degrees(np.float32(2) * np.arccos(dot))
    return {
        "attribute": "rotation_log_q0_delta",
        "gaussian_count": int(ids.size),
        "angular_error_degrees_mean": float(np.mean(angular)),
        "angular_error_degrees_p99": float(np.percentile(angular, 99)),
        "angular_error_degrees_maximum": float(np.max(angular)),
        "frame0_angular_error_degrees_mean": float(np.mean(angular[:, 0])),
        "frame1_angular_error_degrees_mean": float(np.mean(angular[:, 1])),
    }


#WDD-gpt 2026-08-15 - 将LDMG多级RVQ索引按空间位置交给G-PCC，实测其空间熵编码是否优于现有Zstd码流。
def prepare_ldmg_labels(source: Path, container: Path, output_pattern: str) -> dict[str, Any]:
    xyz, geometry_meta = quantized_base(source)
    manifest, streams = read_container(container)
    count = int(manifest["gaussian_count"])
    levels = int(manifest["attributes"]["position"]["curve_bank"]["rvq_levels"])
    labels_sorted = np.frombuffer(streams["position_ldmg_rvq_labels"], dtype=np.uint8).reshape(count, levels)
    order = np.argsort(morton_codes(xyz), kind="stable")
    labels = np.empty_like(labels_sorted)
    labels[order] = labels_sorted
    outputs: list[str] = []
    frame_count = (levels + 2) // 3
    for frame in range(frame_count):
        values = np.zeros((count, 3), dtype=np.uint8)
        first = frame * 3
        available = min(3, levels - first)
        values[:, :available] = labels[:, first:first + available]
        path = Path(output_pattern % frame)
        write_attribute_ply(path, xyz.astype(np.float32), values)
        outputs.append(str(path))
    return {
        "attribute": "ldmg_rvq_labels",
        "container": str(container),
        "levels": levels,
        "frames": frame_count,
        "outputs": outputs,
        "source_label_stored_bytes": next(
            int(item["stored_bytes"])
            for item in manifest["streams"]
            if item["name"] == "position_ldmg_rvq_labels"
        ),
        **geometry_meta,
    }


def analyze_ldmg_labels(
    source: Path,
    container: Path,
    decoded_pattern: str,
    id_mapping: Path,
) -> dict[str, Any]:
    xyz, _ = quantized_base(source)
    manifest, streams = read_container(container)
    count = int(manifest["gaussian_count"])
    levels = int(manifest["attributes"]["position"]["curve_bank"]["rvq_levels"])
    labels_sorted = np.frombuffer(streams["position_ldmg_rvq_labels"], dtype=np.uint8).reshape(count, levels)
    order = np.argsort(morton_codes(xyz), kind="stable")
    labels = np.empty_like(labels_sorted)
    labels[order] = labels_sorted
    ids = decoded_source_ids(id_mapping)
    frames = (levels + 2) // 3
    decoded = np.concatenate(
        [ply_colors(Path(decoded_pattern % frame)) for frame in range(frames)],
        axis=1,
    )[:, :levels]
    difference = decoded.astype(np.int16) - labels[ids].astype(np.int16)
    return {
        "attribute": "ldmg_rvq_labels",
        "gaussian_count": int(ids.size),
        "levels": levels,
        "exact_label_fraction": float(np.mean(difference == 0)),
        "exact_track_fraction": float(np.mean(np.all(difference == 0, axis=1))),
        "maximum_label_difference": int(np.max(np.abs(difference))),
    }


def analyze_roundtrip(original: Path, decoded: Path) -> dict[str, Any]:
    source = read_vertex_ply(original)
    result = read_vertex_ply(decoded)
    source_xyz = np.stack([source[name] for name in ("x", "y", "z")], axis=1)
    decoded_xyz = np.stack([result[name] for name in ("x", "y", "z")], axis=1)
    source_order = np.lexsort((source_xyz[:, 2], source_xyz[:, 1], source_xyz[:, 0]))
    decoded_order = np.lexsort((decoded_xyz[:, 2], decoded_xyz[:, 1], decoded_xyz[:, 0]))
    same_multiset = source_xyz.shape == decoded_xyz.shape and np.array_equal(
        source_xyz[source_order], decoded_xyz[decoded_order]
    )
    output: dict[str, Any] = {
        "source_points": int(source_xyz.shape[0]),
        "decoded_points": int(decoded_xyz.shape[0]),
        "point_count_equal": source_xyz.shape[0] == decoded_xyz.shape[0],
        "geometry_multiset_exact": bool(same_multiset),
        "maximum_coordinate_error": None,
        "id_attribute_present": all(name in result for name in ("red", "green", "blue")),
    }
    if same_multiset:
        output["maximum_coordinate_error"] = float(np.max(np.abs(
            source_xyz[source_order] - decoded_xyz[decoded_order]
        )))
    if output["id_attribute_present"]:
        ids = (
            result["red"].astype(np.uint32)
            | (result["green"].astype(np.uint32) << np.uint32(8))
            | (result["blue"].astype(np.uint32) << np.uint32(16))
        )
        valid = ids < source_xyz.shape[0]
        mapping_exact = bool(
            np.all(valid)
            and np.unique(ids).size == source_xyz.shape[0]
            and np.array_equal(decoded_xyz, source_xyz[ids])
        )
        output.update({
            "id_minimum": int(np.min(ids)),
            "id_maximum": int(np.max(ids)),
            "id_unique_count": int(np.unique(ids).size),
            "id_mapping_exact": mapping_exact,
        })
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="TMC13 probes for RAW4D attributes")
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare-geometry")
    prepare.add_argument("source", type=Path)
    prepare.add_argument("output", type=Path)
    prepare.add_argument("--with-ids", action="store_true")
    analyze = sub.add_parser("analyze-roundtrip")
    analyze.add_argument("original", type=Path)
    analyze.add_argument("decoded", type=Path)
    scale = sub.add_parser("prepare-scale")
    scale.add_argument("source", type=Path)
    scale.add_argument("output_pattern")
    scale_eval = sub.add_parser("analyze-scale")
    scale_eval.add_argument("source", type=Path)
    scale_eval.add_argument("decoded_pattern")
    scale_eval.add_argument("id_mapping", type=Path)
    rotation = sub.add_parser("prepare-rotation")
    rotation.add_argument("source", type=Path)
    rotation.add_argument("output_pattern")
    rotation_eval = sub.add_parser("analyze-rotation")
    rotation_eval.add_argument("source", type=Path)
    rotation_eval.add_argument("decoded_pattern")
    rotation_eval.add_argument("id_mapping", type=Path)
    labels = sub.add_parser("prepare-ldmg-labels")
    labels.add_argument("source", type=Path)
    labels.add_argument("container", type=Path)
    labels.add_argument("output_pattern")
    labels_eval = sub.add_parser("analyze-ldmg-labels")
    labels_eval.add_argument("source", type=Path)
    labels_eval.add_argument("container", type=Path)
    labels_eval.add_argument("decoded_pattern")
    labels_eval.add_argument("id_mapping", type=Path)
    args = parser.parse_args()
    if args.command == "prepare-geometry":
        result = prepare_geometry(args.source, args.output, args.with_ids)
    elif args.command == "analyze-roundtrip":
        result = analyze_roundtrip(args.original, args.decoded)
    elif args.command == "prepare-scale":
        result = prepare_scale(args.source, args.output_pattern)
    elif args.command == "analyze-scale":
        result = analyze_scale(args.source, args.decoded_pattern, args.id_mapping)
    elif args.command == "prepare-rotation":
        result = prepare_rotation(args.source, args.output_pattern)
    elif args.command == "prepare-ldmg-labels":
        result = prepare_ldmg_labels(args.source, args.container, args.output_pattern)
    elif args.command == "analyze-ldmg-labels":
        result = analyze_ldmg_labels(args.source, args.container, args.decoded_pattern, args.id_mapping)
    else:
        result = analyze_rotation(args.source, args.decoded_pattern, args.id_mapping)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
