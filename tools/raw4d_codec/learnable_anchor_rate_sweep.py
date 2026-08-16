#!/usr/bin/env python3
"""Rate-distortion sweep for a topology-free learnable RAW4D anchor field."""

from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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
    assign_codebook,
    decode_unsigned_varints,
    encode_unsigned_varints,
    morton_codes,
    morton_xyz,
    pack_bits,
    train_codebook,
    unpack_bits,
)
from learnable_anchor_field import (
    build_anchor_topology,
    reconstruct_motion,
    solve_static_weights,
    train_joint_translation_field,
    vector_metrics,
)


#WDD-gpt 2026-08-15 - 用首帧重建拓扑、权重VQ和低秩变形场实测4.0到2.0 MB的五档XYZ码率。
FORMAT_NAME = "LAF-EXTREME"
FORMAT_VERSION = 1
DEFAULT_BASE_CORRECTION_RATIO = 0.00028
DEFAULT_TARGETS = (
    ("conservative_4.0mb", 4_000_000, "conservative"),
    ("recommended_3.5mb", 3_500_000, "recommended"),
    ("recommended_3.0mb", 3_000_000, "recommended"),
    ("recommended_2.5mb", 2_500_000, "recommended"),
    ("aggressive_under_2.0mb", 1_999_999, "aggressive"),
)


@dataclass(frozen=True)
class BaseCodec:
    order: np.ndarray
    decoded: np.ndarray
    metadata: dict[str, Any]
    streams: dict[str, bytes]


@dataclass(frozen=True)
class WeightStage:
    codebook: np.ndarray
    labels: np.ndarray
    bits: int


@dataclass(frozen=True)
class WeightCodec:
    stages: tuple[WeightStage, ...]
    decoded: np.ndarray
    metadata: dict[str, Any]


@dataclass(frozen=True)
class FieldCodec:
    decoded: np.ndarray
    coefficient_codes: np.ndarray
    mean: np.ndarray
    basis: np.ndarray
    coefficient_minimum: np.ndarray
    coefficient_maximum: np.ndarray
    bits: int
    metadata: dict[str, Any]


def compress(raw: bytes, level: int) -> bytes:
    return zstd.ZstdCompressor(level=level, threads=0).compress(raw)


def decompress(payload: np.ndarray, raw_bytes: int) -> bytes:
    return zstd.ZstdDecompressor().decompress(payload.tobytes(), max_output_size=raw_bytes)


def encode_base(
    positions: np.ndarray,
    correction_ratio: float,
) -> BaseCodec:
    positions = np.asarray(positions, dtype=np.float32)
    count = positions.shape[0]
    minimum = np.min(positions, axis=(0, 1)).astype(np.float32)
    maximum = np.max(positions, axis=(0, 1)).astype(np.float32)
    extent = np.maximum(maximum - minimum, np.float32(1e-12))
    scale = extent / np.float32(1023)
    q0 = np.rint((positions[:, 0] - minimum) / scale).clip(0, 1023).astype(np.uint16)
    morton = morton_codes(q0)
    order = np.argsort(morton, kind="stable")
    sorted_morton = morton[order]
    deltas = np.empty(count, dtype=np.uint32)
    deltas[0] = sorted_morton[0]
    deltas[1:] = sorted_morton[1:] - sorted_morton[:-1]

    coarse = minimum + morton_xyz(sorted_morton).astype(np.float32) * scale
    scene_diagonal = float(np.linalg.norm(extent))
    correction_target = scene_diagonal * correction_ratio
    correction_step = correction_target / (2 * math.sqrt(3))
    correction = np.rint((positions[order, 0] - coarse) / correction_step)
    if np.max(np.abs(correction)) > np.iinfo(np.int8).max:
        raise ValueError("First-frame correction exceeds int8 range")
    correction = correction.astype(np.int8)
    decoded = coarse + correction.astype(np.float32) * np.float32(correction_step)
    streams = {
        "base_morton_delta": encode_unsigned_varints(deltas),
        "base_correction": correction.tobytes(),
    }
    metadata = {
        "count": count,
        "minimum": minimum.tolist(),
        "maximum": maximum.tolist(),
        "base_bits": 10,
        "correction_ratio": correction_ratio,
        "correction_step": correction_step,
        "scene_diagonal": scene_diagonal,
        "maximum_vector_error": float(np.max(np.linalg.norm(decoded - positions[order, 0], axis=1))),
        "p99_vector_error": float(np.percentile(np.linalg.norm(decoded - positions[order, 0], axis=1), 99)),
    }
    return BaseCodec(order=order, decoded=decoded, metadata=metadata, streams=streams)


