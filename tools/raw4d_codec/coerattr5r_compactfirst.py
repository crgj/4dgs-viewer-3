#!/usr/bin/env python3
"""Compact-first CoReAttr-5R with LAF positions and predictive residuals."""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path
from typing import Any

import numpy as np

from codec import decode_quaternions, encode_quaternions, extract_track, load_rows, read_raw4d_layout
from coerattr5r import AttributeModel, LEVELS, decode_model, sha256_file, train_attribute
from compact40 import pack_bits, unpack_bits
from learnable_anchor_field import build_anchor_topology, reconstruct_motion
from learnable_anchor_rate_sweep import (
    decode_base,
    decode_candidate,
    decode_field_codec,
    decode_weight_codec,
    decompress as decompress_laf,
    encode_base,
)
from mint_like_nonsh35 import (
    _decompress,
    alpha_to_logit,
    canonical_quaternions,
    numeric_metrics,
    quaternion_conjugate,
    quaternion_exp,
    quaternion_log,
    quaternion_multiply,
    serialize_archive,
    stable_sigmoid,
    visibility_importance,
    write_ablation,
)
from quality_attrs import ROTATION_BITS, _rotation_modes


#WDD-gpt 2026-08-15 - 第三轮用紧凑首帧专用流替换float32，并针对PSNR核心Position复用已验收锚点场修正。
PROFILE_NAME = "CoReAttr-5R-COMPACT-FIRST-LAF-POSITION"
RESIDUAL_DIMENSIONS = {
    "rotation": 3,
    "scale": 9,
    "opacity": 3,
}
MODELED_RESIDUAL_DIMENSIONS = {
    "rotation": 3,
    "scale": 9,
}
#WDD-gpt 2026-08-15 - 全68相机首帧码率扫描确认Scale/Opacity 6 bit通过39 dB，5 bit失败。
SCALE_FIRST_BITS = 6
SCALE_MINIMUM = -16.0
SCALE_MAXIMUM = 2.0
OPACITY_FIRST_BITS = 6


def load_laf(path: Path) -> tuple[dict[str, Any], dict[str, bytes], np.ndarray]:
    with np.load(path, allow_pickle=False) as archive:
        manifest = json.loads(archive["manifest"].tobytes().decode("utf-8"))
        streams = {
            name: decompress_laf(archive[name], int(metadata["raw_bytes"]))
            for name, metadata in manifest["streams"].items()
        }
    _, positions = decode_candidate(path)
    metadata = {
        name: value
        for name, value in manifest.items()
        if name not in {"streams", "archive_bytes", "logical_stored_bytes"}
    }
    return metadata, streams, positions


def decode_laf_positions(manifest: dict[str, Any], streams: dict[str, bytes]) -> np.ndarray:
    count = int(manifest["count"])
    base = decode_base(manifest["base_codec"], streams)
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
    corrections = np.frombuffer(streams["corrections"], dtype="<i2").reshape(-1, 3)
    if corrections.shape[0] != np.count_nonzero(mask):
        raise ValueError("LAF position correction count mismatch")
    motion[mask] += corrections.astype(np.float32) * np.float32(manifest["correction_step"])
    return np.concatenate([base[:, None], base[:, None] + motion], axis=1).astype(np.float32)


def encode_rotation_first(
    rotations: np.ndarray,
    scales: np.ndarray,
    opacities: np.ndarray,
) -> tuple[np.ndarray, dict[str, bytes], dict[str, Any]]:
    modes, thresholds = _rotation_modes(scales, opacities)
    streams = {"rotation_first_modes": pack_bits(modes, 2)}
    decoded = np.empty((rotations.shape[0], 4), dtype=np.float32)
    groups: list[dict[str, int]] = []
    for mode, bits in enumerate(ROTATION_BITS):
        selected = modes == mode
        selected_count = int(np.count_nonzero(selected))
        groups.append({"mode": mode, "bits": bits, "count": selected_count})
        if selected_count == 0:
            continue
        packed, _ = encode_quaternions(rotations[selected, :1], bits)
        streams[f"rotation_first_b{bits}"] = pack_bits(packed, 2 + 3 * bits)
        decoded[selected] = decode_quaternions(packed, (selected_count, 1), bits)[:, 0]
    #WDD-gpt 2026-08-15 - 首帧旋转按贡献度使用smallest-three 6/7/8/10 bit，避免四个float32逐点保存。
    return decoded, streams, {
        "codec": "adaptive-smallest-three-6-7-8-10",
        "mode_bits": 2,
        "groups": groups,
        "thresholds": thresholds,
    }


