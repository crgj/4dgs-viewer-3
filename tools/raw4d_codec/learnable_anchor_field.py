#!/usr/bin/env python3
"""Evaluate a learnable anchor deformation field for sparse RAW4D XYZ tracks."""

from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
import zstandard as zstd
from scipy.spatial import cKDTree

from codec import (
    extract_track,
    load_rows,
    property_indices,
    read_raw4d_layout,
    write_decoded_raw4d,
)
from compact40 import morton_codes, pack_bits, unpack_bits


#WDD-gpt 2026-08-15 - 固定测试口径，评估每点静态五权重与可学习锚点平移场的真实码率和残差。
MODEL_NAME = "LearnableAnchorField-StaticK"
DEFAULT_ANCHOR_FRACTION = 0.05
DEFAULT_NEIGHBORS = 5
DEFAULT_CORRECTION_RATIO = 0.00028


@dataclass(frozen=True)
class AnchorTopology:
    anchors: np.ndarray
    neighbors: np.ndarray
    morton_order: np.ndarray


def vector_metrics(prediction: np.ndarray, target: np.ndarray) -> dict[str, float]:
    difference = np.asarray(prediction, dtype=np.float32) - np.asarray(target, dtype=np.float32)
    vector_error = np.linalg.norm(difference, axis=2)
    return {
        "coordinate_rmse": float(np.sqrt(np.mean(np.square(difference), dtype=np.float64))),
        "vector_mean": float(np.mean(vector_error)),
        "vector_p95": float(np.percentile(vector_error, 95)),
        "vector_p99": float(np.percentile(vector_error, 99)),
        "vector_maximum": float(np.max(vector_error)),
        "track_maximum_p99": float(np.percentile(np.max(vector_error, axis=1), 99)),
    }


def build_anchor_topology(
    base: np.ndarray,
    anchor_fraction: float,
    neighbors: int,
) -> AnchorTopology:
    base = np.asarray(base, dtype=np.float32)
    if base.ndim != 2 or base.shape[1] != 3:
        raise ValueError(f"Expected base XYZ with shape [N,3], found {base.shape}")
    count = base.shape[0]
    anchor_count = int(round(count * anchor_fraction))
    if anchor_count < neighbors:
        raise ValueError("Anchor count must be at least the requested neighbor count")
    if not 0 < anchor_fraction < 1:
        raise ValueError("anchor_fraction must be between zero and one")

    minimum = np.min(base, axis=0)
    maximum = np.max(base, axis=0)
    extent = np.maximum(maximum - minimum, np.float32(1e-12))
    quantized = np.rint((base - minimum) / extent * np.float32(1023)).clip(0, 1023).astype(np.uint16)
    morton_order = np.argsort(morton_codes(quantized), kind="stable")

    #WDD-gpt 2026-08-15 - 用等容量Morton空间簇选择真实medoid，避免14K中心全量KMeans的不可控开销。
    anchors = np.empty(anchor_count, dtype=np.int64)
    boundaries = np.rint(np.linspace(0, count, anchor_count + 1)).astype(np.int64)
    for cluster in range(anchor_count):
        indices = morton_order[boundaries[cluster]:boundaries[cluster + 1]]
        if indices.size == 0:
            raise AssertionError("Morton anchor cluster unexpectedly became empty")
        center = np.mean(base[indices], axis=0)
        anchors[cluster] = indices[np.argmin(np.sum(np.square(base[indices] - center), axis=1))]

    tree = cKDTree(base[anchors])
    nearest = tree.query(base, k=neighbors, workers=-1)[1]
    nearest = np.asarray(nearest, dtype=np.int64).reshape(count, neighbors)
    return AnchorTopology(anchors=anchors, neighbors=nearest, morton_order=morton_order)


def reconstruct_motion(
    weights: np.ndarray,
    field: np.ndarray,
    neighbors: np.ndarray,
    chunk_rows: int = 65536,
) -> np.ndarray:
    weights = np.asarray(weights, dtype=np.float32)
    field = np.asarray(field, dtype=np.float32)
    neighbors = np.asarray(neighbors, dtype=np.int64)
    output = np.empty((weights.shape[0], field.shape[1], 3), dtype=np.float32)
    for first in range(0, weights.shape[0], chunk_rows):
        last = min(first + chunk_rows, weights.shape[0])
        output[first:last] = np.einsum(
            "nk,nktc->ntc",
            weights[first:last],
            field[neighbors[first:last]],
            optimize=True,
        )
    return output


