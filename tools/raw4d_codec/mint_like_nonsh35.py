#!/usr/bin/env python3
"""MINT-like one-window codec for the non-SH RAW4D tracks."""

from __future__ import annotations

import argparse
import hashlib
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
from compact40 import assign_codebook, train_codebook
from learnable_anchor_field import build_anchor_topology, reconstruct_motion
from learnable_anchor_rate_sweep import (
    decode_base,
    decode_field_codec,
    decode_weight_codec,
    encode_base,
)


#WDD-gpt 2026-08-15 - 把11个关键帧作为单个MINT-like窗口，联合量化XYZ残差、旋转、尺度和透明度并严格搜索3.5 MB实码流。
FORMAT_NAME = "MINT-LIKE-NONSH35"
FORMAT_VERSION = 1
DEFAULT_TARGET_BYTES = 3_500_000
DEFAULT_MODEL_TARGET_BYTES = 2_900_000
DEFAULT_LEVELS = 8
FEATURE_DIMENSIONS = 52
POSITION_DIMENSIONS = 30
ROTATION_DIMENSIONS = 6
SCALE_DIMENSIONS = 12
OPACITY_DIMENSIONS = 4
GROUP_WEIGHTS = {
    "position": 2.0,
    "rotation": 1.25,
    "scale": 2.5,
    "opacity": 0.5,
}


@dataclass(frozen=True)
class AnchorModel:
    manifest: dict[str, Any]
    raw_streams: dict[str, bytes]
    base: np.ndarray
    prediction: np.ndarray


@dataclass(frozen=True)
class JointFeatures:
    source: np.ndarray
    normalized: np.ndarray
    center: np.ndarray
    spread: np.ndarray
    dimension_weights: np.ndarray


@dataclass(frozen=True)
class JointRvq:
    codebooks: np.ndarray
    labels: np.ndarray
    distortions: np.ndarray


def _compress(raw: bytes, level: int) -> bytes:
    return zstd.ZstdCompressor(level=level, threads=0).compress(raw)