def decode_rotation_first(
    streams: dict[str, bytes],
    metadata: dict[str, Any],
    count: int,
) -> np.ndarray:
    modes = unpack_bits(streams["rotation_first_modes"], count, int(metadata["mode_bits"]))
    decoded = np.empty((count, 4), dtype=np.float32)
    for group in metadata["groups"]:
        mode = int(group["mode"])
        bits = int(group["bits"])
        selected = modes == mode
        selected_count = int(np.count_nonzero(selected))
        if selected_count != int(group["count"]):
            raise ValueError("Rotation first-frame group count mismatch")
        if selected_count == 0:
            continue
        packed = unpack_bits(
            streams[f"rotation_first_b{bits}"],
            selected_count,
            2 + 3 * bits,
        )
        decoded[selected] = decode_quaternions(packed, (selected_count, 1), bits)[:, 0]
    return decoded


def encode_scale_first(values: np.ndarray) -> tuple[np.ndarray, bytes, dict[str, Any]]:
    clipped = np.clip(np.asarray(values, dtype=np.float32), SCALE_MINIMUM, SCALE_MAXIMUM)
    levels = np.float32((1 << SCALE_FIRST_BITS) - 1)
    step = np.float32((SCALE_MAXIMUM - SCALE_MINIMUM) / levels)
    quantized = np.rint((clipped - np.float32(SCALE_MINIMUM)) / step).clip(0, int(levels)).astype(np.uint16)
    decoded = np.float32(SCALE_MINIMUM) + quantized.astype(np.float32) * step
    return decoded, pack_bits(quantized, SCALE_FIRST_BITS), {
        "codec": "global-log-scale-uniform",
        "bits": SCALE_FIRST_BITS,
        "minimum": SCALE_MINIMUM,
        "maximum": SCALE_MAXIMUM,
        "shape": list(values.shape),
        "maximum_relative_linear_error": float(np.max(np.abs(np.expm1(decoded - clipped)))),
    }


def decode_scale_first(stream: bytes, metadata: dict[str, Any]) -> np.ndarray:
    shape = tuple(int(value) for value in metadata["shape"])
    bits = int(metadata["bits"])
    quantized = unpack_bits(stream, int(np.prod(shape)), bits).reshape(shape)
    levels = np.float32((1 << bits) - 1)
    step = np.float32((float(metadata["maximum"]) - float(metadata["minimum"])) / levels)
    return np.float32(metadata["minimum"]) + quantized.astype(np.float32) * step


def encode_opacity_first(values: np.ndarray) -> tuple[np.ndarray, bytes, dict[str, Any]]:
    alpha = stable_sigmoid(np.asarray(values, dtype=np.float32))
    levels = np.float32((1 << OPACITY_FIRST_BITS) - 1)
    quantized = np.rint(alpha * levels).clip(0, int(levels)).astype(np.uint16)
    decoded = quantized.astype(np.float32) / levels
    return decoded, pack_bits(quantized, OPACITY_FIRST_BITS), {
        "codec": "alpha-uniform",
        "bits": OPACITY_FIRST_BITS,
        "shape": list(values.shape),
        "maximum_alpha_error": float(np.max(np.abs(decoded - alpha))),
    }


def decode_opacity_first(stream: bytes, metadata: dict[str, Any]) -> np.ndarray:
    shape = tuple(int(value) for value in metadata["shape"])
    bits = int(metadata["bits"])
    quantized = unpack_bits(stream, int(np.prod(shape)), bits).reshape(shape)
    return quantized.astype(np.float32) / np.float32((1 << bits) - 1)


def pack_predictive_residuals(
    source: dict[str, np.ndarray],
    rotation_first: np.ndarray,
    scale_first: np.ndarray,
    opacity_first_alpha: np.ndarray,
) -> dict[str, np.ndarray]:
    source_rotation = canonical_quaternions(source["rotation"])
    relative = quaternion_multiply(source_rotation[:, 1], quaternion_conjugate(rotation_first))
    scales = np.clip(source["scale"], SCALE_MINIMUM, SCALE_MAXIMUM)
    alpha = stable_sigmoid(source["opacity"])
    residuals = {
        "rotation": quaternion_log(relative),
        "scale": (scales[:, 1:] - scale_first[:, None]).reshape(scales.shape[0], -1),
        "opacity": (alpha[:, 1:] - opacity_first_alpha[:, None]).reshape(alpha.shape[0], -1),
    }
    for name, values in residuals.items():
        if values.shape[1] != RESIDUAL_DIMENSIONS[name]:
            raise AssertionError(f"{name} predictive residual dimension mismatch")
        residuals[name] = values.astype(np.float32)
    return residuals


