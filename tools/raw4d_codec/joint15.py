#!/usr/bin/env python3
"""Joint shared-codebook codec for connected RAW4D segments."""

from __future__ import annotations

import argparse
import json
import math
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.cluster import MiniBatchKMeans

from codec import (
    compress_stream,
    decode_sh_rvq5,
    encode_sh_rvq5,
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
from compact40 import (
    assign_codebook,
    canonical_rotations,
    decode_unsigned_varints,
    encode_unsigned_varints,
    morton_codes,
    morton_xyz,
    pack_bits,
    unpack_bits,
)


#WDD-gpt 2026-08-15 - 六个相连GOP联合共享所有码本，去除逐段重复模型，同时保留段内独立随机访问和跨段birth/death。
PROFILE_NAME = "CoRe4D-Joint15-SharedCodebooks"
PROFILE_VERSION = 1
SEGMENT_PATTERN = re.compile(r"^segment_(\d+)_(\d+)\.raw4d$")
POSITION_LEVELS = 4
POSITION_CLUSTERS = 256
ROTATION_CLUSTERS = 2048
COLOR_CLUSTERS = 64
SCALE_CLUSTERS = 4096
OPACITY_CLUSTERS = 256
LIFETIME_CLUSTERS = 4
TRAINING_SAMPLES = 65536


@dataclass
class SegmentArrays:
    path: Path
    first_frame: int
    last_frame: int
    total_frames: int
    source_bytes: int
    source_sha256: str
    count: int
    position_frames: list[int]
    rotation_frames: list[int]
    color_frames: list[int]
    scale_frames: list[int]
    opacity_frames: list[int]
    minimum: np.ndarray
    maximum: np.ndarray
    morton_deltas: bytes
    position: np.ndarray
    rotation: np.ndarray
    color: np.ndarray
    scale: np.ndarray
    opacity: np.ndarray
    lifetime_bounds: np.ndarray
    sh: np.ndarray


def parse_range(path: Path) -> tuple[int, int]:
    match = SEGMENT_PATTERN.fullmatch(path.name)
    if match is None:
        raise ValueError(f"Unexpected segment filename: {path.name}")
    first, last = (int(value) for value in match.groups())
    if last < first:
        raise ValueError(f"Invalid segment range: {path.name}")
    return first, last


def sigmoid(values: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-np.clip(values, -16, 16)))


def load_segment(path: Path) -> SegmentArrays:
    first, last = parse_range(path)
    layout = read_raw4d_layout(path)
    if layout.total_frames != last - first + 1:
        raise ValueError(f"Filename/header frame mismatch: {path.name}")
    rows = load_rows(layout)
    position, position_frames = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    rotation, rotation_frames = extract_track(rows, layout, "rot_bank", ("w", "x", "y", "z"))
    color, color_frames = extract_track(rows, layout, "f_dc_bank", ("0", "1", "2"))
    scale, scale_frames = extract_track(rows, layout, "scale_bank", ("0", "1", "2"))
    opacity, opacity_frames = extract_track(rows, layout, "opacity_bank", ("",))
    mu = np.asarray(rows[:, property_indices(layout, ["lifetime_mu"])[0]], dtype=np.float32)
    width = np.asarray(rows[:, property_indices(layout, ["lifetime_w"])[0]], dtype=np.float32)
    sh = np.asarray(
        rows[:, property_indices(layout, [f"f_rest_{index}" for index in range(45)])],
        dtype=np.float32,
    )
    minimum = np.min(position, axis=(0, 1)).astype(np.float32)
    maximum = np.max(position, axis=(0, 1)).astype(np.float32)
    scale_xyz = np.where(maximum > minimum, (maximum - minimum) / np.float32(1023), np.float32(1))
    #WDD-gpt 2026-08-15 - Morton量化严格复用除法式，避免FP16边界因代数改写而发生行错配。
    q0 = np.rint((position[:, 0] - minimum) / scale_xyz).clip(0, 1023).astype(np.uint16)
    morton = morton_codes(q0)
    order = np.argsort(morton, kind="stable")
    morton_sorted = morton[order]
    deltas = np.empty(layout.vertex_count, dtype=np.uint32)
    deltas[0] = morton_sorted[0]
    deltas[1:] = morton_sorted[1:] - morton_sorted[:-1]
    return SegmentArrays(
        path=path,
        first_frame=first,
        last_frame=last,
        total_frames=layout.total_frames,
        source_bytes=path.stat().st_size,
        source_sha256=sha256_file(path),
        count=layout.vertex_count,
        position_frames=position_frames,
        rotation_frames=rotation_frames,
        color_frames=color_frames,
        scale_frames=scale_frames,
        opacity_frames=opacity_frames,
        minimum=minimum,
        maximum=maximum,
        morton_deltas=encode_unsigned_varints(deltas),
        position=np.ascontiguousarray(position[order]),
        rotation=np.ascontiguousarray(rotation[order]),
        color=np.ascontiguousarray(color[order]),
        scale=np.ascontiguousarray(scale[order]),
        opacity=np.ascontiguousarray(opacity[order]),
        lifetime_bounds=np.ascontiguousarray(np.stack([mu - width, mu + width], axis=1)[order]),
        sh=np.ascontiguousarray(sh[order]),
    )


