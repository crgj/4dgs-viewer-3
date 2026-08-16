#!/usr/bin/env python3
"""Regression tests for connected-segment joint codec helpers."""

from __future__ import annotations

import unittest

import numpy as np

from joint15 import split_labels, validate_timeline
from compact40 import pack_bits


class Joint15Test(unittest.TestCase):
    def test_split_packed_labels_at_odd_segment_boundaries(self) -> None:
        labels = np.asarray([1, 2, 3, 4, 5], dtype=np.uint32)
        decoded = split_labels(pack_bits(labels, 3), [2, 3], 3)
        np.testing.assert_array_equal(decoded[0], labels[:2])
        np.testing.assert_array_equal(decoded[1], labels[2:])

    def test_split_level_labels(self) -> None:
        labels = np.asarray([1, 2, 3, 4, 5, 6], dtype=np.uint8)
        decoded = split_labels(labels.tobytes(), [1, 2], 8, values_per_gaussian=2)
        np.testing.assert_array_equal(decoded[0], labels[:2])
        np.testing.assert_array_equal(decoded[1], labels[2:])

    def test_timeline_allows_new_ids_but_requires_shared_frame(self) -> None:
        class Segment:
            def __init__(self, first: int, last: int, name: str) -> None:
                self.first_frame = first
                self.last_frame = last
                self.path = type("Path", (), {"name": name})()

        validate_timeline([Segment(180, 210, "a"), Segment(210, 240, "b")])
        with self.assertRaisesRegex(ValueError, "share one boundary"):
            validate_timeline([Segment(180, 210, "a"), Segment(211, 240, "b")])


if __name__ == "__main__":
    unittest.main()
