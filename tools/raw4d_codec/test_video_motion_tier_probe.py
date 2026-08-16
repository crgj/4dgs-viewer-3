#!/usr/bin/env python3
"""Regression tests for trajectory-video plane packing."""

import unittest

from video_motion_tier_probe import padded_plane_height


class VideoMotionTierProbeTest(unittest.TestCase):
    def test_i420_total_height_is_even_for_arbitrary_counts(self) -> None:
        #WDD-gpt 2026-08-15 - 覆盖三通道轨迹块奇数高度，避免aomenc静默丢失最后一个时间帧。
        height = padded_plane_height(14_018, 576, 3)
        self.assertEqual(height, 26)
        self.assertEqual((height * 3) % 2, 0)

    def test_even_height_is_not_padded_again(self) -> None:
        self.assertEqual(padded_plane_height(14_500, 576, 3), 26)


if __name__ == "__main__":
    unittest.main()
