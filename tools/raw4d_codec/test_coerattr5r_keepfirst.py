import unittest

import numpy as np

from coerattr5r_keepfirst import first_keyframes, pack_temporal_residuals, unpack_temporal_residuals
from mint_like_nonsh35 import canonical_quaternions, stable_sigmoid


#WDD-gpt 2026-08-15 - 验证首关键帧精确保留且其余关键帧只依赖首帧残差即可重建。
class CoReAttr5RKeepFirstTest(unittest.TestCase):
    def test_keep_first_residual_roundtrip(self) -> None:
        rng = np.random.default_rng(20260816)
        source = {
            "position": rng.normal(size=(64, 11, 3)).astype(np.float32),
            "rotation": canonical_quaternions(rng.normal(size=(64, 2, 4)).astype(np.float32)),
            "scale": rng.uniform(-8, 1, size=(64, 4, 3)).astype(np.float32),
            "opacity": rng.uniform(-8, 8, size=(64, 4, 1)).astype(np.float32),
        }
        decoded = unpack_temporal_residuals(
            first_keyframes(source),
            pack_temporal_residuals(source),
        )
        for name in ("position", "scale"):
            np.testing.assert_array_equal(decoded[name][:, 0], source[name][:, 0])
            np.testing.assert_allclose(decoded[name], source[name], rtol=0, atol=1e-6)
        np.testing.assert_array_equal(decoded["opacity"][:, 0], source["opacity"][:, 0])
        np.testing.assert_allclose(
            stable_sigmoid(decoded["opacity"]),
            stable_sigmoid(source["opacity"]),
            rtol=0,
            atol=3e-7,
        )
        np.testing.assert_array_equal(decoded["rotation"][:, 0], source["rotation"][:, 0])
        dot = np.abs(np.sum(decoded["rotation"] * source["rotation"], axis=2))
        self.assertGreater(float(np.min(dot)), 0.999999)


if __name__ == "__main__":
    unittest.main()