def validate_timeline(segments: list[SegmentArrays]) -> None:
    if not segments:
        raise ValueError("No RAW4D segments found")
    for previous, current in zip(segments, segments[1:]):
        if previous.last_frame != current.first_frame:
            raise ValueError(
                f"Segments must share one boundary frame: {previous.path.name} -> {current.path.name}"
            )


def sample_rows(values: list[np.ndarray], seed: int) -> np.ndarray:
    total = sum(array.shape[0] for array in values)
    rng = np.random.default_rng(seed)
    samples: list[np.ndarray] = []
    remaining = TRAINING_SAMPLES
    for index, array in enumerate(values):
        if index == len(values) - 1:
            selected_count = min(array.shape[0], remaining)
        else:
            selected_count = min(
                array.shape[0],
                max(1, int(round(TRAINING_SAMPLES * array.shape[0] / total))),
            )
        selected = rng.choice(array.shape[0], size=selected_count, replace=False)
        samples.append(np.asarray(array[selected], dtype=np.float32))
        remaining -= selected_count
    return np.concatenate(samples, axis=0)


def train_centers(
    samples: np.ndarray,
    clusters: int,
    seed: int,
    reserve_zero: bool = False,
) -> np.ndarray:
    trained_clusters = clusters - 1 if reserve_zero else clusters
    model = MiniBatchKMeans(
        n_clusters=trained_clusters,
        random_state=seed,
        batch_size=4096,
        max_iter=60,
        n_init=1,
        reassignment_ratio=0.005,
    )
    model.fit(samples)
    centers = model.cluster_centers_.astype(np.float16).astype(np.float32)
    if reserve_zero:
        centers = np.concatenate([np.zeros((1, samples.shape[1]), dtype=np.float32), centers], axis=0)
    return centers


def train_shared_vq(
    values: list[np.ndarray],
    clusters: int,
    seed: int,
    reserve_zero: bool = False,
) -> tuple[np.ndarray, list[np.ndarray], list[np.ndarray]]:
    samples = sample_rows(values, seed)
    centers = train_centers(samples, clusters, seed, reserve_zero)
    labels = [assign_codebook(array, centers) for array in values]
    decoded = [centers[index] for index in labels]
    return centers, labels, decoded


def train_shared_position(
    values: list[np.ndarray],
) -> tuple[np.ndarray, list[np.ndarray], list[np.ndarray]]:
    residuals = [np.asarray(array, dtype=np.float32).copy() for array in values]
    sample_residual = sample_rows(residuals, 20260840)
    codebooks: list[np.ndarray] = []
    label_sets = [np.empty((array.shape[0], POSITION_LEVELS), dtype=np.uint8) for array in values]
    reconstructed = [np.zeros_like(array, dtype=np.float32) for array in values]
    for level in range(POSITION_LEVELS):
        centers = train_centers(sample_residual, POSITION_CLUSTERS, 20260840 + level, True)
        codebooks.append(centers)
        sample_labels = assign_codebook(sample_residual, centers)
        sample_residual -= centers[sample_labels]
        for segment_index, residual in enumerate(residuals):
            labels = assign_codebook(residual, centers).astype(np.uint8)
            label_sets[segment_index][:, level] = labels
            reconstructed[segment_index] += centers[labels]
            residual -= centers[labels]
    return np.stack(codebooks), label_sets, reconstructed


def labels_stream(
    streams: list[Any],
    name: str,
    labels: list[np.ndarray],
    bits: int,
    zstd_level: int,
) -> None:
    joined = np.concatenate([array.reshape(-1) for array in labels])
    payload = joined.astype(np.uint8).tobytes() if bits == 8 else pack_bits(joined, bits)
    streams.append(compress_stream(name, payload, zstd_level))


