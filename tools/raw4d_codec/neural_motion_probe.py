#!/usr/bin/env python3
"""Probe a compact shared deformation field against RAW4D position tracks."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from codec import extract_track, load_rows, read_raw4d_layout


class MotionField(nn.Module):
    def __init__(self, frequencies: int, width: int, output_dimensions: int) -> None:
        super().__init__()
        self.frequencies = frequencies
        input_dimensions = 3 + 3 * frequencies * 2
        self.network = nn.Sequential(
            nn.Linear(input_dimensions, width),
            nn.SiLU(),
            nn.Linear(width, width),
            nn.SiLU(),
            nn.Linear(width, width),
            nn.SiLU(),
            nn.Linear(width, output_dimensions),
        )

    def encode(self, xyz: torch.Tensor) -> torch.Tensor:
        features = [xyz]
        for level in range(self.frequencies):
            phase = xyz * (2**level) * torch.pi
            features.extend([torch.sin(phase), torch.cos(phase)])
        return torch.cat(features, dim=1)

    def forward(self, xyz: torch.Tensor) -> torch.Tensor:
        return self.network(self.encode(xyz))


# WDD-gpt 2026-08-14 - 验证4DGC式共享形变场能否用小模型替代逐高斯固定轨迹标签。
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--steps", type=int, default=1200)
    parser.add_argument("--batch-size", type=int, default=65536)
    parser.add_argument("--width", type=int, default=192)
    parser.add_argument("--frequencies", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=0.002)
    args = parser.parse_args()

    torch.manual_seed(20260814)
    np.random.seed(20260814)
    layout = read_raw4d_layout(args.source)
    rows = load_rows(layout)
    positions, frames = extract_track(rows, layout, "xyz_bank", ("x", "y", "z"))
    xyz = positions[:, 0]
    target = (positions[:, 1:] - positions[:, :1]).reshape(positions.shape[0], -1)
    xyz_minimum = xyz.min(axis=0).astype(np.float32)
    xyz_maximum = xyz.max(axis=0).astype(np.float32)
    xyz_normalized = ((xyz - xyz_minimum) / np.maximum(xyz_maximum - xyz_minimum, 1e-8) * 2 - 1).astype(np.float32)
    target_mean = target.mean(axis=0).astype(np.float32)
    target_scale = np.maximum(target.std(axis=0), 1e-5).astype(np.float32)
    target_normalized = ((target - target_mean) / target_scale).astype(np.float32)

    device = torch.device("cuda")
    input_tensor = torch.from_numpy(xyz_normalized).to(device)
    target_tensor = torch.from_numpy(target_normalized).to(device)
    model = MotionField(args.frequencies, args.width, target.shape[1]).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-6)
    started = time.perf_counter()
    model.train()
    for step in range(args.steps):
        indices = torch.randint(0, input_tensor.shape[0], (args.batch_size,), device=device)
        prediction = model(input_tensor[indices])
        loss = torch.mean(torch.square(prediction - target_tensor[indices]))
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        if step in {0, args.steps // 4, args.steps // 2, args.steps * 3 // 4, args.steps - 1}:
            print(json.dumps({"step": step + 1, "loss": float(loss.detach())}), flush=True)

    model.eval()
    predictions: list[np.ndarray] = []
    with torch.no_grad():
        for first in range(0, input_tensor.shape[0], args.batch_size):
            normalized = model(input_tensor[first:first + args.batch_size])
            decoded = normalized * torch.from_numpy(target_scale).to(device) + torch.from_numpy(target_mean).to(device)
            predictions.append(decoded.cpu().numpy())
    predicted_motion = np.concatenate(predictions).reshape(positions.shape[0], positions.shape[1] - 1, 3)
    decoded_positions = np.concatenate([positions[:, :1], positions[:, :1] + predicted_motion], axis=1)
    vector_error = np.linalg.norm(decoded_positions - positions, axis=2)
    state = {name: value.detach().cpu().half().numpy() for name, value in model.state_dict().items()}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.output,
        **state,
        xyz_minimum=xyz_minimum,
        xyz_maximum=xyz_maximum,
        target_mean=target_mean,
        target_scale=target_scale,
        frames=np.asarray(frames, dtype=np.int16),
    )
    report = {
        "model_bytes": args.output.stat().st_size,
        "parameter_count": int(sum(parameter.numel() for parameter in model.parameters())),
        "training_seconds": time.perf_counter() - started,
        "position_rmse": float(np.sqrt(np.mean(np.square(decoded_positions - positions), dtype=np.float64))),
        "position_vector_mean": float(np.mean(vector_error)),
        "position_vector_p95": float(np.percentile(vector_error, 95)),
        "position_vector_p99": float(np.percentile(vector_error, 99)),
        "position_vector_maximum": float(np.max(vector_error)),
    }
    report_path = args.output.with_suffix(".json")
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