def decode_base(metadata: dict[str, Any], streams: dict[str, bytes]) -> np.ndarray:
    count = int(metadata["count"])
    deltas = decode_unsigned_varints(streams["base_morton_delta"], count)
    morton = np.cumsum(deltas.astype(np.uint64), dtype=np.uint64).astype(np.uint32)
    minimum = np.asarray(metadata["minimum"], dtype=np.float32)
    maximum = np.asarray(metadata["maximum"], dtype=np.float32)
    scale = np.maximum(maximum - minimum, np.float32(1e-12)) / np.float32(1023)
    coarse = minimum + morton_xyz(morton).astype(np.float32) * scale
    correction = np.frombuffer(streams["base_correction"], dtype=np.int8).reshape(count, 3)
    return coarse + correction.astype(np.float32) * np.float32(metadata["correction_step"])


def train_weight_codec(
    weights: np.ndarray,
    clusters: int,
    stages: int,
    sample_indices: np.ndarray,
    seed: int,
    clip_percentile: float,
) -> WeightCodec:
    cap = max(float(np.percentile(np.abs(weights), clip_percentile)), 1e-8)
    target = np.clip(np.asarray(weights, dtype=np.float32), -cap, cap)
    residual = target.copy()
    decoded = np.zeros_like(target)
    encoded_stages: list[WeightStage] = []
    for stage_index in range(stages):
        codebook, _ = train_codebook(
            residual,
            clusters,
            seed + stage_index,
            sample_indices,
        )
        #WDD-gpt 2026-08-15 - 以真正写入的FP16码本重新分配标签，保证编码端与独立解码端完全一致。
        codebook = codebook.astype(np.float16).astype(np.float32)
        labels = assign_codebook(residual, codebook)
        stage_decoded = codebook[labels]
        decoded += stage_decoded
        residual -= stage_decoded
        encoded_stages.append(
            WeightStage(codebook=codebook, labels=labels, bits=int(math.ceil(math.log2(clusters))))
        )
    return WeightCodec(
        stages=tuple(encoded_stages),
        decoded=decoded,
        metadata={
            "clusters": clusters,
            "stage_count": stages,
            "dimensions": weights.shape[1],
            "clip_percentile": clip_percentile,
            "clip_cap": cap,
            "rmse_vs_unclipped": float(np.sqrt(np.mean(np.square(decoded - weights), dtype=np.float64))),
            "maximum_absolute_error_vs_unclipped": float(np.max(np.abs(decoded - weights))),
        },
    )


