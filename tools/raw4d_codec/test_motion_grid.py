#!/usr/bin/env python3
"""Regression tests for the low-dimensional motion-grid XYZ codec."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from motion_grid import decode_motion_grid, encode_motion_grid  # noqa: E402


class MotionGridTest(unittest.TestCase):
    #WDD-gpt 2026-08-15 - 固定合成曲线覆盖网格拟合、六级RVQ、稀疏节点修正和码流解码一致性。
    def test_integer_node_round_trip_matches_encoder_reconstruction(self) -> None:
        rng = np.random.default_rng(20260815)
        count = 1024
        base = rng.uniform(-1, 1, size=(count, 3)).astype(np.float32)
        time = np.arange(11, dtype=np.float32)[None, :, None]
        velocity = rng.normal(0, 0.012, size=(count, 1, 3)).astype(np.float32)
        acceleration = rng.normal(0, 0.0007, size=(count, 1, 3)).astype(np.float32)
        positions = base[:, None, :] + velocity * time + acceleration * np.square(time)
        streams = []

        encoded_motion, metadata = encode_motion_grid(streams, positions, base, zstd_level=1)
        decoded_streams = {stream.name: stream.raw for stream in streams}
        decoded_motion = decode_motion_grid(decoded_streams, metadata, count, 11, base)

        self.assertTrue(np.allclose(decoded_motion, encoded_motion, atol=5e-7, rtol=0))
        target = float(metadata["maximum_node_error_after_correction"])
        self.assertLessEqual(target, float(metadata["correction_step"]) * np.sqrt(3) + 1e-6)


if __name__ == "__main__":
    unittest.main()
