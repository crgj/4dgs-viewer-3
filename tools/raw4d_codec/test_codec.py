import tempfile
import unittest
from pathlib import Path

import numpy as np

from codec import (
    CONTAINER_MAGIC,
    decode_quaternions,
    encode_positions,
    encode_quaternions,
    load_rows,
    interpolate_masked_positions,
    pack_xyz,
    read_raw4d_layout,
    read_container,
    unpack_xyz,
    write_container,
)


#WDD-gpt 2026-08-14 - 覆盖位打包、四元数和轨迹误差硬门，防止格式实现悄然漂移。
class CodecTests(unittest.TestCase):
    def test_fp16_raw4d_layout_reinterprets_ushort_payload(self) -> None:
        values = np.asarray([[1.5, -2.25], [0.125, 16.0]], dtype="<f2")
        header = "\n".join([
            "ply",
            "format binary_little_endian 1.0",
            "comment total_frames 1",
            "comment fp16_quantized 1",
            "comment fp16_property x",
            "comment fp16_property y",
            "element vertex 2",
            "property ushort x",
            "property ushort y",
            "end_header",
            "",
        ]).encode("ascii")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "quantized.raw4d"
            path.write_bytes(header + values.tobytes())
            layout = read_raw4d_layout(path)
            rows = load_rows(layout)
            self.assertEqual(layout.scalar_encoding, "float16")
            self.assertEqual(layout.scalar_bytes, 2)
            np.testing.assert_array_equal(np.asarray(rows, dtype=np.float32), values.astype(np.float32))

    def test_xyz_roundtrip(self) -> None:
        rng = np.random.default_rng(9)
        bits = (11, 10, 11)
        q = np.column_stack([
            rng.integers(0, 1 << bits[0], 1000),
            rng.integers(0, 1 << bits[1], 1000),
            rng.integers(0, 1 << bits[2], 1000),
        ]).astype(np.uint16)
        np.testing.assert_array_equal(unpack_xyz(pack_xyz(q, bits), bits), q)

    def test_xyz_wide_roundtrip(self) -> None:
        rng = np.random.default_rng(19)
        bits = (14, 14, 14)
        q = rng.integers(0, 1 << 14, size=(1000, 3), dtype=np.uint16)
        packed = pack_xyz(q, bits)
        self.assertEqual(packed.dtype, np.dtype("<u8"))
        np.testing.assert_array_equal(unpack_xyz(packed, bits), q)

    def test_quaternion_10bit_bound(self) -> None:
        rng = np.random.default_rng(10)
        values = rng.normal(size=(4096, 2, 4)).astype(np.float32)
        packed, metrics = encode_quaternions(values)
        decoded = decode_quaternions(packed, values.shape[:-1])
        self.assertEqual(decoded.shape, values.shape)
        self.assertLess(metrics["maximum_angular_error_degrees"], 1.0)

    def test_position_simplification_and_serialized_bound(self) -> None:
        frames = list(range(0, 31, 3))
        t = np.asarray(frames, dtype=np.float32)
        positions = np.zeros((64, len(frames), 3), dtype=np.float32)
        positions[:, :, 0] = t[None, :] * np.linspace(0, 0.03, 64)[:, None]
        positions[:, :, 1] = np.linspace(-1, 1, 64)[:, None]
        positions[32:, 5, 2] = 0.01
        masks, knots, metadata = encode_positions(positions, frames, 0.00045, 0.001)
        decoded = interpolate_masked_positions(
            masks,
            knots,
            frames,
            np.asarray(metadata["minimum"], dtype=np.float32),
            np.asarray(metadata["maximum"], dtype=np.float32),
            tuple(metadata["bits_xyz"]),
        )
        error = np.linalg.norm(decoded - positions, axis=2)
        self.assertLessEqual(float(np.max(error)), metadata["scene_diagonal"] * 0.001001)
        self.assertLess(metadata["average_knots"], len(frames))


if __name__ == "__main__":
    unittest.main()
