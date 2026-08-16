#!/usr/bin/env python3
"""Tests for visibility-ranked RAW4D LOD scoring."""

import unittest

import numpy as np

from make_visibility_lod import visibility_score


class VisibilityLodTest(unittest.TestCase):
    def test_score_uses_maximum_keyframe_alpha_and_projected_area(self) -> None:
        scales = np.zeros((2, 4, 3), dtype=np.float32)
        opacities = np.zeros((2, 4, 1), dtype=np.float32)
        scales[0, 2, :2] = 1.0
        opacities[1, :, 0] = -8.0
        score = visibility_score(scales, opacities)
        #WDD-gpt 2026-08-15 - 大投影面积或高alpha点必须稳定排在全时序低贡献点之前。
        self.assertGreater(score[0], score[1])


if __name__ == "__main__":
    unittest.main()
