#!/usr/bin/env python3
"""Assemble a YOLO dataset for WaymoNet with an HONEST by-camera split.

Positives  = synthetic dome composites (data/synthetic), each tagged with source camera.
Negatives  = real JamCam frames with NO label (Ultralytics background convention):
             - MATCHED: the exact source frame each positive was pasted onto (differs from
               the positive only by the dome -> forces the model onto the dome, not the car)
             - EXTRA:   a sample of other real frames (ordinary London traffic) up to the ratio
Split      = BY CAMERA FEED — whole feeds held out for val; a synthetic inherits its source
             camera's split, so the dome'd and un-dome'd versions of a scene never straddle it.

v0 is 1-class (waymo). The 2-class (waymo+wayve) upgrade plugs in once Wayve roof-bar
imagery is harvested and a class-1 paste is added to make_synthetic.
"""
import glob
import json
import os
import random
import shutil

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYN_IMG = os.path.join(BASE, "data", "synthetic", "images")
SYN_LBL = os.path.join(BASE, "data", "synthetic", "labels")
MANIFEST = os.path.join(BASE, "data", "synthetic", "manifest.json")
FRAMES = os.path.join(BASE, "data", "frames")
OUT = os.path.join(BASE, "data", "dataset")
VAL_FRACTION = 0.15   # hold out ~15% of positive-bearing camera feeds for val
NEG_RATIO = 3.0       # extra plain negatives per positive (matched negs are added on top)
SEED = 7


def camera_of(frame_path):
    return os.path.basename(os.path.dirname(os.path.dirname(frame_path)))


def reset():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    for split in ("train", "val"):
        os.makedirs(os.path.join(OUT, "images", split), exist_ok=True)
        os.makedirs(os.path.join(OUT, "labels", split), exist_ok=True)


def main():
    random.seed(SEED)
    reset()
    manifest = {m["name"]: m for m in json.load(open(MANIFEST))}
    pos_cams = sorted({m["camera"] for m in manifest.values()})
    random.Random(13).shuffle(pos_cams)
    VAL_CAMS = set(pos_cams[:max(1, int(len(pos_cams) * VAL_FRACTION))])
    counts = {"train": {"pos": 0, "neg": 0}, "val": {"pos": 0, "neg": 0}}

    # 1) positives + their matched negatives
    matched_sources = set()
    for name, m in manifest.items():
        split = "val" if m["camera"] in VAL_CAMS else "train"
        shutil.copy(os.path.join(SYN_IMG, name + ".jpg"), os.path.join(OUT, "images", split, name + ".jpg"))
        shutil.copy(os.path.join(SYN_LBL, name + ".txt"), os.path.join(OUT, "labels", split, name + ".txt"))
        counts[split]["pos"] += 1
        src = os.path.join(BASE, m["source_frame"])
        if os.path.exists(src):
            dst = os.path.join(OUT, "images", split, "neg_matched_" + name + ".jpg")  # no label = background
            shutil.copy(src, dst)
            counts[split]["neg"] += 1
            matched_sources.add(os.path.abspath(src))

    # 2) extra plain negatives (ordinary London frames), by camera, up to the ratio
    all_frames = [f for f in glob.glob(os.path.join(FRAMES, "**", "*.jpg"), recursive=True)
                  if os.path.abspath(f) not in matched_sources]
    random.shuffle(all_frames)
    targets = {s: int(counts[s]["pos"] * NEG_RATIO) for s in ("train", "val")}
    added = {"train": 0, "val": 0}
    for f in all_frames:
        split = "val" if camera_of(f) in VAL_CAMS else "train"
        if added[split] >= targets[split]:
            continue
        dst = os.path.join(OUT, "images", split, "neg_" + camera_of(f) + "_" + os.path.basename(f))
        shutil.copy(f, dst)
        counts[split]["neg"] += 1
        added[split] += 1

    yaml = (f"# WaymoNet dataset (v0, 1-class). Powered by TfL Open Data.\n"
            f"path: {OUT}\ntrain: images/train\nval: images/val\n"
            f"nc: 1\nnames:\n  0: waymo\n")
    open(os.path.join(OUT, "dataset.yaml"), "w").write(yaml)

    print(f"dataset -> {OUT}")
    for s in ("train", "val"):
        n_img = len(os.listdir(os.path.join(OUT, "images", s)))
        print(f"  {s}: {counts[s]['pos']} positives + {counts[s]['neg']} negatives = {n_img} images")
    print(f"  val held-out cameras: {sorted(VAL_CAMS)}")
    print(f"  dataset.yaml written")


if __name__ == "__main__":
    main()
