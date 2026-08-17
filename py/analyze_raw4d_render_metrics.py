#!/usr/bin/env python3
"""Aggregate browser/Python RAW4D image metrics and render compact QA charts."""

#WDD-gpt 2026-08-16 - 将多RAW4D分段的逐图误差统一汇总为全局、逐帧、逐相机和尾部样本报告。

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import fmean
from typing import Any, Iterable


def aggregate_psnr(rows: Iterable[dict[str, Any]]) -> float:
    values = list(rows)
    mse = fmean(float(row["mse"]) for row in values)
    return math.inf if mse == 0 else 10.0 * math.log10(255.0 * 255.0 / mse)


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    psnr = [float(row["psnr"]) for row in rows if row["psnr"] is not None]
    return {
        "samples": len(rows),
        "aggregatePsnr": aggregate_psnr(rows),
        "meanPsnr": fmean(psnr),
        "minimumPsnr": min(psnr),
        "maximumPsnr": max(psnr),
    }


def grouped_rows(rows: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    groups: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[row[key]].append(row)
    result = []
    for value, samples in sorted(groups.items()):
        summary = summarize(samples)
        result.append({key: value, **summary})
    return result


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def render_charts(output_dir: Path, frames: list[dict[str, Any]], cameras: list[dict[str, Any]]) -> None:
    import matplotlib.pyplot as plt

    frame_numbers = [int(row["frame"]) for row in frames]
    figure, axis = plt.subplots(figsize=(12, 5.2), dpi=160)
    axis.plot(frame_numbers, [row["aggregatePsnr"] for row in frames], label="Aggregate PSNR", linewidth=2.0)
    axis.plot(frame_numbers, [row["meanPsnr"] for row in frames], label="Mean image PSNR", linewidth=1.5)
    axis.plot(frame_numbers, [row["minimumPsnr"] for row in frames], label="Minimum view", linewidth=1.2)
    axis.axhline(38.0, color="#d94841", linestyle="--", linewidth=1.2, label="38 dB")
    axis.set(xlabel="Global frame", ylabel="PSNR (dB)", title="RAW4D browser vs Python gsplat, frames 230-300")
    axis.grid(alpha=0.22)
    axis.legend(ncol=4, fontsize=8)
    figure.tight_layout()
    figure.savefig(output_dir / "psnr_by_frame.png")
    plt.close(figure)

    ordered = sorted(cameras, key=lambda row: row["aggregatePsnr"])
    labels = [str(row["cameraName"]) for row in ordered]
    figure, axis = plt.subplots(figsize=(10, 5.8), dpi=160)
    y = range(len(ordered))
    axis.barh(y, [row["aggregatePsnr"] for row in ordered], color="#3578c6", label="Aggregate PSNR")
    axis.scatter([row["meanPsnr"] for row in ordered], y, color="#f39c34", s=24, label="Mean image PSNR")
    axis.axvline(38.0, color="#d94841", linestyle="--", linewidth=1.2, label="38 dB")
    axis.set_yticks(list(y), labels)
    axis.set(xlabel="PSNR (dB)", title="RAW4D browser vs Python gsplat by camera")
    axis.grid(axis="x", alpha=0.22)
    axis.legend(fontsize=8)
    figure.tight_layout()
    figure.savefig(output_dir / "psnr_by_camera.png")
    plt.close(figure)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rows: list[dict[str, Any]] = []
    renderers = set()
    raster_quality = []
    for path in args.inputs:
        payload = json.loads(path.read_text(encoding="utf-8"))
        rows.extend(payload["metrics"])
        renderers.add(payload.get("renderer"))
        raster_quality.append(payload.get("rasterQuality"))
    if not rows:
        raise ValueError("No metrics found")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    frames = grouped_rows(rows, "frame")
    cameras = grouped_rows(rows, "cameraName")
    worst = sorted(rows, key=lambda row: float(row["psnr"]))[:50]
    summary = {
        **summarize(rows),
        "frames": len(frames),
        "cameras": len(cameras),
        "firstFrame": min(int(row["frame"]) for row in rows),
        "lastFrame": max(int(row["frame"]) for row in rows),
        "renderers": sorted(value for value in renderers if value),
        "rasterQuality": raster_quality[0] if all(value == raster_quality[0] for value in raster_quality) else raster_quality,
        "worstFrame": min(frames, key=lambda row: row["aggregatePsnr"]),
        "worstCamera": min(cameras, key=lambda row: row["aggregatePsnr"]),
    }
    (args.output_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    write_csv(args.output_dir / "per_frame.csv", frames)
    write_csv(args.output_dir / "per_camera.csv", cameras)
    write_csv(args.output_dir / "worst_samples.csv", worst)
    render_charts(args.output_dir, frames, cameras)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
