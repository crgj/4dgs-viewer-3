#!/usr/bin/env python3
"""Compact 4CGS profile targeting 40x relative to the source RAW4D file."""

from __future__ import annotations

import argparse
import json
import math
import struct
import time
import zlib
from pathlib import Path
from typing import Any, Callable

import numpy as np

from codec import (
    C0,
    SH_HEADER,
    SH_MAGIC,
    compress_stream,
    decode_sh_rvq5,
    extract_track,
    load_rows,
    normalize_quaternions,
    property_indices,
    read_container,
    read_raw4d_layout,
    sha256_file,
    write_container,
    write_decoded_raw4d,
)


#WDD-gpt 2026-08-14 - Compact40 使用空间排序与共享码本，把非 SH 控制在每高斯约 8 字节预算内。
PROFILE_NAME = "CoRe4D-Compact40"
POSITION_CURVE_LEVELS = 4
ROTATION_CLUSTERS = 2048
COLOR_CLUSTERS = 64
SCALE_CLUSTERS = 4096
OPACITY_CLUSTERS = 256
LIFETIME_CLUSTERS = 4
SPARSE_POSITION_FRACTION = 0.0
SPARSE_POSITION_CLUSTERS = 128


def reorder_sh_rvq5(payload: bytes, order: np.ndarray) -> bytes:
    magic, count, dimensions, levels, codebook_size, compressed_size = SH_HEADER.unpack_from(payload)
    if magic != SH_MAGIC or dimensions != 45 or levels != 5 or codebook_size != 256:
        raise ValueError("Unsupported CoReSH-5R stream")
    cursor = SH_HEADER.size + dimensions * 2 + levels * codebook_size * dimensions * 2
    labels = np.frombuffer(zlib.decompress(payload[cursor:cursor + compressed_size]), dtype=np.uint8).reshape(count, levels)
    reordered = zlib.compress(labels[order].tobytes(), level=9)
    return b"".join([
        SH_HEADER.pack(magic, count, dimensions, levels, codebook_size, len(reordered)),
        payload[SH_HEADER.size:cursor],
        reordered,
    ])


def spread_morton_10(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.uint32) & 0x3FF
    values = (values | (values << 16)) & 0x030000FF
    values = (values | (values << 8)) & 0x0300F00F
    values = (values | (values << 4)) & 0x030C30C3
    return (values | (values << 2)) & 0x09249249


def compact_morton_10(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.uint32) & 0x09249249
    values = (values ^ (values >> 2)) & 0x030C30C3
    values = (values ^ (values >> 4)) & 0x0300F00F
    values = (values ^ (values >> 8)) & 0x030000FF
    return (values ^ (values >> 16)) & 0x000003FF


def morton_codes(quantized_xyz: np.ndarray) -> np.ndarray:
    q = np.asarray(quantized_xyz, dtype=np.uint32)
    return spread_morton_10(q[:, 0]) | (spread_morton_10(q[:, 1]) << 1) | (spread_morton_10(q[:, 2]) << 2)


def morton_xyz(codes: np.ndarray) -> np.ndarray:
    codes = np.asarray(codes, dtype=np.uint32)
    return np.stack([
        compact_morton_10(codes),
        compact_morton_10(codes >> 1),
        compact_morton_10(codes >> 2),
    ], axis=1).astype(np.uint16)


def encode_unsigned_varints(values: np.ndarray) -> bytes:
    output = bytearray()
    for source in np.asarray(values, dtype=np.uint64):
        value = int(source)
        while value >= 0x80:
            output.append((value & 0x7F) | 0x80)
            value >>= 7
        output.append(value)
    return bytes(output)


def decode_unsigned_varints(payload: bytes, count: int) -> np.ndarray:
    result = np.empty(count, dtype=np.uint32)
    cursor = 0
    value = 0
    shift = 0
    index = 0
    for byte in payload:
        value |= (byte & 0x7F) << shift
        if byte & 0x80:
            shift += 7
            if shift > 35:
                raise ValueError("Invalid position Morton varint")
            continue
        if index >= count:
            raise ValueError("Too many position Morton values")
        result[index] = value
        index += 1
        value = 0
        shift = 0
    if index != count or shift:
        raise ValueError(f"Position Morton count mismatch: {index} != {count}")
    return result


