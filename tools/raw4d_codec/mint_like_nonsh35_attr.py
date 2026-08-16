#!/usr/bin/env python3
"""Attribute-separated MINT-like 3.5 MB codec for RAW4D non-SH tracks."""

from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from codec import extract_track, load_rows, read_raw4d_layout
from compact40 import assign_codebook, train_codebook
from learnable_anchor_rate_sweep import decode_base, decode_field_codec, decode_weight_codec, encode_base
from learnable_anchor_field import build_anchor_topology, reconstruct_motion
from mint_like_nonsh35 import (
    DEFAULT_TARGET_BYTES,
    FORMAT_NAME,
    FORMAT_VERSION,
    alpha_to_logit,
    canonical_quaternions,
    decode_rotation_features,
    encode_position_corrections,
    encode_rotation_features,
    load_anchor_model,
    numeric_metrics,
    serialize_archive,
    stable_sigmoid,
    visibility_importance,
    write_ablation,
)


#WDD-gpt 2026-08-15 - 按Braindance MINT的属性独立RQ思路拆分means、rotation、scale和opacity，避免联合52D码本牺牲小维度属性。
PROFILE_NAME = "MINT-LIKE-NONSH35-ATTR-RQ"
MODEL_TARGET_BYTES = 3_180_000
ATTRIBUTE_SPECS = {
    "position": {"dimensions": 30, "levels": 6, "minimum_depth": 1, "weight": 1.5},
    "rotation": {"dimensions": 6, "levels": 4, "minimum_depth": 2, "weight": 2.0},
    "scale": {"dimensions": 12, "levels": 6, "minimum_depth": 2, "weight": 3.0},
    "opacity": {"dimensions": 4, "levels": 3, "minimum_depth": 1, "weight": 0.75},
}


@dataclass(frozen=True)
class AttributeFeatures:
    source: np.ndarray
    normalized: np.ndarray
    center: np.ndarray
    spread: np.ndarray


@dataclass(frozen=True)
class AttributeRvq:
    codebooks: np.ndarray
    labels: np.ndarray
    distortions: np.ndarray


def build_attribute_features(
    position_residual: np.ndarray,
    rotations: np.ndarray,
    scales: np.ndarray,
    opacities: np.ndarray,
) -> dict[str, AttributeFeatures]:
    sources = {
        "position": position_residual.reshape(position_residual.shape[0], -1).astype(np.float32),
        "rotation": encode_rotation_features(rotations),
        #WDD-gpt 2026-08-15 - scale和opacity是各帧绝对状态并独立解码，不做相邻帧累加；实测改成0帧增量会传播首帧量化误差。
        "scale": np.clip(scales, -16, 2).reshape(scales.shape[0], -1).astype(np.float32),
        "opacity": stable_sigmoid(np.nan_to_num(opacities, neginf=-16)).reshape(opacities.shape[0], -1),
    }
    result: dict[str, AttributeFeatures] = {}
    for name, source in sources.items():
        expected = int(ATTRIBUTE_SPECS[name]["dimensions"])
        if source.shape[1] != expected:
            raise AssertionError(f"{name} dimension mismatch: {source.shape[1]} != {expected}")
        #WDD-gpt 2026-08-15 - opacity以零alpha为精确零码，避免原本-infinity的非活动节点被码本均值错误激活。
        center = (
            np.zeros(source.shape[1], dtype=np.float32)
            if name == "opacity"
            else np.median(source, axis=0).astype(np.float32)
        )
        spread = np.percentile(np.abs(source - center), 90, axis=0).astype(np.float32)
        spread = np.maximum(spread, np.float32(1e-6))
        normalized = np.clip((source - center) / spread, -16, 16).astype(np.float32)
        result[name] = AttributeFeatures(
            source=source,
            normalized=normalized,
            center=center,
            spread=spread,
        )
    return result


