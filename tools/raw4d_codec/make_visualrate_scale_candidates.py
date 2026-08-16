#!/usr/bin/env python3
"""Build compact scale-PQ candidates for the VisualRate39 profile."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import quality_attrs  # noqa: E402
from codec import decode_sh_rvq5, read_container, write_decoded_raw4d  # noqa: E402
from compact40 import add_vq_stream, morton_codes  # noqa: E402
from make_hybrid39_rate_candidates import load_tracks, quantized_opacity  # noqa: E402


def encode_scale_pq_residual(
    values: np.ndarray,
    sample_indices: np.ndarray,
    base_clusters: int,
    residual_levels: int,
) -> tuple[np.ndarray, int, dict[str, object]]:
    flat = np.clip(values, -16, 2).reshape(values.shape[0], 12).astype(np.float32)
    decoded = np.empty_like(flat)
    streams: list[object] = []
    groups = ([0, 3, 6, 9], [1, 4, 7, 10], [2, 5, 8, 11])
    for group, indices in enumerate(groups):
        reconstructed, _ = add_vq_stream(
            streams,
            f"visual_scale_base_{group}",
            flat[:, indices],
            base_clusters,
            20260890 + group,
            sample_indices,
            8,
        )
        decoded[:, indices] = reconstructed
    residual = flat - decoded
    for level in range(residual_levels):
        reconstructed, _ = add_vq_stream(
            streams,
            f"visual_scale_residual_{level}",
            residual,
            256,
            20260900 + level,
            sample_indices,
            8,
            reserve_zero=True,
        )
        decoded += reconstructed
        residual -= reconstructed
    relative_error = np.abs(np.expm1(decoded - flat))
    stored_bytes = sum(len(stream.stored) for stream in streams)
    #WDD-gpt 2026-08-15 - 尺度先提炼三轴时间共性，再以少量全轨迹残差码本修正，避免2至4bit标量量化产生光晕。
    return decoded.reshape(values.shape), stored_bytes, {
        "base_clusters": base_clusters,
        "residual_levels": residual_levels,
        "stored_bytes": stored_bytes,
        "mean_relative_error": float(np.mean(relative_error)),
        "p99_relative_error": float(np.percentile(relative_error, 99)),
        "maximum_relative_error": float(np.max(relative_error)),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("container", type=Path)
    parser.add_argument("decoded", type=Path)
    parser.add_argument("p12", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()

    layout, source, source_mu, source_width = load_tracks(args.source)
    _, decoded, _, _ = load_tracks(args.decoded)
    _, p12_tracks, _, _ = load_tracks(args.p12)
    minimum = np.min(source["position"], axis=(0, 1)).astype(np.float32)
    maximum = np.max(source["position"], axis=(0, 1)).astype(np.float32)
    coarse = np.rint(
        (source["position"][:, 0] - minimum) / (maximum - minimum) * 1023
    ).clip(0, 1023).astype(np.uint16)
    morton = morton_codes(coarse)
    global_order = np.argsort(morton, kind="stable")
    alpha = 1 / (1 + np.exp(-np.clip(source["opacity"], -16, 16)))
    radius = np.exp(np.clip(np.max(source["scale"], axis=(1, 2)), -16, 2))
    contribution = np.max(alpha, axis=(1, 2)) * radius
    importance_order = np.argsort(-contribution, kind="stable")
    split = round(layout.vertex_count * 0.6)
    tiers = [importance_order[:split], importance_order[split:]]
    p12_order = np.concatenate([
        selected[np.argsort(morton[selected], kind="stable")] for selected in tiers
    ])
    p12_source = np.empty_like(p12_tracks["position"])
    p12_source[p12_order] = p12_tracks["position"]
    p12_global = p12_source[global_order]
    source = {name: value[global_order] for name, value in source.items()}
    source_mu = source_mu[global_order]
    source_width = source_width[global_order]
    importance = contribution[global_order].astype(np.float32)
    rng = np.random.default_rng(20260815)
    sample_indices = rng.choice(layout.vertex_count, min(layout.vertex_count, 65536), replace=False)

    opacity, opacity_bytes = quantized_opacity(source["opacity"], 9)
    lifetime_streams: list[object] = []
    bounds = np.stack([source_mu - source_width, source_mu + source_width], axis=1)
    lifetime, _ = add_vq_stream(
        lifetime_streams,
        "visual_lifetime_bounds",
        bounds,
        4,
        20260910,
        sample_indices,
        8,
    )
    lifetime_mu = np.mean(lifetime, axis=1)
    lifetime_width = (lifetime[:, 1] - lifetime[:, 0]) * np.float32(0.5)
    lifetime_bytes = sum(len(stream.stored) for stream in lifetime_streams)

    previous_rotation_bits = quality_attrs.ROTATION_BITS
    previous_color_bits = quality_attrs.COLOR_MODE_BITS
    try:
        quality_attrs.ROTATION_BITS = (5, 6, 7, 9)
        rotation_streams: list[object] = []
        rotation, _ = quality_attrs.encode_rotation(
            rotation_streams, source["rotation"], source["scale"], source["opacity"], 8
        )
        quality_attrs.COLOR_MODE_BITS = ((4, 3, 3), (5, 4, 4), (6, 5, 5))
        color_streams: list[object] = []
        color, _ = quality_attrs.encode_color(color_streams, source["color"], importance, 8)
    finally:
        quality_attrs.ROTATION_BITS = previous_rotation_bits
        quality_attrs.COLOR_MODE_BITS = previous_color_bits

    manifest, streams = read_container(args.container)
    sh = decode_sh_rvq5(streams["coresh5r"])
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {
        "opacity_bytes": opacity_bytes,
        "lifetime_bytes": lifetime_bytes,
        "rotation_bytes": sum(len(stream.stored) for stream in rotation_streams),
        "color_bytes": sum(len(stream.stored) for stream in color_streams),
        "candidates": {},
    }
    for base_clusters, residual_levels in ((512, 1), (1024, 1), (1024, 2), (2048, 1)):
        scale, scale_bytes, scale_meta = encode_scale_pq_residual(
            source["scale"], sample_indices, base_clusters, residual_levels
        )
        label = f"p12_scale_pq{base_clusters}_r{residual_levels}_op9_aggressive"
        output = args.output_dir / f"{label}.raw4d"
        write_decoded_raw4d(
            output,
            manifest,
            sh,
            p12_global,
            rotation,
            color,
            scale,
            opacity,
            lifetime_mu,
            lifetime_width,
        )
        report["candidates"][label] = {
            "output": str(output),
            "scale": scale_meta,
            "estimated_non_position_bytes": (
                scale_bytes
                + opacity_bytes
                + lifetime_bytes
                + report["rotation_bytes"]
                + report["color_bytes"]
            ),
        }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