def solve_static_weights(
    target_motion: np.ndarray,
    field: np.ndarray,
    neighbors: np.ndarray,
    ridge: float,
) -> np.ndarray:
    count = target_motion.shape[0]
    design = field[neighbors].reshape(count, neighbors.shape[1], -1).astype(np.float32)
    target = target_motion.reshape(count, -1).astype(np.float32)
    gram = np.einsum("nki,nli->nkl", design, design, optimize=True)
    right = np.einsum("nki,ni->nk", design, target, optimize=True)
    diagonal = np.maximum(
        np.trace(gram, axis1=1, axis2=2) / np.float32(neighbors.shape[1]),
        np.float32(1e-10),
    )
    gram[:, np.arange(neighbors.shape[1]), np.arange(neighbors.shape[1])] += diagonal[:, None] * ridge
    return np.linalg.solve(gram, right).astype(np.float32)


def train_joint_translation_field(
    target_motion: np.ndarray,
    neighbors: np.ndarray,
    initial_weights: np.ndarray,
    initial_field: np.ndarray,
    steps: int,
    weight_learning_rate: float,
    field_learning_rate: float,
    weight_regularization: float,
    field_regularization: float,
    device_name: str,
) -> tuple[np.ndarray, np.ndarray, list[dict[str, float]], float]:
    if device_name == "auto":
        device_name = "cuda" if torch.cuda.is_available() else "cpu"
    device = torch.device(device_name)
    torch.manual_seed(20260815)
    target = torch.from_numpy(np.asarray(target_motion, dtype=np.float32)).to(device)
    neighbor_tensor = torch.from_numpy(np.asarray(neighbors, dtype=np.int64)).to(device)
    weights = torch.nn.Parameter(torch.from_numpy(np.asarray(initial_weights, dtype=np.float32)).to(device))
    field = torch.nn.Parameter(torch.from_numpy(np.asarray(initial_field, dtype=np.float32)).to(device))
    initial_field_tensor = field.detach().clone()
    optimizer = torch.optim.Adam([
        {"params": [weights], "lr": weight_learning_rate},
        {"params": [field], "lr": field_learning_rate},
    ])
    history: list[dict[str, float]] = []
    checkpoints = {0, steps}
    checkpoints.update(int(round(steps * fraction)) for fraction in (0.25, 0.5, 0.75))

    def record(step: int, loss: float | None = None) -> None:
        with torch.no_grad():
            prediction = torch.sum(field[neighbor_tensor] * weights[:, :, None, None], dim=1)
            difference = prediction - target
            vector_error = torch.linalg.vector_norm(difference, dim=2).reshape(-1)
            entry = {
                "step": int(step),
                "coordinate_rmse": float(torch.sqrt(torch.mean(torch.square(difference).double())).cpu()),
                "vector_mean": float(torch.mean(vector_error).cpu()),
                "vector_p99": float(torch.quantile(vector_error, 0.99).cpu()),
                "vector_maximum": float(torch.max(vector_error).cpu()),
            }
            if loss is not None:
                entry["loss"] = float(loss)
            history.append(entry)
            print(json.dumps(entry), flush=True)

    started = time.perf_counter()
    record(0)
    for step in range(1, steps + 1):
        prediction = torch.sum(field[neighbor_tensor] * weights[:, :, None, None], dim=1)
        reconstruction_loss = torch.mean(torch.square(prediction - target))
        loss = (
            reconstruction_loss
            + weight_regularization * torch.mean(torch.square(weights))
            + field_regularization * torch.mean(torch.square(field - initial_field_tensor))
        )
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_([weights, field], max_norm=10.0)
        optimizer.step()
        if step in checkpoints:
            record(step, float(loss.detach().cpu()))
    elapsed = time.perf_counter() - started
    return (
        weights.detach().cpu().numpy().astype(np.float32),
        field.detach().cpu().numpy().astype(np.float32),
        history,
        elapsed,
    )


def _compress(raw: bytes, level: int) -> bytes:
    return zstd.ZstdCompressor(level=level, threads=0).compress(raw)


def _decompress(payload: np.ndarray, raw_bytes: int) -> bytes:
    return zstd.ZstdDecompressor().decompress(payload.tobytes(), max_output_size=raw_bytes)


