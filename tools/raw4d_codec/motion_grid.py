#!/usr/bin/env python3
"""Low-dimensional motion-grid plus residual codec for 4CGS XYZ tracks."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np

from codec import compress_stream, read_container
from compact40 import (
    assign_codebook,
    decode as decode_compact,
    encode as encode_compact,
    morton_xyz,
)
from quality_attrs import decode_color, decode_rotation, encode_color, encode_rotation


#WDD-gpt 2026-08-14 - XYZ改为低秩空间运动网格预测，并仅对预测剩余量编码残差。
PROFILE_NAME = "CoRe4D-LDMG-R8G16-RVQ6-RotSTA678-BlockDCYCoCg"
MOTION_RANK = 8
GRID_RESOLUTION = 16
GRID_FIT_ITERATIONS = 8
RVQ_LEVELS = 6
RVQ_CLUSTERS = 256
#WDD-gpt 2026-08-15 - 0.03%门限最差帧为38.960 dB，继续收紧到0.028%并给39 dB门限留出余量。
POSITION_MAXIMUM_RATIO = 0.00028


def _grid_stencil(
    base: np.ndarray,
    minimum: np.ndarray,
    maximum: np.ndarray,
    resolution: int,
) -> tuple[np.ndarray, np.ndarray]:
    extent = np.maximum(maximum - minimum, np.float32(1e-12))
    coordinate = (base - minimum) / extent * np.float32(resolution - 1)
    lower = np.floor(coordinate).astype(np.int32).clip(0, resolution - 2)
    fraction = (coordinate - lower).clip(0, 1).astype(np.float32)
    node_ids = np.empty((base.shape[0], 8), dtype=np.int32)
    weights = np.empty((base.shape[0], 8), dtype=np.float32)
    corner = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                xyz = lower + np.asarray([dx, dy, dz], dtype=np.int32)
                node_ids[:, corner] = (xyz[:, 0] * resolution + xyz[:, 1]) * resolution + xyz[:, 2]
                wx = fraction[:, 0] if dx else 1 - fraction[:, 0]
                wy = fraction[:, 1] if dy else 1 - fraction[:, 1]
                wz = fraction[:, 2] if dz else 1 - fraction[:, 2]
                weights[:, corner] = wx * wy * wz
                corner += 1
    return node_ids, weights


def _interpolate_grid(grid: np.ndarray, node_ids: np.ndarray, weights: np.ndarray) -> np.ndarray:
    return np.einsum("nkr,nk->nr", grid[node_ids], weights, optimize=True)


def _fit_grid(
    coefficients: np.ndarray,
    node_ids: np.ndarray,
    weights: np.ndarray,
    node_count: int,
) -> np.ndarray:
    flat_ids = node_ids.reshape(-1)
    flat_weights = weights.reshape(-1).astype(np.float64)
    repeated = np.repeat(coefficients.astype(np.float64), 8, axis=0)
    denominator = np.bincount(flat_ids, weights=flat_weights, minlength=node_count)
    grid = np.zeros((node_count, coefficients.shape[1]), dtype=np.float64)
    for dimension in range(coefficients.shape[1]):
        numerator = np.bincount(
            flat_ids,
            weights=flat_weights * repeated[:, dimension],
            minlength=node_count,
        )
        grid[:, dimension] = numerator / np.maximum(denominator, 1e-12)
    diagonal = np.bincount(flat_ids, weights=np.square(flat_weights), minlength=node_count)
    best_grid = grid.copy()
    best_rmse = math.inf
    for iteration in range(GRID_FIT_ITERATIONS):
        prediction = _interpolate_grid(grid, node_ids, weights)
        error = coefficients - prediction
        rmse = float(np.sqrt(np.mean(np.square(error), dtype=np.float64)))
        if rmse >= best_rmse:
            grid = best_grid
            print(f"LDMG grid stopped at best RMSE {best_rmse:.8f}", file=sys.stderr)
            break
        best_rmse = rmse
        best_grid = grid.copy()
        repeated_error = np.repeat(error.astype(np.float64), 8, axis=0)
        for dimension in range(coefficients.shape[1]):
            gradient = np.bincount(
                flat_ids,
                weights=flat_weights * repeated_error[:, dimension],
                minlength=node_count,
            )
            grid[:, dimension] += 0.20 * gradient / np.maximum(diagonal, 1e-8)
        print(f"LDMG grid iteration {iteration + 1}/{GRID_FIT_ITERATIONS} RMSE {rmse:.8f}", file=sys.stderr)
    return grid.astype(np.float32)


def _train_residual_rvq(
    residual: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    from sklearn.cluster import MiniBatchKMeans

    count, dimensions = residual.shape
    codebooks = np.empty((RVQ_LEVELS, RVQ_CLUSTERS, dimensions), dtype=np.float32)
    labels = np.empty((count, RVQ_LEVELS), dtype=np.uint8)
    reconstructed = np.zeros_like(residual, dtype=np.float32)
    remaining = residual.copy()
    for level in range(RVQ_LEVELS):
        model = MiniBatchKMeans(
            n_clusters=RVQ_CLUSTERS,
            random_state=20261010 + level,
            batch_size=8192,
            max_iter=40,
            n_init=1,
            reassignment_ratio=0.002,
        )
        #WDD-gpt 2026-08-14 - 每级RVQ遍历全部高斯残差，避免抽样训练在新数据上失稳。
        model.fit(remaining)
        codebook = model.cluster_centers_.astype(np.float16).astype(np.float32)
        assigned = assign_codebook(remaining, codebook)
        decoded = codebook[assigned]
        codebooks[level] = codebook
        labels[:, level] = assigned.astype(np.uint8)
        reconstructed += decoded
        remaining -= decoded
        node_error = np.linalg.norm(remaining.reshape(count, 10, 3), axis=2)
        print(
            f"LDMG RVQ {level + 1}/{RVQ_LEVELS} "
            f"mean={float(np.mean(node_error)):.8f} p99={float(np.percentile(node_error, 99)):.8f} "
            f"max={float(np.max(node_error)):.8f}",
            file=sys.stderr,
            flush=True,
        )
    return codebooks, labels, reconstructed


def encode_motion_grid(
    streams: list[Any],
    positions: np.ndarray,
    base: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    count, keys, components = positions.shape
    if keys != 11 or components != 3:
        raise ValueError(f"LDMG expects 11 XYZ keys, found {positions.shape}")
    motion = (positions[:, 1:] - positions[:, :1]).reshape(count, -1).astype(np.float32)
    motion_mean = np.mean(motion, axis=0).astype(np.float32)
    centered = motion - motion_mean
    covariance = centered.T @ centered / np.float32(count)
    eigenvalues, eigenvectors = np.linalg.eigh(covariance.astype(np.float64))
    basis = eigenvectors[:, np.argsort(eigenvalues)[-MOTION_RANK:][::-1]].T.astype(np.float32)
    basis = basis.astype(np.float16).astype(np.float32)
    coefficients = centered @ basis.T

    grid_minimum = np.min(base, axis=0).astype(np.float32)
    grid_maximum = np.max(base, axis=0).astype(np.float32)
    node_ids, weights = _grid_stencil(base, grid_minimum, grid_maximum, GRID_RESOLUTION)
    node_count = GRID_RESOLUTION ** 3
    grid = _fit_grid(coefficients, node_ids, weights, node_count)
    grid = grid.astype(np.float16).astype(np.float32)
    grid_coefficients = _interpolate_grid(grid, node_ids, weights)
    grid_motion = motion_mean + grid_coefficients @ basis
    residual = motion - grid_motion

    codebooks, labels, rvq_motion = _train_residual_rvq(residual)
    codebooks = codebooks.astype(np.float16).astype(np.float32)
    rvq_motion = np.zeros_like(residual)
    for level in range(RVQ_LEVELS):
        rvq_motion += codebooks[level, labels[:, level]]
    reconstructed = grid_motion + rvq_motion

    scene_diagonal = float(np.linalg.norm(np.max(positions, axis=(0, 1)) - np.min(positions, axis=(0, 1))))
    target = scene_diagonal * POSITION_MAXIMUM_RATIO
    residual_after = (motion - reconstructed).reshape(count, keys - 1, 3)
    node_error_before = np.linalg.norm(residual_after, axis=2)
    correction_mask = node_error_before > target * 0.5
    correction_step = target / (2 * math.sqrt(3))
    correction = residual_after[correction_mask]
    quantized_correction = np.rint(correction / correction_step)
    if quantized_correction.size and np.max(np.abs(quantized_correction)) > np.iinfo(np.int16).max:
        raise ValueError("LDMG node correction exceeds int16 range")
    quantized_correction = quantized_correction.astype("<i2")
    reconstructed_nodes = reconstructed.reshape(count, keys - 1, 3)
    reconstructed_nodes[correction_mask] += quantized_correction.astype(np.float32) * correction_step
    residual_after = motion.reshape(count, keys - 1, 3) - reconstructed_nodes
    reconstructed = reconstructed_nodes.reshape(count, -1)
    node_error_after = np.linalg.norm(residual_after, axis=2)

    streams.append(compress_stream("position_ldmg_mean", motion_mean.astype("<f4").tobytes(), zstd_level))
    streams.append(compress_stream("position_ldmg_basis", basis.astype("<f2").tobytes(), zstd_level))
    streams.append(compress_stream("position_ldmg_grid", grid.astype("<f2").tobytes(), zstd_level))
    streams.append(compress_stream("position_ldmg_rvq_codebooks", codebooks.astype("<f2").tobytes(), zstd_level))
    streams.append(compress_stream("position_ldmg_rvq_labels", labels.tobytes(), zstd_level))
    streams.append(compress_stream(
        "position_ldmg_correction_mask",
        np.packbits(correction_mask.reshape(-1).astype(np.uint8), bitorder="little").tobytes(),
        zstd_level,
    ))
    streams.append(compress_stream("position_ldmg_corrections", quantized_correction.tobytes(), zstd_level))
    explained = float(np.sum(eigenvalues[np.argsort(eigenvalues)[-MOTION_RANK:]]) / np.maximum(np.sum(eigenvalues), 1e-20))
    return reconstructed.reshape(count, keys - 1, 3), {
        "codec": "low-dimensional-motion-grid-plus-node-residual",
        "motion_rank": MOTION_RANK,
        "grid_resolution": GRID_RESOLUTION,
        "grid_shape": [node_count, MOTION_RANK],
        "grid_minimum": grid_minimum.tolist(),
        "grid_maximum": grid_maximum.tolist(),
        "basis_shape": list(basis.shape),
        "mean_shape": list(motion_mean.shape),
        "pca_explained_variance": explained,
        "rvq_levels": RVQ_LEVELS,
        "rvq_clusters": RVQ_CLUSTERS,
        "rvq_codebook_shape": list(codebooks.shape),
        "correction_scope": "integer-nodes-only",
        "correction_step": correction_step,
        "correction_node_count": int(np.count_nonzero(correction_mask)),
        "correction_node_fraction": float(np.mean(correction_mask)),
        "maximum_node_error_before_correction": float(np.max(node_error_before)),
        "p99_node_error_before_correction": float(np.percentile(node_error_before, 99)),
        "maximum_node_error_after_correction": float(np.max(node_error_after)),
        "p99_node_error_after_correction": float(np.percentile(node_error_after, 99)),
        "target_ratio_to_scene_diagonal": POSITION_MAXIMUM_RATIO,
    }


def decode_motion_grid(
    streams: dict[str, bytes],
    metadata: dict[str, Any],
    count: int,
    keys: int,
    base: np.ndarray,
) -> np.ndarray:
    motion_mean = np.frombuffer(streams["position_ldmg_mean"], dtype="<f4").reshape(metadata["mean_shape"])
    basis = np.frombuffer(streams["position_ldmg_basis"], dtype="<f2").astype(np.float32).reshape(metadata["basis_shape"])
    grid = np.frombuffer(streams["position_ldmg_grid"], dtype="<f2").astype(np.float32).reshape(metadata["grid_shape"])
    node_ids, weights = _grid_stencil(
        base,
        np.asarray(metadata["grid_minimum"], dtype=np.float32),
        np.asarray(metadata["grid_maximum"], dtype=np.float32),
        int(metadata["grid_resolution"]),
    )
    reconstructed = motion_mean + _interpolate_grid(grid, node_ids, weights) @ basis
    codebooks = np.frombuffer(streams["position_ldmg_rvq_codebooks"], dtype="<f2").astype(np.float32)
    codebooks = codebooks.reshape(metadata["rvq_codebook_shape"])
    labels = np.frombuffer(streams["position_ldmg_rvq_labels"], dtype=np.uint8)
    labels = labels.reshape(count, int(metadata["rvq_levels"]))
    for level in range(int(metadata["rvq_levels"])):
        reconstructed += codebooks[level, labels[:, level]]

    mask = np.unpackbits(
        np.frombuffer(streams["position_ldmg_correction_mask"], dtype=np.uint8),
        bitorder="little",
    )[:count * (keys - 1)].reshape(count, keys - 1).astype(bool)
    correction_count = int(metadata["correction_node_count"])
    if int(np.count_nonzero(mask)) != correction_count:
        raise ValueError("LDMG correction mask count mismatch")
    corrections = np.frombuffer(streams["position_ldmg_corrections"], dtype="<i2").reshape(correction_count, 3)
    motion = reconstructed.reshape(count, keys - 1, 3)
    motion[mask] += corrections.astype(np.float32) * float(metadata["correction_step"])
    return motion


def _encode_position(
    streams: list[Any],
    positions: np.ndarray,
    importance: np.ndarray,
    sample_indices: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any], np.ndarray]:
    del importance
    del sample_indices
    minimum = np.min(positions, axis=(0, 1)).astype(np.float32)
    maximum = np.max(positions, axis=(0, 1)).astype(np.float32)
    scale = (maximum - minimum) / np.float32(1023)
    quantized_base = np.rint((positions[:, 0] - minimum) / scale).clip(0, 1023).astype(np.uint16)
    base = minimum + quantized_base.astype(np.float32) * scale
    scene_diagonal = float(np.linalg.norm(maximum - minimum))
    target = scene_diagonal * POSITION_MAXIMUM_RATIO
    step = target / (2 * math.sqrt(3))
    quantized_adjustment = np.rint((positions[:, 0] - base) / step)
    if np.max(np.abs(quantized_adjustment)) > np.iinfo(np.int8).max:
        raise ValueError("LDMG base correction exceeds int8 range")
    quantized_adjustment = quantized_adjustment.astype(np.int8)
    adjustment = quantized_adjustment.astype(np.float32) * step
    streams.append(compress_stream("position_ldmg_base_correction", quantized_adjustment.tobytes(), zstd_level))
    motion, metadata = encode_motion_grid(streams, positions, base + adjustment, zstd_level)
    metadata["base_correction"] = {
        "codec": "signed-int8",
        "step": step,
        "shape": list(quantized_adjustment.shape),
        "maximum_vector_error": float(np.max(np.linalg.norm(positions[:, 0] - (base + adjustment), axis=1))),
    }
    return motion, metadata, adjustment


def _decode_position(
    streams: dict[str, bytes],
    metadata: dict[str, Any],
    count: int,
    keys: int,
    base: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    base_meta = metadata["base_correction"]
    quantized = np.frombuffer(streams["position_ldmg_base_correction"], dtype=np.int8).reshape(base_meta["shape"])
    adjustment = quantized.astype(np.float32) * float(base_meta["step"])
    motion = decode_motion_grid(streams, metadata, count, keys, base + adjustment)
    return motion, adjustment


def encode(source: Path, output: Path, sh_stream: Path, zstd_level: int) -> dict[str, Any]:
    return encode_compact(
        source,
        output,
        sh_stream,
        zstd_level,
        profile_name=PROFILE_NAME,
        position_encoder=_encode_position,
        rotation_encoder=encode_rotation,
        color_encoder=encode_color,
    )


def decode(source: Path, output: Path) -> dict[str, Any]:
    manifest, _ = read_container(source)
    if manifest.get("codec_name") != PROFILE_NAME:
        raise ValueError(f"Not a {PROFILE_NAME} stream")
    return decode_compact(
        source,
        output,
        profile_name=PROFILE_NAME,
        position_decoder=_decode_position,
        rotation_decoder=decode_rotation,
        color_decoder=decode_color,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Low-dimensional motion-grid 4CGS codec")
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
