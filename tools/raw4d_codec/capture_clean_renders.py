#!/usr/bin/env python3
"""Capture deterministic clean RAW4D renders through Chrome DevTools Protocol."""

from __future__ import annotations

import argparse
import base64
import json
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import websocket


# WDD-gpt 2026-08-14 - 直接使用 CDP 保持同一浏览器与相机，避免人工截图引入质量评估偏差。
class CdpClient:
    def __init__(self, url: str) -> None:
        self.ws = websocket.create_connection(url, timeout=30)
        self.next_id = 1

    def close(self) -> None:
        self.ws.close()

    def call(self, method: str, params: dict | None = None) -> dict:
        message_id = self.next_id
        self.next_id += 1
        self.ws.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        while True:
            message = json.loads(self.ws.recv())
            if message.get("id") != message_id:
                continue
            if "error" in message:
                raise RuntimeError(f"CDP {method} failed: {message['error']}")
            return message.get("result", {})


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_json(url: str, timeout: float = 15.0) -> list[dict]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                return json.load(response)
        except Exception:
            time.sleep(0.1)
    raise TimeoutError(f"Chrome debugging endpoint did not start: {url}")


def evaluate(cdp: CdpClient, expression: str):
    result = cdp.call("Runtime.evaluate", {
        "expression": expression,
        "returnByValue": True,
        "awaitPromise": True,
    })
    if result.get("exceptionDetails"):
        raise RuntimeError(result["exceptionDetails"])
    return result.get("result", {}).get("value")