def _linear_quantize_field(field: np.ndarray, bits: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    minimum = np.min(field, axis=0).astype(np.float32)
    maximum = np.max(field, axis=0).astype(np.float32)
    levels = np.float32((1 << bits) - 1)
    scale = np.where(maximum > minimum, (maximum - minimum) / levels, np.float32(1.0))
    quantized = np.rint((field - minimum) / scale).clip(0, int(levels)).astype(np.uint16)
    return quantized, minimum, maximum


def _linear_dequantize_field(
    quantized: np.ndarray,
    minimum: np.ndarray,
    maximum: np.ndarray,
    bits: int,
) -> np.ndarray:
    levels = np.float32((1 << bits) - 1)
    scale = np.where(maximum > minimum, (maximum - minimum) / levels, np.float32(0.0))
    return minimum + np.asarray(quantized, dtype=np.float32) * scale


def encode_probe_archive(
    output: Path,
    base: np.ndarray,
    topology: AnchorTopology,
    weights: np.ndarray,
    field: np.ndarray,
    target_motion: np.ndarray,
    frames: list[int],
    weight_bits: int,
    field_bits: int,
    weight_clip_percentile: float,
    correction_ratio: float,
    zstd_level: int,
) -> tuple[dict[str, Any], np.ndarray]:
    count, keys_minus_one, _ = target_motion.shape
    weight_cap = float(np.percentile(np.abs(weights), weight_clip_percentile))
    weight_cap = max(weight_cap, 1e-8)
    weight_levels = (1 << weight_bits) - 1
    weight_q = np.rint(
        (np.clip(weights, -weight_cap, weight_cap) + weight_cap)
        / (2 * weight_cap)
        * weight_levels
    ).clip(0, weight_levels).astype(np.uint16)
    decoded_weights = weight_q.astype(np.float32) / np.float32(weight_levels) * (2 * weight_cap) - weight_cap

    field_q, field_minimum, field_maximum = _linear_quantize_field(field, field_bits)
    decoded_field = _linear_dequantize_field(field_q, field_minimum, field_maximum, field_bits)
    reconstructed = reconstruct_motion(decoded_weights, decoded_field, topology.neighbors)
    error_before = target_motion - reconstructed

    scene_minimum = np.min(base[:, None, :] + np.concatenate([
        np.zeros((count, 1, 3), dtype=np.float32), target_motion,
    ], axis=1), axis=(0, 1))
    scene_maximum = np.max(base[:, None, :] + np.concatenate([
        np.zeros((count, 1, 3), dtype=np.float32), target_motion,
    ], axis=1), axis=(0, 1))
    scene_diagonal = float(np.linalg.norm(scene_maximum - scene_minimum))
    correction_target = scene_diagonal * correction_ratio
    correction_step = correction_target / (2 * math.sqrt(3))
    node_error = np.linalg.norm(error_before, axis=2)
    correction_mask = node_error > correction_target * 0.5
    correction_q = np.rint(error_before[correction_mask] / correction_step)
    if correction_q.size and np.max(np.abs(correction_q)) > np.iinfo(np.int16).max:
        raise ValueError("Anchor-field residual exceeds int16 range")
    correction_q = correction_q.astype("<i2")
    reconstructed[correction_mask] += correction_q.astype(np.float32) * correction_step

    raw_streams = {
        "base": np.asarray(base, dtype="<f4").tobytes(),
        "anchors": np.asarray(topology.anchors, dtype="<u4").tobytes(),
        "neighbors": np.asarray(topology.neighbors, dtype="<u2").tobytes(),
        "weights": pack_bits(weight_q, weight_bits),
        "field": pack_bits(field_q, field_bits),
        "correction_mask": np.packbits(correction_mask.reshape(-1), bitorder="little").tobytes(),
        "corrections": correction_q.tobytes(),
    }
    stored_streams = {name: _compress(raw, zstd_level) for name, raw in raw_streams.items()}
    manifest: dict[str, Any] = {
        "format": "LAF-PROBE",
        "version": 1,
        "model_name": MODEL_NAME,
        "count": count,
        "frames": frames,
        "neighbors_per_point": int(topology.neighbors.shape[1]),
        "anchor_count": int(topology.anchors.size),
        "weight_shape": list(weight_q.shape),
        "weight_bits": weight_bits,
        "weight_cap": weight_cap,
        "weight_clip_percentile": weight_clip_percentile,
        "field_shape": list(field_q.shape),
        "field_bits": field_bits,
        "field_minimum": field_minimum.tolist(),
        "field_maximum": field_maximum.tolist(),
        "correction_ratio": correction_ratio,
        "correction_step": correction_step,
        "correction_count": int(np.count_nonzero(correction_mask)),
        "correction_fraction": float(np.mean(correction_mask)),
        "scene_diagonal": scene_diagonal,
        "streams": {
            name: {"raw_bytes": len(raw_streams[name]), "stored_bytes": len(payload)}
            for name, payload in stored_streams.items()
        },
        "metrics_before_correction": vector_metrics(
            reconstruct_motion(decoded_weights, decoded_field, topology.neighbors),
            target_motion,
        ),
        "metrics_after_correction": vector_metrics(reconstructed, target_motion),
    }
    manifest_bytes = json.dumps(manifest, separators=(",", ":")).encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    archive = {"manifest": np.frombuffer(manifest_bytes, dtype=np.uint8)}
    archive.update({name: np.frombuffer(payload, dtype=np.uint8) for name, payload in stored_streams.items()})
    np.savez(output, **archive)
    manifest["archive_bytes"] = output.stat().st_size
    manifest["logical_stored_bytes"] = sum(len(payload) for payload in stored_streams.values())
    return manifest, reconstructed


def decode_probe_archive(path: Path) -> tuple[dict[str, Any], np.ndarray]:
    with np.load(path, allow_pickle=False) as archive:
        manifest = json.loads(archive["manifest"].tobytes().decode("utf-8"))
        streams = {
            name: _decompress(archive[name], int(metadata["raw_bytes"]))
            for name, metadata in manifest["streams"].items()
        }
    count = int(manifest["count"])
    base = np.frombuffer(streams["base"], dtype="<f4").reshape(count, 3)
    neighbors = np.frombuffer(streams["neighbors"], dtype="<u2").reshape(
        count, int(manifest["neighbors_per_point"])
    )
    weight_shape = tuple(int(value) for value in manifest["weight_shape"])
    weight_q = unpack_bits(streams["weights"], int(np.prod(weight_shape)), int(manifest["weight_bits"]))
    weight_q = weight_q.reshape(weight_shape)
    weight_levels = np.float32((1 << int(manifest["weight_bits"])) - 1)
    weight_cap = np.float32(manifest["weight_cap"])
    weights = weight_q.astype(np.float32) / weight_levels * (2 * weight_cap) - weight_cap

    field_shape = tuple(int(value) for value in manifest["field_shape"])
    field_q = unpack_bits(streams["field"], int(np.prod(field_shape)), int(manifest["field_bits"]))
    field_q = field_q.reshape(field_shape)
    field = _linear_dequantize_field(
        field_q,
        np.asarray(manifest["field_minimum"], dtype=np.float32),
        np.asarray(manifest["field_maximum"], dtype=np.float32),
        int(manifest["field_bits"]),
    )
    motion = reconstruct_motion(weights, field, neighbors)
    node_count = count * (len(manifest["frames"]) - 1)
    mask = np.unpackbits(
        np.frombuffer(streams["correction_mask"], dtype=np.uint8),
        bitorder="little",
    )[:node_count].astype(bool).reshape(count, -1)
    corrections = np.frombuffer(streams["corrections"], dtype="<i2").reshape(-1, 3)
    if corrections.shape[0] != np.count_nonzero(mask):
        raise ValueError("Serialized correction count does not match the mask")
    motion[mask] += corrections.astype(np.float32) * np.float32(manifest["correction_step"])
    positions = np.concatenate([base[:, None, :], base[:, None, :] + motion], axis=1)
    return manifest, positions


def write_position_ablation(source: Path, output: Path, decoded_positions: np.ndarray) -> None:
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
        output, manifest, sh, decoded_positions, rotations, colors, scales, opacities, mu, width
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Train and evaluate a learnable RAW4D anchor field")
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--anchor-fraction", type=float, default=DEFAULT_ANCHOR_FRACTION)
    parser.add_argument("--neighbors", type=int, default=DEFAULT_NEIGHBORS)
    parser.add_argument("--steps", type=int, default=120)
    parser.add_argument("--ridge", type=float, default=1e-4)
    parser.add_argument("--weight-learning-rate", type=float, default=8e-3)
    parser.add_argument("--field-learning-rate", type=float, default=2e-3)
    parser.add_argument("--weight-regularization", type=float, default=1e-8)
    parser.add_argument("--field-regularization", type=float, default=1e-7)
    parser.add_argument("--weight-bits", type=int, default=10)
    parser.add_argument("--field-bits", type=int, default=14)
    parser.add_argument("--weight-clip-percentile", type=float, default=99.9)
    parser.add_argument("--correction-ratio", type=float, default=DEFAULT_CORRECTION_RATIO)
    parser.add_argument("--zstd-level", type=int, default=8)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--skip-raw4d", action="store_true")
    args = parser.parse_args()

    started = time.perf_counter()
    layout = read_raw4d_layout(args.source)
    rows = load_rows(layout)
    positions, frames = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    base = positions[:, 0].copy()
    target_motion = (positions[:, 1:] - positions[:, :1]).astype(np.float32)

    topology_started = time.perf_counter()
    topology = build_anchor_topology(base, args.anchor_fraction, args.neighbors)
    topology_seconds = time.perf_counter() - topology_started
    initial_field = target_motion[topology.anchors].copy()
    initialization_started = time.perf_counter()
    initial_weights = solve_static_weights(target_motion, initial_field, topology.neighbors, args.ridge)
    initialization_seconds = time.perf_counter() - initialization_started
    initial_prediction = reconstruct_motion(initial_weights, initial_field, topology.neighbors)

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
    trained_prediction = reconstruct_motion(weights, field, topology.neighbors)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = args.output_dir / "learnable_anchor_field.npz"
    encode_started = time.perf_counter()
    archive_manifest, encoder_motion = encode_probe_archive(
        archive_path,
        base,
        topology,
        weights,
        field,
        target_motion,
        frames,
        args.weight_bits,
        args.field_bits,
        args.weight_clip_percentile,
        args.correction_ratio,
        args.zstd_level,
    )
    encode_seconds = time.perf_counter() - encode_started
    decode_started = time.perf_counter()
    decoded_manifest, decoded_positions = decode_probe_archive(archive_path)
    decode_seconds = time.perf_counter() - decode_started
    encoder_positions = np.concatenate([base[:, None, :], base[:, None, :] + encoder_motion], axis=1)
    if not np.array_equal(decoded_positions, encoder_positions):
        maximum = float(np.max(np.abs(decoded_positions - encoder_positions)))
        raise AssertionError(f"Serialized decoder differs from encoder reconstruction: max={maximum}")

    raw4d_path = args.output_dir / "position_ablation.raw4d"
    if not args.skip_raw4d:
        write_position_ablation(args.source, raw4d_path, decoded_positions)

    report = {
        "model_name": MODEL_NAME,
        "source": str(args.source),
        "source_bytes": args.source.stat().st_size,
        "gaussian_count": layout.vertex_count,
        "position_keyframes": frames,
        "uncompressed_xyz_bytes": int(positions.nbytes),
        "anchor_fraction": args.anchor_fraction,
        "anchor_count": int(topology.anchors.size),
        "neighbors_per_point": args.neighbors,
        "static_weight_count": int(weights.size),
        "learnable_field_scalar_count": int(field.size),
        "parameter_count": int(weights.size + field.size),
        "metrics": {
            "initial_fixed_field": vector_metrics(initial_prediction, target_motion),
            "trained_float": vector_metrics(trained_prediction, target_motion),
            "serialized_before_correction": archive_manifest["metrics_before_correction"],
            "serialized_after_correction": archive_manifest["metrics_after_correction"],
        },
        "training_history": history,
        "archive": {
            "path": str(archive_path),
            "bytes": archive_path.stat().st_size,
            "logical_stored_bytes": archive_manifest["logical_stored_bytes"],
            "compression_ratio_vs_uncompressed_xyz": positions.nbytes / archive_path.stat().st_size,
            "streams": archive_manifest["streams"],
            "correction_count": archive_manifest["correction_count"],
            "correction_fraction": archive_manifest["correction_fraction"],
            "correction_step": archive_manifest["correction_step"],
        },
        "decoded_raw4d": None if args.skip_raw4d else str(raw4d_path),
        "timing_seconds": {
            "topology": topology_seconds,
            "weight_initialization": initialization_seconds,
            "training": training_seconds,
            "archive_encode": encode_seconds,
            "archive_decode": decode_seconds,
            "total": time.perf_counter() - started,
        },
    }
    report_path = args.output_dir / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