def unpack_predictive_residuals(
    positions: np.ndarray,
    rotation_first: np.ndarray,
    scale_first: np.ndarray,
    opacity_first_alpha: np.ndarray,
    residuals: dict[str, np.ndarray],
) -> dict[str, np.ndarray]:
    rotation_delta = quaternion_exp(residuals["rotation"])
    rotation_second = quaternion_multiply(rotation_delta, rotation_first)
    scale_delta = residuals["scale"].reshape(-1, 3, 3)
    opacity_delta = residuals["opacity"].reshape(-1, 3, 1)
    opacity_alpha = np.concatenate([
        opacity_first_alpha[:, None],
        np.clip(opacity_first_alpha[:, None] + opacity_delta, 0, 1),
    ], axis=1)
    return {
        "position": positions.astype(np.float32),
        "rotation": np.stack([rotation_first, rotation_second], axis=1).astype(np.float32),
        "scale": np.concatenate([
            scale_first[:, None],
            scale_first[:, None] + scale_delta,
        ], axis=1).astype(np.float32),
        "opacity": alpha_to_logit(opacity_alpha).astype(np.float32),
    }


def restore_opacity_negative_infinity(
    decoded_opacity: np.ndarray,
    negative_infinity_mask: np.ndarray,
) -> np.ndarray:
    result = np.asarray(decoded_opacity, dtype=np.float32).copy()
    mask = np.asarray(negative_infinity_mask, dtype=bool)
    if result.shape != mask.shape:
        raise ValueError(f"Opacity -inf mask shape mismatch: {mask.shape} != {result.shape}")
    result[mask] = -np.inf
    return result


def encode_scale_repairs(
    source_scale: np.ndarray,
    decoded_scale: np.ndarray,
    importance: np.ndarray,
    repair_count: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, Any]]:
    target = np.clip(np.asarray(source_scale, dtype=np.float32), SCALE_MINIMUM, SCALE_MAXIMUM)
    repaired = np.asarray(decoded_scale, dtype=np.float32).copy()
    error = target[:, 1:] - repaired[:, 1:]
    node_shape = error.shape[:2]
    count = min(max(int(repair_count), 0), int(np.prod(node_shape)))
    mask = np.zeros(node_shape, dtype=bool)
    if count:
        node_importance = np.asarray(importance, dtype=np.float32)
        if node_importance.ndim == 1:
            node_importance = node_importance[:, None]
        if node_importance.shape not in {(node_shape[0], 1), node_shape}:
            raise ValueError(f"Scale repair importance shape mismatch: {node_importance.shape}")
        score = np.max(np.abs(error), axis=2) * node_importance
        selected = np.argpartition(score.reshape(-1), -count)[-count:]
        mask.reshape(-1)[selected] = True
    corrections = error[mask].astype(np.float16)
    repaired_later = repaired[:, 1:]
    repaired_later[mask] += corrections.astype(np.float32)
    remaining = np.abs(np.expm1(repaired - target))
    #WDD-gpt 2026-08-15 - Scale继续使用固定5R主码流，仅对高可见度大误差节点写稀疏FP16闭环补丁。
    metadata = {
        "codec": "visibility-weighted-sparse-fp16-log-scale-correction",
        "node_shape": list(node_shape),
        "count": count,
        "fraction": float(np.mean(mask)),
        "score": "max_abs_log_error_times_per_keyframe_projected_area_importance",
        "remaining_relative_linear_p99": float(np.percentile(remaining, 99)),
        "remaining_relative_linear_maximum": float(np.max(remaining)),
    }
    return repaired, mask, corrections, metadata


def scale_render_importance(scales: np.ndarray, opacities: np.ndarray) -> np.ndarray:
    later_scales = np.sort(
        np.clip(np.asarray(scales, dtype=np.float32)[:, 1:], SCALE_MINIMUM, SCALE_MAXIMUM),
        axis=2,
    )
    projected_area = np.exp(later_scales[..., -1] + later_scales[..., -2])
    alpha = stable_sigmoid(
        np.nan_to_num(np.asarray(opacities, dtype=np.float32)[:, 1:, 0], neginf=-16.0)
    )
    #WDD-gpt 2026-08-15 - 尺度补丁按逐帧alpha与椭球投影面积排序，修复数值尾差漏掉的大屏幕PSNR核心高斯。
    importance = alpha * projected_area
    positive = importance[importance > 0]
    reference = float(np.median(positive)) if positive.size else 1.0
    return (importance / max(reference, 1e-12)).astype(np.float32)