def train_attribute_rvq(
    name: str,
    features: AttributeFeatures,
    sample_indices: np.ndarray,
) -> AttributeRvq:
    levels = int(ATTRIBUTE_SPECS[name]["levels"])
    residual = features.normalized.copy()
    labels = np.empty((features.normalized.shape[0], levels), dtype=np.uint8)
    codebooks = np.empty((levels, 256, features.normalized.shape[1]), dtype=np.float32)
    distortions = np.empty((features.normalized.shape[0], levels + 1), dtype=np.float32)
    distortions[:, 0] = np.sum(np.square(residual), axis=1)
    for level in range(levels):
        codebook, _ = train_codebook(
            residual,
            256,
            20260920 + sum(ord(character) for character in name) + level,
            sample_indices,
            reserve_zero=True,
        )
        codebook = codebook.astype(np.float16).astype(np.float32)
        assigned = assign_codebook(residual, codebook).astype(np.uint8)
        residual -= codebook[assigned]
        codebooks[level] = codebook
        labels[:, level] = assigned
        distortions[:, level + 1] = np.sum(np.square(residual), axis=1)
        print(json.dumps({
            "attribute": name,
            "rvq_level": level + 1,
            "normalized_rmse": float(np.sqrt(np.mean(np.square(residual), dtype=np.float64))),
            "zero_label_fraction": float(np.mean(assigned == 0)),
        }), flush=True)
    return AttributeRvq(codebooks=codebooks, labels=labels, distortions=distortions)


def decode_attribute_rvq(codebooks: np.ndarray, labels: np.ndarray) -> np.ndarray:
    levels = codebooks.shape[0]
    return codebooks[np.arange(levels, dtype=np.int64)[None, :], labels].sum(axis=1, dtype=np.float32)


def labels_for_lambda(
    rvqs: dict[str, AttributeRvq],
    importance: np.ndarray,
    rate_lambda: float,
) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
    encoded: dict[str, np.ndarray] = {}
    depths: dict[str, np.ndarray] = {}
    for name, rvq in rvqs.items():
        spec = ATTRIBUTE_SPECS[name]
        levels = int(spec["levels"])
        minimum_depth = int(spec["minimum_depth"])
        quality_weight = np.float32(float(spec["weight"]) ** 2)
        candidates = np.arange(levels + 1, dtype=np.float32)
        cost = rvq.distortions * importance[:, None] * quality_weight
        cost += np.float32(rate_lambda) * candidates[None, :]
        cost[:, :minimum_depth] = np.inf
        selected_depth = np.argmin(cost, axis=1).astype(np.uint8)
        labels = rvq.labels.copy()
        labels[np.arange(levels)[None, :] >= selected_depth[:, None]] = 0
        encoded[name] = labels
        depths[name] = selected_depth
    return encoded, depths


def raw_model_streams(
    anchor_streams: dict[str, bytes],
    rvqs: dict[str, AttributeRvq],
    labels: dict[str, np.ndarray],
) -> dict[str, bytes]:
    streams = dict(anchor_streams)
    for name, rvq in rvqs.items():
        streams[f"{name}_rq_codebooks"] = rvq.codebooks.astype("<f2").tobytes()
        streams[f"{name}_rq_labels"] = labels[name].astype(np.uint8).tobytes()
    return streams


def build_manifest(
    anchor_manifest: dict[str, Any],
    count: int,
    features: dict[str, AttributeFeatures],
    target_bytes: int,
) -> dict[str, Any]:
    return {
        "format": FORMAT_NAME,
        "version": FORMAT_VERSION,
        "profile": PROFILE_NAME,
        "profile_revision": "frame0-motion-absolute-scale-opacity-v2",
        "target_bytes": target_bytes,
        "gaussian_count": count,
        "motion_reference": "frame0_to_each_keyframe",
        #WDD-gpt 2026-08-15 - 在码流中明确各属性的时间参考，防止把绝对scale/alpha误解为连续关键帧增量。
        "attribute_reference": {
            "position": "P0 plus independent D(frame0_to_keyframe)",
            "rotation": "log(q0) plus log(q_keyframe times inverse(q0))",
            "scale": "independent absolute log-scale keyframes; no temporal accumulation",
            "opacity": "independent absolute alpha keyframes; no temporal accumulation",
        },
        "position_keyframes": list(anchor_manifest["frames"]),
        "rotation_keyframes": [0, 30],
        "scale_keyframes": [0, 10, 20, 30],
        "opacity_keyframes": [0, 10, 20, 30],
        "anchor_fraction": float(anchor_manifest["anchor_fraction"]),
        "neighbors_per_point": int(anchor_manifest["neighbors_per_point"]),
        "base_codec": anchor_manifest["base_codec"],
        "weight_codec": anchor_manifest["weight_codec"],
        "field_codec": anchor_manifest["field_codec"],
        "attribute_rq": {
            name: {
                **spec,
                "clusters": 256,
                "codebook_shape": [int(spec["levels"]), 256, int(spec["dimensions"])],
                "center": features[name].center.tolist(),
                "spread": features[name].spread.tolist(),
            }
            for name, spec in ATTRIBUTE_SPECS.items()
        },
    }