def encode_field(field: np.ndarray, rank: int, bits: int) -> FieldCodec:
    matrix = np.asarray(field, dtype=np.float32).reshape(field.shape[0], -1)
    mean = np.mean(matrix, axis=0).astype(np.float32)
    centered = matrix - mean
    _, _, right = np.linalg.svd(centered, full_matrices=False)
    basis = right[:rank].astype(np.float16).astype(np.float32)
    coefficients = centered @ basis.T
    minimum = np.min(coefficients, axis=0).astype(np.float32)
    maximum = np.max(coefficients, axis=0).astype(np.float32)
    levels = np.float32((1 << bits) - 1)
    scale = np.where(maximum > minimum, (maximum - minimum) / levels, np.float32(1.0))
    codes = np.rint((coefficients - minimum) / scale).clip(0, int(levels)).astype(np.uint16)

    stored_mean = mean.astype(np.float16).astype(np.float32)
    stored_minimum = minimum.astype(np.float16).astype(np.float32)
    stored_maximum = maximum.astype(np.float16).astype(np.float32)
    stored_scale = np.where(
        stored_maximum > stored_minimum,
        (stored_maximum - stored_minimum) / levels,
        np.float32(0.0),
    )
    decoded_coefficients = stored_minimum + codes.astype(np.float32) * stored_scale
    decoded_matrix = stored_mean + decoded_coefficients @ basis
    decoded = decoded_matrix.reshape(field.shape).astype(np.float32)
    return FieldCodec(
        decoded=decoded,
        coefficient_codes=codes,
        mean=stored_mean,
        basis=basis,
        coefficient_minimum=stored_minimum,
        coefficient_maximum=stored_maximum,
        bits=bits,
        metadata={
            "shape": list(field.shape),
            "rank": rank,
            "bits": bits,
            "rmse": float(np.sqrt(np.mean(np.square(decoded - field), dtype=np.float64))),
            "maximum_absolute_error": float(np.max(np.abs(decoded - field))),
        },
    )


def raw_model_streams(weight_codec: WeightCodec, field_codec: FieldCodec) -> dict[str, bytes]:
    streams: dict[str, bytes] = {}
    for index, stage in enumerate(weight_codec.stages):
        streams[f"weight_codebook_{index}"] = stage.codebook.astype("<f2").tobytes()
        streams[f"weight_labels_{index}"] = pack_bits(stage.labels, stage.bits)
    streams.update({
        "field_mean": field_codec.mean.astype("<f2").tobytes(),
        "field_basis": field_codec.basis.astype("<f2").tobytes(),
        "field_coefficients": pack_bits(field_codec.coefficient_codes, field_codec.bits),
    })
    return streams


def decode_weight_codec(
    manifest: dict[str, Any],
    streams: dict[str, bytes],
    count: int,
) -> np.ndarray:
    metadata = manifest["weight_codec"]
    dimensions = int(metadata["dimensions"])
    clusters = int(metadata["clusters"])
    bits = int(math.ceil(math.log2(clusters)))
    decoded = np.zeros((count, dimensions), dtype=np.float32)
    for index in range(int(metadata["stage_count"])):
        codebook = np.frombuffer(streams[f"weight_codebook_{index}"], dtype="<f2").astype(np.float32)
        codebook = codebook.reshape(clusters, dimensions)
        labels = unpack_bits(streams[f"weight_labels_{index}"], count, bits)
        if np.any(labels >= clusters):
            raise ValueError("Weight label exceeds codebook size")
        decoded += codebook[labels]
    return decoded


def decode_field_codec(manifest: dict[str, Any], streams: dict[str, bytes]) -> np.ndarray:
    metadata = manifest["field_codec"]
    shape = tuple(int(value) for value in metadata["shape"])
    rank = int(metadata["rank"])
    bits = int(metadata["bits"])
    flattened = int(np.prod(shape[1:]))
    mean = np.frombuffer(streams["field_mean"], dtype="<f2").astype(np.float32).reshape(flattened)
    basis = np.frombuffer(streams["field_basis"], dtype="<f2").astype(np.float32).reshape(rank, flattened)
    minimum = np.asarray(metadata["coefficient_minimum"], dtype=np.float32)
    maximum = np.asarray(metadata["coefficient_maximum"], dtype=np.float32)
    codes = unpack_bits(streams["field_coefficients"], shape[0] * rank, bits).reshape(shape[0], rank)
    levels = np.float32((1 << bits) - 1)
    scale = np.where(maximum > minimum, (maximum - minimum) / levels, np.float32(0.0))
    coefficients = minimum + codes.astype(np.float32) * scale
    return (mean + coefficients @ basis).reshape(shape).astype(np.float32)