def error_metrics(source: list[np.ndarray], decoded: list[np.ndarray]) -> dict[str, float]:
    maximum = 0.0
    square_sum = 0.0
    value_count = 0
    for original, reconstructed in zip(source, decoded):
        difference = np.asarray(reconstructed, dtype=np.float32) - np.asarray(original, dtype=np.float32)
        maximum = max(maximum, float(np.max(np.abs(difference))))
        square_sum += float(np.sum(np.square(difference), dtype=np.float64))
        value_count += difference.size
    return {
        "rmse": math.sqrt(square_sum / value_count),
        "maximum_absolute_error": maximum,
    }


def encode(source_dir: Path, output: Path, zstd_level: int) -> dict[str, Any]:
    started = time.perf_counter()
    paths = sorted(source_dir.glob("segment_*.raw4d"), key=parse_range)
    segments = [load_segment(path) for path in paths]
    validate_timeline(segments)
    counts = [segment.count for segment in segments]
    streams: list[Any] = []
    for index, segment in enumerate(segments):
        streams.append(compress_stream(f"s{index}_position_base_morton_delta", segment.morton_deltas, zstd_level))

    position_values = [
        (segment.position[:, 1:] - segment.position[:, :1]).reshape(segment.count, -1)
        for segment in segments
    ]
    position_books, position_labels, position_decoded = train_shared_position(position_values)
    streams.append(compress_stream("position_codebooks", position_books.astype("<f2").tobytes(), zstd_level))
    labels_stream(streams, "position_labels", position_labels, 8, zstd_level)

    rotation_values = [canonical_rotations(segment.rotation).reshape(segment.count, -1) for segment in segments]
    rotation_book, rotation_labels, rotation_decoded_flat = train_shared_vq(
        rotation_values, ROTATION_CLUSTERS, 20260851
    )
    rotation_decoded = [canonical_rotations(array.reshape(segment.count, 2, 4)) for array, segment in zip(rotation_decoded_flat, segments)]
    streams.append(compress_stream("rotation_codebook", rotation_book.astype("<f2").tobytes(), zstd_level))
    labels_stream(streams, "rotation_labels", rotation_labels, 11, zstd_level)

    color_values = [segment.color.reshape(segment.count, -1) for segment in segments]
    color_book, color_labels, color_decoded_flat = train_shared_vq(color_values, COLOR_CLUSTERS, 20260852)
    color_decoded = [array.reshape(segment.count, 2, 3) for array, segment in zip(color_decoded_flat, segments)]
    streams.append(compress_stream("color_codebook", color_book.astype("<f2").tobytes(), zstd_level))
    labels_stream(streams, "color_labels", color_labels, 6, zstd_level)

    scale_source = [np.clip(segment.scale, -16, 2).reshape(segment.count, 12) for segment in segments]
    scale_decoded_flat = [np.empty_like(array) for array in scale_source]
    scale_groups: list[dict[str, Any]] = []
    for group, indices in enumerate(([0, 3, 6, 9], [1, 4, 7, 10], [2, 5, 8, 11])):
        group_values = [array[:, indices] for array in scale_source]
        book, labels, decoded = train_shared_vq(group_values, SCALE_CLUSTERS, 20260860 + group)
        streams.append(compress_stream(f"scale_codebook_{group}", book.astype("<f2").tobytes(), zstd_level))
        labels_stream(streams, f"scale_labels_{group}", labels, 12, zstd_level)
        for output_values, group_decoded in zip(scale_decoded_flat, decoded):
            output_values[:, indices] = group_decoded
        scale_groups.append({"indices": list(indices), "codebook_shape": list(book.shape)})
    scale_decoded = [array.reshape(segment.count, 4, 3) for array, segment in zip(scale_decoded_flat, segments)]

    opacity_values = [
        np.clip(np.nan_to_num(segment.opacity, neginf=-16), -16, 16).reshape(segment.count, 4)
        for segment in segments
    ]
    opacity_book, opacity_labels, opacity_decoded_flat = train_shared_vq(
        opacity_values, OPACITY_CLUSTERS, 20260870
    )
    opacity_decoded = [array.reshape(segment.count, 4, 1) for array, segment in zip(opacity_decoded_flat, segments)]
    streams.append(compress_stream("opacity_codebook", opacity_book.astype("<f2").tobytes(), zstd_level))
    labels_stream(streams, "opacity_labels", opacity_labels, 8, zstd_level)

    lifetime_values = [segment.lifetime_bounds for segment in segments]
    lifetime_book, lifetime_labels, lifetime_decoded = train_shared_vq(
        lifetime_values, LIFETIME_CLUSTERS, 20260871
    )
    streams.append(compress_stream("lifetime_codebook", lifetime_book.astype("<f2").tobytes(), zstd_level))
    labels_stream(streams, "lifetime_labels", lifetime_labels, 2, zstd_level)

    #WDD-gpt 2026-08-15 - CoReSH-5R在全部Gaussian上只训练和保存一套五级码本，标签按各GOP的Morton顺序连续熵编码。
    sh_source = np.concatenate([segment.sh for segment in segments], axis=0)
    sh_payload = encode_sh_rvq5(sh_source, seed=20260880)
    sh_decoded = decode_sh_rvq5(sh_payload)
    streams.append(compress_stream("coresh5r", sh_payload, zstd_level, compression="raw"))

    segment_metadata: list[dict[str, Any]] = []
    offset = 0
    for index, segment in enumerate(segments):
        segment_metadata.append({
            "index": index,
            "name": segment.path.stem,
            "source_name": segment.path.name,
            "source_bytes": segment.source_bytes,
            "source_sha256": segment.source_sha256,
            "gaussian_count": segment.count,
            "gaussian_offset": offset,
            "global_start_frame": segment.first_frame,
            "global_end_frame": segment.last_frame,
            "total_frames": segment.total_frames,
            "identity_mode": "segment-local-with-birth-death",
            "position": {
                "keyframes": segment.position_frames,
                "minimum": segment.minimum.tolist(),
                "maximum": segment.maximum.tolist(),
                "base_bits": 10,
            },
            "rotation_keyframes": segment.rotation_frames,
            "color_keyframes": segment.color_frames,
            "scale_keyframes": segment.scale_frames,
            "opacity_keyframes": segment.opacity_frames,
        })
        offset += segment.count

    position_source_tracks = [segment.position for segment in segments]
    position_reconstructed_tracks: list[np.ndarray] = []
    for segment, motion in zip(segments, position_decoded):
        scale_xyz = np.where(
            segment.maximum > segment.minimum,
            (segment.maximum - segment.minimum) / np.float32(1023),
            np.float32(0),
        )
        morton = np.cumsum(
            decode_unsigned_varints(segment.morton_deltas, segment.count).astype(np.uint64),
            dtype=np.uint64,
        ).astype(np.uint32)
        base = segment.minimum + morton_xyz(morton).astype(np.float32) * scale_xyz
        position_reconstructed_tracks.append(np.concatenate([
            base[:, None, :],
            base[:, None, :] + motion.reshape(segment.count, len(segment.position_frames) - 1, 3),
        ], axis=1))

    manifest: dict[str, Any] = {
        "format": "4CGS",
        "version": PROFILE_VERSION,
        "codec_name": PROFILE_NAME,
        "source_bytes": sum(segment.source_bytes for segment in segments),
        "gaussian_instances": sum(counts),
        "gaussian_pruning": False,
        "timeline": {
            "global_start_frame": segments[0].first_frame,
            "global_end_frame": segments[-1].last_frame,
            "unique_frame_count": segments[-1].last_frame - segments[0].first_frame + 1,
            "overlapped_boundary_count": len(segments) - 1,
            "boundary_anchor_policy": "use-previous-segment-endpoint",
        },
        "identity_contract": {
            "row_ids_persist_within_gop_only": True,
            "cross_gop_births_and_deaths_allowed": True,
            "cross_gop_row_prediction": False,
        },
        "segments": segment_metadata,
        "attributes": {
            "position": {
                "codec": "shared-four-stage-residual-trajectory-vq",
                "levels": POSITION_LEVELS,
                "clusters": POSITION_CLUSTERS,
                "dimensions": 30,
                "codebook_shape": list(position_books.shape),
                **error_metrics(position_source_tracks, position_reconstructed_tracks),
            },
            "rotation": {
                "codec": "shared-quaternion-pair-vq",
                "clusters": ROTATION_CLUSTERS,
                "bits": 11,
                "codebook_shape": list(rotation_book.shape),
                **error_metrics([segment.rotation for segment in segments], rotation_decoded),
            },
            "color_dc": {
                "codec": "shared-dc-pair-vq",
                "clusters": COLOR_CLUSTERS,
                "bits": 6,
                "codebook_shape": list(color_book.shape),
                **error_metrics([segment.color for segment in segments], color_decoded),
            },
            "scale": {
                "codec": "shared-axis-track-pq",
                "clusters": SCALE_CLUSTERS,
                "bits": 12,
                "groups": scale_groups,
                "clamp": [-16, 2],
                **error_metrics([segment.scale for segment in segments], scale_decoded),
            },
            "opacity": {
                "codec": "shared-opacity-track-vq",
                "clusters": OPACITY_CLUSTERS,
                "bits": 8,
                "codebook_shape": list(opacity_book.shape),
                **error_metrics(opacity_values, [array.reshape(segment.count, 4) for array, segment in zip(opacity_decoded, segments)]),
            },
            "lifetime": {
                "codec": "shared-lifetime-bound-vq",
                "clusters": LIFETIME_CLUSTERS,
                "bits": 2,
                "codebook_shape": list(lifetime_book.shape),
                **error_metrics(lifetime_values, lifetime_decoded),
            },
            "sh": {
                "codec": "CoReSH-5R-shared-all-gops",
                "shape": [sum(counts), 45],
                **error_metrics([sh_source], [sh_decoded]),
            },
        },
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    write_container(output, manifest, streams)
    decoded_manifest, _ = read_container(output)
    result = dict(decoded_manifest)
    result["container_bytes"] = output.stat().st_size
    result["compression_ratio_vs_source_raw4d"] = int(result["source_bytes"]) / output.stat().st_size
    result["measured_encode_seconds"] = time.perf_counter() - started
    result["serialized_container_validated"] = True
    return result


def split_labels(
    stream: bytes,
    counts: list[int],
    bits: int,
    values_per_gaussian: int = 1,
) -> list[np.ndarray]:
    total = sum(counts) * values_per_gaussian
    joined = (
        np.frombuffer(stream, dtype=np.uint8, count=total).astype(np.uint32)
        if bits == 8 else unpack_bits(stream, total, bits)
    )
    result: list[np.ndarray] = []
    offset = 0
    for count in counts:
        size = count * values_per_gaussian
        result.append(joined[offset:offset + size])
        offset += size
    return result


def decode(source: Path, output_dir: Path) -> dict[str, Any]:
    started = time.perf_counter()
    manifest, streams = read_container(source)
    if manifest.get("codec_name") != PROFILE_NAME:
        raise ValueError(f"Not a {PROFILE_NAME} file")
    segments = manifest["segments"]
    counts = [int(segment["gaussian_count"]) for segment in segments]
    position_meta = manifest["attributes"]["position"]
    position_books = np.frombuffer(streams["position_codebooks"], dtype="<f2").astype(np.float32)
    position_books = position_books.reshape(position_meta["codebook_shape"])
    position_labels = split_labels(streams["position_labels"], counts, 8, int(position_meta["levels"]))

    rotation_meta = manifest["attributes"]["rotation"]
    rotation_book = np.frombuffer(streams["rotation_codebook"], dtype="<f2").astype(np.float32)
    rotation_book = rotation_book.reshape(rotation_meta["codebook_shape"])
    rotation_labels = split_labels(streams["rotation_labels"], counts, int(rotation_meta["bits"]))

    color_meta = manifest["attributes"]["color_dc"]
    color_book = np.frombuffer(streams["color_codebook"], dtype="<f2").astype(np.float32)
    color_book = color_book.reshape(color_meta["codebook_shape"])
    color_labels = split_labels(streams["color_labels"], counts, int(color_meta["bits"]))

    scale_meta = manifest["attributes"]["scale"]
    scale_books = [
        np.frombuffer(streams[f"scale_codebook_{group}"], dtype="<f2").astype(np.float32).reshape(item["codebook_shape"])
        for group, item in enumerate(scale_meta["groups"])
    ]
    scale_labels = [
        split_labels(streams[f"scale_labels_{group}"], counts, int(scale_meta["bits"]))
        for group in range(len(scale_meta["groups"]))
    ]

    opacity_meta = manifest["attributes"]["opacity"]
    opacity_book = np.frombuffer(streams["opacity_codebook"], dtype="<f2").astype(np.float32)
    opacity_book = opacity_book.reshape(opacity_meta["codebook_shape"])
    opacity_labels = split_labels(streams["opacity_labels"], counts, int(opacity_meta["bits"]))

    lifetime_meta = manifest["attributes"]["lifetime"]
    lifetime_book = np.frombuffer(streams["lifetime_codebook"], dtype="<f2").astype(np.float32)
    lifetime_book = lifetime_book.reshape(lifetime_meta["codebook_shape"])
    lifetime_labels = split_labels(streams["lifetime_labels"], counts, int(lifetime_meta["bits"]))
    sh = decode_sh_rvq5(streams["coresh5r"])

    output_dir.mkdir(parents=True, exist_ok=True)
    outputs: list[dict[str, Any]] = []
    sh_offset = 0
    for index, segment in enumerate(segments):
        count = counts[index]
        position_segment = segment["position"]
        deltas = decode_unsigned_varints(streams[f"s{index}_position_base_morton_delta"], count)
        morton = np.cumsum(deltas.astype(np.uint64), dtype=np.uint64).astype(np.uint32)
        minimum = np.asarray(position_segment["minimum"], dtype=np.float32)
        maximum = np.asarray(position_segment["maximum"], dtype=np.float32)
        scale_xyz = np.where(maximum > minimum, (maximum - minimum) / np.float32(1023), np.float32(0))
        base = minimum + morton_xyz(morton).astype(np.float32) * scale_xyz
        labels = position_labels[index].reshape(count, int(position_meta["levels"])).astype(np.int64)
        motion = position_books[np.arange(int(position_meta["levels"]))[None, :], labels].sum(axis=1)
        keys = len(position_segment["keyframes"])
        position = np.concatenate([
            base[:, None, :],
            base[:, None, :] + motion.reshape(count, keys - 1, 3),
        ], axis=1)
        rotation = normalize_quaternions(rotation_book[rotation_labels[index]].reshape(count, 2, 4))
        color = color_book[color_labels[index]].reshape(count, 2, 3)
        scale_flat = np.empty((count, 12), dtype=np.float32)
        for group, group_meta in enumerate(scale_meta["groups"]):
            scale_flat[:, group_meta["indices"]] = scale_books[group][scale_labels[group][index]]
        scale = scale_flat.reshape(count, 4, 3)
        opacity = opacity_book[opacity_labels[index]].reshape(count, 4, 1)
        lifetime = lifetime_book[lifetime_labels[index]]
        mu = np.mean(lifetime, axis=1)
        width = (lifetime[:, 1] - lifetime[:, 0]) * np.float32(0.5)
        segment_sh = sh[sh_offset:sh_offset + count]
        sh_offset += count
        raw_manifest = {
            "gaussian_count": count,
            "total_frames": int(segment["total_frames"]),
            "attributes": {
                "position": {"keyframes": position_segment["keyframes"]},
                "rotation": {"keyframes": segment["rotation_keyframes"]},
                "color_dc": {"keyframes": segment["color_keyframes"]},
                "scale": {"keyframes": segment["scale_keyframes"]},
                "opacity": {"keyframes": segment["opacity_keyframes"]},
            },
        }
        output = output_dir / f"{segment['name']}.decoded.raw4d"
        write_decoded_raw4d(
            output, raw_manifest, segment_sh, position, rotation, color, scale, opacity, mu, width
        )
        outputs.append({
            "segment": segment["name"],
            "decoded_raw4d": str(output),
            "decoded_bytes": output.stat().st_size,
            "gaussian_count": count,
            "total_frames": int(segment["total_frames"]),
        })
    if sh_offset != sh.shape[0]:
        raise ValueError("Unused CoReSH rows after segment decode")
    return {
        "source": str(source),
        "output_dir": str(output_dir),
        "segments": outputs,
        "container_checksums_validated": True,
        "measured_decode_seconds": time.perf_counter() - started,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Joint connected-segment 15x 4CGS codec")
    subparsers = parser.add_subparsers(dest="command", required=True)
    encode_parser = subparsers.add_parser("encode")
    encode_parser.add_argument("source_dir", type=Path)
    encode_parser.add_argument("output", type=Path)
    encode_parser.add_argument("--zstd-level", type=int, default=19)
    decode_parser = subparsers.add_parser("decode")
    decode_parser.add_argument("source", type=Path)
    decode_parser.add_argument("output_dir", type=Path)
    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("source", type=Path)
    args = parser.parse_args()
    if args.command == "encode":
        if args.output.suffix.lower() != ".4cgs":
            raise ValueError("Output must use the .4cgs suffix")
        result = encode(args.source_dir, args.output, args.zstd_level)
    elif args.command == "decode":
        result = decode(args.source, args.output_dir)
    else:
        result, _ = read_container(args.source)
        result = dict(result)
        result["container_bytes"] = args.source.stat().st_size
        result["compression_ratio_vs_source_raw4d"] = int(result["source_bytes"]) / args.source.stat().st_size
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
