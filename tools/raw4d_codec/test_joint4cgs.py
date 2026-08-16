#!/usr/bin/env python3
"""Tests for the boundary-aware multi-segment 4CGS framing."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from joint4cgs import read_joint, validate_timeline, write_joint


class Joint4CGSTest(unittest.TestCase):
    def test_round_trip_and_checksum(self) -> None:
        manifest = {
            "format": "4CGS-JointTrajectoryGOP",
            "version": 1,
            "segments": [
                {
                    "name": "segment_0_2",
                    "global_start_frame": 0,
                    "global_end_frame": 2,
                    "payload_bytes": 3,
                    "payload_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                },
                {
                    "name": "segment_2_4",
                    "global_start_frame": 2,
                    "global_end_frame": 4,
                    "payload_bytes": 3,
                    "payload_sha256": "cb8379ac2098aa165029e3938a51da0bcecfc008fd6795f401178647f96c5b34",
                },
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.4cgs"
            write_joint(path, manifest, [b"abc", b"def"])
            decoded, payloads = read_joint(path)
        self.assertEqual(decoded["format"], manifest["format"])
        self.assertEqual(payloads, [b"abc", b"def"])

    def test_rejects_non_overlapping_timeline(self) -> None:
        segments = [
            {"name": "segment_0_2", "global_start_frame": 0, "global_end_frame": 2},
            {"name": "segment_3_4", "global_start_frame": 3, "global_end_frame": 4},
        ]
        with self.assertRaisesRegex(ValueError, "share exactly one boundary"):
            validate_timeline(segments)


if __name__ == "__main__":
    unittest.main()