def make_manifest(
    frames: list[int],
    count: int,
    anchor_fraction: float,
    neighbors: int,
    base: BaseCodec,
    weight_codec: WeightCodec,
    field_codec: FieldCodec,
    correction_ratio: float,
    correction_step: float,
    correction_mask: np.ndarray,
    profile_name: str,
    target_bytes: int,
) -> dict[str, Any]:
    field_metadata = dict(field_codec.metadata)
    field_metadata["coefficient_minimum"] = field_codec.coefficient_minimum.tolist()
    field_metadata["coefficient_maximum"] = field_codec.coefficient_maximum.tolist()
    return {
        "format": FORMAT_NAME,
        "version": FORMAT_VERSION,
        "profile_name": profile_name,
        "target_bytes": target_bytes,
        "count": count,
        "frames": frames,
        "motion_reference": "frame0_to_each_keyframe",
        "anchor_fraction": anchor_fraction,
        "neighbors_per_point": neighbors,
        "base_codec": base.metadata,
        "weight_codec": weight_codec.metadata,
        "field_codec": field_metadata,
        "correction_ratio": correction_ratio,
        "correction_step": correction_step,
        "correction_count": int(np.count_nonzero(correction_mask)),
        "correction_fraction": float(np.mean(correction_mask)),
    }


def serialize_candidate(
    output: Path,
    manifest: dict[str, Any],
    raw_streams: dict[str, bytes],
    zstd_level: int,
) -> dict[str, Any]:
    stored = {name: compress(payload, zstd_level) for name, payload in raw_streams.items()}
    manifest = dict(manifest)
    manifest["streams"] = {
        name: {"raw_bytes": len(raw_streams[name]), "stored_bytes": len(payload)}
        for name, payload in stored.items()
    }
    manifest_bytes = json.dumps(manifest, separators=(",", ":")).encode("utf-8")
    archive: dict[str, np.ndarray] = {"manifest": np.frombuffer(manifest_bytes, dtype=np.uint8)}
    archive.update({name: np.frombuffer(payload, dtype=np.uint8) for name, payload in stored.items()})
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez(output, **archive)
    manifest["archive_bytes"] = output.stat().st_size
    manifest["logical_stored_bytes"] = int(sum(len(payload) for payload in stored.values()))
    return manifest


def encode_candidate(
    output: Path,
    frames: list[int],
    target_motion: np.ndarray,
    base: BaseCodec,
    prediction: np.ndarray,
    weight_codec: WeightCodec,
    field_codec: FieldCodec,
    anchor_fraction: float,
    neighbors: int,
    correction_ratio: float,
    profile_name: str,
    target_bytes: int,
    zstd_level: int,
) -> tuple[dict[str, Any], np.ndarray]:
    error = target_motion - prediction
    correction_target = float(base.metadata["scene_diagonal"]) * correction_ratio
    correction_step = correction_target / (2 * math.sqrt(3))
    mask = np.linalg.norm(error, axis=2) > correction_target * 0.5
    correction = np.rint(error[mask] / correction_step)
    if correction.size and np.max(np.abs(correction)) > np.iinfo(np.int16).max:
        raise ValueError("Candidate correction exceeds int16 range")
    correction = correction.astype("<i2")
    reconstructed = prediction.copy()
    reconstructed[mask] += correction.astype(np.float32) * np.float32(correction_step)

    raw_streams = dict(base.streams)
    raw_streams.update(raw_model_streams(weight_codec, field_codec))
    raw_streams["correction_mask"] = np.packbits(mask.reshape(-1), bitorder="little").tobytes()
    raw_streams["corrections"] = correction.tobytes()
    manifest = make_manifest(
        frames,
        target_motion.shape[0],
        anchor_fraction,
        neighbors,
        base,
        weight_codec,
        field_codec,
        correction_ratio,
        correction_step,
        mask,
        profile_name,
        target_bytes,
    )
    manifest["metrics_before_correction"] = vector_metrics(prediction, target_motion)
    manifest["metrics_after_correction"] = vector_metrics(reconstructed, target_motion)
    manifest = serialize_candidate(output, manifest, raw_streams, zstd_level)
    return manifest, reconstructed


