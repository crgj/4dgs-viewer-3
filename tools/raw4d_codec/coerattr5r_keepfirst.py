#!/usr/bin/env python3
"""CoReAttr-5R probe with exact first keys and RVQ temporal residuals."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import numpy as np

from codec import extract_track, load_rows, read_raw4d_layout
from coerattr5r import AttributeModel, LEVELS, decode_model, sha256_file, train_attribute
from mint_like_nonsh35 import (
    _decompress,
    alpha_to_logit,
    canonical_quaternions,
    encode_rotation_features,
    numeric_metrics,
    quaternion_exp,
    quaternion_multiply,
    serialize_archive,
    stable_sigmoid,
    visibility_importance,
    write_ablation,
)


#WDD-gpt 2026-08-15 - 第二轮保留四种非SH属性的首关键帧，只让后续关键帧残差进入五级RVQ。
PROFILE_NAME = "CoReAttr-5R-NONSH-TEMPORAL-KEEP-FIRST"
RESIDUAL_DIMENSIONS = {
    "position": 30,
    "rotation": 3,
    "scale": 9,
    "opacity": 3,
}
BASE_SHAPES = {
    "position": (-1, 3),
    "rotation": (-1, 4),
    "scale": (-1, 3),
    "opacity": (-1, 1),
}


def pack_temporal_residuals(source: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    positions = np.asarray(source["position"], dtype=np.float32)
    rotations = np.asarray(source["rotation"], dtype=np.float32)
    scales = np.clip(np.asarray(source["scale"], dtype=np.float32), -16, 2)
    alpha = stable_sigmoid(np.asarray(source["opacity"], dtype=np.float32))
    residuals = {
        "position": (positions[:, 1:] - positions[:, :1]).reshape(positions.shape[0], -1),
        "rotation": encode_rotation_features(rotations)[:, 3:],
        "scale": (scales[:, 1:] - scales[:, :1]).reshape(scales.shape[0], -1),
        "opacity": (alpha[:, 1:] - alpha[:, :1]).reshape(alpha.shape[0], -1),
    }
    for name, values in residuals.items():
        expected = RESIDUAL_DIMENSIONS[name]
        if values.shape[1] != expected:
            raise AssertionError(f"{name} residual dimension mismatch: {values.shape[1]} != {expected}")
        residuals[name] = values.astype(np.float32)
    return residuals


def first_keyframes(source: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    #WDD-gpt 2026-08-15 - 首关键帧按源float32逐元素保存，禁止其误差传播到后续残差重建。
    return {
        name: np.asarray(values[:, 0], dtype=np.float32).copy()
        for name, values in source.items()
    }


def unpack_temporal_residuals(
    bases: dict[str, np.ndarray],
    residuals: dict[str, np.ndarray],
) -> dict[str, np.ndarray]:
    position_base = np.asarray(bases["position"], dtype=np.float32)
    position_delta = np.asarray(residuals["position"], dtype=np.float32).reshape(-1, 10, 3)

    rotation_base = np.asarray(bases["rotation"], dtype=np.float32)
    rotation_delta = quaternion_exp(np.asarray(residuals["rotation"], dtype=np.float32))
    rotation_second = quaternion_multiply(rotation_delta, canonical_quaternions(rotation_base))

    scale_base = np.asarray(bases["scale"], dtype=np.float32)
    scale_delta = np.asarray(residuals["scale"], dtype=np.float32).reshape(-1, 3, 3)

    opacity_base = np.asarray(bases["opacity"], dtype=np.float32)
    opacity_base_alpha = stable_sigmoid(opacity_base)
    opacity_delta = np.asarray(residuals["opacity"], dtype=np.float32).reshape(-1, 3, 1)
    opacity_future_alpha = np.clip(opacity_base_alpha[:, None] + opacity_delta, 0, 1)
    return {
        "position": np.concatenate([
            position_base[:, None],
            position_base[:, None] + position_delta,
        ], axis=1).astype(np.float32),
        "rotation": np.stack([rotation_base, rotation_second], axis=1).astype(np.float32),
        "scale": np.concatenate([
            scale_base[:, None],
            scale_base[:, None] + scale_delta,
        ], axis=1).astype(np.float32),
        #WDD-gpt 2026-08-15 - opacity首帧保留原始logit含无穷值，只有后续alpha残差转回有限logit。
        "opacity": np.concatenate([
            opacity_base[:, None],
            alpha_to_logit(opacity_future_alpha),
        ], axis=1).astype(np.float32),
    }


def build_manifest(
    count: int,
    models: dict[str, AttributeModel],
) -> dict[str, Any]:
    return {
        "format": PROFILE_NAME,
        "version": 1,
        "gaussian_count": count,
        "levels": LEVELS,
        "clusters": 256,
        "first_keyframe_storage": "exact float32 per attribute",
        "parameterization": {
            "position": "exact P0 plus independent Pk-P0 residuals",
            "rotation": "exact q0 plus log(q30*inverse(q0))",
            "scale": "exact log-scale s0 plus independent sk-s0 residuals",
            "opacity": "exact logit o0 plus independent alpha ak-a0 residuals",
        },
        "keyframes": {
            "position": [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30],
            "rotation": [0, 30],
            "scale": [0, 10, 20, 30],
            "opacity": [0, 10, 20, 30],
        },
        "base_streams": {
            name: {"dtype": "float32", "shape": [count, shape[1]]}
            for name, shape in BASE_SHAPES.items()
        },
        "attributes": {
            name: {
                "dimensions": RESIDUAL_DIMENSIONS[name],
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


def raw_streams(
    bases: dict[str, np.ndarray],
    models: dict[str, AttributeModel],
) -> dict[str, bytes]:
    streams = {
        f"{name}_first": np.asarray(values, dtype="<f4").tobytes()
        for name, values in bases.items()
    }
    for name, model in models.items():
        streams[f"{name}_codebooks"] = model.codebooks.astype("<f2").tobytes()
        streams[f"{name}_labels"] = model.labels.tobytes()
    return streams


def decode_archive(path: Path) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    with np.load(path, allow_pickle=False) as archive:
        manifest = json.loads(archive["manifest"].tobytes().decode("utf-8"))
        streams = {
            name: _decompress(archive[name], int(metadata["raw_bytes"]))
            for name, metadata in manifest["streams"].items()
        }
    if manifest.get("format") != PROFILE_NAME:
        raise ValueError("Unsupported keep-first CoReAttr-5R archive")
    count = int(manifest["gaussian_count"])
    bases = {
        name: np.frombuffer(streams[f"{name}_first"], dtype="<f4").reshape(count, metadata["shape"][1])
        for name, metadata in manifest["base_streams"].items()
    }
    residuals: dict[str, np.ndarray] = {}
    for name, metadata in manifest["attributes"].items():
        codebooks = np.frombuffer(streams[f"{name}_codebooks"], dtype="<f2").astype(np.float32)
        codebooks = codebooks.reshape(metadata["codebook_shape"])
        labels = np.frombuffer(streams[f"{name}_labels"], dtype=np.uint8).reshape(count, LEVELS)
        indices = np.arange(LEVELS, dtype=np.int64)[None, :]
        normalized = codebooks[indices, labels].sum(axis=1, dtype=np.float32)
        center = np.asarray(metadata["center"], dtype=np.float32)
        spread = np.asarray(metadata["spread"], dtype=np.float32)
        residuals[name] = (normalized * spread + center).astype(np.float32)
    return manifest, unpack_temporal_residuals(bases, residuals)


def main() -> None:
    parser = argparse.ArgumentParser(description="Keep first RAW4D keys and CoReAttr-5R encode temporal residuals")
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

    #WDD-gpt 2026-08-15 - 保持源Gaussian顺序，使精确保留的首帧可进行逐像素渲染对照。
    order = np.arange(layout.vertex_count, dtype=np.int64)
    source = {
        "position": positions,
        "rotation": rotations,
        "scale": scales,
        "opacity": opacities,
    }
    bases = first_keyframes(source)
    residuals = pack_temporal_residuals(source)
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
        name: train_attribute(name, residuals[name], sample_indices)
        for name in RESIDUAL_DIMENSIONS
    }
    training_seconds = time.perf_counter() - training_started
    manifest = build_manifest(layout.vertex_count, models)
    archive_path = args.output_dir / "coerattr5r_keepfirst_nonsh55.npz"
    encoded_manifest = serialize_archive(
        archive_path,
        manifest,
        raw_streams(bases, models),
        args.zstd_level,
    )

    encoder_residuals = {name: decode_model(model) for name, model in models.items()}
    encoder_decoded = unpack_temporal_residuals(bases, encoder_residuals)
    decode_started = time.perf_counter()
    decoded_manifest, independently_decoded = decode_archive(archive_path)
    decode_seconds = time.perf_counter() - decode_started
    for name in RESIDUAL_DIMENSIONS:
        left = encoder_decoded[name]
        right = independently_decoded[name]
        equal = np.array_equal(left, right, equal_nan=True)
        if not equal:
            maximum = float(np.nanmax(np.abs(left - right)))
            raise AssertionError(f"Independent {name} decode mismatch: {maximum}")

    decoded_raw4d = args.output_dir / "coerattr5r_keepfirst_nonsh_ablation.raw4d"
    write_ablation(args.source, decoded_raw4d, independently_decoded, order)
    raw_nonsh_bytes = int(sum(values.nbytes for values in source.values()))
    first_keyframe_raw_bytes = int(sum(values.nbytes for values in bases.values()))
    first_keyframe_stored_bytes = int(sum(
        encoded_manifest["streams"][f"{name}_first"]["stored_bytes"]
        for name in bases
    ))
    report = {
        "profile": PROFILE_NAME,
        "source": str(args.source),
        "source_bytes": args.source.stat().st_size,
        "gaussian_count": layout.vertex_count,
        "scope": {
            "included": list(RESIDUAL_DIMENSIONS),
            "excluded_and_copied_for_render": ["color_dc", "f_rest", "lifetime"],
            "raw_nonsh_bytes": raw_nonsh_bytes,
        },
        "archive": str(archive_path),
        "archive_bytes": archive_path.stat().st_size,
        "archive_sha256": sha256_file(archive_path),
        "compression_ratio_vs_raw_nonsh": raw_nonsh_bytes / archive_path.stat().st_size,
        "first_keyframe": {
            "raw_bytes": first_keyframe_raw_bytes,
            "stored_bytes": first_keyframe_stored_bytes,
            "exact_float32": True,
        },
        "decoded_raw4d": str(decoded_raw4d),
        "independent_decoder_validated": decoded_manifest["format"] == PROFILE_NAME,
        "numeric_quality": numeric_metrics(source, independently_decoded),
        "attributes": {
            name: {
                "residual_dimensions": RESIDUAL_DIMENSIONS[name],
                "first_stored_bytes": int(encoded_manifest["streams"][f"{name}_first"]["stored_bytes"]),
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
        "first_keyframe": report["first_keyframe"],
        "numeric_quality": report["numeric_quality"],
        "rvq_training_seconds": training_seconds,
        "decode_seconds": decode_seconds,
    }, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