def pack_bits(values: np.ndarray, bits: int) -> bytes:
    values = np.asarray(values, dtype=np.uint32).reshape(-1)
    if np.any(values >= (1 << bits)):
        raise ValueError(f"Value does not fit in {bits} bits")
    bit_indices = np.arange(bits, dtype=np.uint32)
    planes = ((values[:, None] >> bit_indices[None, :]) & 1).astype(np.uint8)
    return np.packbits(planes.reshape(-1), bitorder="little").tobytes()


def unpack_bits(payload: bytes, count: int, bits: int) -> np.ndarray:
    unpacked = np.unpackbits(np.frombuffer(payload, dtype=np.uint8), bitorder="little")[:count * bits]
    planes = unpacked.reshape(count, bits).astype(np.uint32)
    return np.sum(planes << np.arange(bits, dtype=np.uint32)[None, :], axis=1, dtype=np.uint32)


def assign_codebook(values: np.ndarray, codebook: np.ndarray, chunk_rows: int = 32768) -> np.ndarray:
    labels = np.empty(values.shape[0], dtype=np.uint16)
    center_norm = np.sum(np.square(codebook), axis=1)
    for first in range(0, values.shape[0], chunk_rows):
        chunk = values[first:first + chunk_rows]
        distances = (
            np.sum(np.square(chunk), axis=1, keepdims=True)
            + center_norm[None, :]
            - 2 * chunk @ codebook.T
        )
        labels[first:first + chunk.shape[0]] = np.argmin(distances, axis=1).astype(np.uint16)
    return labels


def train_codebook(
    values: np.ndarray,
    clusters: int,
    seed: int,
    sample_indices: np.ndarray,
    reserve_zero: bool = False,
) -> tuple[np.ndarray, np.ndarray]:
    from sklearn.cluster import MiniBatchKMeans

    trained_clusters = clusters - 1 if reserve_zero else clusters
    model = MiniBatchKMeans(
        n_clusters=trained_clusters,
        random_state=seed,
        batch_size=4096,
        max_iter=60,
        n_init=1,
        reassignment_ratio=0.005,
    )
    model.fit(values[sample_indices])
    centers = model.cluster_centers_.astype(np.float16).astype(np.float32)
    if reserve_zero:
        centers = np.concatenate([np.zeros((1, values.shape[1]), dtype=np.float32), centers], axis=0)
    labels = assign_codebook(values, centers)
    return centers, labels


def add_vq_stream(
    streams: list[Any],
    name: str,
    values: np.ndarray,
    clusters: int,
    seed: int,
    sample_indices: np.ndarray,
    zstd_level: int,
    reserve_zero: bool = False,
) -> tuple[np.ndarray, dict[str, Any]]:
    codebook, labels = train_codebook(values, clusters, seed, sample_indices, reserve_zero)
    bits = int(math.ceil(math.log2(clusters)))
    streams.append(compress_stream(f"{name}_codebook", codebook.astype("<f2").tobytes(), zstd_level))
    streams.append(compress_stream(f"{name}_labels", pack_bits(labels, bits), zstd_level))
    decoded = codebook[labels]
    return decoded, {
        "clusters": clusters,
        "bits": bits,
        "dimensions": values.shape[1],
        "codebook_shape": list(codebook.shape),
        "rmse": float(np.sqrt(np.mean(np.square(decoded - values), dtype=np.float64))),
        "maximum_absolute_error": float(np.max(np.abs(decoded - values))),
    }


def decode_vq_stream(streams: dict[str, bytes], metadata: dict[str, Any], name: str, count: int) -> np.ndarray:
    shape = tuple(int(value) for value in metadata["codebook_shape"])
    codebook = np.frombuffer(streams[f"{name}_codebook"], dtype="<f2").astype(np.float32).reshape(shape)
    labels = unpack_bits(streams[f"{name}_labels"], count, int(metadata["bits"]))
    if np.any(labels >= shape[0]):
        raise ValueError(f"Invalid {name} codebook label")
    return codebook[labels]


