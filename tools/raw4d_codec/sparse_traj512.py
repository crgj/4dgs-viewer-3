#!/usr/bin/env python3
"""SparseTraj-512xN position experiment in a standalone 4CGS container."""

from __future__ import annotations

import argparse
import json
import math
import sys
import warnings
from pathlib import Path
from typing import Any

import numpy as np

from codec import compress_stream, read_container, write_container
from compact40 import (
    decode as decode_compact,
    encode as encode_compact,
    pack_bits,
    train_codebook,
    unpack_bits,
)


#WDD-gpt  2026-08-14 - 实现一秒单高斯集的 512 折线四稀疏加权位置编码实验。
PROFILE_PREFIX = "CoRe4D-SparseTraj512x"
DICTIONARY_SIZE = 512
ACTIVE_SPARSE_ATOMS = 4
WEIGHT_CLUSTERS = 1024
POSITION_MAXIMUM_RATIO = 0.00025
OMP_CHUNK_ROWS = 4096
DICTIONARY_UPDATES = 2


def _normalized_dictionary(values: np.ndarray) -> np.ndarray:
    from sklearn.cluster import MiniBatchKMeans

    #WDD-gpt  2026-08-14 - 字典初始化遍历全部 XYZ 轨迹，不用抽样结果代替全数据学习。
    sampled = np.asarray(values, dtype=np.float32)
    norms = np.linalg.norm(sampled, axis=1)
    sampled = sampled[norms > 1e-10]
    if sampled.shape[0] < DICTIONARY_SIZE:
        raise ValueError("SparseTraj requires at least 512 non-linear training tracks")
    sampled /= np.linalg.norm(sampled, axis=1, keepdims=True)
    model = MiniBatchKMeans(
        n_clusters=DICTIONARY_SIZE,
        random_state=20260881,
        batch_size=4096,
        max_iter=50,
        n_init=1,
        reassignment_ratio=0.002,
    )
    model.fit(sampled)
    dictionary = np.asarray(model.cluster_centers_, dtype=np.float32)
    dictionary /= np.maximum(np.linalg.norm(dictionary, axis=1, keepdims=True), 1e-12)
    return dictionary


def _sparse_omp(
    values: np.ndarray,
    dictionary: np.ndarray,
    atoms: int,
) -> tuple[np.ndarray, np.ndarray]:
    from sklearn.decomposition import sparse_encode

    count = values.shape[0]
    supports = np.zeros((count, atoms), dtype=np.uint16)
    weights = np.zeros((count, atoms), dtype=np.float32)
    active = np.flatnonzero(np.linalg.norm(values, axis=1) > 1e-10)
    for first in range(0, active.size, OMP_CHUNK_ROWS):
        rows = active[first:first + OMP_CHUNK_ROWS]
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", category=RuntimeWarning, message=".*prematurely.*")
            codes = sparse_encode(
                np.asarray(values[rows], dtype=np.float32),
                dictionary,
                algorithm="omp",
                n_nonzero_coefs=atoms,
                #WDD-gpt  2026-08-14 - 单进程 OMP 可在本地抑制退化原子警告，并保持确定性输出。
                n_jobs=1,
                check_input=False,
            )
        chosen = np.argpartition(np.abs(codes), -atoms, axis=1)[:, -atoms:]
        chosen_weights = np.take_along_axis(codes, chosen, axis=1)
        order = np.argsort(chosen, axis=1)
        supports[rows] = np.take_along_axis(chosen, order, axis=1).astype(np.uint16)
        weights[rows] = np.take_along_axis(chosen_weights, order, axis=1).astype(np.float32)
        completed = min(first + rows.size, active.size)
        print(f"SparseTraj OMP {completed}/{active.size}", file=sys.stderr, flush=True)
    return supports, weights