def build_manifest(
    count: int,
    laf_manifest: dict[str, Any],
    rotation_meta: dict[str, Any],
    scale_meta: dict[str, Any],
    opacity_keyframes: np.ndarray,
    models: dict[str, AttributeModel],
    scale_repair_meta: dict[str, Any] | None,
) -> dict[str, Any]:
    manifest = {
        "format": PROFILE_NAME,
        "version": 4,
        "gaussian_count": count,
        "position_laf": laf_manifest,
        "first_keyframes": {
            "position": "LAF Morton 10-bit plus int8 correction",
            "rotation": rotation_meta,
            "scale": scale_meta,
            "opacity": {
                "codec": "lossless-native-fp16-sparse-keyframes",
                "shape": list(opacity_keyframes.shape),
            },
        },
        "residual_reference": "each temporal key references the decoded first key",
        "attributes": {
            name: {
                "dimensions": RESIDUAL_DIMENSIONS[name],
                "codebook_shape": list(model.codebooks.shape),
                "center": model.center.tolist(),
                "spread": model.spread.tolist(),
                "normalized_rmse_by_level": model.normalized_rmse_by_level,
                "zero_label_fraction_by_level": model.zero_label_fraction_by_level,
            }
            for name, model in models.items()
        },
    }
    if scale_repair_meta and int(scale_repair_meta["count"]):
        manifest["scale_repair"] = scale_repair_meta
    return manifest


def build_streams(
    laf_streams: dict[str, bytes],
    rotation_streams: dict[str, bytes],
    scale_stream: bytes,
    opacity_keyframes: np.ndarray,
    models: dict[str, AttributeModel],
    scale_repair_mask: np.ndarray,
    scale_repair_values: np.ndarray,
) -> dict[str, bytes]:
    streams = {f"laf_{name}": payload for name, payload in laf_streams.items()}
    streams.update(rotation_streams)
    streams["scale_first"] = scale_stream
    streams["opacity_keyframes_fp16"] = opacity_keyframes.astype("<f2").tobytes()
    for name, model in models.items():
        streams[f"{name}_codebooks"] = model.codebooks.astype("<f2").tobytes()
        streams[f"{name}_labels"] = model.labels.tobytes()
    if scale_repair_values.size:
        streams["scale_repair_mask"] = np.packbits(
            scale_repair_mask.reshape(-1), bitorder="little"
        ).tobytes()
        streams["scale_repair_values"] = scale_repair_values.astype("<f2").tobytes()
    return streams


