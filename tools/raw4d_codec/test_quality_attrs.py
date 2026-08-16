#!/usr/bin/env python3

import unittest

import numpy as np

from quality_attrs import decode_color, decode_rotation, encode_color, encode_rotation


class QualityAttributeTests(unittest.TestCase):
    def test_rotation_serialized_roundtrip(self) -> None:
        rng = np.random.default_rng(20260814)
        count = 777
        rotation = rng.normal(size=(count, 2, 4)).astype(np.float32)
        scale = rng.uniform(-6, -1, size=(count, 4, 3)).astype(np.float32)
        opacity = rng.uniform(-8, 5, size=(count, 4, 1)).astype(np.float32)
        streams = []
        encoded, metadata = encode_rotation(streams, rotation, scale, opacity, 3)
        decoded = decode_rotation({stream.name: stream.raw for stream in streams}, metadata, count)
        np.testing.assert_array_equal(decoded, encoded)

    def test_color_serialized_roundtrip(self) -> None:
        rng = np.random.default_rng(20260815)
        count = 777
        color = rng.normal(0, 1.5, size=(count, 2, 3)).astype(np.float32)
        importance = rng.random(count).astype(np.float32)
        streams = []
        encoded, metadata = encode_color(streams, color, importance, 3)
        decoded = decode_color({stream.name: stream.raw for stream in streams}, metadata, count)
        np.testing.assert_array_equal(decoded, encoded)


if __name__ == "__main__":
    unittest.main()
