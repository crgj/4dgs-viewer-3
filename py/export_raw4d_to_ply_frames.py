#!/usr/bin/env python3
"""Dequantize RAW4D and export one standard float32 PLY per frame.

This script is deliberately independent of the Mirrortime training/rendering
modules.  Its only non-stdlib dependencies are NumPy and plyfile.

Each input ``.raw4d`` is processed through this pipeline:

1. reinterpret the recorded ``ushort`` properties as IEEE float16 values;
2. restore them into a temporary float32 Master PLY4;
3. evaluate every requested integer frame into a static float32 3DGS PLY;
4. remove the temporary PLY4 automatically.

For every integer frame it evaluates the current PLY4 semantics:

* xyz: linear interpolation in world space
* rotation: normalized shortest-path WXYZ SLERP
* SH DC: linear interpolation in coefficient space
* scale: linear interpolation of raw log-scales
* base opacity: linear interpolation of raw logits, then sigmoid
* lifetime: parametric gate using lifetime_mu/lifetime_w when available

The output is a conventional static 3DGS PLY containing ``x/y/z``, normals,
SH coefficients, final opacity as a logit, raw ``scale_0..2``, and normalized
``rot_0..3``.  It contains no lifetime fields or temporal banks.

Examples::

    python export_raw4d_to_ply_frames.py \
        --input segment_180_210.raw4d \
        --output-dir frames

    # Export only local frames 5..10 and drop final alpha <= 0.01
    python export_raw4d_to_ply_frames.py \
        --input segment_180_210.raw4d \
        --output-dir frames \
        --start-frame 5 --end-frame 10 \
        --opacity-threshold 0.01

For a range-named input such as ``segment_180_210.raw4d``, output names are
automatically global (``frame_000180.ply`` ... ``frame_000210.ply``).  For an
input directory, each source gets a separate output subdirectory.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import os
from pathlib import Path
import re
import stat
import tempfile
from typing import Sequence

import numpy as np
from plyfile import PlyData, PlyElement, PlyListProperty


RANGE_PATTERN = re.compile(r"(?:^|_)(\d+)_(\d+)\.raw4d$")
FP16_MARKER = "fp16_quantized 1"
FP16_PROPERTY_PREFIX = "fp16_property "


@dataclass(frozen=True)
class Bank:
    values: np.ndarray
    key_times: np.ndarray


@dataclass
class MasterPly4:
    source_path: Path
    plydata: PlyData
    total_frames: int
    point_count: int
    xyz: np.ndarray
    normals: np.ndarray
    features_dc: np.ndarray
    features_rest: np.ndarray
    scales: np.ndarray
    opacity_logits: np.ndarray
    rotations: np.ndarray
    lifetime_mu: np.ndarray | None
    lifetime_w: np.ndarray | None
    lifetime_bank: np.ndarray | None
    xyz_bank: Bank | None
    rot_bank: Bank | None
    dc_bank: Bank | None
    scale_bank: Bank | None
    opacity_bank: Bank | None


def stable_sigmoid(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float64)
    result = np.empty_like(values)
    nonnegative = values >= 0.0
    result[nonnegative] = 1.0 / (1.0 + np.exp(-values[nonnegative]))
    exp_values = np.exp(values[~nonnegative])
    result[~nonnegative] = exp_values / (1.0 + exp_values)
    return result


def alpha_to_logit(alpha: np.ndarray, epsilon: float) -> np.ndarray:
    clipped = np.clip(np.asarray(alpha, dtype=np.float64), epsilon, 1.0 - epsilon)
    return np.log(clipped / (1.0 - clipped)).astype(np.float32)


def normalize_quaternions(quaternions: np.ndarray, label: str) -> np.ndarray:
    quaternions = np.asarray(quaternions, dtype=np.float64)
    norms = np.linalg.norm(quaternions, axis=-1, keepdims=True)
    bad_count = int(np.count_nonzero((~np.isfinite(norms)) | (norms <= 1e-12)))
    if bad_count:
        raise ValueError(f"{label} contains {bad_count} invalid quaternion(s)")
    return quaternions / norms


def slerp_wxyz(q0: np.ndarray, q1: np.ndarray, weight: float) -> np.ndarray:
    q0 = normalize_quaternions(q0, "rotation bank left key")
    q1 = normalize_quaternions(q1, "rotation bank right key")
    dot = np.sum(q0 * q1, axis=1, keepdims=True)
    q1 = np.where(dot < 0.0, -q1, q1)
    dot = np.clip(np.abs(dot), 0.0, 1.0)

    result = np.empty_like(q0)
    near = dot[:, 0] > 0.9995
    if np.any(near):
        result[near] = (1.0 - weight) * q0[near] + weight * q1[near]
    far = ~near
    if np.any(far):
        theta = np.arccos(dot[far])
        sin_theta = np.sin(theta)
        left_weight = np.sin((1.0 - weight) * theta) / sin_theta
        right_weight = np.sin(weight * theta) / sin_theta
        result[far] = left_weight * q0[far] + right_weight * q1[far]
    return normalize_quaternions(result, "interpolated rotation").astype(np.float32)


def comment_int(comments: Sequence[str], key: str, *, required: bool) -> int | None:
    matches = []
    for comment in comments:
        parts = comment.split()
        if len(parts) == 2 and parts[0] == key:
            try:
                matches.append(int(parts[1]))
            except ValueError as exc:
                raise ValueError(f"Invalid PLY comment: {comment!r}") from exc
    if len(matches) > 1:
        raise ValueError(f"Duplicate '{key} VALUE' comments")
    if not matches:
        if required:
            raise ValueError(f"Missing required '{key} VALUE' comment")
        return None
    return matches[0]


def keyframe_times(total_frames: int, stride: int, bank_size: int, label: str) -> np.ndarray:
    if stride < 1:
        raise ValueError(f"{label} stride must be >= 1, got {stride}")
    times = list(range(0, total_frames, stride))
    if times[-1] != total_frames - 1:
        times.append(total_frames - 1)
    if len(times) != bank_size:
        raise ValueError(
            f"{label} bank has K={bank_size}, but total_frames={total_frames} "
            f"and stride={stride} require K={len(times)} at times {times}"
        )
    return np.asarray(times, dtype=np.int64)


def indexed_static_names(property_names: Sequence[str], prefix: str) -> list[str]:
    indexed = []
    for name in property_names:
        if name.startswith(prefix) and name[len(prefix):].isdigit():
            indexed.append((int(name[len(prefix):]), name))
    indexed.sort()
    indices = [index for index, _ in indexed]
    if indices and indices != list(range(len(indices))):
        raise ValueError(f"{prefix} property indices are not continuous: {indices}")
    return [name for _, name in indexed]


def load_component_bank(
    vertex,
    property_names: Sequence[str],
    *,
    pattern: re.Pattern[str],
    components: Sequence[str],
    total_frames: int,
    stride: int | None,
    label: str,
) -> Bank | None:
    slots: dict[int, set[str]] = {}
    for name in property_names:
        match = pattern.fullmatch(name)
        if match:
            index = int(match.group(1))
            component = match.group(2)
            slots.setdefault(index, set()).add(component)
    if not slots:
        return None

    indices = sorted(slots)
    if indices != list(range(len(indices))):
        raise ValueError(f"{label} bank indices are not continuous: {indices}")
    expected_components = set(components)
    for index in indices:
        if slots[index] != expected_components:
            raise ValueError(
                f"{label} bank key {index} components are {sorted(slots[index])}; "
                f"expected {sorted(expected_components)}"
            )
    if stride is None:
        raise ValueError(f"{label} bank exists but its stride comment is missing")

    values = np.stack(
        [
            np.stack(
                [
                    np.asarray(vertex[pattern_to_name(label, index, component)], dtype=np.float32)
                    for component in components
                ],
                axis=1,
            )
            for index in indices
        ],
        axis=1,
    )
    if not np.all(np.isfinite(values)):
        raise ValueError(f"{label} bank contains non-finite values")
    times = keyframe_times(total_frames, stride, len(indices), label)
    return Bank(values=values, key_times=times)


def pattern_to_name(label: str, index: int, component: str) -> str:
    if label == "xyz":
        return f"xyz_bank_{index}_{component}"
    if label == "rotation":
        return f"rot_bank_{index}_{component}"
    if label == "SH DC":
        return f"f_dc_bank_{index}_{component}"
    if label == "scale":
        return f"scale_bank_{index}_{component}"
    raise ValueError(f"Unsupported component bank label: {label}")


def load_scalar_bank(
    vertex,
    property_names: Sequence[str],
    *,
    pattern: re.Pattern[str],
    name_template: str,
    total_frames: int,
    stride: int | None,
    label: str,
    allow_infinity: bool,
) -> Bank | None:
    indices = sorted(
        int(match.group(1))
        for name in property_names
        if (match := pattern.fullmatch(name)) is not None
    )
    if not indices:
        return None
    if indices != list(range(len(indices))):
        raise ValueError(f"{label} bank indices are not continuous: {indices}")
    if stride is None:
        raise ValueError(f"{label} bank exists but its stride comment is missing")
    values = np.stack(
        [
            np.asarray(vertex[name_template.format(index=index)], dtype=np.float32)
            for index in indices
        ],
        axis=1,
    )[..., None]
    invalid = np.isnan(values) if allow_infinity else ~np.isfinite(values)
    if np.any(invalid):
        raise ValueError(f"{label} bank contains invalid values")
    times = keyframe_times(total_frames, stride, len(indices), label)
    return Bank(values=values, key_times=times)


def interpolate_linear(bank: Bank, frame: int, label: str) -> np.ndarray:
    values = bank.values
    times = bank.key_times
    exact = np.flatnonzero(times == frame)
    if exact.size:
        return values[:, int(exact[0])]

    right = int(np.searchsorted(times, frame, side="right"))
    left = right - 1
    if left < 0 or right >= len(times):
        raise ValueError(f"Frame {frame} is outside {label} bank time range")
    weight = float(frame - times[left]) / float(times[right] - times[left])
    result = (1.0 - weight) * values[:, left] + weight * values[:, right]
    if np.any(np.isnan(result)):
        raise ValueError(
            f"{label} interpolation at frame {frame} produced NaN, likely from "
            "opposite signed infinite logits"
        )
    return result


def interpolate_rotation(bank: Bank, frame: int) -> np.ndarray:
    times = bank.key_times
    exact = np.flatnonzero(times == frame)
    if exact.size:
        return normalize_quaternions(
            bank.values[:, int(exact[0])], "rotation bank key"
        ).astype(np.float32)
    right = int(np.searchsorted(times, frame, side="right"))
    left = right - 1
    weight = float(frame - times[left]) / float(times[right] - times[left])
    return slerp_wxyz(bank.values[:, left], bank.values[:, right], weight)


def require_finite(name: str, values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    bad_count = int(np.count_nonzero(~np.isfinite(values)))
    if bad_count:
        raise ValueError(f"Property group {name!r} contains {bad_count} non-finite values")
    return values


def dequantize_raw4d_to_ply4(raw4d_path: Path, ply4_path: Path) -> None:
    """Restore fp16 bit patterns from RAW4D into a temporary float32 PLY4."""
    print(f"Dequantizing RAW4D: {raw4d_path}")
    source = PlyData.read(str(raw4d_path), mmap="r")
    if len(source.elements) != 1 or source.elements[0].name != "vertex":
        raise ValueError(f"{raw4d_path} must contain only one vertex element")
    vertex = source["vertex"]
    if vertex.count <= 0:
        raise ValueError(f"{raw4d_path} has no vertices")
    if any(isinstance(prop, PlyListProperty) for prop in vertex.properties):
        raise ValueError(f"{raw4d_path} contains unsupported list properties")
    if not any(comment.strip() == FP16_MARKER for comment in source.comments):
        raise ValueError(
            f"{raw4d_path} is not RAW4D: missing exact '{FP16_MARKER}' comment"
        )

    property_names = [
        comment[len(FP16_PROPERTY_PREFIX):].strip()
        for comment in source.comments
        if comment.startswith(FP16_PROPERTY_PREFIX)
    ]
    if not property_names:
        # Compatibility with early RAW4D files which did not record a manifest.
        property_names = [
            prop.name
            for prop in vertex.properties
            if np.asarray(vertex[prop.name]).dtype.kind == "u"
            and np.asarray(vertex[prop.name]).dtype.itemsize == 2
        ]
    if not property_names:
        raise ValueError(f"{raw4d_path} has no fp16-bit properties")
    if len(property_names) != len(set(property_names)):
        raise ValueError(f"{raw4d_path} has duplicate fp16 property comments")

    known_names = set(vertex.data.dtype.names or ())
    missing = [name for name in property_names if name not in known_names]
    wrong_type = [
        name
        for name in property_names
        if name in known_names
        and not (
            np.asarray(vertex[name]).dtype.kind == "u"
            and np.asarray(vertex[name]).dtype.itemsize == 2
        )
    ]
    if missing or wrong_type:
        raise ValueError(
            f"{raw4d_path} has an invalid fp16 manifest; "
            f"missing={missing}, non-ushort={wrong_type}"
        )

    converted = set(property_names)
    dtype_fields = []
    for prop in vertex.properties:
        values = np.asarray(vertex[prop.name])
        dtype_fields.append(
            (prop.name, "f4" if prop.name in converted else values.dtype.str)
        )
    output = np.empty(vertex.count, dtype=np.dtype(dtype_fields))
    for prop in vertex.properties:
        name = prop.name
        values = np.asarray(vertex[name])
        if name in converted:
            # Normalize endian order before reinterpreting the raw 16 bits.
            native_bits = np.asarray(values, dtype=np.uint16)
            output[name] = native_bits.view(np.float16).astype(np.float32)
        else:
            output[name] = values

    comments = [
        comment
        for comment in source.comments
        if comment.strip() != FP16_MARKER
        and not comment.startswith(FP16_PROPERTY_PREFIX)
    ]
    output_element = PlyElement.describe(
        output,
        "vertex",
        comments=list(vertex.comments),
    )
    PlyData(
        [output_element],
        text=source.text,
        byte_order=source.byte_order,
        comments=comments,
        obj_info=list(source.obj_info),
    ).write(str(ply4_path))
    print(
        f"  restored {len(property_names)} properties for {vertex.count:,} points "
        f"into temporary float32 PLY4"
    )


def load_master_ply4(path: Path) -> MasterPly4:
    print(f"Loading: {path}")
    plydata = PlyData.read(str(path), mmap="r")
    if any(comment.strip() == FP16_MARKER for comment in plydata.comments):
        raise ValueError(
            f"Internal error: temporary PLY4 {path} is still fp16-quantized"
        )
    if len(plydata.elements) != 1 or plydata.elements[0].name != "vertex":
        raise ValueError(f"{path} must contain only one vertex element")
    vertex = plydata["vertex"]
    if vertex.count <= 0:
        raise ValueError(f"{path} has no vertices")
    if any(isinstance(prop, PlyListProperty) for prop in vertex.properties):
        raise ValueError(f"{path} contains unsupported list-valued vertex properties")
    property_names = list(vertex.data.dtype.names or ())
    required = {"x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2"}
    missing = sorted(required.difference(property_names))
    if missing:
        raise ValueError(f"{path} is missing properties: {missing}")

    total_frames = comment_int(plydata.comments, "total_frames", required=True)
    assert total_frames is not None
    if total_frames < 1:
        raise ValueError(f"total_frames must be >= 1, got {total_frames}")

    strides = {
        "xyz": comment_int(
            plydata.comments, "xyz_bank_keyframe_stride", required=False
        ),
        "rotation": comment_int(
            plydata.comments, "rot_bank_keyframe_stride", required=False
        ),
        "SH DC": comment_int(
            plydata.comments, "features_dc_bank_keyframe_stride", required=False
        ),
        "scale": comment_int(
            plydata.comments, "scaling_bank_keyframe_stride", required=False
        ),
        "opacity": comment_int(
            plydata.comments, "opacity_bank_keyframe_stride", required=False
        ),
    }

    def stack(names: Sequence[str], label: str) -> np.ndarray:
        if not names:
            return np.zeros((vertex.count, 0), dtype=np.float32)
        return require_finite(
            label,
            np.stack(
                [np.asarray(vertex[name], dtype=np.float32) for name in names], axis=1
            ),
        )

    xyz = stack(["x", "y", "z"], "xyz")
    normal_names = [name for name in ("nx", "ny", "nz") if name in property_names]
    normals = (
        stack(normal_names, "normals")
        if len(normal_names) == 3
        else np.zeros((vertex.count, 3), dtype=np.float32)
    )
    dc_names = indexed_static_names(property_names, "f_dc_")
    rest_names = indexed_static_names(property_names, "f_rest_")
    scale_names = indexed_static_names(property_names, "scale_")
    if len(dc_names) != 3:
        raise ValueError(f"Expected 3 f_dc properties, got {dc_names}")
    if len(scale_names) != 3:
        raise ValueError(f"Expected 3 scale properties, got {scale_names}")
    features_dc = stack(dc_names, "f_dc")
    features_rest = stack(rest_names, "f_rest")
    scales = stack(scale_names, "scale")

    opacity_logits = np.asarray(vertex["opacity"], dtype=np.float32)
    if np.any(np.isnan(opacity_logits)):
        raise ValueError("Base opacity contains NaN values")

    rot_names = indexed_static_names(property_names, "rot_")
    rotations = (
        stack(rot_names, "rotation")
        if len(rot_names) == 4
        else np.tile(
            np.asarray([[1.0, 0.0, 0.0, 0.0]], dtype=np.float32),
            (vertex.count, 1),
        )
    )
    if rot_names and len(rot_names) != 4:
        raise ValueError(f"Expected 4 rot properties or none, got {rot_names}")

    lifetime_mu = (
        require_finite("lifetime_mu", vertex["lifetime_mu"])
        if "lifetime_mu" in property_names
        else None
    )
    lifetime_w = (
        require_finite("lifetime_w", vertex["lifetime_w"])
        if "lifetime_w" in property_names
        else None
    )
    if (lifetime_mu is None) != (lifetime_w is None):
        raise ValueError("lifetime_mu and lifetime_w must either both exist or both be absent")

    lifetime_names = []
    for name in property_names:
        match = re.fullmatch(r"lifetime_(\d+)", name)
        if match:
            lifetime_names.append((int(match.group(1)), name))
    lifetime_names.sort()
    lifetime_bank = None
    if lifetime_names:
        indices = [index for index, _ in lifetime_names]
        if indices != list(range(len(indices))) or len(indices) != total_frames:
            raise ValueError(
                f"Legacy lifetime bank must have one entry per frame; got {indices}"
            )
        lifetime_bank = stack([name for _, name in lifetime_names], "lifetime bank")

    xyz_bank = load_component_bank(
        vertex,
        property_names,
        pattern=re.compile(r"xyz_bank_(\d+)_(x|y|z)"),
        components=("x", "y", "z"),
        total_frames=total_frames,
        stride=strides["xyz"],
        label="xyz",
    )
    rot_bank = load_component_bank(
        vertex,
        property_names,
        pattern=re.compile(r"rot_bank_(\d+)_(w|x|y|z)"),
        components=("w", "x", "y", "z"),
        total_frames=total_frames,
        stride=strides["rotation"],
        label="rotation",
    )
    dc_bank = load_component_bank(
        vertex,
        property_names,
        pattern=re.compile(r"f_dc_bank_(\d+)_(0|1|2)"),
        components=("0", "1", "2"),
        total_frames=total_frames,
        stride=strides["SH DC"],
        label="SH DC",
    )
    scale_bank = load_component_bank(
        vertex,
        property_names,
        pattern=re.compile(r"scale_bank_(\d+)_(0|1|2)"),
        components=("0", "1", "2"),
        total_frames=total_frames,
        stride=strides["scale"],
        label="scale",
    )
    opacity_bank = load_scalar_bank(
        vertex,
        property_names,
        pattern=re.compile(r"opacity_bank_(\d+)"),
        name_template="opacity_bank_{index}",
        total_frames=total_frames,
        stride=strides["opacity"],
        label="opacity",
        allow_infinity=True,
    )

    if rot_bank is not None:
        normalize_quaternions(rot_bank.values, "rotation bank")
    else:
        rotations = normalize_quaternions(rotations, "base rotation").astype(np.float32)

    print(
        f"  points={vertex.count:,}, frames={total_frames}, "
        f"banks xyz/rot/dc/scale/opacity="
        f"{xyz_bank is not None}/{rot_bank is not None}/{dc_bank is not None}/"
        f"{scale_bank is not None}/{opacity_bank is not None}"
    )
    return MasterPly4(
        source_path=path,
        plydata=plydata,
        total_frames=total_frames,
        point_count=vertex.count,
        xyz=xyz,
        normals=normals,
        features_dc=features_dc,
        features_rest=features_rest,
        scales=scales,
        opacity_logits=opacity_logits,
        rotations=rotations,
        lifetime_mu=lifetime_mu,
        lifetime_w=lifetime_w,
        lifetime_bank=lifetime_bank,
        xyz_bank=xyz_bank,
        rot_bank=rot_bank,
        dc_bank=dc_bank,
        scale_bank=scale_bank,
        opacity_bank=opacity_bank,
    )


def lifetime_gate(model: MasterPly4, frame: int, gate_k: float) -> np.ndarray:
    if model.lifetime_mu is not None and model.lifetime_w is not None:
        left = stable_sigmoid(
            gate_k * (frame - (model.lifetime_mu - model.lifetime_w))
        )
        right = stable_sigmoid(
            gate_k * ((model.lifetime_mu + model.lifetime_w) - frame)
        )
        return left * right
    if model.lifetime_bank is not None:
        return stable_sigmoid(model.lifetime_bank[:, frame])
    return np.ones(model.point_count, dtype=np.float64)


def evaluate_frame(
    model: MasterPly4,
    frame: int,
    *,
    lifetime_gate_k: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    xyz = (
        interpolate_linear(model.xyz_bank, frame, "xyz")
        if model.xyz_bank is not None
        else model.xyz
    )
    rotation = (
        interpolate_rotation(model.rot_bank, frame)
        if model.rot_bank is not None
        else model.rotations
    )
    features_dc = (
        interpolate_linear(model.dc_bank, frame, "SH DC")
        if model.dc_bank is not None
        else model.features_dc
    )
    scales = (
        interpolate_linear(model.scale_bank, frame, "scale")
        if model.scale_bank is not None
        else model.scales
    )
    raw_opacity = (
        interpolate_linear(model.opacity_bank, frame, "opacity")[:, 0]
        if model.opacity_bank is not None
        else model.opacity_logits
    )
    final_alpha = stable_sigmoid(raw_opacity) * lifetime_gate(
        model, frame, lifetime_gate_k
    )
    if np.any(~np.isfinite(final_alpha)):
        raise ValueError(f"Final opacity contains invalid values at frame {frame}")
    return xyz, rotation, features_dc, scales, final_alpha, model.normals


def output_dtype(model: MasterPly4) -> np.dtype:
    fields = [
        ("x", "f4"), ("y", "f4"), ("z", "f4"),
        ("nx", "f4"), ("ny", "f4"), ("nz", "f4"),
    ]
    fields.extend((f"f_dc_{index}", "f4") for index in range(3))
    fields.extend(
        (f"f_rest_{index}", "f4")
        for index in range(model.features_rest.shape[1])
    )
    fields.append(("opacity", "f4"))
    fields.extend((f"scale_{index}", "f4") for index in range(3))
    fields.extend((f"rot_{index}", "f4") for index in range(4))
    return np.dtype(fields)


def build_output_array(
    model: MasterPly4,
    frame: int,
    *,
    lifetime_gate_k: float,
    opacity_threshold: float | None,
    opacity_epsilon: float,
) -> tuple[np.ndarray, int]:
    xyz, rotation, features_dc, scales, final_alpha, normals = evaluate_frame(
        model, frame, lifetime_gate_k=lifetime_gate_k
    )
    if opacity_threshold is None:
        keep = np.ones(model.point_count, dtype=bool)
    else:
        keep = final_alpha > opacity_threshold

    kept_count = int(np.count_nonzero(keep))
    output = np.empty(kept_count, dtype=output_dtype(model))
    for index, name in enumerate(("x", "y", "z")):
        output[name] = xyz[keep, index]
    for index, name in enumerate(("nx", "ny", "nz")):
        output[name] = normals[keep, index]
    for index in range(3):
        output[f"f_dc_{index}"] = features_dc[keep, index]
    for index in range(model.features_rest.shape[1]):
        output[f"f_rest_{index}"] = model.features_rest[keep, index]
    output["opacity"] = alpha_to_logit(final_alpha[keep], opacity_epsilon)
    for index in range(3):
        output[f"scale_{index}"] = scales[keep, index]
    for index in range(4):
        output[f"rot_{index}"] = rotation[keep, index]

    for name in output.dtype.names or ():
        if not np.all(np.isfinite(output[name])):
            raise ValueError(f"Output property {name} is non-finite at frame {frame}")
    return output, model.point_count - kept_count


def write_frame_ply(
    model: MasterPly4,
    output_array: np.ndarray,
    output_path: Path,
    *,
    local_frame: int,
    global_frame: int,
    overwrite: bool,
) -> None:
    if output_path.exists() and not overwrite:
        raise FileExistsError(
            f"Output already exists: {output_path} (use --overwrite to replace it)"
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    element = PlyElement.describe(output_array, "vertex")
    comments = [
        f"source_raw4d {model.source_path.name}",
        f"local_frame {local_frame}",
        f"global_frame {global_frame}",
    ]
    output_ply = PlyData(
        [element],
        text=False,
        byte_order=model.plydata.byte_order,
        comments=comments,
    )

    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=str(output_path.parent),
        prefix=f".{output_path.name}.",
        suffix=".tmp",
    )
    os.close(file_descriptor)
    temporary_path = Path(temporary_name)
    try:
        output_ply.write(str(temporary_path))
        os.chmod(
            temporary_path,
            stat.S_IMODE(model.source_path.stat().st_mode),
        )
        os.replace(temporary_path, output_path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def auto_frame_offset(path: Path, total_frames: int) -> int:
    match = RANGE_PATTERN.search(path.name)
    if match is None:
        return 0
    start, end = int(match.group(1)), int(match.group(2))
    if end - start + 1 != total_frames:
        raise ValueError(
            f"{path.name} implies {end - start + 1} frames, but PLY4 comment says "
            f"{total_frames}"
        )
    return start


def export_loaded_model(
    model: MasterPly4,
    input_path: Path,
    output_dir: Path,
    *,
    start_frame: int,
    end_frame: int | None,
    frame_offset: str,
    lifetime_gate_k: float,
    opacity_threshold: float | None,
    opacity_epsilon: float,
    overwrite: bool,
) -> dict[str, int]:
    last_frame = model.total_frames - 1 if end_frame is None else end_frame
    if not 0 <= start_frame <= last_frame < model.total_frames:
        raise ValueError(
            f"Requested local frame range {start_frame}..{last_frame}; valid range is "
            f"0..{model.total_frames - 1}"
        )
    offset = (
        auto_frame_offset(input_path, model.total_frames)
        if frame_offset == "auto"
        else int(frame_offset)
    )

    planned = [
        output_dir / f"frame_{offset + frame:06d}.ply"
        for frame in range(start_frame, last_frame + 1)
    ]
    existing = [path for path in planned if path.exists()]
    if existing and not overwrite:
        raise FileExistsError(
            f"{len(existing)} outputs already exist; first: {existing[0]}"
        )

    total_removed = 0
    for frame, output_path in zip(range(start_frame, last_frame + 1), planned):
        output_array, removed = build_output_array(
            model,
            frame,
            lifetime_gate_k=lifetime_gate_k,
            opacity_threshold=opacity_threshold,
            opacity_epsilon=opacity_epsilon,
        )
        write_frame_ply(
            model,
            output_array,
            output_path,
            local_frame=frame,
            global_frame=offset + frame,
            overwrite=overwrite,
        )
        total_removed += removed
        print(
            f"  frame local={frame} global={offset + frame}: "
            f"points={len(output_array):,}, removed={removed:,} -> {output_path}"
        )
    return {
        "files": len(planned),
        "source_points": model.point_count * len(planned),
        "removed": total_removed,
    }


def export_one(
    input_path: Path,
    output_dir: Path,
    *,
    start_frame: int,
    end_frame: int | None,
    frame_offset: str,
    lifetime_gate_k: float,
    opacity_threshold: float | None,
    opacity_epsilon: float,
    overwrite: bool,
) -> dict[str, int]:
    with tempfile.TemporaryDirectory(prefix=f"{input_path.stem}-f32-") as temp_dir:
        temporary_ply4 = Path(temp_dir) / f"{input_path.stem}.ply4"
        dequantize_raw4d_to_ply4(input_path, temporary_ply4)
        model = load_master_ply4(temporary_ply4)
        # Use the real source in output comments and permission handling.
        model.source_path = input_path
        return export_loaded_model(
            model,
            input_path,
            output_dir,
            start_frame=start_frame,
            end_frame=end_frame,
            frame_offset=frame_offset,
            lifetime_gate_k=lifetime_gate_k,
            opacity_threshold=opacity_threshold,
            opacity_epsilon=opacity_epsilon,
            overwrite=overwrite,
        )


def discover_jobs(input_path: Path, output_dir: Path) -> list[tuple[Path, Path]]:
    if input_path.is_file():
        if input_path.suffix.lower() != ".raw4d":
            raise ValueError(f"Input file must have a .raw4d suffix: {input_path}")
        return [(input_path, output_dir)]
    if input_path.is_dir():
        files = sorted(input_path.glob("*.raw4d"))
        if not files:
            raise FileNotFoundError(f"No .raw4d files found directly in {input_path}")
        return [(path, output_dir / path.stem) for path in files]
    raise FileNotFoundError(f"Input does not exist: {input_path}")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Dequantize RAW4D files and export one static float32 3DGS PLY per frame."
        )
    )
    parser.add_argument(
        "--input", "-i", type=Path, required=True, help=".raw4d file or directory"
    )
    parser.add_argument("--output-dir", "-o", type=Path, required=True)
    parser.add_argument("--start-frame", type=int, default=0, help="Local start, inclusive")
    parser.add_argument("--end-frame", type=int, help="Local end, inclusive (default: last)")
    parser.add_argument(
        "--frame-offset",
        default="auto",
        help="Global output frame offset, integer or auto from segment_A_B filename",
    )
    parser.add_argument("--lifetime-gate-k", type=float, default=10.0)
    parser.add_argument(
        "--opacity-threshold",
        type=float,
        default=None,
        help="Optionally omit points whose final alpha is <= this value",
    )
    parser.add_argument(
        "--opacity-epsilon",
        type=float,
        default=1e-6,
        help="Clamp final alpha to [epsilon, 1-epsilon] before storing logit",
    )
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args(argv)

    if args.start_frame < 0:
        parser.error("--start-frame must be >= 0")
    if args.end_frame is not None and args.end_frame < 0:
        parser.error("--end-frame must be >= 0")
    try:
        if args.frame_offset != "auto":
            int(args.frame_offset)
    except ValueError:
        parser.error("--frame-offset must be an integer or 'auto'")
    if not np.isfinite(args.lifetime_gate_k) or args.lifetime_gate_k <= 0:
        parser.error("--lifetime-gate-k must be finite and > 0")
    if args.opacity_threshold is not None and not 0 <= args.opacity_threshold < 1:
        parser.error("--opacity-threshold must be in [0, 1)")
    if not 0 < args.opacity_epsilon < 0.5:
        parser.error("--opacity-epsilon must be in (0, 0.5)")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    input_path = args.input.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    jobs = discover_jobs(input_path, output_dir)

    totals = {"files": 0, "source_points": 0, "removed": 0}
    for source, destination in jobs:
        result = export_one(
            source,
            destination,
            start_frame=args.start_frame,
            end_frame=args.end_frame,
            frame_offset=args.frame_offset,
            lifetime_gate_k=args.lifetime_gate_k,
            opacity_threshold=args.opacity_threshold,
            opacity_epsilon=args.opacity_epsilon,
            overwrite=args.overwrite,
        )
        for key in totals:
            totals[key] += result[key]

    print("\nDone")
    print(f"  source files: {len(jobs)}")
    print(f"  frame PLY files: {totals['files']}")
    print(f"  output: {output_dir}")
    if args.opacity_threshold is not None:
        print(
            f"  opacity-filtered rows: {totals['removed']:,} / "
            f"{totals['source_points']:,}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