def _mod_dictionary_update(
    values: np.ndarray,
    supports: np.ndarray,
    weights: np.ndarray,
) -> np.ndarray:
    from scipy import sparse

    count, atoms = supports.shape
    row_indices = np.repeat(np.arange(count, dtype=np.int32), atoms)
    codes = sparse.csr_matrix(
        (weights.reshape(-1), (row_indices, supports.reshape(-1))),
        shape=(count, DICTIONARY_SIZE),
        dtype=np.float32,
    )
    gram = (codes.T @ codes).toarray().astype(np.float64)
    cross = np.asarray(codes.T @ values, dtype=np.float64)
    ridge = max(float(np.trace(gram)) / DICTIONARY_SIZE, 1.0) * 1e-6
    dictionary = np.linalg.solve(
        gram + np.eye(DICTIONARY_SIZE, dtype=np.float64) * ridge,
        cross,
    ).astype(np.float32)
    norms = np.linalg.norm(dictionary, axis=1, keepdims=True)
    dictionary /= np.maximum(norms, 1e-12)
    return dictionary


def _reconstruct(
    dictionary: np.ndarray,
    supports: np.ndarray,
    weight_codebook: np.ndarray,
    weight_labels: np.ndarray,
) -> np.ndarray:
    count = supports.shape[0]
    result = np.empty((count, dictionary.shape[1]), dtype=np.float32)
    for first in range(0, count, 32768):
        last = min(count, first + 32768)
        atoms = dictionary[supports[first:last]]
        weights = weight_codebook[weight_labels[first:last]]
        result[first:last] = np.einsum("bkd,bk->bd", atoms, weights, optimize=True)
    return result


