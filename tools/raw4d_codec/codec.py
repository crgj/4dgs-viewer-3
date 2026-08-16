#!/usr/bin/env python3
"""Standalone encoder/decoder for the engineering-oriented .4cgs container."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
import time
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import zstandard as zstd


#WDD-gpt 2026-08-14 - 定义可独立解码的 4CGS V1 容器，避免依赖源 RAW4D 补齐属性。
CONTAINER_MAGIC = b"4CGS0001"
CONTAINER_PREFIX = struct.Struct("<8sII")
SH_MAGIC = b"RVQ5SH01"
SH_HEADER = struct.Struct("<8sIBBHI")
C0 = 0.28209479177387814


@dataclass(frozen=True)
class Raw4DLayout:
    path: Path
    header_bytes: int
    vertex_count: int
    total_frames: int
    properties: tuple[str, ...]
    comments: dict[str, str]
    scalar_encoding: str
    scalar_bytes: int


@dataclass
class StreamPayload:
    name: str
    compression: str
    raw: bytes
    stored: bytes


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path, chunk_bytes: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_bytes):
            digest.update(chunk)
    return digest.hexdigest()


def read_raw4d_layout(path: Path) -> Raw4DLayout:
    header = bytearray()
    with path.open("rb") as handle:
        while b"end_header\n" not in header:
            chunk = handle.read(65536)
            if not chunk:
                raise ValueError("RAW4D end_header was not found")
            header.extend(chunk)
            if len(header) > 1024 * 1024:
                raise ValueError("RAW4D header exceeds 1 MiB")
    header_bytes = header.index(b"end_header\n") + len(b"end_header\n")
    lines = bytes(header[:header_bytes]).decode("ascii").splitlines()
    if lines[:2] != ["ply", "format binary_little_endian 1.0"]:
        raise ValueError("Only binary_little_endian PLY/RAW4D is supported")
    vertex_count = int(next(line.split()[2] for line in lines if line.startswith("element vertex ")))
    property_declarations = [line.split() for line in lines if line.startswith("property ")]
    properties = tuple(parts[-1] for parts in property_declarations)
    property_types = tuple(parts[1] for parts in property_declarations)
    supported_types = {
        "float": ("float32", 4),
        "float32": ("float32", 4),
        "ushort": ("float16", 2),
        "uint16": ("float16", 2),
    }
    unsupported = [kind for kind in property_types if kind not in supported_types]
    if unsupported:
        raise ValueError(f"RAW4D contains unsupported property type: {unsupported[0]}")
    encodings = {supported_types[kind] for kind in property_types}
    if len(encodings) != 1:
        raise ValueError("RAW4D requires one uniform scalar encoding for all vertex properties")
    scalar_encoding, scalar_bytes = next(iter(encodings))
    comments: dict[str, str] = {}
    for line in lines:
        match = re.match(r"comment\s+(\S+)\s+(.+)", line)
        if match:
            comments[match.group(1)] = match.group(2).strip()
    total_frames = int(comments["total_frames"])
    if scalar_encoding == "float16" and comments.get("fp16_quantized") != "1":
        raise ValueError("RAW4D ushort properties require comment fp16_quantized 1")
    expected = header_bytes + vertex_count * len(properties) * scalar_bytes
    if path.stat().st_size < expected:
        raise ValueError(f"RAW4D is truncated: expected {expected} bytes")
    return Raw4DLayout(
        path,
        header_bytes,
        vertex_count,
        total_frames,
        properties,
        comments,
        scalar_encoding,
        scalar_bytes,
    )


def load_rows(layout: Raw4DLayout) -> np.memmap:
    #WDD-gpt  2026-08-15 - ushort RAW4D 承载的是 IEEE 754 binary16 位模式，必须按 float16 重解释后再由属性提取器展开为 float32。
    dtype = "<f2" if layout.scalar_encoding == "float16" else "<f4"
    return np.memmap(
        layout.path,
        dtype=dtype,
        mode="r",
        offset=layout.header_bytes,
        shape=(layout.vertex_count, len(layout.properties)),
    )


def property_indices(layout: Raw4DLayout, names: Iterable[str]) -> list[int]:
    lookup = {name: index for index, name in enumerate(layout.properties)}
    missing = [name for name in names if name not in lookup]
    if missing:
        raise ValueError(f"RAW4D is missing properties: {', '.join(missing[:8])}")
    return [lookup[name] for name in names]


def keyframes(total_frames: int, stride: int, count: int) -> list[int]:
    result = list(range(0, total_frames, stride))
    if result[-1] != total_frames - 1:
        result.append(total_frames - 1)
    if len(result) != count:
        raise ValueError(f"Keyframe mismatch: stride={stride}, expected={len(result)}, stored={count}")
    return result


def track_names(prefix: str, components: tuple[str, ...], count: int) -> list[str]:
    names: list[str] = []
    for bank in range(count):
        for component in components:
            names.append(f"{prefix}_{bank}_{component}" if component else f"{prefix}_{bank}")
    return names


def find_bank_count(properties: tuple[str, ...], prefix: str) -> int:
    expression = re.compile(rf"^{re.escape(prefix)}_(\d+)(?:_|$)")
    maximum = -1
    for name in properties:
        if match := expression.match(name):
            maximum = max(maximum, int(match.group(1)))
    return maximum + 1


def extract_track(
    rows: np.ndarray,
    layout: Raw4DLayout,
    prefix: str,
    components: tuple[str, ...],
) -> tuple[np.ndarray, list[int]]:
    count = find_bank_count(layout.properties, prefix)
    if count <= 0:
        raise ValueError(f"RAW4D contains no {prefix} bank")
    stride_names = {
        "xyz_bank": "xyz_bank_keyframe_stride",
        "rot_bank": "rot_bank_keyframe_stride",
        "f_dc_bank": "features_dc_bank_keyframe_stride",
        "scale_bank": "scaling_bank_keyframe_stride",
        "opacity_bank": "opacity_bank_keyframe_stride",
    }
    stride = int(layout.comments[stride_names[prefix]])
    frames = keyframes(layout.total_frames, stride, count)
    indices = property_indices(layout, track_names(prefix, components, count))
    values = np.asarray(rows[:, indices], dtype=np.float32).reshape(layout.vertex_count, count, len(components))
    return values, frames


def compress_stream(name: str, data: bytes, level: int, compression: str = "zstd") -> StreamPayload:
    if compression == "raw":
        stored = data
    elif compression == "zstd":
        stored = zstd.ZstdCompressor(level=level, threads=0).compress(data)
    else:
        raise ValueError(f"Unsupported compression: {compression}")
    return StreamPayload(name=name, compression=compression, raw=data, stored=stored)


def linear_quantize(values: np.ndarray, bits: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    values = np.asarray(values, dtype=np.float32)
    reduce_axes = tuple(range(values.ndim - 1))
    minimum = np.min(values, axis=reduce_axes).astype(np.float32)
    maximum = np.max(values, axis=reduce_axes).astype(np.float32)
    levels = np.float32((1 << bits) - 1)
    scale = np.where(maximum > minimum, (maximum - minimum) / levels, np.float32(1.0)).astype(np.float32)
    quantized = np.rint((values - minimum) / scale).clip(0, int(levels)).astype(np.uint16)
    return quantized, minimum, maximum


def linear_dequantize(quantized: np.ndarray, minimum: np.ndarray, maximum: np.ndarray, bits: int) -> np.ndarray:
    minimum = np.asarray(minimum, dtype=np.float32)
    maximum = np.asarray(maximum, dtype=np.float32)
    levels = np.float32((1 << bits) - 1)
    scale = np.where(maximum > minimum, (maximum - minimum) / levels, np.float32(0.0)).astype(np.float32)
    return minimum + np.asarray(quantized, dtype=np.float32) * scale


def pack_xyz(quantized: np.ndarray, bits: tuple[int, int, int]) -> np.ndarray:
    wide = sum(bits) > 32
    dtype = np.uint64 if wide else np.uint32
    q = np.asarray(quantized, dtype=dtype)
    packed = q[..., 0] | (q[..., 1] << bits[0]) | (q[..., 2] << (bits[0] + bits[1]))
    return packed.astype("<u8" if wide else "<u4", copy=False)


def unpack_xyz(packed: np.ndarray, bits: tuple[int, int, int]) -> np.ndarray:
    packed = np.asarray(packed, dtype=np.uint64 if sum(bits) > 32 else np.uint32)
    result = np.empty(packed.shape + (3,), dtype=np.uint16)
    result[..., 0] = packed & ((1 << bits[0]) - 1)
    result[..., 1] = (packed >> bits[0]) & ((1 << bits[1]) - 1)
    result[..., 2] = (packed >> (bits[0] + bits[1])) & ((1 << bits[2]) - 1)
    return result


def dequantize_position(q: np.ndarray, minimum: np.ndarray, maximum: np.ndarray, bits: tuple[int, int, int]) -> np.ndarray:
    levels = np.asarray([(1 << bit) - 1 for bit in bits], dtype=np.float32)
    minimum = np.asarray(minimum, dtype=np.float32)
    maximum = np.asarray(maximum, dtype=np.float32)
    scale = np.where(maximum > minimum, (maximum - minimum) / levels, np.float32(0.0)).astype(np.float32)
    return minimum + np.asarray(q, dtype=np.float32) * scale


def interpolate_masked_positions(
    masks: np.ndarray,
    packed_values: np.ndarray,
    frames: list[int],
    minimum: np.ndarray,
    maximum: np.ndarray,
    bits: tuple[int, int, int],
) -> np.ndarray:
    count = masks.size
    keys = len(frames)
    selected = ((masks[:, None].astype(np.uint32) >> np.arange(keys, dtype=np.uint32)) & 1).astype(bool)
    expected = int(selected.sum())
    if expected != packed_values.size:
        raise ValueError(f"Position knot count mismatch: mask={expected}, stream={packed_values.size}")
    retained = np.zeros((count, keys, 3), dtype=np.float32)
    retained[selected] = dequantize_position(unpack_xyz(packed_values, bits), minimum, maximum, bits)

    left = np.zeros((count, keys), dtype=np.uint8)
    current = np.zeros(count, dtype=np.uint8)
    for key in range(keys):
        current = np.where(selected[:, key], key, current)
        left[:, key] = current
    right = np.zeros((count, keys), dtype=np.uint8)
    current.fill(0)
    for key in range(keys - 1, -1, -1):
        current = np.where(selected[:, key], key, current)
        right[:, key] = current

    rows = np.arange(count)[:, None]
    left_values = retained[rows, left]
    right_values = retained[rows, right]
    frame_values = np.asarray(frames, dtype=np.float32)
    left_times = frame_values[left]
    right_times = frame_values[right]
    denominator = right_times - left_times
    alpha = np.divide(
        frame_values[None, :] - left_times,
        denominator,
        out=np.zeros_like(denominator, dtype=np.float32),
        where=denominator != 0,
    )
    return left_values + (right_values - left_values) * alpha[..., None]


def encode_positions(
    positions: np.ndarray,
    frames: list[int],
    fit_ratio: float,
    maximum_ratio: float,
    bits_per_axis: int | None = None,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    count, keys, _ = positions.shape
    if keys > 16:
        raise ValueError("4CGS V1 position masks support at most 16 source keys")
    minimum = np.min(positions, axis=(0, 1)).astype(np.float32)
    maximum = np.max(positions, axis=(0, 1)).astype(np.float32)
    ranges = maximum - minimum
    diagonal = float(np.linalg.norm(ranges.astype(np.float64)))
    if not diagonal > 0:
        raise ValueError("Position scene diagonal is zero")
    if bits_per_axis is None:
        #WDD-gpt 2026-08-14 - 将较少的 10 位分给跨度最短轴，32 位恰好保存一个 XYZ 节点。
        shortest_axis = int(np.argmin(ranges))
        bit_list = [11, 11, 11]
        bit_list[shortest_axis] = 10
    else:
        if not 10 <= bits_per_axis <= 16:
            raise ValueError("Position bits per axis must be in [10, 16]")
        bit_list = [bits_per_axis, bits_per_axis, bits_per_axis]
    bits = tuple(bit_list)
    levels = np.asarray([(1 << bit) - 1 for bit in bits], dtype=np.float32)
    scale = np.where(ranges > 0, ranges / levels, np.float32(1.0)).astype(np.float32)
    quantized = np.rint((positions - minimum) / scale).clip(0, levels).astype(np.uint16)

    fit_limit = diagonal * fit_ratio
    maximum_limit = diagonal * maximum_ratio
    frame_values = np.asarray(frames, dtype=np.float32)
    infinity = np.uint8(127)
    cost = np.full((count, keys), infinity, dtype=np.uint8)
    predecessor = np.zeros((count, keys), dtype=np.uint8)
    cost[:, 0] = 1
    for right in range(1, keys):
        for left in range(right):
            if right == left + 1:
                valid = np.ones(count, dtype=bool)
            else:
                alpha = (
                    (frame_values[left + 1:right] - frame_values[left])
                    / (frame_values[right] - frame_values[left])
                ).astype(np.float32)
                predicted = positions[:, left:left + 1] + (
                    positions[:, right:right + 1] - positions[:, left:left + 1]
                ) * alpha[None, :, None]
                errors = np.linalg.norm(positions[:, left + 1:right] - predicted, axis=2)
                valid = np.max(errors, axis=1) <= fit_limit
            candidate = cost[:, left] + np.uint8(1)
            improve = valid & (candidate < cost[:, right])
            cost[improve, right] = candidate[improve]
            predecessor[improve, right] = left

    masks = np.zeros(count, dtype=np.uint16)
    current = np.full(count, keys - 1, dtype=np.uint8)
    active = np.ones(count, dtype=bool)
    rows = np.arange(count)
    for _ in range(keys):
        masks[active] |= (np.uint16(1) << current[active].astype(np.uint16))
        next_key = predecessor[rows, current]
        active &= current != 0
        current = np.where(active, next_key, current)
    masks |= np.uint16(1)
    static_error = np.max(np.linalg.norm(positions - positions[:, :1], axis=2), axis=1)
    masks[static_error <= fit_limit] = np.uint16(1)

    def serialize_selected(current_masks: np.ndarray) -> np.ndarray:
        selected = ((current_masks[:, None].astype(np.uint32) >> np.arange(keys, dtype=np.uint32)) & 1).astype(bool)
        return pack_xyz(quantized[selected], bits)

    packed = serialize_selected(masks)
    decoded = interpolate_masked_positions(masks, packed, frames, minimum, maximum, bits)
    per_track_error = np.max(np.linalg.norm(decoded - positions, axis=2), axis=1)
    fallback = per_track_error > maximum_limit
    if np.any(fallback):
        masks[fallback] = np.uint16((1 << keys) - 1)
        packed = serialize_selected(masks)
        decoded = interpolate_masked_positions(masks, packed, frames, minimum, maximum, bits)
        per_track_error = np.max(np.linalg.norm(decoded - positions, axis=2), axis=1)
    if float(np.max(per_track_error)) > maximum_limit * 1.00001:
        raise AssertionError("Serialized position stream violates the configured hard error bound")

    knot_counts = np.asarray([int(value).bit_count() for value in masks], dtype=np.uint8)
    metrics = {
        "keyframes": frames,
        "bits_xyz": list(bits),
        "packed_dtype": "uint64" if sum(bits) > 32 else "uint32",
        # WDD-gpt 2026-08-14 - 共享关键帧区间构成零存储解析曲线 Bank，每个高斯仅保存选中的稀疏折线节点。
        "curve_bank": {
            "type": "shared analytic linear-segment basis",
            "candidate_segments": keys * (keys - 1) // 2,
            "stored_codebook_bytes": 0,
            "selection_stream": "position_masks",
        },
        "minimum": minimum.tolist(),
        "maximum": maximum.tolist(),
        "scene_diagonal": diagonal,
        "fit_ratio": fit_ratio,
        "maximum_ratio": maximum_ratio,
        "maximum_error": float(np.max(per_track_error)),
        "maximum_error_ratio": float(np.max(per_track_error) / diagonal),
        "rmse": float(np.sqrt(np.mean(np.square(decoded - positions), dtype=np.float64))),
        "average_knots": float(np.mean(knot_counts)),
        "removed_fraction": float(1.0 - np.sum(knot_counts) / (count * keys)),
        "static_tracks": int(np.count_nonzero(knot_counts == 1)),
        "linear_or_static_tracks": int(np.count_nonzero(knot_counts <= 2)),
        "fallback_tracks": int(np.count_nonzero(fallback)),
        "packed_knot_count": int(packed.size),
    }
    return masks.astype("<u2", copy=False), packed, metrics


def normalize_quaternions(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    lengths = np.linalg.norm(values, axis=-1, keepdims=True)
    fallback = np.zeros_like(values)
    fallback[..., 0] = 1
    return np.where(lengths > 1e-12, values / np.maximum(lengths, 1e-12), fallback).astype(np.float32)


def encode_quaternions(values: np.ndarray, bits: int = 10) -> tuple[np.ndarray, dict[str, Any]]:
    normalized = normalize_quaternions(values)
    flat = normalized.reshape(-1, 4)
    omitted = np.argmax(np.abs(flat), axis=1).astype(np.uint32)
    signs = np.where(flat[np.arange(flat.shape[0]), omitted] < 0, -1.0, 1.0).astype(np.float32)
    canonical = flat * signs[:, None]
    kept = np.empty((flat.shape[0], 3), dtype=np.float32)
    for index in range(4):
        selected = omitted == index
        kept[selected] = canonical[selected][:, [component for component in range(4) if component != index]]
    limit = np.float32(1 / math.sqrt(2))
    levels = np.float32((1 << bits) - 1)
    quantized = np.rint((np.clip(kept, -limit, limit) + limit) * (levels / (2 * limit))).astype(np.uint32)
    packed = omitted | (quantized[:, 0] << 2) | (quantized[:, 1] << (2 + bits)) | (quantized[:, 2] << (2 + 2 * bits))
    decoded = decode_quaternions(packed, values.shape[:-1], bits)
    dot = np.abs(np.sum(normalized * decoded, axis=-1)).clip(0, 1)
    degrees = np.degrees(2 * np.arccos(dot))
    return packed.astype("<u4", copy=False), {
        "bits_per_component": bits,
        "maximum_angular_error_degrees": float(np.max(degrees)),
        "mean_angular_error_degrees": float(np.mean(degrees)),
        "p99_angular_error_degrees": float(np.percentile(degrees, 99)),
    }


def decode_quaternions(packed: np.ndarray, shape: tuple[int, ...], bits: int = 10) -> np.ndarray:
    packed = np.asarray(packed, dtype=np.uint32).reshape(-1)
    omitted = packed & 3
    mask = (1 << bits) - 1
    q = np.stack([
        (packed >> 2) & mask,
        (packed >> (2 + bits)) & mask,
        (packed >> (2 + 2 * bits)) & mask,
    ], axis=1).astype(np.float32)
    limit = np.float32(1 / math.sqrt(2))
    kept = q * (2 * limit / np.float32(mask)) - limit
    result = np.zeros((packed.size, 4), dtype=np.float32)
    for index in range(4):
        selected = omitted == index
        components = [component for component in range(4) if component != index]
        result[np.ix_(selected, components)] = kept[selected]
        result[selected, index] = np.sqrt(np.maximum(0, 1 - np.sum(np.square(kept[selected]), axis=1)))
    return normalize_quaternions(result).reshape(shape + (4,))


def encode_opacity(values: np.ndarray, bits: int = 14, clamp: tuple[float, float] = (-16.0, 16.0)) -> tuple[np.ndarray, dict[str, Any]]:
    low, high = clamp
    finite = np.isfinite(values)
    clipped = np.clip(values, low, high)
    levels = (1 << bits) - 1
    # Code zero is exact negative infinity; finite values occupy 1..levels.
    quantized = np.rint((clipped - low) * ((levels - 1) / (high - low))).astype(np.int64) + 1
    quantized[(~finite) & (values < 0)] = 0
    quantized = np.clip(quantized, 0, levels).astype(np.uint16)
    decoded = decode_opacity(quantized, bits, clamp)
    source_alpha = 1 / (1 + np.exp(-np.clip(values, -80, 80)))
    decoded_alpha = 1 / (1 + np.exp(-np.clip(decoded, -80, 80)))
    error = np.abs(decoded_alpha - source_alpha)
    return quantized.astype("<u2", copy=False), {
        "bits": bits,
        "clamp": [low, high],
        "maximum_alpha_error": float(np.max(error)),
        "rmse_alpha": float(np.sqrt(np.mean(np.square(error), dtype=np.float64))),
        "negative_infinity_count": int(np.count_nonzero(np.isneginf(values))),
    }


def decode_opacity(quantized: np.ndarray, bits: int, clamp: tuple[float, float]) -> np.ndarray:
    low, high = clamp
    levels = (1 << bits) - 1
    q = np.asarray(quantized, dtype=np.uint16)
    result = low + (q.astype(np.float32) - 1) * ((high - low) / (levels - 1))
    result[q == 0] = -np.inf
    return result.astype(np.float32)


def stable_sigmoid(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    return 1 / (1 + np.exp(-np.clip(values, -80, 80)))


def encode_lifetime(mu: np.ndarray, width: np.ndarray, total_frames: int) -> tuple[np.ndarray, dict[str, Any]]:
    bounds = np.stack([mu - width, mu + width], axis=1).astype(np.float32)
    quantized, minimum, maximum = linear_quantize(bounds, 16)
    decoded = linear_dequantize(quantized, minimum, maximum, 16)
    frames = np.arange(total_frames, dtype=np.float32)[None, :]
    source_gate = stable_sigmoid(10 * (frames - bounds[:, :1])) * stable_sigmoid(10 * (bounds[:, 1:] - frames))
    decoded_gate = stable_sigmoid(10 * (frames - decoded[:, :1])) * stable_sigmoid(10 * (decoded[:, 1:] - frames))
    error = np.abs(decoded_gate - source_gate)
    return quantized.astype("<u2", copy=False), {
        "bits": 16,
        "minimum": minimum.tolist(),
        "maximum": maximum.tolist(),
        "maximum_gate_error": float(np.max(error)),
        "rmse_gate": float(np.sqrt(np.mean(np.square(error), dtype=np.float64))),
    }


def decode_lifetime(quantized: np.ndarray, metadata: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    bounds = linear_dequantize(
        quantized,
        np.asarray(metadata["minimum"], dtype=np.float32),
        np.asarray(metadata["maximum"], dtype=np.float32),
        int(metadata["bits"]),
    )
    return ((bounds[:, 0] + bounds[:, 1]) * 0.5).astype(np.float32), ((bounds[:, 1] - bounds[:, 0]) * 0.5).astype(np.float32)


def decode_sh_rvq5(payload: bytes) -> np.ndarray:
    magic, count, dimensions, levels, codebook_size, compressed_size = SH_HEADER.unpack_from(payload)
    if magic != SH_MAGIC or dimensions != 45 or levels != 5 or codebook_size != 256:
        raise ValueError("Unsupported CoReSH-5R stream")
    cursor = SH_HEADER.size
    mean = np.frombuffer(payload, dtype="<f2", count=dimensions, offset=cursor).astype(np.float32)
    cursor += dimensions * 2
    codebooks = np.frombuffer(
        payload,
        dtype="<f2",
        count=levels * codebook_size * dimensions,
        offset=cursor,
    ).reshape(levels, codebook_size, dimensions).astype(np.float32)
    cursor += levels * codebook_size * dimensions * 2
    labels = np.frombuffer(zlib.decompress(payload[cursor:cursor + compressed_size]), dtype=np.uint8)
    labels = labels.reshape(count, levels)
    return mean[None, :] + codebooks[np.arange(levels)[None, :], labels].sum(axis=1)


def encode_sh_rvq5(sh: np.ndarray, seed: int = 20260814) -> bytes:
    """Train CoReSH-5R. Current master.raw4d runs may reuse its already validated stream."""
    from sklearn.cluster import MiniBatchKMeans

    sh = np.asarray(sh, dtype=np.float32)
    count, dimensions = sh.shape
    if dimensions != 45:
        raise ValueError("CoReSH-5R requires 45 non-DC SH coefficients")
    rng = np.random.default_rng(seed)
    sample_indices = rng.choice(count, size=min(count, 65536), replace=False)
    mean_half = np.mean(sh, axis=0, dtype=np.float64).astype(np.float16)
    residual = sh - mean_half.astype(np.float32)
    codebooks = np.zeros((5, 256, dimensions), dtype=np.float16)
    labels = np.empty((count, 5), dtype=np.uint8)
    for level in range(5):
        model = MiniBatchKMeans(
            n_clusters=255,
            random_state=seed + level,
            batch_size=4096,
            max_iter=50,
            n_init=1,
            reassignment_ratio=0.01,
        )
        model.fit(residual[sample_indices])
        codebooks[level, 1:] = model.cluster_centers_.astype(np.float16)
        centers = codebooks[level].astype(np.float32)
        center_norm = np.sum(np.square(centers), axis=1)
        for first in range(0, count, 16384):
            chunk = residual[first:first + 16384]
            distances = np.sum(np.square(chunk), axis=1, keepdims=True) + center_norm[None, :] - 2 * chunk @ centers.T
            assigned = np.argmin(distances, axis=1).astype(np.uint8)
            labels[first:first + chunk.shape[0], level] = assigned
            residual[first:first + chunk.shape[0]] -= centers[assigned]
    compressed = zlib.compress(labels.tobytes(order="C"), level=9)
    return b"".join([
        SH_HEADER.pack(SH_MAGIC, count, dimensions, 5, 256, len(compressed)),
        mean_half.astype("<f2", copy=False).tobytes(),
        codebooks.astype("<f2", copy=False).tobytes(),
        compressed,
    ])


def add_linear_stream(
    streams: list[StreamPayload],
    metadata: dict[str, Any],
    name: str,
    values: np.ndarray,
    bits: int,
    zstd_level: int,
) -> np.ndarray:
    quantized, minimum, maximum = linear_quantize(values, bits)
    decoded = linear_dequantize(quantized, minimum, maximum, bits)
    streams.append(compress_stream(name, quantized.astype("<u2", copy=False).tobytes(), zstd_level))
    metadata[name] = {
        "shape": list(values.shape),
        "bits": bits,
        "minimum": minimum.tolist(),
        "maximum": maximum.tolist(),
        "rmse": float(np.sqrt(np.mean(np.square(decoded - values), dtype=np.float64))),
        "maximum_absolute_error": float(np.max(np.abs(decoded - values))),
    }
    return decoded


def write_container(output: Path, manifest: dict[str, Any], streams: list[StreamPayload]) -> None:
    manifest["streams"] = []
    for stream in streams:
        manifest["streams"].append({
            "name": stream.name,
            "compression": stream.compression,
            "raw_bytes": len(stream.raw),
            "stored_bytes": len(stream.stored),
            "sha256": sha256_bytes(stream.raw),
        })
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        handle.write(CONTAINER_PREFIX.pack(CONTAINER_MAGIC, len(manifest_bytes), zlib.crc32(manifest_bytes)))
        handle.write(manifest_bytes)
        for stream in streams:
            handle.write(stream.stored)


def read_container(path: Path) -> tuple[dict[str, Any], dict[str, bytes]]:
    with path.open("rb") as handle:
        prefix = handle.read(CONTAINER_PREFIX.size)
        if len(prefix) != CONTAINER_PREFIX.size:
            raise ValueError("Truncated 4CGS prefix")
        magic, manifest_size, manifest_crc = CONTAINER_PREFIX.unpack(prefix)
        if magic != CONTAINER_MAGIC:
            raise ValueError("Unsupported 4CGS magic/version")
        manifest_bytes = handle.read(manifest_size)
        if zlib.crc32(manifest_bytes) != manifest_crc:
            raise ValueError("4CGS manifest CRC mismatch")
        manifest = json.loads(manifest_bytes)
        streams: dict[str, bytes] = {}
        decompressor = zstd.ZstdDecompressor()
        for entry in manifest["streams"]:
            stored = handle.read(entry["stored_bytes"])
            if len(stored) != entry["stored_bytes"]:
                raise ValueError(f"Truncated 4CGS stream {entry['name']}")
            if entry["compression"] == "raw":
                raw = stored
            elif entry["compression"] == "zstd":
                raw = decompressor.decompress(stored, max_output_size=entry["raw_bytes"])
            else:
                raise ValueError(f"Unknown stream compression {entry['compression']}")
            if len(raw) != entry["raw_bytes"] or sha256_bytes(raw) != entry["sha256"]:
                raise ValueError(f"4CGS stream verification failed: {entry['name']}")
            streams[entry["name"]] = raw
        if handle.read(1):
            raise ValueError("Unexpected trailing bytes in 4CGS")
    return manifest, streams


def encode(
    source: Path,
    output: Path,
    sh_stream_path: Path | None,
    zstd_level: int,
    position_fit_ratio: float = 0.00015,
    position_maximum_ratio: float = 0.00025,
    position_bits: int | None = 14,
) -> dict[str, Any]:
    started = time.perf_counter()
    layout = read_raw4d_layout(source)
    rows = load_rows(layout)
    positions, position_frames = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    rotations, rotation_frames = extract_track(rows, layout, "rot_bank", ("w", "x", "y", "z"))
    colors, color_frames = extract_track(rows, layout, "f_dc_bank", ("0", "1", "2"))
    scales, scale_frames = extract_track(rows, layout, "scale_bank", ("0", "1", "2"))
    opacities, opacity_frames = extract_track(rows, layout, "opacity_bank", ("",))
    sh_names = [f"f_rest_{index}" for index in range(45)]
    sh = np.asarray(rows[:, property_indices(layout, sh_names)], dtype=np.float32)
    mu = np.asarray(rows[:, property_indices(layout, ["lifetime_mu"])[0]], dtype=np.float32)
    width = np.asarray(rows[:, property_indices(layout, ["lifetime_w"])[0]], dtype=np.float32)

    streams: list[StreamPayload] = []
    attributes: dict[str, Any] = {}

    masks, packed_positions, position_meta = encode_positions(
        positions,
        position_frames,
        position_fit_ratio,
        position_maximum_ratio,
        position_bits,
    )
    streams.append(compress_stream("position_masks", masks.tobytes(), zstd_level))
    streams.append(compress_stream("position_knots", packed_positions.tobytes(), zstd_level))
    position_meta["mask_shape"] = [layout.vertex_count]
    attributes["position"] = position_meta

    packed_rotations, rotation_metrics = encode_quaternions(rotations, 10)
    streams.append(compress_stream("rotation", packed_rotations.tobytes(), zstd_level))
    attributes["rotation"] = {
        "shape": list(rotations.shape[:-1]),
        "keyframes": rotation_frames,
        **rotation_metrics,
    }

    decoded_color = add_linear_stream(streams, attributes, "color_dc", colors, 12, zstd_level)
    attributes["color_dc"]["keyframes"] = color_frames
    attributes["color_dc"]["maximum_render_rgb_error"] = float(np.max(np.abs(decoded_color - colors)) * C0)

    decoded_scale = add_linear_stream(streams, attributes, "scale", scales, 14, zstd_level)
    attributes["scale"]["keyframes"] = scale_frames
    attributes["scale"]["maximum_relative_linear_error"] = float(np.max(np.abs(np.expm1(decoded_scale - scales))))

    quantized_opacity, opacity_metrics = encode_opacity(opacities, 14)
    streams.append(compress_stream("opacity", quantized_opacity.tobytes(), zstd_level))
    attributes["opacity"] = {
        "shape": list(opacities.shape),
        "keyframes": opacity_frames,
        **opacity_metrics,
    }

    quantized_lifetime, lifetime_metrics = encode_lifetime(mu, width, layout.total_frames)
    streams.append(compress_stream("lifetime", quantized_lifetime.tobytes(), zstd_level))
    attributes["lifetime"] = {"shape": list(quantized_lifetime.shape), **lifetime_metrics}

    if sh_stream_path is None:
        sh_payload = encode_sh_rvq5(sh)
        sh_mode = "trained"
    else:
        sh_payload = sh_stream_path.read_bytes()
        sh_mode = f"reused:{sh_stream_path}"
    decoded_sh = decode_sh_rvq5(sh_payload)
    if decoded_sh.shape != sh.shape:
        raise ValueError(f"CoReSH-5R shape mismatch: {decoded_sh.shape} != {sh.shape}")
    sh_error = decoded_sh - sh
    streams.append(compress_stream("coresh5r", sh_payload, zstd_level, compression="raw"))
    attributes["sh"] = {
        "shape": list(sh.shape),
        "codec": "CoReSH-5R",
        "source": sh_mode,
        "rmse": float(np.sqrt(np.mean(np.square(sh_error), dtype=np.float64))),
        "mae": float(np.mean(np.abs(sh_error))),
        "maximum_absolute_error": float(np.max(np.abs(sh_error))),
    }

    equivalent_ply_bytes = layout.vertex_count * layout.total_frames * 59 * 4
    manifest: dict[str, Any] = {
        "format": "4CGS",
        "version": 1,
        "codec_name": "CoRe4D-Adaptive39",
        "gaussian_pruning": False,
        "gaussian_count": layout.vertex_count,
        "total_frames": layout.total_frames,
        "source_name": source.name,
        "source_bytes": source.stat().st_size,
        "source_sha256": sha256_file(source),
        "compression_ratio_basis": "source_raw4d_bytes",
        "equivalent_float32_ply_sequence_bytes": equivalent_ply_bytes,
        "attributes": attributes,
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    write_container(output, manifest, streams)
    elapsed = time.perf_counter() - started
    manifest["measured_encode_seconds"] = elapsed
    manifest["container_bytes"] = output.stat().st_size
    manifest["compression_ratio_vs_source_raw4d"] = source.stat().st_size / output.stat().st_size
    manifest["compression_ratio_vs_equivalent_ply_sequence"] = equivalent_ply_bytes / output.stat().st_size
    return manifest


def decode_linear_stream(raw: bytes, metadata: dict[str, Any]) -> np.ndarray:
    shape = tuple(int(value) for value in metadata["shape"])
    quantized = np.frombuffer(raw, dtype="<u2").reshape(shape)
    return linear_dequantize(
        quantized,
        np.asarray(metadata["minimum"], dtype=np.float32),
        np.asarray(metadata["maximum"], dtype=np.float32),
        int(metadata["bits"]),
    )


def raw4d_output_properties(manifest: dict[str, Any]) -> list[str]:
    attributes = manifest["attributes"]
    names = [f"f_rest_{index}" for index in range(45)]
    names.extend(["lifetime_mu", "lifetime_w"])
    tracks = [
        ("xyz_bank", ("x", "y", "z"), len(attributes["position"]["keyframes"])),
        ("rot_bank", ("w", "x", "y", "z"), len(attributes["rotation"]["keyframes"])),
        ("f_dc_bank", ("0", "1", "2"), len(attributes["color_dc"]["keyframes"])),
        ("scale_bank", ("0", "1", "2"), len(attributes["scale"]["keyframes"])),
        ("opacity_bank", ("",), len(attributes["opacity"]["keyframes"])),
    ]
    for prefix, components, count in tracks:
        names.extend(track_names(prefix, components, count))
    return names


def write_decoded_raw4d(
    output: Path,
    manifest: dict[str, Any],
    sh: np.ndarray,
    position: np.ndarray,
    rotation: np.ndarray,
    color: np.ndarray,
    scale: np.ndarray,
    opacity: np.ndarray,
    mu: np.ndarray,
    width: np.ndarray,
) -> None:
    attributes = manifest["attributes"]
    count = int(manifest["gaussian_count"])
    properties = raw4d_output_properties(manifest)
    comments = [
        f"comment total_frames {manifest['total_frames']}",
        f"comment xyz_bank_keyframe_stride {attributes['position']['keyframes'][1] - attributes['position']['keyframes'][0]}",
        f"comment rot_bank_keyframe_stride {attributes['rotation']['keyframes'][1] - attributes['rotation']['keyframes'][0]}",
        f"comment features_dc_bank_keyframe_stride {attributes['color_dc']['keyframes'][1] - attributes['color_dc']['keyframes'][0]}",
        f"comment scaling_bank_keyframe_stride {attributes['scale']['keyframes'][1] - attributes['scale']['keyframes'][0]}",
        f"comment opacity_bank_keyframe_stride {attributes['opacity']['keyframes'][1] - attributes['opacity']['keyframes'][0]}",
        "comment decoded_from_4cgs CoRe4D-EBTS",
    ]
    header = "\n".join([
        "ply",
        "format binary_little_endian 1.0",
        *comments,
        f"element vertex {count}",
        *(f"property float {name}" for name in properties),
        "end_header",
        "",
    ]).encode("ascii")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        handle.write(header)
        handle.truncate(len(header) + count * len(properties) * 4)
    rows = np.memmap(output, dtype="<f4", mode="r+", offset=len(header), shape=(count, len(properties)))
    cursor = 0
    rows[:, cursor:cursor + 45] = sh
    cursor += 45
    rows[:, cursor] = mu
    rows[:, cursor + 1] = width
    cursor += 2
    for values in [position, rotation, color, scale, opacity]:
        columns = values.shape[1] * values.shape[2]
        rows[:, cursor:cursor + columns] = values.reshape(count, columns)
        cursor += columns
    if cursor != len(properties):
        raise AssertionError(f"Decoded RAW4D column mismatch: {cursor} != {len(properties)}")
    rows.flush()


def decode(source: Path, output: Path) -> dict[str, Any]:
    started = time.perf_counter()
    manifest, streams = read_container(source)
    attributes = manifest["attributes"]
    count = int(manifest["gaussian_count"])

    position_meta = attributes["position"]
    masks = np.frombuffer(streams["position_masks"], dtype="<u2", count=count)
    packed_dtype = "<u8" if position_meta.get("packed_dtype") == "uint64" else "<u4"
    knots = np.frombuffer(streams["position_knots"], dtype=packed_dtype)
    position = interpolate_masked_positions(
        masks,
        knots,
        position_meta["keyframes"],
        np.asarray(position_meta["minimum"], dtype=np.float32),
        np.asarray(position_meta["maximum"], dtype=np.float32),
        tuple(position_meta["bits_xyz"]),
    )

    rotation_meta = attributes["rotation"]
    rotation_shape = tuple(int(value) for value in rotation_meta["shape"])
    rotation = decode_quaternions(
        np.frombuffer(streams["rotation"], dtype="<u4"),
        rotation_shape,
        int(rotation_meta["bits_per_component"]),
    )
    color = decode_linear_stream(streams["color_dc"], attributes["color_dc"])
    scale = decode_linear_stream(streams["scale"], attributes["scale"])
    opacity_meta = attributes["opacity"]
    opacity = decode_opacity(
        np.frombuffer(streams["opacity"], dtype="<u2").reshape(opacity_meta["shape"]),
        int(opacity_meta["bits"]),
        tuple(opacity_meta["clamp"]),
    )
    lifetime_meta = attributes["lifetime"]
    lifetime_q = np.frombuffer(streams["lifetime"], dtype="<u2").reshape(lifetime_meta["shape"])
    mu, width = decode_lifetime(lifetime_q, lifetime_meta)
    sh = decode_sh_rvq5(streams["coresh5r"])
    write_decoded_raw4d(output, manifest, sh, position, rotation, color, scale, opacity, mu, width)
    return {
        "decoded_raw4d": str(output),
        "decoded_raw4d_bytes": output.stat().st_size,
        "measured_decode_seconds": time.perf_counter() - started,
        "gaussian_count": count,
        "total_frames": int(manifest["total_frames"]),
    }


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def main() -> None:
    parser = argparse.ArgumentParser(description="Encode, decode, or inspect standalone .4cgs files")
    subparsers = parser.add_subparsers(dest="command", required=True)
    encode_parser = subparsers.add_parser("encode", help="Encode RAW4D to standalone 4CGS")
    encode_parser.add_argument("source", type=Path)
    encode_parser.add_argument("output", type=Path)
    encode_parser.add_argument("--reuse-sh", type=Path, help="Reuse a validated CoReSH-5R stream")
    encode_parser.add_argument("--zstd-level", type=int, default=8)
    encode_parser.add_argument("--position-fit-ratio", type=float, default=0.00015)
    encode_parser.add_argument("--position-maximum-ratio", type=float, default=0.00025)
    encode_parser.add_argument("--position-bits", type=int, default=14)
    decode_parser = subparsers.add_parser("decode", help="Decode standalone 4CGS to viewer-compatible RAW4D")
    decode_parser.add_argument("source", type=Path)
    decode_parser.add_argument("output", type=Path)
    inspect_parser = subparsers.add_parser("inspect", help="Print the verified 4CGS manifest")
    inspect_parser.add_argument("source", type=Path)
    args = parser.parse_args()

    if args.command == "encode":
        if args.output.suffix.lower() != ".4cgs":
            raise ValueError("4CGS output must use the .4cgs suffix")
        result = encode(
            args.source,
            args.output,
            args.reuse_sh,
            args.zstd_level,
            args.position_fit_ratio,
            args.position_maximum_ratio,
            args.position_bits,
        )
    elif args.command == "decode":
        result = decode(args.source, args.output)
    else:
        result, _ = read_container(args.source)
    print_json(result)


if __name__ == "__main__":
    main()