def encode_curve_bank(
    streams: list[Any],
    positions: np.ndarray,
    importance: np.ndarray,
    sample_indices: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    count, keys, _ = positions.shape
    displacements = (positions[:, 1:] - positions[:, :1]).reshape(count, -1)
    residual = displacements.copy()
    reconstructed = np.zeros_like(displacements)
    codebooks: list[np.ndarray] = []
    label_columns: list[np.ndarray] = []
    for level in range(POSITION_CURVE_LEVELS):
        codebook, labels = train_codebook(residual, 256, 20260840 + level, sample_indices, reserve_zero=True)
        codebooks.append(codebook)
        label_columns.append(labels.astype(np.uint8))
        reconstructed += codebook[labels]
        residual -= codebook[labels]
    codebook_array = np.stack(codebooks).astype(np.float16)
    labels = np.stack(label_columns, axis=1).astype(np.uint8)
    streams.append(compress_stream("position_curve_codebooks", codebook_array.astype("<f2").tobytes(), zstd_level))
    streams.append(compress_stream("position_curve_labels", labels.tobytes(), zstd_level))
    #WDD-gpt 2026-08-14 - 只为高视觉贡献轨迹追加稀疏残差折线，低贡献轨迹使用可熵压缩的零码。
    sparse_metadata: dict[str, Any] | None = None
    if SPARSE_POSITION_FRACTION > 0:
        selected_count = max(1, int(round(count * SPARSE_POSITION_FRACTION)))
        selected = np.argpartition(importance, count - selected_count)[count - selected_count:]
        selected_residual = residual[selected]
        rng = np.random.default_rng(20260842)
        sparse_sample = rng.choice(
            selected_residual.shape[0],
            size=min(selected_residual.shape[0], 32768),
            replace=False,
        )
        sparse_codebook, selected_labels = train_codebook(
            selected_residual,
            SPARSE_POSITION_CLUSTERS,
            20260842,
            sparse_sample,
            reserve_zero=True,
        )
        sparse_labels = np.zeros(count, dtype=np.uint16)
        sparse_labels[selected] = selected_labels
        reconstructed += sparse_codebook[sparse_labels]
        residual -= sparse_codebook[sparse_labels]
        sparse_bits = int(math.ceil(math.log2(SPARSE_POSITION_CLUSTERS)))
        streams.append(compress_stream("position_sparse_polyline_codebook", sparse_codebook.astype("<f2").tobytes(), zstd_level))
        streams.append(compress_stream("position_sparse_polyline_labels", pack_bits(sparse_labels, sparse_bits), zstd_level))
        sparse_metadata = {
            "selected_count": selected_count,
            "selected_fraction": SPARSE_POSITION_FRACTION,
            "clusters": SPARSE_POSITION_CLUSTERS,
            "bits": sparse_bits,
            "codebook_shape": list(sparse_codebook.shape),
        }
    track_error = np.max(np.linalg.norm(residual.reshape(count, keys - 1, 3), axis=2), axis=1)
    return reconstructed.reshape(count, keys - 1, 3), {
        "levels": POSITION_CURVE_LEVELS,
        "clusters": 256,
        "dimensions": displacements.shape[1],
        "codebook_shape": list(codebook_array.shape),
        "mean_track_error": float(np.mean(track_error)),
        "p99_track_error": float(np.percentile(track_error, 99)),
        "maximum_track_error": float(np.max(track_error)),
        "sparse_polyline_residual": sparse_metadata,
    }


def decode_curve_bank(
    streams: dict[str, bytes],
    metadata: dict[str, Any],
    count: int,
    keys: int,
    base: np.ndarray | None = None,
) -> np.ndarray:
    del base
    codebooks = np.frombuffer(streams["position_curve_codebooks"], dtype="<f2").astype(np.float32)
    codebooks = codebooks.reshape(metadata["codebook_shape"])
    labels = np.frombuffer(streams["position_curve_labels"], dtype=np.uint8).reshape(count, metadata["levels"])
    decoded = codebooks[np.arange(metadata["levels"])[None, :], labels].sum(axis=1)
    sparse_meta = metadata.get("sparse_polyline_residual")
    if sparse_meta:
        sparse_book = np.frombuffer(streams["position_sparse_polyline_codebook"], dtype="<f2").astype(np.float32)
        sparse_book = sparse_book.reshape(sparse_meta["codebook_shape"])
        sparse_labels = unpack_bits(streams["position_sparse_polyline_labels"], count, int(sparse_meta["bits"]))
        decoded += sparse_book[sparse_labels]
    return decoded.reshape(count, keys - 1, 3)


def canonical_rotations(rotations: np.ndarray) -> np.ndarray:
    result = normalize_quaternions(rotations)
    return result * np.where(result[..., :1] < 0, -1, 1)


def normalize_rotation_codebook(values: np.ndarray) -> np.ndarray:
    shape = values.shape
    return canonical_rotations(values.reshape(-1, 2, 4)).reshape(shape)


def encode(
    source: Path,
    output: Path,
    sh_stream_path: Path,
    zstd_level: int,
    *,
    profile_name: str = PROFILE_NAME,
    position_encoder: Callable[..., tuple[np.ndarray, dict[str, Any]]] | None = None,
    rotation_encoder: Callable[..., tuple[np.ndarray, dict[str, Any]]] | None = None,
    color_encoder: Callable[..., tuple[np.ndarray, dict[str, Any]]] | None = None,
    scale_encoder: Callable[..., tuple[np.ndarray, dict[str, Any]]] | None = None,
    opacity_encoder: Callable[..., tuple[np.ndarray, dict[str, Any]]] | None = None,
    lifetime_encoder: Callable[..., tuple[np.ndarray, np.ndarray, dict[str, Any]]] | None = None,
    codec_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    layout = read_raw4d_layout(source)
    rows = load_rows(layout)
    positions, position_frames = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    rotations, rotation_frames = extract_track(rows, layout, "rot_bank", ("w", "x", "y", "z"))
    colors, color_frames = extract_track(rows, layout, "f_dc_bank", ("0", "1", "2"))
    scales, scale_frames = extract_track(rows, layout, "scale_bank", ("0", "1", "2"))
    opacities, opacity_frames = extract_track(rows, layout, "opacity_bank", ("",))
    mu = np.asarray(rows[:, property_indices(layout, ["lifetime_mu"])[0]], dtype=np.float32)
    width = np.asarray(rows[:, property_indices(layout, ["lifetime_w"])[0]], dtype=np.float32)
    count = layout.vertex_count

    minimum = np.min(positions, axis=(0, 1)).astype(np.float32)
    maximum = np.max(positions, axis=(0, 1)).astype(np.float32)
    scale_xyz = (maximum - minimum) / np.float32(1023)
    q0 = np.rint((positions[:, 0] - minimum) / scale_xyz).clip(0, 1023).astype(np.uint16)
    morton = morton_codes(q0)
    order = np.argsort(morton, kind="stable")
    morton_sorted = morton[order]
    deltas = np.empty(count, dtype=np.uint32)
    deltas[0] = morton_sorted[0]
    deltas[1:] = morton_sorted[1:] - morton_sorted[:-1]

    positions = positions[order]
    rotations = rotations[order]
    colors = colors[order]
    scales = scales[order]
    opacities = opacities[order]
    mu = mu[order]
    width = width[order]
    rng = np.random.default_rng(20260814)
    sample_indices = rng.choice(count, size=min(count, 65536), replace=False)

    maximum_alpha = np.max(1 / (1 + np.exp(-np.clip(opacities.reshape(count, 4), -16, 16))), axis=1)
    maximum_radius = np.exp(np.clip(np.max(scales, axis=(1, 2)), -16, 2))
    position_importance = maximum_alpha * maximum_radius

    streams: list[Any] = []
    streams.append(compress_stream("position_base_morton_delta", encode_unsigned_varints(deltas), zstd_level))
    #WDD-gpt 2026-08-14 - 允许实验位置编码器复用相同的非 SH 基线，保证消融只改变一项。
    curve_encoder = position_encoder or encode_curve_bank
    encoded_position = curve_encoder(
        streams,
        positions,
        position_importance,
        sample_indices,
        zstd_level,
    )
    if len(encoded_position) == 3:
        reconstructed_motion, curve_meta, base_adjustment = encoded_position
    else:
        reconstructed_motion, curve_meta = encoded_position
        base_adjustment = np.float32(0.0)
    base_decoded = minimum + morton_xyz(morton_sorted).astype(np.float32) * scale_xyz
    base_decoded = base_decoded + base_adjustment
    decoded_position = np.concatenate([
        base_decoded[:, None, :],
        base_decoded[:, None, :] + reconstructed_motion,
    ], axis=1)
    position_error = np.linalg.norm(decoded_position - positions, axis=2)
    position_meta = {
        "keyframes": position_frames,
        "minimum": minimum.tolist(),
        "maximum": maximum.tolist(),
        "base_bits": 10,
        "scene_diagonal": float(np.linalg.norm(maximum - minimum)),
        "maximum_error": float(np.max(position_error)),
        "mean_error": float(np.mean(position_error)),
        "p99_error": float(np.percentile(position_error, 99)),
        "curve_bank": curve_meta,
        "sparse_polyline_residual": curve_meta.get("sparse_polyline_residual"),
    }

    #WDD-gpt 2026-08-14 - 允许质量版本替换旋转与DC码流，同时保持位置和其余属性完全可比。
    if rotation_encoder is None:
        rotation_values = canonical_rotations(rotations).reshape(count, 8)
        decoded_rotation_flat, rotation_meta = add_vq_stream(
            streams, "rotation_quaternion", rotation_values, ROTATION_CLUSTERS, 20260851, sample_indices, zstd_level
        )
        decoded_rotation = canonical_rotations(decoded_rotation_flat.reshape(count, 2, 4))
        rotation_meta["codec"] = "joint quaternion-pair spherical codebook"
    else:
        decoded_rotation, rotation_meta = rotation_encoder(
            streams, rotations, scales, opacities, zstd_level
        )
        decoded_rotation = canonical_rotations(decoded_rotation)
    rotation_dot = np.abs(np.sum(canonical_rotations(rotations) * decoded_rotation, axis=2)).clip(0, 1)
    rotation_error = np.degrees(2 * np.arccos(rotation_dot))
    rotation_meta.update({
        "keyframes": rotation_frames,
        "mean_angular_error_degrees": float(np.mean(rotation_error)),
        "p99_angular_error_degrees": float(np.percentile(rotation_error, 99)),
        "maximum_angular_error_degrees": float(np.max(rotation_error)),
    })

    if color_encoder is None:
        decoded_color_flat, color_meta = add_vq_stream(
            streams, "color_dc_pq", colors.reshape(count, 6), COLOR_CLUSTERS, 20260852, sample_indices, zstd_level
        )
        decoded_color = decoded_color_flat.reshape(count, 2, 3)
        color_meta["codec"] = "DC color vector codebook"
    else:
        decoded_color, color_meta = color_encoder(
            streams, colors, position_importance, zstd_level
        )
    color_meta.update({
        "keyframes": color_frames,
        "maximum_render_rgb_error": float(np.max(np.abs(decoded_color - colors)) * C0),
        "p99_render_rgb_error": float(np.percentile(np.abs(decoded_color - colors) * C0, 99)),
    })

    #WDD-gpt 2026-08-15 - 质量混合档可单独替换尺度、透明度和生命周期，基础Compact40行为保持不变。
    if scale_encoder is None:
        scale_clamped = np.clip(scales, -16, 2).astype(np.float32)
        scale_flat = scale_clamped.reshape(count, 12)
        decoded_scale_flat = np.empty_like(scale_flat)
        scale_groups: list[dict[str, Any]] = []
        scale_group_indices = [
            [0, 3, 6, 9],
            [1, 4, 7, 10],
            [2, 5, 8, 11],
        ]
        for group, indices in enumerate(scale_group_indices):
            decoded_group, group_meta = add_vq_stream(
                streams,
                f"scale_log_pq_{group}",
                scale_flat[:, indices],
                SCALE_CLUSTERS,
                20260860 + group,
                sample_indices,
                zstd_level,
            )
            decoded_scale_flat[:, indices] = decoded_group
            group_meta["indices"] = indices
            scale_groups.append(group_meta)
        decoded_scale = decoded_scale_flat.reshape(count, 4, 3)
        scale_meta = {
            "keyframes": scale_frames,
            "shape": list(scales.shape),
            "codec": "log-domain axis product quantization",
            "groups": scale_groups,
            "clamp": [-16.0, 2.0],
            "p99_relative_linear_error": float(np.percentile(np.abs(np.expm1(decoded_scale - scale_clamped)), 99)),
        }
    else:
        decoded_scale, scale_meta = scale_encoder(streams, scales, position_importance, zstd_level)
        scale_meta.update({"keyframes": scale_frames, "shape": list(scales.shape)})

    if opacity_encoder is None:
        opacity_clamped = np.clip(np.nan_to_num(opacities, neginf=-16), -16, 16).reshape(count, 4)
        decoded_opacity_flat, opacity_meta = add_vq_stream(
            streams, "opacity_track", opacity_clamped, OPACITY_CLUSTERS, 20260870, sample_indices, zstd_level
        )
        decoded_opacity = decoded_opacity_flat.reshape(count, 4, 1)
        source_alpha = 1 / (1 + np.exp(-opacity_clamped))
        decoded_alpha = 1 / (1 + np.exp(-decoded_opacity_flat))
        opacity_meta.update({
            "keyframes": opacity_frames,
            "codec": "separate opacity-logit codebook",
            "p99_alpha_error": float(np.percentile(np.abs(decoded_alpha - source_alpha), 99)),
        })
    else:
        decoded_opacity, opacity_meta = opacity_encoder(streams, opacities, position_importance, zstd_level)
        opacity_meta.update({"keyframes": opacity_frames, "shape": list(opacities.shape)})

    if lifetime_encoder is None:
        lifetime_bounds = np.stack([mu - width, mu + width], axis=1)
        decoded_lifetime, lifetime_meta = add_vq_stream(
            streams, "lifetime_bounds", lifetime_bounds, LIFETIME_CLUSTERS, 20260871, sample_indices, zstd_level
        )
        decoded_mu = (decoded_lifetime[:, 0] + decoded_lifetime[:, 1]) * 0.5
        decoded_width = (decoded_lifetime[:, 1] - decoded_lifetime[:, 0]) * 0.5
        lifetime_meta.update({"codec": "separate lifetime start/end codebook"})
    else:
        decoded_mu, decoded_width, lifetime_meta = lifetime_encoder(streams, mu, width, zstd_level)

    sh_payload = reorder_sh_rvq5(sh_stream_path.read_bytes(), order)
    streams.append(compress_stream("coresh5r", sh_payload, zstd_level, compression="raw"))

    manifest: dict[str, Any] = {
        "format": "4CGS",
        "version": 2,
        "codec_name": profile_name,
        "compression_ratio_basis": "source_raw4d_bytes",
        "gaussian_pruning": False,
        "gaussian_count": count,
        "total_frames": layout.total_frames,
        "source_name": source.name,
        "source_bytes": source.stat().st_size,
        "source_sha256": sha256_file(source),
        "attributes": {
            "position": position_meta,
            "rotation": rotation_meta,
            "color_dc": color_meta,
            "scale": scale_meta,
            "opacity": opacity_meta,
            "lifetime": lifetime_meta,
            "sh": {"codec": "CoReSH-5R", "shape": [count, 45]},
        },
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    #WDD-gpt  2026-08-15 - 允许实验入口把窗口语义和兼容性边界写入实码流清单，避免只存在于外部报告。
    if codec_metadata is not None:
        manifest["codec_metadata"] = codec_metadata
    write_container(output, manifest, streams)
    result = dict(manifest)
    result["measured_encode_seconds"] = time.perf_counter() - started
    result["container_bytes"] = output.stat().st_size
    result["compression_ratio_vs_source_raw4d"] = source.stat().st_size / output.stat().st_size
    return result


def decode(
    source: Path,
    output: Path,
    *,
    profile_name: str = PROFILE_NAME,
    position_decoder: Callable[..., np.ndarray] | None = None,
    rotation_decoder: Callable[..., np.ndarray] | None = None,
    color_decoder: Callable[..., np.ndarray] | None = None,
    scale_decoder: Callable[..., np.ndarray] | None = None,
    opacity_decoder: Callable[..., np.ndarray] | None = None,
    lifetime_decoder: Callable[..., tuple[np.ndarray, np.ndarray]] | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    manifest, streams = read_container(source)
    if manifest.get("codec_name") != profile_name:
        raise ValueError(f"Not a {profile_name} stream")
    count = int(manifest["gaussian_count"])
    attributes = manifest["attributes"]

    deltas = decode_unsigned_varints(streams["position_base_morton_delta"], count)
    morton = np.cumsum(deltas.astype(np.uint64), dtype=np.uint64).astype(np.uint32)
    position_meta = attributes["position"]
    minimum = np.asarray(position_meta["minimum"], dtype=np.float32)
    maximum = np.asarray(position_meta["maximum"], dtype=np.float32)
    base = minimum + morton_xyz(morton).astype(np.float32) * ((maximum - minimum) / np.float32(1023))
    keys = len(position_meta["keyframes"])
    #WDD-gpt 2026-08-14 - 解码器由清单对应的实验入口显式传入，避免错误解释位置位流。
    curve_decoder = position_decoder or decode_curve_bank
    decoded_position = curve_decoder(streams, position_meta["curve_bank"], count, keys, base)
    if isinstance(decoded_position, tuple):
        motion, base_adjustment = decoded_position
        base = base + base_adjustment
    else:
        motion = decoded_position
    position = np.concatenate([base[:, None, :], base[:, None, :] + motion], axis=1)

    if rotation_decoder is None:
        rotation_flat = decode_vq_stream(streams, attributes["rotation"], "rotation_quaternion", count)
        rotation = canonical_rotations(rotation_flat.reshape(count, 2, 4))
    else:
        rotation = canonical_rotations(rotation_decoder(streams, attributes["rotation"], count))
    if color_decoder is None:
        color = decode_vq_stream(streams, attributes["color_dc"], "color_dc_pq", count).reshape(count, 2, 3)
    else:
        color = color_decoder(streams, attributes["color_dc"], count)
    if scale_decoder is None:
        scale_flat = np.empty((count, 12), dtype=np.float32)
        for group, group_meta in enumerate(attributes["scale"]["groups"]):
            scale_flat[:, group_meta["indices"]] = decode_vq_stream(streams, group_meta, f"scale_log_pq_{group}", count)
        scale = scale_flat.reshape(count, 4, 3)
    else:
        scale = scale_decoder(streams, attributes["scale"], count)
    if opacity_decoder is None:
        opacity = decode_vq_stream(streams, attributes["opacity"], "opacity_track", count).reshape(count, 4, 1)
    else:
        opacity = opacity_decoder(streams, attributes["opacity"], count)
    if lifetime_decoder is None:
        lifetime = decode_vq_stream(streams, attributes["lifetime"], "lifetime_bounds", count)
        mu = (lifetime[:, 0] + lifetime[:, 1]) * 0.5
        width = (lifetime[:, 1] - lifetime[:, 0]) * 0.5
    else:
        mu, width = lifetime_decoder(streams, attributes["lifetime"], count)
    sh = decode_sh_rvq5(streams["coresh5r"])
    write_decoded_raw4d(output, manifest, sh, position, rotation, color, scale, opacity, mu, width)
    return {
        "decoded_raw4d": str(output),
        "decoded_raw4d_bytes": output.stat().st_size,
        "measured_decode_seconds": time.perf_counter() - started,
        "gaussian_count": count,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Compact 40x 4CGS encoder/decoder")
    sub = parser.add_subparsers(dest="command", required=True)
    enc = sub.add_parser("encode")
    enc.add_argument("source", type=Path)
    enc.add_argument("output", type=Path)
    enc.add_argument("--reuse-sh", type=Path, required=True)
    enc.add_argument("--zstd-level", type=int, default=8)
    dec = sub.add_parser("decode")
    dec.add_argument("source", type=Path)
    dec.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.command == "encode":
        if args.output.suffix.lower() != ".4cgs":
            raise ValueError("Output must use the .4cgs suffix")
        result = encode(args.source, args.output, args.reuse_sh, args.zstd_level)
    else:
        result = decode(args.source, args.output)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