def encode_sparse_trajectory_bank(
    streams: list[Any],
    positions: np.ndarray,
    importance: np.ndarray,
    sample_indices: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any]]:
    del importance
    del sample_indices
    count, keys, components = positions.shape
    if keys != 11 or components != 3:
        raise ValueError(f"SparseTraj-512xN expects 11 XYZ keys, found {positions.shape}")

    #WDD-gpt  2026-08-14 - 码本原子直接表示相对首节点的完整十段折线，避免另存每点终点或速度。
    residual = (positions[:, 1:] - positions[:, :1]).reshape(count, -1)

    atoms = ACTIVE_SPARSE_ATOMS
    print("SparseTraj training 512 residual polylines on all tracks", file=sys.stderr, flush=True)
    dictionary = _normalized_dictionary(residual)
    for update in range(DICTIONARY_UPDATES):
        print(f"SparseTraj dictionary update {update + 1}/{DICTIONARY_UPDATES}", file=sys.stderr, flush=True)
        supports, weights = _sparse_omp(residual, dictionary, atoms)
        reconstructed_update = np.einsum(
            "nkd,nk->nd", dictionary[supports], weights, optimize=True
        )
        update_rmse = float(np.sqrt(np.mean(np.square(residual - reconstructed_update), dtype=np.float64)))
        print(f"SparseTraj update RMSE {update_rmse:.8f}", file=sys.stderr, flush=True)
        dictionary = _mod_dictionary_update(residual, supports, weights)
    #WDD-gpt  2026-08-14 - 最终稀疏编码使用实际写入的 FP16 字典，保证容器解码结果一致。
    dictionary = dictionary.astype(np.float16).astype(np.float32)
    dictionary /= np.maximum(np.linalg.norm(dictionary, axis=1, keepdims=True), 1e-12)
    dictionary = dictionary.astype(np.float16).astype(np.float32)
    print("SparseTraj final all-track OMP", file=sys.stderr, flush=True)
    supports, weights = _sparse_omp(residual, dictionary, atoms)
    all_indices = np.arange(count, dtype=np.int64)
    weight_codebook, weight_labels = train_codebook(
        weights,
        WEIGHT_CLUSTERS,
        20260882,
        all_indices,
        reserve_zero=True,
    )
    reconstructed = _reconstruct(dictionary, supports, weight_codebook, weight_labels)

    scene_minimum = np.min(positions, axis=(0, 1))
    scene_maximum = np.max(positions, axis=(0, 1))
    scene_diagonal = float(np.linalg.norm(scene_maximum - scene_minimum))
    target = scene_diagonal * POSITION_MAXIMUM_RATIO
    before_error = np.max(
        np.linalg.norm((residual - reconstructed).reshape(count, keys - 1, 3), axis=2),
        axis=1,
    )

    #WDD-gpt  2026-08-14 - 稀疏原子不足的轨迹写入整数残差，确保难数据增加尺寸而不是静默降质。
    correction_mask = before_error > target * 0.5
    correction_step = target / (2 * math.sqrt(3))
    correction = residual[correction_mask] - reconstructed[correction_mask]
    quantized_correction = np.rint(correction / correction_step)
    if quantized_correction.size and np.max(np.abs(quantized_correction)) > np.iinfo(np.int16).max:
        raise ValueError("SparseTraj correction exceeds int16 range")
    quantized_correction = quantized_correction.astype("<i2")
    reconstructed[correction_mask] += quantized_correction.astype(np.float32) * correction_step
    after_error = np.max(
        np.linalg.norm((residual - reconstructed).reshape(count, keys - 1, 3), axis=2),
        axis=1,
    )

    streams.append(compress_stream(
        "position_sparse_traj_dictionary",
        dictionary.astype("<f2").tobytes(),
        zstd_level,
    ))
    streams.append(compress_stream(
        "position_sparse_traj_supports",
        pack_bits(supports, 9),
        zstd_level,
    ))
    streams.append(compress_stream(
        "position_sparse_traj_weight_codebook",
        weight_codebook.astype("<f2").tobytes(),
        zstd_level,
    ))
    streams.append(compress_stream(
        "position_sparse_traj_weight_labels",
        pack_bits(weight_labels, 10),
        zstd_level,
    ))
    streams.append(compress_stream(
        "position_sparse_traj_correction_mask",
        np.packbits(correction_mask.astype(np.uint8), bitorder="little").tobytes(),
        zstd_level,
    ))
    streams.append(compress_stream(
        "position_sparse_traj_corrections",
        quantized_correction.tobytes(),
        zstd_level,
    ))

    motion = reconstructed.reshape(count, keys - 1, 3)
    return motion, {
        "codec": "weighted-sparse-polyline-dictionary",
        "dictionary_size": DICTIONARY_SIZE,
        "dictionary_updates": DICTIONARY_UPDATES,
        "training_scope": "all_tracks",
        "maximum_atoms": atoms,
        "dictionary_shape": [DICTIONARY_SIZE, keys - 1, 3],
        "support_bits_per_atom": 9,
        "weight_clusters": WEIGHT_CLUSTERS,
        "weight_bits": 10,
        "weight_codebook_shape": list(weight_codebook.shape),
        "correction_ratio_to_scene_diagonal": POSITION_MAXIMUM_RATIO,
        "correction_step": correction_step,
        "correction_count": int(np.count_nonzero(correction_mask)),
        "correction_fraction": float(np.mean(correction_mask)),
        "maximum_track_error_before_correction": float(np.max(before_error)),
        "p99_track_error_before_correction": float(np.percentile(before_error, 99)),
        "maximum_track_error_after_correction": float(np.max(after_error)),
        "p99_track_error_after_correction": float(np.percentile(after_error, 99)),
    }


