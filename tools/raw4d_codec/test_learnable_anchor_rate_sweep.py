#!/usr/bin/env python3
"""Regression tests for the extreme learnable-anchor rate sweep."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from learnable_anchor_field import build_anchor_topology, reconstruct_motion  # noqa: E402
from learnable_anchor_rate_sweep import (  # noqa: E402
    decode_base,
    decode_candidate,
    encode_base,
    encode_candidate,
    encode_field,
    train_weight_codec,
)


class LearnableAnchorRateSweepTest(unittest.TestCase):
    #WDD-gpt 2026-08-15 - 覆盖Morton首帧、VQ五权重、低秩场和稀疏残差的独立解码闭环。
    def test_extreme_archive_round_trip(self) -> None:
        rng = np.random.default_rng(20260815)
        positions = rng.uniform(-1, 1, size=(256, 11, 3)).astype(np.float32)
        base = encode_base(positions, correction_ratio=0.00028)
        self.assertTrue(np.array_equal(base.decoded, decode_base(base.metadata, base.streams)))
        sorted_positions = positions[base.order]
        target_motion = sorted_positions[:, 1:] - base.decoded[:, None, :]
        topology = build_anchor_topology(base.decoded, anchor_fraction=0.125, neighbors=5)
        weights = rng.normal(0.2, 0.08, size=(256, 5)).astype(np.float32)
        field = rng.normal(0, 0.02, size=(topology.anchors.size, 10, 3)).astype(np.float32)
        sample_indices = np.arange(256)
        weight_codec = train_weight_codec(
            weights,
            clusters=16,
            stages=1,
            sample_indices=sample_indices,
            seed=20260815,
            clip_percentile=99.9,
        )
        field_codec = encode_field(field, rank=4, bits=8)
        prediction = reconstruct_motion(weight_codec.decoded, field_codec.decoded, topology.neighbors)

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "candidate.npz"
            manifest, encoder_motion = encode_candidate(
                output,
                list(range(11)),
                target_motion,
                base,
                prediction,
                weight_codec,
                field_codec,
                anchor_fraction=0.125,
                neighbors=5,
                correction_ratio=0.00028,
                profile_name="test",
                target_bytes=10_000_000,
                zstd_level=1,
            )
            decoded_manifest, decoded_positions = decode_candidate(output)
            encoder_positions = np.concatenate([
                base.decoded[:, None, :],
                base.decoded[:, None, :] + encoder_motion,
            ], axis=1)
            self.assertTrue(np.array_equal(decoded_positions, encoder_positions))
            self.assertEqual(decoded_manifest["motion_reference"], "frame0_to_each_keyframe")
            self.assertEqual(decoded_manifest["correction_count"], manifest["correction_count"])
            maximum = float(np.max(np.linalg.norm(decoded_positions - sorted_positions, axis=2)))
            self.assertLessEqual(maximum, float(base.metadata["scene_diagonal"]) * 0.00028)


if __name__ == "__main__":
    unittest.main()