def decode_archive(path: Path) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    with np.load(path, allow_pickle=False) as archive:
        manifest = json.loads(archive["manifest"].tobytes().decode("utf-8"))
        streams = {
            name: _decompress(archive[name], int(metadata["raw_bytes"]))
            for name, metadata in manifest["streams"].items()
        }
    if manifest.get("format") != PROFILE_NAME:
        raise ValueError("Unsupported compact-first CoReAttr-5R archive")
    count = int(manifest["gaussian_count"])
    laf_streams = {
        name.removeprefix("laf_"): payload
        for name, payload in streams.items()
        if name.startswith("laf_")
    }
    positions = decode_laf_positions(manifest["position_laf"], laf_streams)
    first_meta = manifest["first_keyframes"]
    rotation_first = decode_rotation_first(streams, first_meta["rotation"], count)
    scale_first = decode_scale_first(streams["scale_first"], first_meta["scale"])
    opacity_meta = first_meta["opacity"]
    lossless_opacity = opacity_meta.get("codec") == "lossless-native-fp16-sparse-keyframes"
    if lossless_opacity:
        opacity_shape = tuple(int(value) for value in opacity_meta["shape"])
        opacity_exact = np.frombuffer(streams["opacity_keyframes_fp16"], dtype="<f2").astype(np.float32)
        opacity_exact = opacity_exact.reshape(opacity_shape)
        opacity_first = stable_sigmoid(opacity_exact[:, 0])
    else:
        opacity_exact = None
        opacity_first = decode_opacity_first(streams["opacity_first"], opacity_meta)
    residuals: dict[str, np.ndarray] = {}
    for name, metadata in manifest["attributes"].items():
        codebooks = np.frombuffer(streams[f"{name}_codebooks"], dtype="<f2").astype(np.float32)
        codebooks = codebooks.reshape(metadata["codebook_shape"])
        labels = np.frombuffer(streams[f"{name}_labels"], dtype=np.uint8).reshape(count, LEVELS)
        normalized = codebooks[np.arange(LEVELS)[None, :], labels].sum(axis=1, dtype=np.float32)
        center = np.asarray(metadata["center"], dtype=np.float32)
        spread = np.asarray(metadata["spread"], dtype=np.float32)
        residuals[name] = (normalized * spread + center).astype(np.float32)
    if "opacity" not in residuals:
        residuals["opacity"] = np.zeros((count, RESIDUAL_DIMENSIONS["opacity"]), dtype=np.float32)
    decoded = unpack_predictive_residuals(
        positions,
        rotation_first,
        scale_first,
        opacity_first,
        residuals,
    )
    if opacity_exact is not None:
        decoded["opacity"] = opacity_exact
    opacity_infinity_meta = manifest.get("opacity_negative_infinity")
    if opacity_infinity_meta:
        infinity_shape = tuple(int(value) for value in opacity_infinity_meta["shape"])
        infinity_count = int(np.prod(infinity_shape))
        infinity_mask = np.unpackbits(
            np.frombuffer(streams["opacity_negative_infinity_mask"], dtype=np.uint8),
            bitorder="little",
        )[:infinity_count].astype(bool).reshape(infinity_shape)
        if int(np.count_nonzero(infinity_mask)) != int(opacity_infinity_meta["count"]):
            raise ValueError("Opacity -inf stream count does not match its manifest")
        decoded["opacity"] = restore_opacity_negative_infinity(decoded["opacity"], infinity_mask)
    repair_meta = manifest.get("scale_repair")
    if repair_meta:
        node_shape = tuple(int(value) for value in repair_meta["node_shape"])
        node_count = int(np.prod(node_shape))
        mask = np.unpackbits(
            np.frombuffer(streams["scale_repair_mask"], dtype=np.uint8),
            bitorder="little",
        )[:node_count].astype(bool).reshape(node_shape)
        corrections = np.frombuffer(streams["scale_repair_values"], dtype="<f2").astype(np.float32)
        corrections = corrections.reshape(-1, 3)
        if corrections.shape[0] != np.count_nonzero(mask):
            raise ValueError("Scale repair stream does not match its mask")
        decoded_later = decoded["scale"][:, 1:]
        decoded_later[mask] += corrections
    return manifest, decoded


