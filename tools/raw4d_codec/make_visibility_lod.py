#!/usr/bin/env python3
"""Create native-scalar RAW4D visibility-LOD candidates without modifying sources."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

from codec import extract_track, load_rows, read_raw4d_layout
from mint_like_nonsh35 import stable_sigmoid


def visibility_score(scales: np.ndarray, opacities: np.ndarray) -> np.ndarray:
    ordered_scale = np.sort(np.clip(np.asarray(scales, dtype=np.float32), -16, 2), axis=2)
    projected_area = np.exp(ordered_scale[..., -1] + ordered_scale[..., -2])
    alpha = stable_sigmoid(np.nan_to_num(np.asarray(opacities, dtype=np.float32)[..., 0], neginf=-16.0))
    return np.max(alpha * projected_area, axis=1).astype(np.float32)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_native_subset(source: Path, output: Path, selected: np.ndarray) -> None:
    layout = read_raw4d_layout(source)
    header = source.read_bytes()[:layout.header_bytes]
    old = f"element vertex {layout.vertex_count}".encode("ascii")
    new = f"element vertex {selected.size}".encode("ascii")
    if old not in header:
        raise ValueError("RAW4D header does not contain its vertex count")
    header = header.replace(old, new, 1)
    row_bytes = len(layout.properties) * layout.scalar_bytes
    payload = np.memmap(
        source,
        mode="r",
        dtype=np.uint8,
        offset=layout.header_bytes,
        shape=(layout.vertex_count, row_bytes),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        handle.write(header)
        handle.write(np.ascontiguousarray(payload[selected]).tobytes())


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a visibility-ranked native RAW4D LOD candidate")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--keep-fraction", type=float, required=True)
    args = parser.parse_args()
    if not 0 < args.keep_fraction <= 1:
        raise ValueError("--keep-fraction must be in (0, 1]")

    layout = read_raw4d_layout(args.source)
    rows = load_rows(layout)
    scales = extract_track(rows, layout, "scale_bank", ("0", "1", "2"))[0]
    opacities = extract_track(rows, layout, "opacity_bank", ("",))[0]
    score = visibility_score(scales, opacities)
    keep_count = max(1, int(round(layout.vertex_count * args.keep_fraction)))
    ranked = np.argpartition(score, -keep_count)[-keep_count:]
    selected = np.sort(ranked.astype(np.int64))
    #WDD-gpt 2026-08-15 - 仅生成可逆实验LOD产物，按全关键帧最大alpha与投影面积保留高贡献Gaussian。
    write_native_subset(args.source, args.output, selected)
    report = {
        "source": str(args.source),
        "output": str(args.output),
        "source_gaussians": layout.vertex_count,
        "kept_gaussians": int(selected.size),
        "keep_fraction": float(selected.size / layout.vertex_count),
        "minimum_kept_score": float(np.min(score[selected])),
        "maximum_removed_score": float(np.max(np.delete(score, selected))) if selected.size < score.size else None,
        "output_bytes": args.output.stat().st_size,
        "output_sha256": sha256_file(args.output),
    }
    report_path = args.output.with_suffix(args.output.suffix + ".json")
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
