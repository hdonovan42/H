#!/usr/bin/env python3
"""Export yolo11n to OpenVINO INT8 for the CPU-only live loop (v0.5 coverage work).

Why: measured 2.7s CPU per clip on the VPS (torch backend) — one core's entire budget at
117 cams, and the Waymo zone is ~430 cams. INT8 OpenVINO typically gives 2-3.5x on CPU.

Calibration matters for INT8: we quantise against OUR domain — real JamCam frames
(352x288, low light, JPEG-degraded) sampled across cameras — not COCO photos.

Output: collector/models/yolo11n_int8_openvino_model/ (committed artifact; live_capture
prefers it over yolo11n.pt when present). Verify speed/accuracy with the printed bench.
"""
import glob
import os
import random
import shutil
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAMES = os.path.join(BASE, "data", "frames")
CALIB = os.path.join(BASE, "data", "calib")
OUT = os.path.join(BASE, "collector", "models")
N_CALIB = 300
IMGSZ = 352  # must match live inference size
SEED = 7


def build_calib():
    imgs = os.path.join(CALIB, "images")
    shutil.rmtree(CALIB, ignore_errors=True)
    os.makedirs(imgs)
    os.makedirs(os.path.join(CALIB, "labels"))  # empty = background images, loader accepts
    frames = sorted(glob.glob(os.path.join(FRAMES, "**", "*.jpg"), recursive=True))
    random.seed(SEED)
    random.shuffle(frames)
    # spread across cameras: round-robin by camera dir
    by_cam = {}
    for f in frames:
        by_cam.setdefault(f.split(os.sep)[-3], []).append(f)
    picked, i = [], 0
    while len(picked) < N_CALIB and any(by_cam.values()):
        for cam in list(by_cam):
            if by_cam[cam]:
                picked.append(by_cam[cam].pop())
            if len(picked) >= N_CALIB:
                break
        i += 1
    for n, f in enumerate(picked):
        shutil.copy(f, os.path.join(imgs, f"c{n:04d}.jpg"))
    yaml_path = os.path.join(CALIB, "calib.yaml")
    open(yaml_path, "w").write(
        f"path: {CALIB}\ntrain: images\nval: images\nnc: 80\n"
        "names: " + str([str(i) for i in range(80)]) + "\n")
    print(f"calibration set: {len(picked)} frames from {len(by_cam)} cameras -> {imgs}")
    return yaml_path


def main():
    from ultralytics import YOLO
    yaml_path = build_calib()
    model = YOLO("yolo11n.pt")
    path = model.export(format="openvino", int8=True, imgsz=IMGSZ, data=yaml_path)
    os.makedirs(OUT, exist_ok=True)
    dst = os.path.join(OUT, os.path.basename(str(path).rstrip("/")))
    shutil.rmtree(dst, ignore_errors=True)
    shutil.move(str(path), dst)
    print(f"exported -> {dst}")


if __name__ == "__main__":
    main()