def decode_candidate(path: Path) -> tuple[dict[str, Any], np.ndarray]:
    with np.load(path, allow_pickle=False) as archive:
        manifest = json.loads(archive["manifest"].tobytes().decode("utf-8"))
        streams = {
            name: decompress(archive[name], int(metadata["raw_bytes"]))
            for name, metadata in manifest["streams"].items()
        }
    count = int(manifest["count"])
    if manifest.get("motion_reference", "frame0_to_each_keyframe") != "frame0_to_each_keyframe":
        raise ValueError("LAF-EXTREME requires every keyframe displacement to reference frame 0")
    base = decode_base(manifest["base_codec"], streams)
    #WDD-gpt 2026-08-15 - 邻接完全由解码后的首帧确定性重建，码流不再保存锚点和每点五索引。
    topology = build_anchor_topology(
        base,
        float(manifest["anchor_fraction"]),
        int(manifest["neighbors_per_point"]),
    )
    weights = decode_weight_codec(manifest, streams, count)
    field = decode_field_codec(manifest, streams)
    motion = reconstruct_motion(weights, field, topology.neighbors)
    node_count = count * (len(manifest["frames"]) - 1)
    mask = np.unpackbits(
        np.frombuffer(streams["correction_mask"], dtype=np.uint8),
        bitorder="little",
    )[:node_count].astype(bool).reshape(count, -1)
    correction = np.frombuffer(streams["corrections"], dtype="<i2").reshape(-1, 3)
    if correction.shape[0] != np.count_nonzero(mask):
        raise ValueError("Correction stream does not match its mask")
    motion[mask] += correction.astype(np.float32) * np.float32(manifest["correction_step"])
    positions = np.concatenate([base[:, None, :], base[:, None, :] + motion], axis=1)
    return manifest, positions


def search_budget(
    output: Path,
    frames: list[int],
    target_motion: np.ndarray,
    base: BaseCodec,
    prediction: np.ndarray,
    weight_codec: WeightCodec,
    field_codec: FieldCodec,
    anchor_fraction: float,
    neighbors: int,
    profile_name: str,
    target_bytes: int,
    zstd_level: int,
    iterations: int,
) -> tuple[dict[str, Any], np.ndarray, list[dict[str, float]]]:
    low = 1e-5
    high = 0.1
    trials: list[dict[str, float]] = []
    best: tuple[float, dict[str, Any], np.ndarray] | None = None
    temporary = output.with_name(f".{output.name}.search.npz")
    for _ in range(iterations):
        ratio = math.sqrt(low * high)
        manifest, reconstructed = encode_candidate(
            temporary,
            frames,
            target_motion,
            base,
            prediction,
            weight_codec,
            field_codec,
            anchor_fraction,
            neighbors,
            ratio,
            profile_name,
            target_bytes,
            zstd_level,
        )
        size = int(manifest["archive_bytes"])
        trials.append({
            "correction_ratio": ratio,
            "archive_bytes": size,
            "correction_fraction": float(manifest["correction_fraction"]),
        })
        if size <= target_bytes:
            best = (ratio, manifest, reconstructed)
            high = ratio
        else:
            low = ratio
    if best is None:
        ratio = high
    else:
        ratio = best[0]
    manifest, reconstructed = encode_candidate(
        output,
        frames,
        target_motion,
        base,
        prediction,
        weight_codec,
        field_codec,
        anchor_fraction,
        neighbors,
        ratio,
        profile_name,
        target_bytes,
        zstd_level,
    )
    if int(manifest["archive_bytes"]) > target_bytes:
        raise RuntimeError(
            f"{profile_name} could not meet {target_bytes} bytes; got {manifest['archive_bytes']}"
        )
    temporary.unlink(missing_ok=True)
    return manifest, reconstructed, trials


