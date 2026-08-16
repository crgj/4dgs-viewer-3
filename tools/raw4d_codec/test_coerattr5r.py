import unittest

import numpy as np

from coerattr5r import pack_residual_features, unpack_residual_features
from mint_like_nonsh35 import canonical_quaternions, stable_sigmoid


#WDD-gpt 2026-08-15 - 验证55D首帧参考残差参数化本身可逆，隔离RVQ量化误差。
class CoReAttr5RTest(unittest.TestCase):
    def test_residual_parameterization_roundtrip(self) -> None:
        rng = np.random.default_rng(20260815)
        source = {
            "position": rng.normal(size=(64, 11, 3)).astype(np.float32),
            "rotation": canonical_quaternions(rng.normal(size=(64, 2, 4)).astype(np.float32)),
            "scale": rng.uniform(-8, 1, size=(64, 4, 3)).astype(np.float32),
            "opacity": rng.uniform(-8, 8, size=(64, 4, 1)).astype(np.float32),
        }
        decoded = unpack_residual_features(pack_residual_features(source))
        np.testing.assert_allclose(decoded["position"], source["position"], rtol=0, atol=3e-7)
        np.testing.assert_allclose(decoded["scale"], source["scale"], rtol=0, atol=1e-6)
        np.testing.assert_allclose(
            stable_sigmoid(decoded["opacity"]),
            stable_sigmoid(source["opacity"]),
            rtol=0,
            atol=3e-7,
        )
        dot = np.abs(np.sum(decoded["rotation"] * source["rotation"], axis=2))
        self.assertGreater(float(np.min(dot)), 0.999999)


if __name__ == "__main__":
    unittest.main()
