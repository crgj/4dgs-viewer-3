#!/usr/bin/env python3
"""CoReAttr-5R feasibility probe for all sparse RAW4D non-SH tracks."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from codec import extract_track, load_rows, read_raw4d_layout
from compact40 import assign_codebook, morton_codes, train_codebook
from mint_like_nonsh35 import (
    _decompress,
    alpha_to_logit,
    decode_rotation_features,
    encode_rotation_features,
    numeric_metrics,
    serialize_archive,
    stable_sigmoid,
    visibility_importance,
    write_ablation,
)


#WDD-gpt 2026-08-15 - 用与CoReSH-5R相同的五级加性残差VQ实测全部55D非SH稀疏轨迹。
PROFILE_NAME = "CoReAttr-5R-NONSH55-PROBE"
LEVELS = 5
CLUSTERS = 256
ATTRIBUTE_DIMENSIONS = {
    "position": 33,
    "rotation": 6,
    "scale": 12,
    "opacity": 4,
}


@dataclass(frozen=True)
class AttributeModel:
    center: np.ndarray
    spread: np.ndarray
    codebooks: np.ndarray
    labels: np.ndarray
    normalized_rmse_by_level: list[float]
    zero_label_fraction_by_level: list[float]


def spatial_order(positions: np.ndarray) -> np.ndarray:
    """Return a stable 10-bit Morton order based on the first position key."""
    first = np.asarray(positions[:, 0], dtype=np.float32)
    minimum = np.min(first, axis=0)
    extent = np.maximum(np.max(first, axis=0) - minimum, np.float32(1e-12))
    quantized = np.rint((first - minimum) / extent * np.float32(1023)).clip(0, 1023)
    return np.argsort(morton_codes(quantized.astype(np.uint16)), kind="stable")


def pack_residual_features(source: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    positions = np.asarray(source["position"], dtype=np.float32)
    scales = np.clip(np.asarray(source["scale"], dtype=np.float32), -16, 2)
    alpha = stable_sigmoid(np.asarray(source["opacity"], dtype=np.float32))
    #WDD-gpt 2026-08-15 - 每个时间节点都相对首关键帧编码，禁止相邻帧残差链累积误差。
    result = {
        "position": np.concatenate([
            positions[:, 0],
            (positions[:, 1:] - positions[:, :1]).reshape(positions.shape[0], -1),
        ], axis=1),
        "rotation": encode_rotation_features(source["rotation"]),
        "scale": np.concatenate([
            scales[:, 0],
            (scales[:, 1:] - scales[:, :1]).reshape(scales.shape[0], -1),
        ], axis=1),
        "opacity": np.concatenate([
            alpha[:, 0],
            (alpha[:, 1:] - alpha[:, :1]).reshape(alpha.shape[0], -1),
        ], axis=1),
    }
    for name, values in result.items():
        expected = ATTRIBUTE_DIMENSIONS[name]
        if values.shape[1] != expected:
            raise AssertionError(f"{name} feature dimension mismatch: {values.shape[1]} != {expected}")
        result[name] = values.astype(np.float32)
    return result


def unpack_residual_features(features: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    position_values = np.asarray(features["position"], dtype=np.float32)
    position_base = position_values[:, :3]
    position_delta = position_values[:, 3:].reshape(position_values.shape[0], 10, 3)

    scale_values = np.asarray(features["scale"], dtype=np.float32)
    scale_base = scale_values[:, :3]
    scale_delta = scale_values[:, 3:].reshape(scale_values.shape[0], 3, 3)

    opacity_values = np.asarray(features["opacity"], dtype=np.float32)
    opacity_base = opacity_values[:, :1]
    opacity_delta = opacity_values[:, 1:].reshape(opacity_values.shape[0], 3, 1)
    alpha = np.concatenate([opacity_base[:, None], opacity_base[:, None] + opacity_delta], axis=1)
    return {
        "position": np.concatenate([
            position_base[:, None],
            position_base[:, None] + position_delta,
        ], axis=1).astype(np.float32),
        "rotation": decode_rotation_features(features["rotation"]),
        "scale": np.concatenate([
            scale_base[:, None],
            scale_base[:, None] + scale_delta,
        ], axis=1).astype(np.float32),
        "opacity": alpha_to_logit(np.clip(alpha, 0, 1)).astype(np.float32),
    }


def train_attribute(
    name: str,
    values: np.ndarray,
    sample_indices: np.ndarray,
) -> AttributeModel:
    #WDD-gpt 2026-08-15 - 每个属性独立归一化和训练码本，防止33D位置能量吞掉旋转与尺度容量。
    center = (
        np.zeros(values.shape[1], dtype=np.float32)
        if name == "opacity"
        else np.median(values, axis=0).astype(np.float32)
    )
    spread = np.percentile(np.abs(values - center), 90, axis=0).astype(np.float32)
    spread = np.maximum(spread, np.float32(1e-6))
    normalized = np.clip((values - center) / spread, -16, 16).astype(np.float32)
    residual = normalized.copy()
    codebooks = np.empty((LEVELS, CLUSTERS, values.shape[1]), dtype=np.float32)
    labels = np.empty((values.shape[0], LEVELS), dtype=np.uint8)
    rmses: list[float] = []
    zero_fractions: list[float] = []
    for level in range(LEVELS):
        codebook, _ = train_codebook(
            residual,
            CLUSTERS,
            20261000 + sum(ord(character) for character in name) + level,
            sample_indices,
            reserve_zero=True,
        )
        #WDD-gpt 2026-08-15 - 标签必须针对实际序列化的FP16码本重新分配，保证独立解码一致。
        codebook = codebook.astype(np.float16).astype(np.float32)
        assigned = assign_codebook(residual, codebook).astype(np.uint8)
        residual -= codebook[assigned]
        codebooks[level] = codebook
        labels[:, level] = assigned
        rmse = float(np.sqrt(np.mean(np.square(residual), dtype=np.float64)))
        zero_fraction = float(np.mean(assigned == 0))
        rmses.append(rmse)
        zero_fractions.append(zero_fraction)
        print(json.dumps({
            "attribute": name,
            "level": level + 1,
            "normalized_rmse": rmse,
            "zero_label_fraction": zero_fraction,
        }), flush=True)
    return AttributeModel(center, spread, codebooks, labels, rmses, zero_fractions)


def decode_model(model: AttributeModel) -> np.ndarray:
    indices = np.arange(LEVELS, dtype=np.int64)[None, :]
    normalized = model.codebooks[indices, model.labels].sum(axis=1, dtype=np.float32)
    return (normalized * model.spread + model.center).astype(np.float32)


def raw_streams(models: dict[str, AttributeModel]) -> dict[str, bytes]:
    streams: dict[str, bytes] = {}
    for name, model in models.items():
        streams[f"{name}_codebooks"] = model.codebooks.astype("<f2").tobytes()
        streams[f"{name}_labels"] = model.labels.tobytes()
    return streams


def build_manifest(
    count: int,
    models: dict[str, AttributeModel],
) -> dict[str, Any]:
    return {
        "format": PROFILE_NAME,
        "version": 1,
        "gaussian_count": count,
        "levels": LEVELS,
        "clusters": CLUSTERS,
        "parameterization": {
            "position": "P0 plus independent Pk-P0 residuals",
            "rotation": "log(q0) plus log(q30*inverse(q0))",
            "scale": "log-scale s0 plus independent sk-s0 residuals",
            "opacity": "alpha a0 plus independent ak-a0 residuals",
        },
        "keyframes": {
            "position": [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30],
            "rotation": [0, 30],
            "scale": [0, 10, 20, 30],
            "opacity": [0, 10, 20, 30],
        },
        "attributes": {
            name: {
                "dimensions": ATTRIBUTE_DIMENSIONS[name],
                "codebook_shape": list(model.codebooks.shape),
                "label_shape": list(model.labels.shape),
                "center": model.center.tolist(),
                "spread": model.spread.tolist(),
                "normalized_rmse_by_level": model.normalized_rmse_by_level,
                "zero_label_fraction_by_level": model.zero_label_fraction_by_level,
            }
            for name, model in models.items()
        },
    }


def decode_archive(path: Path) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    with np.load(path, allow_pickle=False) as archive:
        manifest = json.loads(archive["manifest"].tobytes().decode("utf-8"))
        streams = {
            name: _decompress(archive[name], int(metadata["raw_bytes"]))
            for name, metadata in manifest["streams"].items()
        }
    if manifest.get("format") != PROFILE_NAME:
        raise ValueError("Unsupported CoReAttr-5R archive")
    count = int(manifest["gaussian_count"])
    features: dict[str, np.ndarray] = {}
    for name, metadata in manifest["attributes"].items():
        codebooks = np.frombuffer(streams[f"{name}_codebooks"], dtype="<f2").astype(np.float32)
        codebooks = codebooks.reshape(metadata["codebook_shape"])
        labels = np.frombuffer(streams[f"{name}_labels"], dtype=np.uint8)
        labels = labels.reshape(count, LEVELS)
        indices = np.arange(LEVELS, dtype=np.int64)[None, :]
        normalized = codebooks[indices, labels].sum(axis=1, dtype=np.float32)
        center = np.asarray(metadata["center"], dtype=np.float32)
        spread = np.asarray(metadata["spread"], dtype=np.float32)
        features[name] = (normalized * spread + center).astype(np.float32)
    return manifest, unpack_residual_features(features)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Test CoReSH-style 5R on every non-SH RAW4D attribute")
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--sample-count", type=int, default=65536)
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
    expected_frames = (
        position_frames == [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30]
        and rotation_frames == [0, 30]
        and scale_frames == [0, 10, 20, 30]
        and opacity_frames == [0, 10, 20, 30]
    )
    if not expected_frames:
        raise ValueError("Unexpected non-SH sparse keyframe layout")

    order = spatial_order(positions)
    source = {
        "position": positions[order],
        "rotation": rotations[order],
        "scale": scales[order],
        "opacity": opacities[order],
    }
    features = pack_residual_features(source)
    importance = visibility_importance(source["scale"], source["opacity"])
    probabilities = importance.astype(np.float64)
    probabilities /= np.sum(probabilities)
    rng = np.random.default_rng(20260815)
    sample_indices = rng.choice(
        layout.vertex_count,
        size=min(args.sample_count, layout.vertex_count),
        replace=True,
        p=probabilities,
    )

    training_started = time.perf_counter()
    models = {
        name: train_attribute(name, features[name], sample_indices)
        for name in ATTRIBUTE_DIMENSIONS
    }
    training_seconds = time.perf_counter() - training_started
    manifest = build_manifest(layout.vertex_count, models)
    archive_path = args.output_dir / "coerattr5r_nonsh55.npz"
    encoded_manifest = serialize_archive(archive_path, manifest, raw_streams(models), args.zstd_level)

    encoder_features = {name: decode_model(model) for name, model in models.items()}
    encoder_decoded = unpack_residual_features(encoder_features)
    decode_started = time.perf_counter()
    decoded_manifest, independently_decoded = decode_archive(archive_path)
    decode_seconds = time.perf_counter() - decode_started
    for name in ATTRIBUTE_DIMENSIONS:
        if not np.array_equal(encoder_decoded[name], independently_decoded[name]):
            maximum = float(np.max(np.abs(encoder_decoded[name] - independently_decoded[name])))
            raise AssertionError(f"Independent {name} decode mismatch: {maximum}")

    decoded_raw4d = args.output_dir / "coerattr5r_nonsh_ablation.raw4d"
    write_ablation(args.source, decoded_raw4d, independently_decoded, order)
    raw_nonsh_bytes = int(sum(values.nbytes for values in source.values()))
    report = {
        "profile": PROFILE_NAME,
        "source": str(args.source),
        "source_bytes": args.source.stat().st_size,
        "gaussian_count": layout.vertex_count,
        "scope": {
            "included": list(ATTRIBUTE_DIMENSIONS),
            "excluded_and_copied_for_render": ["color_dc", "f_rest", "lifetime"],
            "raw_nonsh_bytes": raw_nonsh_bytes,
        },
        "archive": str(archive_path),
        "archive_bytes": archive_path.stat().st_size,
        "archive_sha256": sha256_file(archive_path),
        "compression_ratio_vs_raw_nonsh": raw_nonsh_bytes / archive_path.stat().st_size,
        "decoded_raw4d": str(decoded_raw4d),
        "independent_decoder_validated": decoded_manifest["format"] == PROFILE_NAME,
        "numeric_quality": numeric_metrics(source, independently_decoded),
        "attributes": {
            name: {
                "dimensions": ATTRIBUTE_DIMENSIONS[name],
                "codebook_stored_bytes": int(encoded_manifest["streams"][f"{name}_codebooks"]["stored_bytes"]),
                "labels_stored_bytes": int(encoded_manifest["streams"][f"{name}_labels"]["stored_bytes"]),
                "normalized_rmse_by_level": model.normalized_rmse_by_level,
                "zero_label_fraction_by_level": model.zero_label_fraction_by_level,
            }
            for name, model in models.items()
        },
        "streams": encoded_manifest["streams"],
        "rvq_training_seconds": training_seconds,
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
        "rvq_training_seconds": training_seconds,
        "decode_seconds": decode_seconds,
    }, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