def write_position_ablation(
    source: Path,
    output: Path,
    decoded_positions: np.ndarray,
    order: np.ndarray,
) -> None:
    layout = read_raw4d_layout(source)
    rows = load_rows(layout)
    rotations, rotation_frames = extract_track(rows, layout, "rot_bank", ("w", "x", "y", "z"))
    colors, color_frames = extract_track(rows, layout, "f_dc_bank", ("0", "1", "2"))
    scales, scale_frames = extract_track(rows, layout, "scale_bank", ("0", "1", "2"))
    opacities, opacity_frames = extract_track(rows, layout, "opacity_bank", ("",))
    _, position_frames = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    sh = np.asarray(
        rows[:, property_indices(layout, [f"f_rest_{index}" for index in range(45)])],
        dtype=np.float32,
    )
    mu = np.asarray(rows[:, property_indices(layout, ["lifetime_mu"])[0]], dtype=np.float32)
    width = np.asarray(rows[:, property_indices(layout, ["lifetime_w"])[0]], dtype=np.float32)
    manifest = {
        "gaussian_count": layout.vertex_count,
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
        output,
        manifest,
        sh[order],
        decoded_positions,
        rotations[order],
        colors[order],
        scales[order],
        opacities[order],
        mu[order],
        width[order],
    )


