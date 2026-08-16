#!/usr/bin/env python3

import unittest

import numpy as np

from hybrid39 import (
    SCALE_TARGET_RELATIVE_ERROR,
    decode_lifetime,
    decode_opacity,
    decode_scale,
    encode_lifetime,
    encode_opacity,
    encode_scale,
)


class Hybrid39AttributeTests(unittest.TestCase):
    #WDD-gpt 2026-08-15 - 覆盖困难块自动加位宽及三个新属性码流的序列化一致性。
    def test_scale_serialized_roundtrip_and_bound(self) -> None:
        rng = np.random.default_rng(20260815)
        count = 777
        scale = rng.uniform(-34, 1, size=(count, 4, 3)).astype(np.float32)
        streams = []
        encoded, metadata = encode_scale(streams, scale, np.ones(count, dtype=np.float32), 3)
        decoded = decode_scale({stream.name: stream.raw for stream in streams}, metadata, count)
        np.testing.assert_array_equal(decoded, encoded)
        maximum = float(np.max(np.abs(np.expm1(decoded - scale))))
        self.assertLessEqual(maximum, SCALE_TARGET_RELATIVE_ERROR + 1e-6)

    def test_opacity_serialized_roundtrip(self) -> None:
        rng = np.random.default_rng(20260816)
        count = 777
        opacity = rng.uniform(-16, 16, size=(count, 4, 1)).astype(np.float32)
        streams = []
        encoded, metadata = encode_opacity(streams, opacity, np.ones(count, dtype=np.float32), 3)
        decoded = decode_opacity({stream.name: stream.raw for stream in streams}, metadata, count)
        np.testing.assert_array_equal(decoded, encoded)
        source_alpha = 1 / (1 + np.exp(-opacity))
        decoded_alpha = 1 / (1 + np.exp(-decoded))
        self.assertLessEqual(float(np.max(np.abs(decoded_alpha - source_alpha))), 1 / 510 + 1e-6)

    def test_lifetime_serialized_roundtrip(self) -> None:
        rng = np.random.default_rng(20260817)
        count = 777
        mu = rng.uniform(-1, 3, size=count).astype(np.float32)
        width = rng.uniform(13, 17, size=count).astype(np.float32)
        streams = []
        encoded_mu, encoded_width, metadata = encode_lifetime(streams, mu, width, 3)
        decoded_mu, decoded_width = decode_lifetime(
            {stream.name: stream.raw for stream in streams}, metadata, count
        )
        np.testing.assert_array_equal(decoded_mu, encoded_mu)
        np.testing.assert_array_equal(decoded_width, encoded_width)


if __name__ == "__main__":
    unittest.main()