def wait_until(cdp: CdpClient, expression: str, timeout: float, label: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = evaluate(cdp, expression)
        if value:
            return
        time.sleep(0.2)
    body = evaluate(cdp, "document.body?.innerText || ''")
    raise TimeoutError(f"Timed out waiting for {label}. Page text: {body[-1000:]}")


def upload_raw4d(cdp: CdpClient, path: Path) -> None:
    document = cdp.call("DOM.getDocument", {"depth": 1})
    node = cdp.call("DOM.querySelector", {
        "nodeId": document["root"]["nodeId"],
        "selector": "input[type=file]",
    })
    if not node.get("nodeId"):
        raise RuntimeError("RAW4D file input was not found")
    cdp.call("DOM.setFileInputFiles", {"nodeId": node["nodeId"], "files": [str(path)]})
    expected_name = json.dumps(path.name)
    wait_until(
        cdp,
        f"""
        (() => {{
          const root = document.querySelector('main');
          return root?.dataset.sourceName === {expected_name}
            && root?.dataset.statusPhase === 'ready';
        }})()
        """,
        120,
        f"RAW4D ready: {path.name}",
    )
    #WDD-gpt 2026-08-15 - 按目标文件名和加载阶段双重等待，禁止把空场景或上一资产的ready状态当成新文件完成。


def set_frame(cdp: CdpClient, frame: int) -> None:
    evaluate(cdp, f"""
        (() => {{
          const input = document.querySelector('input[aria-label="当前时间轴帧"]');
          if (!input) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, {frame!r});
          input.dispatchEvent(new Event('input', {{ bubbles: true }}));
          input.dispatchEvent(new Event('change', {{ bubbles: true }}));
          return true;
        }})()
    """)


def set_evaluation_camera(cdp: CdpClient, camera: dict) -> None:
    pose = {
        "position": camera["position"],
        "rotation": camera["rotation"],
        "fx": camera["fx"],
        "sourceWidth": camera["width"],
    }
    deadline = time.monotonic() + 15
    last_error: RuntimeError | None = None
    while time.monotonic() < deadline:
        try:
            applied = evaluate(
                cdp,
                f"""
                (() => {{
                  const runtime = window.__wddViewportRuntime;
                  if (!runtime) return false;
                  runtime.setEvaluationCamera({json.dumps(pose)});
                  return true;
                }})()
                """,
            )
            if applied:
                return
        except RuntimeError as error:
            last_error = error
        time.sleep(0.2)
    #WDD-gpt 2026-08-15 - 新浏览器中状态栏可能先于PlayCanvas相机就绪，显式重试避免评估偶发失败。
    if last_error is not None:
        raise RuntimeError("Viewport evaluation camera did not become ready") from last_error
    raise RuntimeError("Viewport evaluation camera API is unavailable")


def capture_assets(
    url: str,
    assets: list[tuple[str, Path]],
    output_root: Path,
    frames: list[int],
    wheel_steps: int,
    pan_y: int,
    settle_ms: int,
    skip_first_asset_capture: bool = False,
    evaluation_cameras: list[tuple[int, dict]] | None = None,
) -> dict:
    chrome = shutil.which("google-chrome") or shutil.which("chromium")
    if not chrome:
        raise RuntimeError("Google Chrome or Chromium is required")
    port = free_port()
    profile = tempfile.TemporaryDirectory(prefix="raw4d-capture-")
    process = subprocess.Popen([
        chrome,
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--enable-gpu",
        "--enable-unsafe-webgpu",
        "--ignore-gpu-blocklist",
        "--remote-allow-origins=*",
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile.name}",
        "--window-size=1280,720",
        "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cdp: CdpClient | None = None
    started = time.perf_counter()
    summary: dict = {"url": url, "frames": frames, "assets": {}}
    try:
        pages = wait_json(f"http://127.0.0.1:{port}/json/list")
        page = next(item for item in pages if item.get("type") == "page")
        cdp = CdpClient(page["webSocketDebuggerUrl"])
        cdp.call("Page.enable")
        cdp.call("DOM.enable")
        cdp.call("Runtime.enable")
        cdp.call("Emulation.setDeviceMetricsOverride", {
            "width": 1280,
            "height": 720,
            "deviceScaleFactor": 1,
            "mobile": False,
        })
        cdp.call("Page.navigate", {"url": url})
        wait_until(cdp, "document.querySelector('canvas') !== null", 30, "viewport canvas")

        for asset_index, (label, path) in enumerate(assets):
            asset_started = time.perf_counter()
            upload_raw4d(cdp, path)
            if asset_index == 0:
                for _ in range(wheel_steps):
                    cdp.call("Input.dispatchMouseEvent", {
                        "type": "mouseWheel",
                        "x": 640,
                        "y": 360,
                        "deltaX": 0,
                        "deltaY": -160,
                    })
                    time.sleep(0.04)
                if pan_y:
                    cdp.call("Input.dispatchMouseEvent", {
                        "type": "mousePressed", "x": 640, "y": 360,
                        "button": "right", "buttons": 2, "clickCount": 1,
                    })
                    cdp.call("Input.dispatchMouseEvent", {
                        "type": "mouseMoved", "x": 640, "y": 360 + pan_y,
                        "button": "right", "buttons": 2,
                    })
                    cdp.call("Input.dispatchMouseEvent", {
                        "type": "mouseReleased", "x": 640, "y": 360 + pan_y,
                        "button": "right", "buttons": 0, "clickCount": 1,
                    })
                time.sleep(0.5)

            #WDD-gpt 2026-08-15 - 长序列可只用首资产锁定相机，避免重复截图导致CDP长任务超时。
            if asset_index == 0 and skip_first_asset_capture:
                summary["assets"][label] = {
                    "path": str(path),
                    "camera_anchor_only": True,
                    "seconds": time.perf_counter() - asset_started,
                }
                continue

            output_dir = output_root / label
            output_dir.mkdir(parents=True, exist_ok=True)
            for frame in frames:
                set_frame(cdp, frame)
                cameras = evaluation_cameras or [(None, None)]
                for camera_index, camera in cameras:
                    if camera is not None:
                        set_evaluation_camera(cdp, camera)
                    time.sleep(settle_ms / 1000)
                    screenshot = cdp.call("Page.captureScreenshot", {
                        "format": "png",
                        "fromSurface": True,
                        "captureBeyondViewport": False,
                    })
                    suffix = "" if camera_index is None else f"_camera_{camera_index:03d}"
                    (output_dir / f"frame_{frame:03d}{suffix}.png").write_bytes(
                        base64.b64decode(screenshot["data"])
                    )
            summary["assets"][label] = {
                "path": str(path),
                "output_dir": str(output_dir),
                "seconds": time.perf_counter() - asset_started,
            }
        summary["total_seconds"] = time.perf_counter() - started
        return summary
    finally:
        if cdp is not None:
            cdp.close()
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        profile.cleanup()


def parse_asset(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("asset must be LABEL=/absolute/path.raw4d")
    label, raw_path = value.split("=", 1)
    path = Path(raw_path).resolve()
    if not label or not path.is_file():
        raise argparse.ArgumentTypeError(f"invalid asset: {value}")
    return label, path


def parse_frames(value: str) -> list[int]:
    frames: list[int] = []
    for part in value.split(","):
        if ":" in part:
            start, end = (int(number) for number in part.split(":", 1))
            frames.extend(range(start, end + 1))
        else:
            frames.append(int(part))
    return frames


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:4173/?capture=1")
    parser.add_argument("--asset", action="append", required=True, type=parse_asset)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--frames", default="0:30", type=parse_frames)
    parser.add_argument("--wheel-steps", default=8, type=int)
    parser.add_argument("--pan-y", default=-100, type=int)
    parser.add_argument("--settle-ms", default=250, type=int)
    parser.add_argument("--skip-first-asset-capture", action="store_true")
    parser.add_argument("--cameras-json", type=Path)
    parser.add_argument("--camera-indices", type=parse_frames)
    args = parser.parse_args()
    evaluation_cameras = None
    if args.cameras_json:
        cameras = json.loads(args.cameras_json.read_text(encoding="utf-8"))
        indices = args.camera_indices or list(range(len(cameras)))
        if any(index < 0 or index >= len(cameras) for index in indices):
            raise ValueError("Camera index is outside cameras.json")
        #WDD-gpt 2026-08-15 - 训练相机列表按显式索引采样，保证多视角验收可复现且不会默默换视角。
        evaluation_cameras = [(index, cameras[index]) for index in indices]
    result = capture_assets(
        args.url,
        args.asset,
        args.output_root.resolve(),
        args.frames,
        args.wheel_steps,
        args.pan_y,
        args.settle_ms,
        args.skip_first_asset_capture,
        evaluation_cameras,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
