import unittest

import numpy as np

from mint_like_nonsh35 import (
    canonical_quaternions,
    decode_rotation_features,
    encode_rotation_features,
    quaternion_exp,
    quaternion_log,
)


#WDD-gpt 2026-08-15 - 覆盖MINT-like非SH码流使用的四元数首帧加相对旋转表示，防止旋转顺序或符号回归。
class MintLikeNonSh35Test(unittest.TestCase):
    def test_quaternion_log_exp_roundtrip(self) -> None:
        rng = np.random.default_rng(20260815)
        source = canonical_quaternions(rng.normal(size=(128, 4)).astype(np.float32))
        decoded = quaternion_exp(quaternion_log(source))
        dot = np.abs(np.sum(source * decoded, axis=1))
        self.assertGreater(float(np.min(dot)), 0.999999)

    def test_rotation_pair_feature_roundtrip(self) -> None:
        rng = np.random.default_rng(20260816)
        source = canonical_quaternions(rng.normal(size=(96, 2, 4)).astype(np.float32))
        decoded = decode_rotation_features(encode_rotation_features(source))
        dot = np.abs(np.sum(source * decoded, axis=2))
        self.assertGreater(float(np.min(dot)), 0.999999)

if __name__ == "__main__":
    unittest.main()