def _decompress(payload: np.ndarray, raw_bytes: int) -> bytes:
    return zstd.ZstdDecompressor().decompress(
        payload.tobytes(),
        max_output_size=raw_bytes,
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_quaternions(values: np.ndarray) -> np.ndarray:
    result = np.asarray(values, dtype=np.float32).copy()
    result /= np.maximum(np.linalg.norm(result, axis=-1, keepdims=True), np.float32(1e-12))
    result *= np.where(result[..., :1] < 0, np.float32(-1), np.float32(1))
    return result


def quaternion_conjugate(values: np.ndarray) -> np.ndarray:
    result = np.asarray(values, dtype=np.float32).copy()
    result[..., 1:] *= np.float32(-1)
    return result


def quaternion_multiply(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    left = np.asarray(left, dtype=np.float32)
    right = np.asarray(right, dtype=np.float32)
    lw = left[..., :1]
    rw = right[..., :1]
    lv = left[..., 1:]
    rv = right[..., 1:]
    scalar = lw * rw - np.sum(lv * rv, axis=-1, keepdims=True)
    vector = lw * rv + rw * lv + np.cross(lv, rv)
    return canonical_quaternions(np.concatenate([scalar, vector], axis=-1))


def quaternion_log(values: np.ndarray) -> np.ndarray:
    values = canonical_quaternions(values)
    vector = values[..., 1:]
    length = np.linalg.norm(vector, axis=-1, keepdims=True)
    angle = np.float32(2) * np.arctan2(length, np.clip(values[..., :1], 0, 1))
    scale = np.divide(angle, length, out=np.zeros_like(angle), where=length > np.float32(1e-8))
    return (vector * scale).astype(np.float32)


def quaternion_exp(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    angle = np.linalg.norm(values, axis=-1, keepdims=True)
    half = angle * np.float32(0.5)
    scale = np.divide(
        np.sin(half),
        angle,
        out=np.full_like(angle, np.float32(0.5)),
        where=angle > np.float32(1e-8),
    )
    return canonical_quaternions(np.concatenate([np.cos(half), values * scale], axis=-1))


def encode_rotation_features(rotations: np.ndarray) -> np.ndarray:
    rotations = canonical_quaternions(rotations)
    first = rotations[:, 0]
    delta = quaternion_multiply(rotations[:, 1], quaternion_conjugate(first))
    return np.concatenate([quaternion_log(first), quaternion_log(delta)], axis=1)


def decode_rotation_features(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    first = quaternion_exp(values[:, :3])
    delta = quaternion_exp(values[:, 3:6])
    second = quaternion_multiply(delta, first)
    return np.stack([first, second], axis=1).astype(np.float32)


def stable_sigmoid(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    result = np.empty_like(values)
    positive = values >= 0
    result[positive] = 1 / (1 + np.exp(-values[positive]))
    exponential = np.exp(values[~positive])
    result[~positive] = exponential / (1 + exponential)
    return result


def alpha_to_logit(values: np.ndarray) -> np.ndarray:
    lower = np.float32(1 / (1 + math.exp(16)))
    upper = np.float32(1 / (1 + math.exp(-16)))
    clipped = np.clip(np.asarray(values, dtype=np.float32), lower, upper)
    return np.log(clipped / (1 - clipped)).astype(np.float32)


def load_anchor_model(path: Path) -> AnchorModel:
    with np.load(path, allow_pickle=False) as archive:
        manifest = json.loads(archive["manifest"].tobytes().decode("utf-8"))
        streams = {
            name: _decompress(archive[name], int(metadata["raw_bytes"]))
            for name, metadata in manifest["streams"].items()
            if name not in {"correction_mask", "corrections"}
        }
    base = decode_base(manifest["base_codec"], streams)
    topology = build_anchor_topology(
        base,
        float(manifest["anchor_fraction"]),
        int(manifest["neighbors_per_point"]),
    )
    weights = decode_weight_codec(manifest, streams, base.shape[0])
    field = decode_field_codec(manifest, streams)
    prediction = reconstruct_motion(weights, field, topology.neighbors)
    return AnchorModel(manifest=manifest, raw_streams=streams, base=base, prediction=prediction)


def feature_slices() -> dict[str, slice]:
    return {
        "position": slice(0, POSITION_DIMENSIONS),
        "rotation": slice(POSITION_DIMENSIONS, POSITION_DIMENSIONS + ROTATION_DIMENSIONS),
        "scale": slice(
            POSITION_DIMENSIONS + ROTATION_DIMENSIONS,
            POSITION_DIMENSIONS + ROTATION_DIMENSIONS + SCALE_DIMENSIONS,
        ),
        "opacity": slice(FEATURE_DIMENSIONS - OPACITY_DIMENSIONS, FEATURE_DIMENSIONS),
    }


def build_joint_features(
    position_residual: np.ndarray,
    rotations: np.ndarray,
    scales: np.ndarray,
    opacities: np.ndarray,
) -> JointFeatures:
    source = np.concatenate([
        position_residual.reshape(position_residual.shape[0], -1),
        encode_rotation_features(rotations),
        np.clip(scales, -16, 2).reshape(scales.shape[0], -1),
        stable_sigmoid(np.nan_to_num(opacities, neginf=-16)).reshape(opacities.shape[0], -1),
    ], axis=1).astype(np.float32)
    if source.shape[1] != FEATURE_DIMENSIONS:
        raise AssertionError(f"Joint feature dimension mismatch: {source.shape}")
    center = np.median(source, axis=0).astype(np.float32)
    spread = np.percentile(np.abs(source - center), 90, axis=0).astype(np.float32)
    spread = np.maximum(spread, np.float32(1e-6))
    dimension_weights = np.empty(FEATURE_DIMENSIONS, dtype=np.float32)
    for name, selected in feature_slices().items():
        dimension_weights[selected] = np.float32(GROUP_WEIGHTS[name])
    normalized = (source - center) / spread * dimension_weights
    normalized = np.clip(normalized, -16, 16).astype(np.float32)
    return JointFeatures(
        source=source,
        normalized=normalized,
        center=center,
        spread=spread,
        dimension_weights=dimension_weights,
    )


def denormalize_features(normalized: np.ndarray, features: JointFeatures | dict[str, Any]) -> np.ndarray:
    if isinstance(features, JointFeatures):
        center = features.center
        spread = features.spread
        weights = features.dimension_weights
    else:
        center = np.asarray(features["center"], dtype=np.float32)
        spread = np.asarray(features["spread"], dtype=np.float32)
        weights = np.asarray(features["dimension_weights"], dtype=np.float32)
    return (np.asarray(normalized, dtype=np.float32) / weights * spread + center).astype(np.float32)


def visibility_importance(scales: np.ndarray, opacities: np.ndarray) -> np.ndarray:
    radius = np.exp(np.clip(np.max(scales, axis=(1, 2)), -16, 2))
    alpha = np.max(stable_sigmoid(np.nan_to_num(opacities, neginf=-16)), axis=(1, 2))
    raw = alpha * np.square(radius)
    positive = raw[raw > 0]
    reference = float(np.median(positive)) if positive.size else 1.0
    normalized = np.sqrt(np.maximum(raw, 0) / max(reference, 1e-12))
    return np.clip(normalized, 0.25, 4.0).astype(np.float32)


def train_joint_rvq(
    values: np.ndarray,
    levels: int,
    sample_indices: np.ndarray,
) -> JointRvq:
    residual = np.asarray(values, dtype=np.float32).copy()
    decoded = np.zeros_like(residual)
    labels = np.empty((values.shape[0], levels), dtype=np.uint8)
    codebooks = np.empty((levels, 256, values.shape[1]), dtype=np.float32)
    distortions = np.empty((values.shape[0], levels + 1), dtype=np.float32)
    distortions[:, 0] = np.sum(np.square(residual), axis=1)
    for level in range(levels):
        codebook, _ = train_codebook(
            residual,
            256,
            20260880 + level,
            sample_indices,
            reserve_zero=True,
        )
        codebook = codebook.astype(np.float16).astype(np.float32)
        assigned = assign_codebook(residual, codebook).astype(np.uint8)
        decoded += codebook[assigned]
        residual -= codebook[assigned]
        codebooks[level] = codebook
        labels[:, level] = assigned
        distortions[:, level + 1] = np.sum(np.square(residual), axis=1)
        print(json.dumps({
            "rvq_level": level + 1,
            "normalized_rmse": float(np.sqrt(np.mean(np.square(residual), dtype=np.float64))),
            "zero_label_fraction": float(np.mean(assigned == 0)),
        }), flush=True)
    return JointRvq(codebooks=codebooks, labels=labels, distortions=distortions)


def labels_for_lambda(rvq: JointRvq, importance: np.ndarray, rate_lambda: float) -> tuple[np.ndarray, np.ndarray]:
    levels = rvq.labels.shape[1]
    cost = rvq.distortions * importance[:, None]
    cost = cost + np.float32(rate_lambda) * np.arange(levels + 1, dtype=np.float32)[None, :]
    depths = np.argmin(cost, axis=1).astype(np.uint8)
    labels = rvq.labels.copy()
    labels[np.arange(levels)[None, :] >= depths[:, None]] = 0
    return labels, depths


def decode_rvq(codebooks: np.ndarray, labels: np.ndarray) -> np.ndarray:
    level_indices = np.arange(codebooks.shape[0], dtype=np.int64)[None, :]
    return codebooks[level_indices, labels].sum(axis=1, dtype=np.float32)


def manifest_base(anchor: AnchorModel, features: JointFeatures, levels: int, target_bytes: int) -> dict[str, Any]:
    return {
        "format": FORMAT_NAME,
        "version": FORMAT_VERSION,
        "target_bytes": target_bytes,
        "gaussian_count": int(anchor.base.shape[0]),
        "motion_reference": "frame0_to_each_keyframe",
        "position_keyframes": list(anchor.manifest["frames"]),
        "rotation_keyframes": [0, 30],
        "scale_keyframes": [0, 10, 20, 30],
        "opacity_keyframes": [0, 10, 20, 30],
        "anchor_fraction": float(anchor.manifest["anchor_fraction"]),
        "neighbors_per_point": int(anchor.manifest["neighbors_per_point"]),
        "base_codec": anchor.manifest["base_codec"],
        "weight_codec": anchor.manifest["weight_codec"],
        "field_codec": anchor.manifest["field_codec"],
        "joint_rvq": {
            "levels": levels,
            "clusters": 256,
            "dimensions": FEATURE_DIMENSIONS,
            "codebook_shape": [levels, 256, FEATURE_DIMENSIONS],
            "center": features.center.tolist(),
            "spread": features.spread.tolist(),
            "dimension_weights": features.dimension_weights.tolist(),
            "group_weights": GROUP_WEIGHTS,
            "feature_slices": {
                name: [selected.start, selected.stop]
                for name, selected in feature_slices().items()
            },
        },
    }


def serialize_archive(
    output: Path,
    manifest: dict[str, Any],
    raw_streams: dict[str, bytes],
    zstd_level: int,
) -> dict[str, Any]:
    stored = {name: _compress(payload, zstd_level) for name, payload in raw_streams.items()}
    serialized_manifest = dict(manifest)
    serialized_manifest["streams"] = {
        name: {"raw_bytes": len(raw_streams[name]), "stored_bytes": len(payload)}
        for name, payload in stored.items()
    }
    manifest_bytes = json.dumps(serialized_manifest, separators=(",", ":")).encode("utf-8")
    archive: dict[str, np.ndarray] = {"manifest": np.frombuffer(manifest_bytes, dtype=np.uint8)}
    archive.update({name: np.frombuffer(payload, dtype=np.uint8) for name, payload in stored.items()})
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez(output, **archive)
    result = dict(serialized_manifest)
    result["archive_bytes"] = output.stat().st_size
    result["logical_stored_bytes"] = int(sum(len(payload) for payload in stored.values()))
    return result


def raw_model_streams(anchor: AnchorModel, rvq: JointRvq, labels: np.ndarray) -> dict[str, bytes]:
    streams = dict(anchor.raw_streams)
    streams["joint_codebooks"] = rvq.codebooks.astype("<f2").tobytes()
    streams["joint_labels"] = np.asarray(labels, dtype=np.uint8).tobytes()
    return streams


def search_model_budget(
    output: Path,
    manifest: dict[str, Any],
    anchor: AnchorModel,
    rvq: JointRvq,
    importance: np.ndarray,
    target_bytes: int,
    zstd_level: int,
    iterations: int,
) -> tuple[np.ndarray, np.ndarray, list[dict[str, Any]]]:
    trials: list[dict[str, Any]] = []
    best: tuple[float, np.ndarray, np.ndarray] | None = None
    temporary = output.with_name(f".{output.name}.model-search.npz")
    low = 1e-8
    high = 1e4
    for _ in range(iterations):
        rate_lambda = math.sqrt(low * high)
        labels, depths = labels_for_lambda(rvq, importance, rate_lambda)
        candidate_manifest = dict(manifest)
        candidate_manifest["joint_rvq"] = dict(manifest["joint_rvq"])
        candidate_manifest["joint_rvq"]["rate_lambda"] = rate_lambda
        encoded = serialize_archive(
            temporary,
            candidate_manifest,
            raw_model_streams(anchor, rvq, labels),
            zstd_level,
        )
        size = int(encoded["archive_bytes"])
        distortion = float(np.mean(rvq.distortions[np.arange(depths.size), depths] * importance))
        trials.append({
            "rate_lambda": rate_lambda,
            "archive_bytes": size,
            "mean_depth": float(np.mean(depths)),
            "weighted_distortion": distortion,
        })
        if size <= target_bytes:
            if best is None or distortion < best[0]:
                best = (distortion, labels.copy(), depths.copy())
            high = rate_lambda
        else:
            low = rate_lambda
    temporary.unlink(missing_ok=True)
    if best is None:
        raise RuntimeError(f"MINT-like base model cannot fit {target_bytes} bytes")
    return best[1], best[2], trials


def split_decoded_features(values: np.ndarray) -> dict[str, np.ndarray]:
    slices = feature_slices()
    return {
        "position_residual": values[:, slices["position"]].reshape(-1, 10, 3),
        "rotation": decode_rotation_features(values[:, slices["rotation"]]),
        "scale": values[:, slices["scale"]].reshape(-1, 4, 3),
        "opacity": alpha_to_logit(values[:, slices["opacity"]]).reshape(-1, 4, 1),
    }


def encode_position_corrections(
    target_motion: np.ndarray,
    predicted_motion: np.ndarray,
    scene_diagonal: float,
    correction_ratio: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    error = target_motion - predicted_motion
    correction_target = scene_diagonal * correction_ratio
    correction_step = correction_target / (2 * math.sqrt(3))
    mask = np.linalg.norm(error, axis=2) > correction_target * 0.5
    quantized = np.rint(error[mask] / correction_step)
    if quantized.size and np.max(np.abs(quantized)) > np.iinfo(np.int16).max:
        raise ValueError("Position escape exceeds int16 range")
    quantized = quantized.astype("<i2")
    decoded = predicted_motion.copy()
    decoded[mask] += quantized.astype(np.float32) * np.float32(correction_step)
    return mask, quantized, decoded, correction_step


def search_final_budget(
    output: Path,
    manifest: dict[str, Any],
    model_streams: dict[str, bytes],
    target_motion: np.ndarray,
    predicted_motion: np.ndarray,
    target_bytes: int,
    zstd_level: int,
    iterations: int,
) -> tuple[dict[str, Any], np.ndarray, list[dict[str, Any]]]:
    scene_diagonal = float(manifest["base_codec"]["scene_diagonal"])
    low = 1e-5
    high = 0.1
    trials: list[dict[str, Any]] = []
    best: tuple[float, dict[str, Any], np.ndarray] | None = None
    temporary = output.with_name(f".{output.name}.correction-search.npz")
    for _ in range(iterations):
        ratio = math.sqrt(low * high)
        mask, corrections, decoded, step = encode_position_corrections(
            target_motion,
            predicted_motion,
            scene_diagonal,
            ratio,
        )
        raw_streams = dict(model_streams)
        raw_streams["position_escape_mask"] = np.packbits(mask.reshape(-1), bitorder="little").tobytes()
        raw_streams["position_escape_values"] = corrections.tobytes()
        candidate_manifest = dict(manifest)
        candidate_manifest["position_escape"] = {
            "correction_ratio": ratio,
            "correction_step": step,
            "count": int(np.count_nonzero(mask)),
            "fraction": float(np.mean(mask)),
        }
        encoded = serialize_archive(temporary, candidate_manifest, raw_streams, zstd_level)
        size = int(encoded["archive_bytes"])
        trials.append({
            "correction_ratio": ratio,
            "archive_bytes": size,
            "count": int(np.count_nonzero(mask)),
            "fraction": float(np.mean(mask)),
        })
        if size <= target_bytes:
            best = (ratio, candidate_manifest, decoded)
            high = ratio
        else:
            low = ratio
    if best is None:
        raise RuntimeError(f"MINT-like stream cannot fit {target_bytes} bytes")
    ratio, final_manifest, decoded = best
    mask, corrections, decoded, step = encode_position_corrections(
        target_motion,
        predicted_motion,
        scene_diagonal,
        ratio,
    )
    raw_streams = dict(model_streams)
    raw_streams["position_escape_mask"] = np.packbits(mask.reshape(-1), bitorder="little").tobytes()
    raw_streams["position_escape_values"] = corrections.tobytes()
    final_manifest["position_escape"] = {
        "correction_ratio": ratio,
        "correction_step": step,
        "count": int(np.count_nonzero(mask)),
        "fraction": float(np.mean(mask)),
    }
    encoded = serialize_archive(output, final_manifest, raw_streams, zstd_level)
    if int(encoded["archive_bytes"]) > target_bytes:
        raise RuntimeError(f"Final archive exceeds target: {encoded['archive_bytes']} > {target_bytes}")
    temporary.unlink(missing_ok=True)
    return encoded, decoded, trials


def decode_archive(path: Path) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    with np.load(path, allow_pickle=False) as archive:
        manifest = json.loads(archive["manifest"].tobytes().decode("utf-8"))
        streams = {
            name: _decompress(archive[name], int(metadata["raw_bytes"]))
            for name, metadata in manifest["streams"].items()
        }
    if manifest.get("format") != FORMAT_NAME or int(manifest.get("version", 0)) != FORMAT_VERSION:
        raise ValueError("Unsupported MINT-like non-SH stream")
    if manifest.get("motion_reference") != "frame0_to_each_keyframe":
        raise ValueError("MINT-like non-SH motion must reference frame 0")
    count = int(manifest["gaussian_count"])
    base = decode_base(manifest["base_codec"], streams)
    topology = build_anchor_topology(
        base,
        float(manifest["anchor_fraction"]),
        int(manifest["neighbors_per_point"]),
    )
    weights = decode_weight_codec(manifest, streams, count)
    field = decode_field_codec(manifest, streams)
    anchor_prediction = reconstruct_motion(weights, field, topology.neighbors)
    rvq_meta = manifest["joint_rvq"]
    codebooks = np.frombuffer(streams["joint_codebooks"], dtype="<f2").astype(np.float32)
    codebooks = codebooks.reshape(rvq_meta["codebook_shape"])
    labels = np.frombuffer(streams["joint_labels"], dtype=np.uint8).reshape(count, int(rvq_meta["levels"]))
    normalized = decode_rvq(codebooks, labels)
    decoded_values = denormalize_features(normalized, rvq_meta)
    decoded = split_decoded_features(decoded_values)
    motion = anchor_prediction + decoded.pop("position_residual")
    node_count = count * (len(manifest["position_keyframes"]) - 1)
    mask = np.unpackbits(
        np.frombuffer(streams["position_escape_mask"], dtype=np.uint8),
        bitorder="little",
    )[:node_count].astype(bool).reshape(count, -1)
    corrections = np.frombuffer(streams["position_escape_values"], dtype="<i2").reshape(-1, 3)
    if corrections.shape[0] != np.count_nonzero(mask):
        raise ValueError("Position escape count mismatch")
    motion[mask] += corrections.astype(np.float32) * np.float32(manifest["position_escape"]["correction_step"])
    decoded["position"] = np.concatenate([base[:, None, :], base[:, None, :] + motion], axis=1)
    return manifest, decoded


def numeric_metrics(
    source: dict[str, np.ndarray],
    decoded: dict[str, np.ndarray],
) -> dict[str, Any]:
    position_error = np.linalg.norm(decoded["position"] - source["position"], axis=2)
    source_rotation = canonical_quaternions(source["rotation"])
    decoded_rotation = canonical_quaternions(decoded["rotation"])
    dot = np.abs(np.sum(source_rotation * decoded_rotation, axis=2)).clip(0, 1)
    angular = np.degrees(2 * np.arccos(dot))
    relative_scale = np.abs(np.expm1(decoded["scale"] - np.clip(source["scale"], -16, 2)))
    source_alpha = stable_sigmoid(np.nan_to_num(source["opacity"], neginf=-16))
    decoded_alpha = stable_sigmoid(decoded["opacity"])
    alpha_error = np.abs(decoded_alpha - source_alpha)
    return {
        "position_vector": {
            "mean": float(np.mean(position_error)),
            "p99": float(np.percentile(position_error, 99)),
            "maximum": float(np.max(position_error)),
        },
        "rotation_angular_degrees": {
            "mean": float(np.mean(angular)),
            "p99": float(np.percentile(angular, 99)),
            "maximum": float(np.max(angular)),
        },
        "scale_relative_linear": {
            "mean": float(np.mean(relative_scale)),
            "p99": float(np.percentile(relative_scale, 99)),
            "maximum": float(np.max(relative_scale)),
        },
        "opacity_alpha": {
            "mean": float(np.mean(alpha_error)),
            "p99": float(np.percentile(alpha_error, 99)),
            "maximum": float(np.max(alpha_error)),
        },
    }


def write_ablation(
    source_path: Path,
    output: Path,
    decoded: dict[str, np.ndarray],
    order: np.ndarray,
) -> None:
    layout = read_raw4d_layout(source_path)
    rows = load_rows(layout)
    colors, color_frames = extract_track(rows, layout, "f_dc_bank", ("0", "1", "2"))
    sh = np.asarray(
        rows[:, property_indices(layout, [f"f_rest_{index}" for index in range(45)])],
        dtype=np.float32,
    )
    mu = np.asarray(rows[:, property_indices(layout, ["lifetime_mu"])[0]], dtype=np.float32)
    width = np.asarray(rows[:, property_indices(layout, ["lifetime_w"])[0]], dtype=np.float32)
    output_manifest = {
        "gaussian_count": layout.vertex_count,
        "total_frames": layout.total_frames,
        "attributes": {
            "position": {"keyframes": [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30]},
            "rotation": {"keyframes": [0, 30]},
            "color_dc": {"keyframes": color_frames},
            "scale": {"keyframes": [0, 10, 20, 30]},
            "opacity": {"keyframes": [0, 10, 20, 30]},
        },
    }
    write_decoded_raw4d(
        output,
        output_manifest,
        sh[order],
        decoded["position"],
        decoded["rotation"],
        colors[order],
        decoded["scale"],
        decoded["opacity"],
        mu[order],
        width[order],
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="MINT-like 3.5 MB non-SH RAW4D codec")
    parser.add_argument("source", type=Path)
    parser.add_argument("anchor_archive", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--target-bytes", type=int, default=DEFAULT_TARGET_BYTES)
    parser.add_argument("--model-target-bytes", type=int, default=DEFAULT_MODEL_TARGET_BYTES)
    parser.add_argument("--levels", type=int, default=DEFAULT_LEVELS)
    parser.add_argument("--sample-count", type=int, default=65536)
    parser.add_argument("--search-iterations", type=int, default=16)
    parser.add_argument("--zstd-level", type=int, default=8)
    args = parser.parse_args()

    started = time.perf_counter()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    layout = read_raw4d_layout(args.source)
    rows = load_rows(layout)
    positions, position_frames = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    rotations, rotation_frames = extract_track(rows, layout, "rot_bank", ("w", "x", "y", "z"))
    scales, scale_frames = extract_track(rows, layout, "scale_bank", ("0", "1", "2"))
    opacities, opacity_frames = extract_track(rows, layout, "opacity_bank", ("",))
    if position_frames != [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30]:
        raise ValueError(f"Unexpected position keyframes: {position_frames}")
    if rotation_frames != [0, 30] or scale_frames != [0, 10, 20, 30] or opacity_frames != [0, 10, 20, 30]:
        raise ValueError("Unexpected non-SH sparse keyframe layout")

    anchor = load_anchor_model(args.anchor_archive)
    regenerated_base = encode_base(positions, float(anchor.manifest["base_codec"]["correction_ratio"]))
    if not np.array_equal(regenerated_base.decoded, anchor.base):
        raise AssertionError("Source ordering does not reproduce the anchor archive base")
    order = regenerated_base.order
    source = {
        "position": positions[order],
        "rotation": rotations[order],
        "scale": scales[order],
        "opacity": opacities[order],
    }
    target_motion = source["position"][:, 1:] - anchor.base[:, None, :]
    position_residual = target_motion - anchor.prediction
    features = build_joint_features(
        position_residual,
        source["rotation"],
        source["scale"],
        source["opacity"],
    )
    importance = visibility_importance(source["scale"], source["opacity"])
    rng = np.random.default_rng(20260815)
    probabilities = importance.astype(np.float64)
    probabilities /= np.sum(probabilities)
    sample_indices = rng.choice(
        source["position"].shape[0],
        size=min(args.sample_count, source["position"].shape[0]),
        replace=True,
        p=probabilities,
    )
    rvq_started = time.perf_counter()
    rvq = train_joint_rvq(features.normalized, args.levels, sample_indices)
    rvq_seconds = time.perf_counter() - rvq_started
    manifest = manifest_base(anchor, features, args.levels, args.target_bytes)
    archive_path = args.output_dir / "nonsh_mint_like_3.5mb.npz"
    labels, depths, model_trials = search_model_budget(
        archive_path,
        manifest,
        anchor,
        rvq,
        importance,
        args.model_target_bytes,
        args.zstd_level,
        args.search_iterations,
    )
    manifest["joint_rvq"]["depth_histogram"] = np.bincount(
        depths,
        minlength=args.levels + 1,
    ).astype(int).tolist()
    manifest["joint_rvq"]["mean_depth"] = float(np.mean(depths))
    normalized_prediction = decode_rvq(rvq.codebooks, labels)
    joint_prediction = denormalize_features(normalized_prediction, features)
    decoded_groups = split_decoded_features(joint_prediction)
    predicted_motion = anchor.prediction + decoded_groups.pop("position_residual")
    model_streams = raw_model_streams(anchor, rvq, labels)
    encoded_manifest, decoded_motion, correction_trials = search_final_budget(
        archive_path,
        manifest,
        model_streams,
        target_motion,
        predicted_motion,
        args.target_bytes,
        args.zstd_level,
        args.search_iterations,
    )
    encoder_decoded = dict(decoded_groups)
    encoder_decoded["position"] = np.concatenate([
        anchor.base[:, None, :],
        anchor.base[:, None, :] + decoded_motion,
    ], axis=1)

    decode_started = time.perf_counter()
    decoded_manifest, independently_decoded = decode_archive(archive_path)
    decode_seconds = time.perf_counter() - decode_started
    for name in ("position", "rotation", "scale", "opacity"):
        if not np.array_equal(encoder_decoded[name], independently_decoded[name]):
            maximum = float(np.max(np.abs(encoder_decoded[name] - independently_decoded[name])))
            raise AssertionError(f"Independent {name} decode mismatch: {maximum}")
    decoded_raw4d = args.output_dir / "nonsh_ablation.raw4d"
    write_ablation(args.source, decoded_raw4d, independently_decoded, order)

    raw_nonsh_bytes = int(sum(source[name].nbytes for name in ("position", "rotation", "scale", "opacity")))
    report = {
        "format": FORMAT_NAME,
        "source": str(args.source),
        "source_bytes": args.source.stat().st_size,
        "gaussian_count": layout.vertex_count,
        "scope": {
            "included": ["position", "rotation", "scale", "opacity"],
            "excluded_and_copied_for_render": ["color_dc", "f_rest", "lifetime"],
            "raw_nonsh_bytes": raw_nonsh_bytes,
        },
        "archive": str(archive_path),
        "archive_bytes": archive_path.stat().st_size,
        "archive_sha256": _sha256(archive_path),
        "compression_ratio_vs_raw_nonsh": raw_nonsh_bytes / archive_path.stat().st_size,
        "compression_ratio_vs_source_raw4d": args.source.stat().st_size / archive_path.stat().st_size,
        "target_bytes": args.target_bytes,
        "model_target_bytes": args.model_target_bytes,
        "decoded_raw4d": str(decoded_raw4d),
        "independent_decoder_validated": decoded_manifest["format"] == FORMAT_NAME,
        "rvq": {
            "levels": args.levels,
            "clusters": 256,
            "mean_depth": float(np.mean(depths)),
            "depth_histogram": encoded_manifest["joint_rvq"]["depth_histogram"],
            "training_seconds": rvq_seconds,
        },
        "position_escape": encoded_manifest["position_escape"],
        "numeric_quality": numeric_metrics(source, independently_decoded),
        "streams": encoded_manifest["streams"],
        "model_search_trials": model_trials,
        "correction_search_trials": correction_trials,
        "measured_decode_seconds": decode_seconds,
        "total_encode_and_analysis_seconds": time.perf_counter() - started,
    }
    report_path = args.output_dir / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "report": str(report_path),
        "archive_bytes": report["archive_bytes"],
        "compression_ratio_vs_raw_nonsh": report["compression_ratio_vs_raw_nonsh"],
        "numeric_quality": report["numeric_quality"],
        "total_seconds": report["total_encode_and_analysis_seconds"],
    }, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
