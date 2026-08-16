import unittest

import numpy as np

from offline_render import (
    Track,
    interpolate_rotation,
    interpolate_track,
    normalize_rotation_track,
    track_span,
)


class OfflineRenderTests(unittest.TestCase):
    def test_track_span_uses_integer_keyframes(self) -> None:
        keyframes = np.asarray([0, 10, 20, 30], dtype=np.float32)
        self.assertEqual(track_span(keyframes, 0), (0, 0, 0.0))
        self.assertEqual(track_span(keyframes, 30), (3, 3, 0.0))
        self.assertEqual(track_span(keyframes, 15), (1, 2, 0.5))

    def test_linear_track_interpolation(self) -> None:
        track = Track(
            np.asarray([[[0, 1], [10, 21]]], dtype=np.float32),
            np.asarray([0, 10], dtype=np.float32),
        )
        np.testing.assert_allclose(interpolate_track(track, 5), [[5, 11]])

    def test_negative_infinity_opacity_remains_inactive_between_keys(self) -> None:
        track = Track(
            np.asarray([[[-np.inf], [-np.inf]]], dtype=np.float32),
            np.asarray([0, 10], dtype=np.float32),
        )
        self.assertTrue(np.isneginf(interpolate_track(track, 5)[0, 0]))

    def test_quaternion_slerp_normalizes_and_uses_shortest_path(self) -> None:
        values = normalize_rotation_track(
            np.asarray([[[1, 0, 0, 0], [-1, 0, 0, 0]]], dtype=np.float32)
        )
        track = Track(
            values,
            np.asarray([0, 10], dtype=np.float32),
        )
        result = interpolate_rotation(track, 5)
        np.testing.assert_allclose(np.abs(result), [[1, 0, 0, 0]], atol=1e-6)


if __name__ == "__main__":
    unittest.main()