def main() -> None:
    parser = argparse.ArgumentParser(description="Compact first keys and solve CoReAttr position quality")
    parser.add_argument("source", type=Path)
    parser.add_argument("position_laf", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--sample-count", type=int, default=65536)
    parser.add_argument("--scale-repair-count", type=int, default=0)
    parser.add_argument("--zstd-level", type=int, default=8)
    args = parser.parse_args()

    started = time.perf_counter()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    layout = read_raw4d_layout(args.source)
    rows = load_rows(layout)
    source_unsorted = {
        "position": extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))[0],
        "rotation": extract_track(rows, layout, "rot_bank", ("w", "x", "y", "z"))[0],
        "scale": extract_track(rows, layout, "scale_bank", ("0", "1", "2"))[0],
        "opacity": extract_track(rows, layout, "opacity_bank", ("",))[0],
    }
    laf_manifest, laf_streams, laf_positions = load_laf(args.position_laf)
    regenerated = encode_base(
        source_unsorted["position"],
        float(laf_manifest["base_codec"]["correction_ratio"]),
    )
    if not np.array_equal(regenerated.decoded, laf_positions[:, 0]):
        raise AssertionError("Position LAF does not match source Morton base")
    order = regenerated.order
    source = {name: values[order] for name, values in source_unsorted.items()}

    rotation_first, rotation_streams, rotation_meta = encode_rotation_first(
        source["rotation"], source["scale"], source["opacity"]
    )
    scale_first, scale_stream, scale_meta = encode_scale_first(source["scale"][:, 0])
    opacity_first = stable_sigmoid(source["opacity"][:, 0])
    residuals = pack_predictive_residuals(source, rotation_first, scale_first, opacity_first)
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
        for name in MODELED_RESIDUAL_DIMENSIONS
    }
    training_seconds = time.perf_counter() - training_started
    decoded_residuals = {name: decode_model(model) for name, model in models.items()}
    decoded_residuals["opacity"] = np.zeros_like(residuals["opacity"])
    encoder_decoded = unpack_predictive_residuals(
        laf_positions,
        rotation_first,
        scale_first,
        opacity_first,
        decoded_residuals,
    )
    opacity_keyframes = source["opacity"].astype(np.float16).astype(np.float32)
    #WDD-gpt 2026-08-15 - Opacity的logit插值对低alpha量化尾差敏感，改存四个原生FP16稀疏关键帧并删除冗余5R标签。
    encoder_decoded["opacity"] = opacity_keyframes
    repaired_scale, scale_repair_mask, scale_repair_values, scale_repair_meta = encode_scale_repairs(
        source["scale"],
        encoder_decoded["scale"],
        scale_render_importance(source["scale"], source["opacity"]),
        args.scale_repair_count,
    )
    encoder_decoded["scale"] = repaired_scale
    manifest = build_manifest(
        layout.vertex_count,
        laf_manifest,
        rotation_meta,
        scale_meta,
        opacity_keyframes,
        models,
        scale_repair_meta,
    )
    archive_path = args.output_dir / "coerattr5r_compactfirst_nonsh.npz"
    encoded_manifest = serialize_archive(
        archive_path,
        manifest,
        build_streams(
            laf_streams,
            rotation_streams,
            scale_stream,
            opacity_keyframes,
            models,
            scale_repair_mask,
            scale_repair_values,
        ),
        args.zstd_level,
    )
    decode_started = time.perf_counter()
    decoded_manifest, independently_decoded = decode_archive(archive_path)
    decode_seconds = time.perf_counter() - decode_started
    for name in encoder_decoded:
        if not np.array_equal(encoder_decoded[name], independently_decoded[name], equal_nan=True):
            maximum = float(np.nanmax(np.abs(encoder_decoded[name] - independently_decoded[name])))
            raise AssertionError(f"Independent {name} decode mismatch: {maximum}")
    decoded_raw4d = args.output_dir / "coerattr5r_compactfirst_nonsh_ablation.raw4d"
    write_ablation(args.source, decoded_raw4d, independently_decoded, order)

    first_stream_names = [
        "laf_base_morton_delta",
        "laf_base_correction",
        "rotation_first_modes",
        *[f"rotation_first_b{bits}" for bits in ROTATION_BITS if f"rotation_first_b{bits}" in encoded_manifest["streams"]],
        "scale_first",
    ]
    first_stored_bytes = int(sum(encoded_manifest["streams"][name]["stored_bytes"] for name in first_stream_names))
    position_stored_bytes = int(sum(
        metadata["stored_bytes"]
        for name, metadata in encoded_manifest["streams"].items()
        if name.startswith("laf_")
    ))
    raw_nonsh_bytes = int(sum(values.nbytes for values in source.values()))
    report = {
        "profile": PROFILE_NAME,
        "source": str(args.source),
        "position_laf_source": str(args.position_laf),
        "gaussian_count": layout.vertex_count,
        "scope": {
            "included": ["position", "rotation", "scale", "opacity"],
            "excluded_and_copied_for_render": ["color_dc", "f_rest", "lifetime"],
            "raw_nonsh_bytes": raw_nonsh_bytes,
        },
        "archive": str(archive_path),
        "archive_bytes": archive_path.stat().st_size,
        "archive_sha256": sha256_file(archive_path),
        "compression_ratio_vs_raw_nonsh": raw_nonsh_bytes / archive_path.stat().st_size,
        "first_keyframe_stored_bytes": first_stored_bytes,
        "position_total_stored_bytes": position_stored_bytes,
        "scale_repair": scale_repair_meta,
        "decoded_raw4d": str(decoded_raw4d),
        "independent_decoder_validated": decoded_manifest["format"] == PROFILE_NAME,
        "numeric_quality": numeric_metrics(source, independently_decoded),
        "attributes": {
            name: {
                "codebook_stored_bytes": int(encoded_manifest["streams"][f"{name}_codebooks"]["stored_bytes"]),
                "labels_stored_bytes": int(encoded_manifest["streams"][f"{name}_labels"]["stored_bytes"]),
                "normalized_rmse_by_level": model.normalized_rmse_by_level,
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
        "first_keyframe_stored_bytes": first_stored_bytes,
        "position_total_stored_bytes": position_stored_bytes,
        "numeric_quality": report["numeric_quality"],
        "training_seconds": training_seconds,
        "decode_seconds": decode_seconds,
    }, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