def decode_sparse_trajectory_bank(
    streams: dict[str, bytes],
    metadata: dict[str, Any],
    count: int,
    keys: int,
) -> np.ndarray:
    dictionary = np.frombuffer(
        streams["position_sparse_traj_dictionary"], dtype="<f2"
    ).astype(np.float32).reshape(metadata["dictionary_shape"])
    dictionary = dictionary.reshape(DICTIONARY_SIZE, -1)
    atoms = int(metadata["maximum_atoms"])
    supports = unpack_bits(
        streams["position_sparse_traj_supports"], count * atoms, 9
    ).reshape(count, atoms)
    weight_codebook = np.frombuffer(
        streams["position_sparse_traj_weight_codebook"], dtype="<f2"
    ).astype(np.float32).reshape(metadata["weight_codebook_shape"])
    weight_labels = unpack_bits(
        streams["position_sparse_traj_weight_labels"], count, int(metadata["weight_bits"])
    )
    reconstructed = _reconstruct(dictionary, supports, weight_codebook, weight_labels)

    #WDD-gpt 2026-08-14 - 支持完全依靠字典重建运动的无残差码流，用真实渲染判断可行性。
    correction_count = int(metadata.get("correction_count", 0))
    if correction_count == 0 or "position_sparse_traj_correction_mask" not in streams:
        return reconstructed.reshape(count, keys - 1, 3)

    mask = np.unpackbits(
        np.frombuffer(streams["position_sparse_traj_correction_mask"], dtype=np.uint8),
        bitorder="little",
    )[:count].astype(bool)
    if int(np.count_nonzero(mask)) != correction_count:
        raise ValueError("SparseTraj correction mask count mismatch")
    corrections = np.frombuffer(
        streams["position_sparse_traj_corrections"], dtype="<i2"
    ).reshape(correction_count, (keys - 1) * 3)
    reconstructed[mask] += corrections.astype(np.float32) * float(metadata["correction_step"])

    return reconstructed.reshape(count, keys - 1, 3)


def _base_correction(
    streams: list[Any],
    positions: np.ndarray,
    metadata: dict[str, Any],
    zstd_level: int,
) -> np.ndarray:
    minimum = np.min(positions, axis=(0, 1)).astype(np.float32)
    maximum = np.max(positions, axis=(0, 1)).astype(np.float32)
    base_scale = (maximum - minimum) / np.float32(1023)
    q0 = np.rint((positions[:, 0] - minimum) / base_scale).clip(0, 1023).astype(np.uint16)
    base = minimum + q0.astype(np.float32) * base_scale
    scene_diagonal = float(np.linalg.norm(maximum - minimum))
    target = scene_diagonal * POSITION_MAXIMUM_RATIO
    step = target / (2 * math.sqrt(3))
    quantized = np.rint((positions[:, 0] - base) / step)
    if np.max(np.abs(quantized)) > np.iinfo(np.int8).max:
        raise ValueError("SparseTraj base correction exceeds int8 range")
    quantized = quantized.astype(np.int8)
    streams.append(compress_stream(
        "position_sparse_traj_base_correction", quantized.tobytes(), zstd_level
    ))
    adjustment = quantized.astype(np.float32) * step
    metadata["base_correction"] = {
        "codec": "signed-int8",
        "step": step,
        "shape": list(quantized.shape),
        "maximum_vector_error": float(np.max(np.linalg.norm(positions[:, 0] - (base + adjustment), axis=1))),
    }
    return adjustment


def _encode_position(
    streams: list[Any],
    positions: np.ndarray,
    importance: np.ndarray,
    sample_indices: np.ndarray,
    zstd_level: int,
) -> tuple[np.ndarray, dict[str, Any], np.ndarray]:
    motion, metadata = encode_sparse_trajectory_bank(
        streams, positions, importance, sample_indices, zstd_level
    )
    adjustment = _base_correction(streams, positions, metadata, zstd_level)
    return motion, metadata, adjustment


def _decode_position(
    streams: dict[str, bytes],
    metadata: dict[str, Any],
    count: int,
    keys: int,
    base: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray] | np.ndarray:
    del base
    motion = decode_sparse_trajectory_bank(streams, metadata, count, keys)
    if "base_correction" not in metadata:
        return motion
    base_meta = metadata["base_correction"]
    quantized = np.frombuffer(
        streams["position_sparse_traj_base_correction"], dtype=np.int8
    ).reshape(base_meta["shape"])
    return motion, quantized.astype(np.float32) * float(base_meta["step"])