def search_model_budget(
    output: Path,
    manifest: dict[str, Any],
    anchor_streams: dict[str, bytes],
    rvqs: dict[str, AttributeRvq],
    importance: np.ndarray,
    target_bytes: int,
    zstd_level: int,
    iterations: int,
) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray], list[dict[str, Any]]]:
    low = 1e-8
    high = 1e5
    temporary = output.with_name(f".{output.name}.attr-model-search.npz")
    trials: list[dict[str, Any]] = []
    best: tuple[float, dict[str, np.ndarray], dict[str, np.ndarray]] | None = None
    for _ in range(iterations):
        rate_lambda = math.sqrt(low * high)
        labels, depths = labels_for_lambda(rvqs, importance, rate_lambda)
        candidate_manifest = dict(manifest)
        candidate_manifest["rate_lambda"] = rate_lambda
        encoded = serialize_archive(
            temporary,
            candidate_manifest,
            raw_model_streams(anchor_streams, rvqs, labels),
            zstd_level,
        )
        distortion = 0.0
        for name, rvq in rvqs.items():
            selected = depths[name]
            weight = float(ATTRIBUTE_SPECS[name]["weight"]) ** 2
            distortion += float(np.mean(rvq.distortions[np.arange(selected.size), selected] * importance)) * weight
        size = int(encoded["archive_bytes"])
        trial = {
            "rate_lambda": rate_lambda,
            "archive_bytes": size,
            "weighted_distortion": distortion,
            "mean_depths": {name: float(np.mean(value)) for name, value in depths.items()},
        }
        trials.append(trial)
        if size <= target_bytes:
            if best is None or distortion < best[0]:
                best = (
                    distortion,
                    {name: value.copy() for name, value in labels.items()},
                    {name: value.copy() for name, value in depths.items()},
                )
            high = rate_lambda
        else:
            low = rate_lambda
    temporary.unlink(missing_ok=True)
    if best is None:
        raise RuntimeError(f"Attribute RQ model cannot fit {target_bytes} bytes")
    return best[1], best[2], trials


def decode_model_features(
    features: dict[str, AttributeFeatures],
    rvqs: dict[str, AttributeRvq],
    labels: dict[str, np.ndarray],
) -> dict[str, np.ndarray]:
    decoded: dict[str, np.ndarray] = {}
    for name in ATTRIBUTE_SPECS:
        normalized = decode_attribute_rvq(rvqs[name].codebooks, labels[name])
        decoded[name] = (
            normalized * features[name].spread + features[name].center
        ).astype(np.float32)
    decoded["scale"] = np.clip(decoded["scale"], -16, 2)
    decoded["opacity"] = np.clip(decoded["opacity"], 0, 1)
    return decoded


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
    best: tuple[float, dict[str, Any], np.ndarray] | None = None
    trials: list[dict[str, Any]] = []
    temporary = output.with_name(f".{output.name}.attr-correction-search.npz")
    for _ in range(iterations):
        ratio = math.sqrt(low * high)
        mask, corrections, decoded, step = encode_position_corrections(
            target_motion, predicted_motion, scene_diagonal, ratio
        )
        streams = dict(model_streams)
        streams["position_escape_mask"] = np.packbits(mask.reshape(-1), bitorder="little").tobytes()
        streams["position_escape_values"] = corrections.tobytes()
        candidate_manifest = dict(manifest)
        candidate_manifest["position_escape"] = {
            "correction_ratio": ratio,
            "correction_step": step,
            "count": int(np.count_nonzero(mask)),
            "fraction": float(np.mean(mask)),
        }
        encoded = serialize_archive(temporary, candidate_manifest, streams, zstd_level)
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
        raise RuntimeError(f"Attribute RQ stream cannot fit {target_bytes} bytes")
    ratio, final_manifest, _ = best
    mask, corrections, decoded, step = encode_position_corrections(
        target_motion, predicted_motion, scene_diagonal, ratio
    )
    streams = dict(model_streams)
    streams["position_escape_mask"] = np.packbits(mask.reshape(-1), bitorder="little").tobytes()
    streams["position_escape_values"] = corrections.tobytes()
    final_manifest["position_escape"] = {
        "correction_ratio": ratio,
        "correction_step": step,
        "count": int(np.count_nonzero(mask)),
        "fraction": float(np.mean(mask)),
    }
    encoded = serialize_archive(output, final_manifest, streams, zstd_level)
    temporary.unlink(missing_ok=True)
    if int(encoded["archive_bytes"]) > target_bytes:
        raise RuntimeError("Final attribute RQ archive exceeds target")
    return encoded, decoded, trials


