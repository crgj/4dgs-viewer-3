import unittest

import numpy as np

from coerattr5r_compactfirst import (
    decode_opacity_first,
    decode_rotation_first,
    decode_scale_first,
    encode_opacity_first,
    encode_rotation_first,
    encode_scale_repairs,
    scale_render_importance,
    restore_opacity_negative_infinity,
    encode_scale_first,
    pack_predictive_residuals,
    unpack_predictive_residuals,
)
from mint_like_nonsh35 import canonical_quaternions, stable_sigmoid


#WDD-gpt 2026-08-15 - 覆盖紧凑首帧的独立解码和相对已解码首帧的闭环残差语义。
class CoReAttr5RCompactFirstTest(unittest.TestCase):
    def test_base_codecs_and_predictive_residuals(self) -> None:
        rng = np.random.default_rng(20260817)
        count = 128
        source = {
            "position": rng.normal(size=(count, 11, 3)).astype(np.float32),
            "rotation": canonical_quaternions(rng.normal(size=(count, 2, 4)).astype(np.float32)),
            "scale": rng.uniform(-8, 1, size=(count, 4, 3)).astype(np.float32),
            "opacity": rng.uniform(-8, 8, size=(count, 4, 1)).astype(np.float32),
        }
        rotation, rotation_streams, rotation_meta = encode_rotation_first(
            source["rotation"], source["scale"], source["opacity"]
        )
        scale, scale_stream, scale_meta = encode_scale_first(source["scale"][:, 0])
        opacity, opacity_stream, opacity_meta = encode_opacity_first(source["opacity"][:, 0])
        np.testing.assert_array_equal(
            decode_rotation_first(rotation_streams, rotation_meta, count), rotation
        )
        np.testing.assert_array_equal(decode_scale_first(scale_stream, scale_meta), scale)
        np.testing.assert_array_equal(decode_opacity_first(opacity_stream, opacity_meta), opacity)

        residuals = pack_predictive_residuals(source, rotation, scale, opacity)
        decoded = unpack_predictive_residuals(
            source["position"], rotation, scale, opacity, residuals
        )
        np.testing.assert_allclose(decoded["scale"][:, 1:], source["scale"][:, 1:], rtol=0, atol=1e-6)
        np.testing.assert_allclose(
            stable_sigmoid(decoded["opacity"][:, 1:]),
            stable_sigmoid(source["opacity"][:, 1:]),
            rtol=0,
            atol=3e-7,
        )
        dot = np.abs(np.sum(decoded["rotation"][:, 1] * source["rotation"][:, 1], axis=1))
        self.assertGreater(float(np.min(dot)), 0.999999)

    def test_sparse_scale_repairs_select_high_impact_nodes(self) -> None:
        source = np.zeros((4, 4, 3), dtype=np.float32)
        decoded = source.copy()
        decoded[0, 1, 0] = 0.5
        decoded[1, 2, 0] = 0.4
        decoded[2, 3, 0] = 0.3
        importance = np.asarray([1, 4, 1, 1], dtype=np.float32)
        repaired, mask, corrections, metadata = encode_scale_repairs(
            source, decoded, importance, 2
        )
        self.assertTrue(mask[0, 0])
        self.assertTrue(mask[1, 1])
        self.assertEqual(corrections.shape, (2, 3))
        self.assertEqual(metadata["count"], 2)
        np.testing.assert_allclose(repaired[[0, 1], [1, 2]], 0, atol=2e-4)

    def test_scale_render_importance_is_per_keyframe_and_area_weighted(self) -> None:
        scales = np.zeros((2, 4, 3), dtype=np.float32)
        opacities = np.zeros((2, 4, 1), dtype=np.float32)
        scales[0, 2, :2] = 1.0
        opacities[1, 3, 0] = -8.0
        importance = scale_render_importance(scales, opacities)
        self.assertEqual(importance.shape, (2, 3))
        self.assertGreater(importance[0, 1], importance[1, 1])
        self.assertLess(importance[1, 2], importance[0, 2])

    def test_opacity_negative_infinity_mask_is_exact(self) -> None:
        decoded = np.zeros((2, 4, 1), dtype=np.float32)
        mask = np.zeros_like(decoded, dtype=bool)
        mask[0, 1, 0] = True
        restored = restore_opacity_negative_infinity(decoded, mask)
        self.assertTrue(np.isneginf(restored[0, 1, 0]))
        self.assertEqual(float(restored[1, 1, 0]), 0.0)


if __name__ == "__main__":
    unittest.main()