def encode(
    source: Path,
    output: Path,
    sh_stream: Path,
    zstd_level: int,
    atoms: int,
) -> dict[str, Any]:
    global ACTIVE_SPARSE_ATOMS
    ACTIVE_SPARSE_ATOMS = atoms
    return encode_compact(
        source,
        output,
        sh_stream,
        zstd_level,
        profile_name=f"{PROFILE_PREFIX}{atoms}",
        position_encoder=_encode_position,
    )


def decode(source: Path, output: Path) -> dict[str, Any]:
    manifest, _ = read_container(source)
    atoms = int(manifest["attributes"]["position"]["curve_bank"]["maximum_atoms"])
    profile_name = str(manifest["codec_name"])
    if not profile_name.startswith(f"{PROFILE_PREFIX}{atoms}"):
        raise ValueError(f"Unsupported SparseTraj profile: {profile_name}")
    return decode_compact(
        source,
        output,
        profile_name=profile_name,
        position_decoder=_decode_position,
    )


def strip_motion_residuals(source: Path, output: Path, zstd_level: int) -> dict[str, Any]:
    manifest, streams = read_container(source)
    omitted = {
        "position_sparse_traj_correction_mask",
        "position_sparse_traj_corrections",
    }
    retained = []
    for entry in manifest["streams"]:
        name = entry["name"]
        if name in omitted:
            continue
        retained.append(compress_stream(
            name,
            streams[name],
            zstd_level,
            compression=entry["compression"],
        ))
    #WDD-gpt 2026-08-14 - 纯字典实验从容器物理删除整数节点残差，尺寸与解码结果都可复核。
    curve = manifest["attributes"]["position"]["curve_bank"]
    curve["motion_residual"] = "none"
    curve["correction_count"] = 0
    curve["correction_fraction"] = 0.0
    curve["maximum_track_error_after_correction"] = curve["maximum_track_error_before_correction"]
    curve["p99_track_error_after_correction"] = curve["p99_track_error_before_correction"]
    manifest["codec_name"] = f"{manifest['codec_name']}-DictionaryOnly"
    write_container(output, manifest, retained)
    return {
        "dictionary_only_4cgs": str(output),
        "container_bytes": output.stat().st_size,
        "compression_ratio_vs_source_raw4d": int(manifest["source_bytes"]) / output.stat().st_size,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="SparseTraj-512xN 4CGS encoder/decoder")
    sub = parser.add_subparsers(dest="command", required=True)
    enc = sub.add_parser("encode")
    enc.add_argument("source", type=Path)
    enc.add_argument("output", type=Path)
    enc.add_argument("--reuse-sh", type=Path, required=True)
    enc.add_argument("--zstd-level", type=int, default=8)
    enc.add_argument("--atoms", type=int, choices=(4, 6, 8), default=4)
    dec = sub.add_parser("decode")
    dec.add_argument("source", type=Path)
    dec.add_argument("output", type=Path)
    strip = sub.add_parser("strip-residuals")
    strip.add_argument("source", type=Path)
    strip.add_argument("output", type=Path)
    strip.add_argument("--zstd-level", type=int, default=8)
    args = parser.parse_args()
    if args.command == "encode":
        if args.output.suffix.lower() != ".4cgs":
            raise ValueError("Output must use the .4cgs suffix")
        result = encode(args.source, args.output, args.reuse_sh, args.zstd_level, args.atoms)
    elif args.command == "decode":
        result = decode(args.source, args.output)
    else:
        if args.output.suffix.lower() != ".4cgs":
            raise ValueError("Output must use the .4cgs suffix")
        result = strip_motion_residuals(args.source, args.output, args.zstd_level)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