def parse_targets(value: str) -> tuple[tuple[str, int, str], ...]:
    parsed: list[tuple[str, int, str]] = []
    for item in value.split(","):
        name, bytes_text, model = item.split(":")
        parsed.append((name, int(bytes_text), model))
    return tuple(parsed)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate actual LAF archives at five byte budgets")
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--targets", type=parse_targets, default=DEFAULT_TARGETS)
    parser.add_argument("--anchor-fraction", type=float, default=0.05)
    parser.add_argument("--neighbors", type=int, default=5)
    parser.add_argument("--steps", type=int, default=120)
    parser.add_argument("--ridge", type=float, default=1e-4)
    parser.add_argument("--weight-learning-rate", type=float, default=8e-3)
    parser.add_argument("--field-learning-rate", type=float, default=2e-3)
    parser.add_argument("--weight-regularization", type=float, default=1e-8)
    parser.add_argument("--field-regularization", type=float, default=1e-7)
    parser.add_argument("--base-correction-ratio", type=float, default=DEFAULT_BASE_CORRECTION_RATIO)
    parser.add_argument("--weight-clip-percentile", type=float, default=99.9)
    parser.add_argument("--zstd-level", type=int, default=8)
    parser.add_argument("--search-iterations", type=int, default=16)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--skip-raw4d", action="store_true")
    args = parser.parse_args()

    started = time.perf_counter()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    layout = read_raw4d_layout(args.source)
    rows = load_rows(layout)
    positions, frames = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    base = encode_base(positions, args.base_correction_ratio)
    sorted_positions = positions[base.order]
    #WDD-gpt 2026-08-15 - 每个关键帧独立学习P(t)-P(0)，禁止把相邻帧增量连续累加。
    target_motion = (sorted_positions[:, 1:] - base.decoded[:, None, :]).astype(np.float32)
    topology = build_anchor_topology(base.decoded, args.anchor_fraction, args.neighbors)
    initial_field = target_motion[topology.anchors].copy()
    initial_weights = solve_static_weights(target_motion, initial_field, topology.neighbors, args.ridge)
    weights, field, history, training_seconds = train_joint_translation_field(
        target_motion,
        topology.neighbors,
        initial_weights,
        initial_field,
        args.steps,
        args.weight_learning_rate,
        args.field_learning_rate,
        args.weight_regularization,
        args.field_regularization,
        args.device,
    )

    rng = np.random.default_rng(20260815)
    sample_indices = rng.choice(weights.shape[0], size=min(weights.shape[0], 65536), replace=False)
    model_specs = {
        "conservative": {"weight_clusters": 256, "weight_stages": 2, "field_rank": 8, "field_bits": 10},
        "recommended": {"weight_clusters": 256, "weight_stages": 1, "field_rank": 6, "field_bits": 8},
        "aggressive": {"weight_clusters": 64, "weight_stages": 1, "field_rank": 4, "field_bits": 6},
    }
    models: dict[str, tuple[WeightCodec, FieldCodec, np.ndarray]] = {}
    for model_name, spec in model_specs.items():
        print(json.dumps({"building_model": model_name, **spec}), flush=True)
        weight_codec = train_weight_codec(
            weights,
            int(spec["weight_clusters"]),
            int(spec["weight_stages"]),
            sample_indices,
            20260815,
            args.weight_clip_percentile,
        )
        field_codec = encode_field(field, int(spec["field_rank"]), int(spec["field_bits"]))
        prediction = reconstruct_motion(weight_codec.decoded, field_codec.decoded, topology.neighbors)
        models[model_name] = (weight_codec, field_codec, prediction)

    entries: list[dict[str, Any]] = []
    for profile_name, target_bytes, model_name in args.targets:
        weight_codec, field_codec, prediction = models[model_name]
        profile_dir = args.output_dir / profile_name
        archive_path = profile_dir / "xyz_laf_extreme.npz"
        profile_started = time.perf_counter()
        manifest, encoder_motion, trials = search_budget(
            archive_path,
            frames,
            target_motion,
            base,
            prediction,
            weight_codec,
            field_codec,
            args.anchor_fraction,
            args.neighbors,
            profile_name,
            target_bytes,
            args.zstd_level,
            args.search_iterations,
        )
        decoded_manifest, decoded_positions = decode_candidate(archive_path)
        encoder_positions = np.concatenate([
            base.decoded[:, None, :],
            base.decoded[:, None, :] + encoder_motion,
        ], axis=1)
        if not np.array_equal(decoded_positions, encoder_positions):
            maximum_error = float(np.max(np.abs(decoded_positions - encoder_positions)))
            raise AssertionError(f"Independent decoder differs from encoder: {maximum_error}")
        raw4d_path = profile_dir / "position_ablation.raw4d"
        if not args.skip_raw4d:
            write_position_ablation(args.source, raw4d_path, decoded_positions, base.order)
        entry = {
            "profile_name": profile_name,
            "model_name": model_name,
            "target_bytes": target_bytes,
            "archive_path": str(archive_path),
            "archive_bytes": archive_path.stat().st_size,
            "compression_ratio_vs_uncompressed_xyz": positions.nbytes / archive_path.stat().st_size,
            "raw4d_path": None if args.skip_raw4d else str(raw4d_path),
            "correction_ratio": manifest["correction_ratio"],
            "correction_count": manifest["correction_count"],
            "correction_fraction": manifest["correction_fraction"],
            "metrics_before_correction": manifest["metrics_before_correction"],
            "metrics_after_correction": manifest["metrics_after_correction"],
            "streams": manifest["streams"],
            "search_trials": trials,
            "independent_decoder_validated": decoded_manifest["format"] == FORMAT_NAME,
            "seconds": time.perf_counter() - profile_started,
        }
        (profile_dir / "report.json").write_text(json.dumps(entry, indent=2), encoding="utf-8")
        entries.append(entry)
        print(json.dumps({
            "profile": profile_name,
            "archive_bytes": entry["archive_bytes"],
            "ratio": entry["compression_ratio_vs_uncompressed_xyz"],
            "correction_ratio": entry["correction_ratio"],
            "p99": entry["metrics_after_correction"]["vector_p99"],
        }), flush=True)

    report = {
        "format": FORMAT_NAME,
        "source": str(args.source),
        "source_bytes": args.source.stat().st_size,
        "uncompressed_xyz_bytes": positions.nbytes,
        "gaussian_count": positions.shape[0],
        "frames": frames,
        "anchor_fraction": args.anchor_fraction,
        "anchor_count": int(topology.anchors.size),
        "neighbors_per_point": args.neighbors,
        "base": base.metadata,
        "training_history": history,
        "training_seconds": training_seconds,
        "models": {
            name: {
                "spec": model_specs[name],
                "weight": codec[0].metadata,
                "field": codec[1].metadata,
                "prediction_metrics": vector_metrics(codec[2], target_motion),
            }
            for name, codec in models.items()
        },
        "profiles": entries,
        "total_seconds": time.perf_counter() - started,
    }
    (args.output_dir / "rate_sweep.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        "report": str(args.output_dir / "rate_sweep.json"),
        "profiles": len(entries),
        "total_seconds": report["total_seconds"],
    }), flush=True)


if __name__ == "__main__":
    main()