def decode_archive(path: Path) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    from mint_like_nonsh35 import _decompress

    with np.load(path, allow_pickle=False) as archive:
        manifest = json.loads(archive["manifest"].tobytes().decode("utf-8"))
        streams = {
            name: _decompress(archive[name], int(metadata["raw_bytes"]))
            for name, metadata in manifest["streams"].items()
        }
    if manifest.get("profile") != PROFILE_NAME:
        raise ValueError("Unsupported attribute-separated MINT-like profile")
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
    values: dict[str, np.ndarray] = {}
    for name, metadata in manifest["attribute_rq"].items():
        codebooks = np.frombuffer(streams[f"{name}_rq_codebooks"], dtype="<f2").astype(np.float32)
        codebooks = codebooks.reshape(metadata["codebook_shape"])
        labels = np.frombuffer(streams[f"{name}_rq_labels"], dtype=np.uint8)
        labels = labels.reshape(count, int(metadata["levels"]))
        normalized = decode_attribute_rvq(codebooks, labels)
        center = np.asarray(metadata["center"], dtype=np.float32)
        spread = np.asarray(metadata["spread"], dtype=np.float32)
        values[name] = (normalized * spread + center).astype(np.float32)
    values["scale"] = np.clip(values["scale"], -16, 2)
    values["opacity"] = np.clip(values["opacity"], 0, 1)
    motion = anchor_prediction + values["position"].reshape(count, 10, 3)
    node_count = count * 10
    mask = np.unpackbits(
        np.frombuffer(streams["position_escape_mask"], dtype=np.uint8),
        bitorder="little",
    )[:node_count].astype(bool).reshape(count, 10)
    corrections = np.frombuffer(streams["position_escape_values"], dtype="<i2").reshape(-1, 3)
    if corrections.shape[0] != np.count_nonzero(mask):
        raise ValueError("Position escape count mismatch")
    motion[mask] += corrections.astype(np.float32) * np.float32(manifest["position_escape"]["correction_step"])
    return manifest, {
        "position": np.concatenate([base[:, None, :], base[:, None, :] + motion], axis=1),
        "rotation": decode_rotation_features(values["rotation"]),
        "scale": values["scale"].reshape(count, 4, 3),
        "opacity": alpha_to_logit(values["opacity"]).reshape(count, 4, 1),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Attribute-separated MINT-like non-SH codec")
    parser.add_argument("source", type=Path)
    parser.add_argument("anchor_archive", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--target-bytes", type=int, default=DEFAULT_TARGET_BYTES)
    parser.add_argument("--model-target-bytes", type=int, default=MODEL_TARGET_BYTES)
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
        raise ValueError("Unexpected position keyframes")
    if rotation_frames != [0, 30] or scale_frames != [0, 10, 20, 30] or opacity_frames != [0, 10, 20, 30]:
        raise ValueError("Unexpected non-SH sparse keyframes")
    anchor = load_anchor_model(args.anchor_archive)
    regenerated = encode_base(positions, float(anchor.manifest["base_codec"]["correction_ratio"]))
    if not np.array_equal(regenerated.decoded, anchor.base):
        raise AssertionError("Source does not reproduce anchor base")
    order = regenerated.order
    source = {
        "position": positions[order],
        "rotation": rotations[order],
        "scale": scales[order],
        "opacity": opacities[order],
    }
    target_motion = source["position"][:, 1:] - anchor.base[:, None, :]
    position_residual = target_motion - anchor.prediction
    features = build_attribute_features(
        position_residual,
        source["rotation"],
        source["scale"],
        source["opacity"],
    )
    importance = visibility_importance(source["scale"], source["opacity"])
    probability = importance.astype(np.float64)
    probability /= np.sum(probability)
    rng = np.random.default_rng(20260815)
    sample_indices = rng.choice(
        layout.vertex_count,
        size=min(args.sample_count, layout.vertex_count),
        replace=True,
        p=probability,
    )
    rvq_started = time.perf_counter()
    rvqs = {
        name: train_attribute_rvq(name, features[name], sample_indices)
        for name in ATTRIBUTE_SPECS
    }
    rvq_seconds = time.perf_counter() - rvq_started
    manifest = build_manifest(anchor.manifest, layout.vertex_count, features, args.target_bytes)
    archive_path = args.output_dir / "nonsh_mint_like_attr_3.5mb.npz"
    labels, depths, model_trials = search_model_budget(
        archive_path,
        manifest,
        anchor.raw_streams,
        rvqs,
        importance,
        args.model_target_bytes,
        args.zstd_level,
        args.search_iterations,
    )
    for name, selected in depths.items():
        manifest["attribute_rq"][name]["mean_depth"] = float(np.mean(selected))
        manifest["attribute_rq"][name]["depth_histogram"] = np.bincount(
            selected,
            minlength=int(ATTRIBUTE_SPECS[name]["levels"]) + 1,
        ).astype(int).tolist()
    decoded_features = decode_model_features(features, rvqs, labels)
    predicted_motion = anchor.prediction + decoded_features["position"].reshape(layout.vertex_count, 10, 3)
    model_streams = raw_model_streams(anchor.raw_streams, rvqs, labels)
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
    encoder_decoded = {
        "position": np.concatenate([
            anchor.base[:, None, :],
            anchor.base[:, None, :] + decoded_motion,
        ], axis=1),
        "rotation": decode_rotation_features(decoded_features["rotation"]),
        "scale": decoded_features["scale"].reshape(layout.vertex_count, 4, 3),
        "opacity": alpha_to_logit(decoded_features["opacity"]).reshape(layout.vertex_count, 4, 1),
    }
    decode_started = time.perf_counter()
    decoded_manifest, independently_decoded = decode_archive(archive_path)
    decode_seconds = time.perf_counter() - decode_started
    for name in encoder_decoded:
        if not np.array_equal(encoder_decoded[name], independently_decoded[name]):
            maximum = float(np.max(np.abs(encoder_decoded[name] - independently_decoded[name])))
            raise AssertionError(f"Independent {name} decode mismatch: {maximum}")
    decoded_raw4d = args.output_dir / "nonsh_attr_ablation.raw4d"
    write_ablation(args.source, decoded_raw4d, independently_decoded, order)
    raw_nonsh_bytes = int(sum(source[name].nbytes for name in source))
    report = {
        "format": FORMAT_NAME,
        "profile": PROFILE_NAME,
        "source": str(args.source),
        "anchor_archive": str(args.anchor_archive),
        "source_bytes": args.source.stat().st_size,
        "gaussian_count": layout.vertex_count,
        "scope": {
            "included": ["position", "rotation", "scale", "opacity"],
            "excluded_and_copied_for_render": ["color_dc", "f_rest", "lifetime"],
            "raw_nonsh_bytes": raw_nonsh_bytes,
        },
        "archive": str(archive_path),
        "archive_bytes": archive_path.stat().st_size,
        "compression_ratio_vs_raw_nonsh": raw_nonsh_bytes / archive_path.stat().st_size,
        "compression_ratio_vs_source_raw4d": args.source.stat().st_size / archive_path.stat().st_size,
        "target_bytes": args.target_bytes,
        "model_target_bytes": args.model_target_bytes,
        "decoded_raw4d": str(decoded_raw4d),
        "independent_decoder_validated": decoded_manifest["profile"] == PROFILE_NAME,
        "attribute_rq": {
            name: {
                "levels": int(ATTRIBUTE_SPECS[name]["levels"]),
                "mean_depth": float(np.mean(depths[name])),
                "depth_histogram": encoded_manifest["attribute_rq"][name]["depth_histogram"],
                "stored_codebook_bytes": int(encoded_manifest["streams"][f"{name}_rq_codebooks"]["stored_bytes"]),
                "stored_label_bytes": int(encoded_manifest["streams"][f"{name}_rq_labels"]["stored_bytes"]),
            }
            for name in ATTRIBUTE_SPECS
        },
        "position_escape": encoded_manifest["position_escape"],
        "numeric_quality": numeric_metrics(source, independently_decoded),
        "streams": encoded_manifest["streams"],
        "model_search_trials": model_trials,
        "correction_search_trials": correction_trials,
        "rvq_training_seconds": rvq_seconds,
        "measured_decode_seconds": decode_seconds,
        "total_encode_and_analysis_seconds": time.perf_counter() - started,
    }
    report_path = args.output_dir / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "report": str(report_path),
        "archive_bytes": report["archive_bytes"],
        "compression_ratio_vs_raw_nonsh": report["compression_ratio_vs_raw_nonsh"],
        "attribute_rq": report["attribute_rq"],
        "numeric_quality": report["numeric_quality"],
        "total_seconds": report["total_encode_and_analysis_seconds"],
    }, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
