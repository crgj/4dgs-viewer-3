#!/usr/bin/env python3
"""Train and validate a standalone CoReSH-5R stream for one RAW4D asset."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from codec import (
    decode_sh_rvq5,
    encode_sh_rvq5,
    load_rows,
    property_indices,
    read_raw4d_layout,
    sha256_file,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Train an actual CoReSH-5R SH bitstream")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    started = time.perf_counter()
    layout = read_raw4d_layout(args.source)
    rows = load_rows(layout)
    source = np.asarray(
        rows[:, property_indices(layout, [f"f_rest_{index}" for index in range(45)])],
        dtype=np.float32,
    )
    payload = encode_sh_rvq5(source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(payload)
    decoded = decode_sh_rvq5(args.output.read_bytes())
    if decoded.shape != source.shape:
        raise AssertionError("Independent CoReSH-5R decode shape mismatch")
    error = np.abs(decoded - source)
    #WDD-gpt 2026-08-15 - 新FP16 RAW4D必须重训并独立解码自己的CoReSH-5R，禁止复用旧Gaussian标签。
    report = {
        "source": str(args.source),
        "gaussian_count": layout.vertex_count,
        "source_sh_bytes_float32_equivalent": source.nbytes,
        "source_sh_bytes_native_fp16": source.size * layout.scalar_bytes,
        "stream": str(args.output),
        "stream_bytes": args.output.stat().st_size,
        "stream_sha256": sha256_file(args.output),
        "ratio_vs_float32_sh": source.nbytes / args.output.stat().st_size,
        "ratio_vs_native_fp16_sh": (source.size * layout.scalar_bytes) / args.output.stat().st_size,
        "mae": float(np.mean(error)),
        "rmse": float(np.sqrt(np.mean(np.square(decoded - source), dtype=np.float64))),
        "p99_absolute_error": float(np.percentile(error, 99)),
        "maximum_absolute_error": float(np.max(error)),
        "independent_decoder_validated": True,
        "seconds": time.perf_counter() - started,
    }
    report_path = args.output.with_suffix(".json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({**report, "report": str(report_path)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
