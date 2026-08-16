import unittest
import sys
from pathlib import Path

import numpy as np

#WDD-gpt 2026-08-15 - 允许从仓库根目录用 unittest 直接加载同目录 TSOG 模块。
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tsog import (
    decode_rgba,
    dequantize16,
    morton_order,
    normalize_quaternions,
    quantize16,
    quaternion_exp,
    quaternion_multiply,
    relative_rotation_vectors,
    rgba_webp,
)


#WDD-gpt 2026-08-15 - 回归 TSOG 的 16 位图像量化、Morton 对齐顺序与相对四元数重建。
class TsogCodecTest(unittest.TestCase):
    def test_quantize16_roundtrip_respects_half_step(self) -> None:
        values = np.asarray(
            [
                [[-2.0, 4.0, 0.25], [0.0, 8.0, 0.5]],
                [[2.0, 12.0, 0.75], [1.0, 16.0, 1.0]],
            ],
            dtype=np.float32,
        )
        quantized, minimum, maximum = quantize16(values)
        decoded = dequantize16(quantized, minimum, maximum)
        step = (maximum - minimum) / 65535
        self.assertTrue(np.all(np.abs(decoded - values) <= step * 0.501 + 1e-7))

    def test_morton_order_is_a_deterministic_permutation(self) -> None:
        points = np.asarray(
            [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float32
        )
        first = morton_order(points)
        second = morton_order(points)
        np.testing.assert_array_equal(first, second)
        np.testing.assert_array_equal(np.sort(first), np.arange(points.shape[0]))
        self.assertEqual(int(first[0]), 0)
        self.assertEqual(int(first[-1]), 1)

    def test_relative_rotation_vector_reconstructs_key(self) -> None:
        base = normalize_quaternions(np.asarray([[1.0, 0.2, -0.1, 0.3]], dtype=np.float32))
        tail = normalize_quaternions(np.asarray([[0.8, -0.3, 0.4, 0.1]], dtype=np.float32))
        track = np.stack([base, tail], axis=1)
        vector = relative_rotation_vectors(track)
        decoded = quaternion_multiply(base, quaternion_exp(vector[:, 0]))
        dot = np.abs(np.sum(decoded * tail, axis=1))
        self.assertGreater(float(dot[0]), 1 - 1e-6)

    def test_lossless_webp_preserves_rgb_behind_zero_alpha(self) -> None:
        image = np.asarray([[[17, 83, 201, 0], [4, 5, 6, 255]]], dtype=np.uint8)
        np.testing.assert_array_equal(decode_rgba(rgba_webp(image)), image)


if __name__ == "__main__":
    unittest.main()
