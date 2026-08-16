from __future__ import annotations

import numpy as np

import visualrate39


def test_alpha_logit_round_trip() -> None:
    alpha = np.asarray([0.01, 0.25, 0.5, 0.75, 0.99], dtype=np.float32)
    decoded = 1 / (1 + np.exp(-visualrate39._alpha_to_logit(alpha)))
    np.testing.assert_allclose(decoded, alpha, atol=1e-6)


def test_lifetime_stream_round_trip() -> None:
    mu = np.asarray([0.0, 10.25, 30.0], dtype=np.float32)
    width = np.asarray([0.0, 2.25, 3.0], dtype=np.float32)
    streams = []
    decoded_mu, decoded_width, metadata = visualrate39.encode_lifetime(streams, mu, width, 1)
    raw_streams = {stream.name: stream.raw for stream in streams}
    actual_mu, actual_width = visualrate39.decode_lifetime(raw_streams, metadata, mu.size)
    np.testing.assert_array_equal(actual_mu, decoded_mu)
    np.testing.assert_array_equal(actual_width, decoded_width)


def test_stream_categories_cover_profile() -> None:
    assert visualrate39._stream_category("position_tier0_av1") == "position"
    assert visualrate39._stream_category("rotation_st_modes") == "rotation"
    assert visualrate39._stream_category("color_block_ranges") == "color_dc"
    assert visualrate39._stream_category("visual_scale_base_0_labels") == "scale"
    assert visualrate39._stream_category("opacity_alpha_b8") == "opacity"
    assert visualrate39._stream_category("lifetime_boundary_q") == "lifetime"
    assert visualrate39._stream_category("coresh5r") == "sh"
