#!/usr/bin/env python3
"""Pack independently seekable RAW4D GOPs into one boundary-aware 4CGS file."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import tempfile
import time
from pathlib import Path
from typing import Any

from codec import read_container
from compact40 import decode as decode_compact40


#WDD-gpt 2026-08-15 - 相邻片段共享时间边界但允许Gaussian出生/消失，因此外层只复用视觉锚而不假设行ID连续。
MAGIC = b"4CGSJNT1"
HEADER = struct.Struct("<8sQ")
SEGMENT_HEADER = struct.Struct("<Q32s")
SEGMENT_PATTERN = re.compile(r"^segment_(\d+)_(\d+)$")
FORMAT_NAME = "4CGS-JointTrajectoryGOP"
FORMAT_VERSION = 1


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def parse_segment_range(stem: str) -> tuple[int, int]:
    match = SEGMENT_PATTERN.fullmatch(stem)
    if match is None:
        raise ValueError(f"Segment name must match segment_<first>_<last>: {stem}")
    first, last = (int(value) for value in match.groups())
    if last < first:
        raise ValueError(f"Invalid segment range: {stem}")
    return first, last


def validate_timeline(items: list[dict[str, Any]]) -> None:
    if not items:
        raise ValueError("At least one segment is required")
    for previous, current in zip(items, items[1:]):
        if int(previous["global_end_frame"]) != int(current["global_start_frame"]):
            raise ValueError(
                "Adjacent segments must share exactly one boundary frame: "
                f"{previous['name']} -> {current['name']}"
            )


def build_manifest(
    source_paths: list[Path],
    child_paths: list[Path],
    child_payloads: list[bytes],
) -> dict[str, Any]:
    segments: list[dict[str, Any]] = []
    for source, child, payload in zip(source_paths, child_paths, child_payloads, strict=True):
        first, last = parse_segment_range(source.stem)
        child_manifest, _ = read_container(child)
        if int(child_manifest["total_frames"]) != last - first + 1:
            raise ValueError(f"Timeline length does not match {source.name}")
        if int(child_manifest["source_bytes"]) != source.stat().st_size:
            raise ValueError(f"Child source size does not match {source.name}")
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        if child_manifest.get("source_sha256") != source_hash:
            raise ValueError(f"Child source hash does not match {source.name}")
        segments.append({
            "name": source.stem,
            "source_name": source.name,
            "global_start_frame": first,
            "global_end_frame": last,
            "local_frame_count": last - first + 1,
            "gaussian_count": int(child_manifest["gaussian_count"]),
            "codec_name": str(child_manifest["codec_name"]),
            "source_bytes": source.stat().st_size,
            "source_sha256": source_hash,
            "payload_bytes": len(payload),
            "payload_sha256": sha256_bytes(payload),
            "identity_mode": "segment-local-with-birth-death",
        })
    validate_timeline(segments)
    first_frame = int(segments[0]["global_start_frame"])
    last_frame = int(segments[-1]["global_end_frame"])
    source_bytes = sum(int(item["source_bytes"]) for item in segments)
    return {
        "format": FORMAT_NAME,
        "version": FORMAT_VERSION,
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "timeline": {
            "global_start_frame": first_frame,
            "global_end_frame": last_frame,
            "unique_frame_count": last_frame - first_frame + 1,
            "overlapped_boundary_count": len(segments) - 1,
            "boundary_anchor_policy": "use-previous-segment-endpoint",
        },
        "identity_contract": {
            "row_ids_persist_within_gop_only": True,
            "cross_gop_births_and_deaths_allowed": True,
            "cross_gop_row_order_prediction": False,
        },
        "source_bytes": source_bytes,
        "gaussian_instances": sum(int(item["gaussian_count"]) for item in segments),
        "segments": segments,
    }


def write_joint(output: Path, manifest: dict[str, Any], payloads: list[bytes]) -> None:
    encoded_manifest = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(HEADER.pack(MAGIC, len(encoded_manifest)))
            handle.write(encoded_manifest)
            for payload in payloads:
                handle.write(SEGMENT_HEADER.pack(len(payload), hashlib.sha256(payload).digest()))
                handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, output)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def read_joint(path: Path) -> tuple[dict[str, Any], list[bytes]]:
    with path.open("rb") as handle:
        header = handle.read(HEADER.size)
        if len(header) != HEADER.size:
            raise ValueError("Truncated joint 4CGS header")
        magic, manifest_size = HEADER.unpack(header)
        if magic != MAGIC:
            raise ValueError("Not a joint 4CGS file")
        manifest_payload = handle.read(manifest_size)
        if len(manifest_payload) != manifest_size:
            raise ValueError("Truncated joint 4CGS manifest")
        manifest = json.loads(manifest_payload)
        if manifest.get("format") != FORMAT_NAME or int(manifest.get("version", 0)) != FORMAT_VERSION:
            raise ValueError("Unsupported joint 4CGS version")
        payloads: list[bytes] = []
        for segment in manifest["segments"]:
            segment_header = handle.read(SEGMENT_HEADER.size)
            if len(segment_header) != SEGMENT_HEADER.size:
                raise ValueError("Truncated joint 4CGS segment header")
            payload_size, expected_digest = SEGMENT_HEADER.unpack(segment_header)
            payload = handle.read(payload_size)
            if len(payload) != payload_size:
                raise ValueError("Truncated joint 4CGS segment payload")
            actual_digest = hashlib.sha256(payload).digest()
            if actual_digest != expected_digest:
                raise ValueError(f"Segment checksum failed: {segment['name']}")
            if int(segment["payload_bytes"]) != payload_size:
                raise ValueError(f"Segment size manifest mismatch: {segment['name']}")
            if segment["payload_sha256"] != actual_digest.hex():
                raise ValueError(f"Segment hash manifest mismatch: {segment['name']}")
            payloads.append(payload)
        if handle.read(1):
            raise ValueError("Trailing bytes after joint 4CGS payloads")
    validate_timeline(manifest["segments"])
    return manifest, payloads


def pack(source_dir: Path, child_dir: Path, output: Path) -> dict[str, Any]:
    source_paths = sorted(source_dir.glob("segment_*.raw4d"), key=lambda path: parse_segment_range(path.stem))
    child_paths = [child_dir / f"{path.stem}.4cgs" for path in source_paths]
    missing = [str(path) for path in child_paths if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Missing child 4CGS files: {missing}")
    payloads = [path.read_bytes() for path in child_paths]
    manifest = build_manifest(source_paths, child_paths, payloads)
    write_joint(output, manifest, payloads)
    decoded_manifest, decoded_payloads = read_joint(output)
    if decoded_payloads != payloads:
        raise RuntimeError("Serialized joint 4CGS payload validation failed")
    result = dict(decoded_manifest)
    result["container_bytes"] = output.stat().st_size
    result["compression_ratio_vs_source_raw4d"] = (
        int(result["source_bytes"]) / output.stat().st_size
    )
    result["independent_container_validation"] = True
    return result


def extract(path: Path, output_dir: Path, decode_raw4d: bool) -> dict[str, Any]:
    started = time.perf_counter()
    manifest, payloads = read_joint(path)
    output_dir.mkdir(parents=True, exist_ok=True)
    extracted: list[dict[str, Any]] = []
    for segment, payload in zip(manifest["segments"], payloads, strict=True):
        child_path = output_dir / f"{segment['name']}.4cgs"
        child_path.write_bytes(payload)
        item: dict[str, Any] = {"child_4cgs": str(child_path), "bytes": len(payload)}
        if decode_raw4d:
            decoded_path = output_dir / f"{segment['name']}.decoded.raw4d"
            item["decoded"] = decode_compact40(child_path, decoded_path)
        extracted.append(item)
    return {
        "output_dir": str(output_dir),
        "segments": extracted,
        "measured_seconds": time.perf_counter() - started,
        "container_checksum_validated": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Boundary-aware multi-segment 4CGS container")
    subparsers = parser.add_subparsers(dest="command", required=True)
    pack_parser = subparsers.add_parser("pack")
    pack_parser.add_argument("source_dir", type=Path)
    pack_parser.add_argument("child_dir", type=Path)
    pack_parser.add_argument("output", type=Path)
    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("source", type=Path)
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("source", type=Path)
    extract_parser.add_argument("output_dir", type=Path)
    extract_parser.add_argument("--decode-raw4d", action="store_true")
    args = parser.parse_args()
    if args.command == "pack":
        if args.output.suffix.lower() != ".4cgs":
            raise ValueError("Output must use the .4cgs suffix")
        result = pack(args.source_dir, args.child_dir, args.output)
    elif args.command == "inspect":
        result, _ = read_joint(args.source)
        result = dict(result)
        result["container_bytes"] = args.source.stat().st_size
        result["compression_ratio_vs_source_raw4d"] = (
            int(result["source_bytes"]) / args.source.stat().st_size
        )
    else:
        result = extract(args.source, args.output_dir, args.decode_raw4d)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
