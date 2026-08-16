#!/usr/bin/env python3
"""Regression tests for the learnable anchor-field evaluation codec."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from learnable_anchor_field import (  # noqa: E402
    build_anchor_topology,
    decode_probe_archive,
    encode_probe_archive,
    reconstruct_motion,
    solve_static_weights,
)


class LearnableAnchorFieldTest(unittest.TestCase):
    #WDD-gpt 2026-08-15 - 验证跨关键帧共享五权重能够复现合成锚点场，并覆盖独立码流解码。
    def test_static_weights_and_serialized_residual_round_trip(self) -> None:
        rng = np.random.default_rng(20260815)
        count = 256
        base = rng.uniform(-1, 1, size=(count, 3)).astype(np.float32)
        topology = build_anchor_topology(base, anchor_fraction=0.125, neighbors=5)
        field = rng.normal(0, 0.02, size=(topology.anchors.size, 10, 3)).astype(np.float32)
        weights = rng.normal(0.2, 0.08, size=(count, 5)).astype(np.float32)
        target = reconstruct_motion(weights, field, topology.neighbors)
        solved = solve_static_weights(target, field, topology.neighbors, ridge=1e-8)
        solved_prediction = reconstruct_motion(solved, field, topology.neighbors)
        self.assertLess(float(np.max(np.abs(solved_prediction - target))), 2e-4)

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "model.npz"
            manifest, encoder_motion = encode_probe_archive(
                output,
                base,
                topology,
                solved,
                field,
                target,
                list(range(11)),
                weight_bits=8,
                field_bits=12,
                weight_clip_percentile=99.9,
                correction_ratio=0.00028,
                zstd_level=1,
            )
            decoded_manifest, decoded_positions = decode_probe_archive(output)
            encoder_positions = np.concatenate([base[:, None, :], base[:, None, :] + encoder_motion], axis=1)
            self.assertTrue(np.array_equal(decoded_positions, encoder_positions))
            self.assertEqual(decoded_manifest["correction_count"], manifest["correction_count"])
            target_positions = np.concatenate([base[:, None, :], base[:, None, :] + target], axis=1)
            maximum = float(np.max(np.linalg.norm(decoded_positions - target_positions, axis=2)))
            self.assertLessEqual(maximum, float(manifest["scene_diagonal"]) * 0.00028)


if __name__ == "__main__":
    unittest.main()
