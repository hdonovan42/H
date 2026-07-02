#!/usr/bin/env python3
"""Confuser regression suite — the honest replacement for the "labelled-reject ceiling".

RUN_2's "0.22 confuser ceiling" was a sampling artifact: it was measured over already-caught
`status='reject'` rows, while the hardest confusers sat unlabelled in the new/near pool (#40294
scored 0.67 live and was never in the tally). This suite makes the ceiling a MEASURED number over
a FIXED set, re-run for every candidate weights file:

  CONFUSERS (max conf must stay under --bar):
    - curated galleries data/special/{funny,i-pac,roof-box,van_roof} — special IS NOT NULL rejects,
      held OUT of all training forever (trained=0): the generalisation read
    - data/hard_negatives/run2/ — the model's own live FPs incl. the novel tail #40294/#47783;
      these ARE RUN_3 training data (trained=1): the suppression read
  EDGE POSITIVES (informational recall floor): data/special/edge_positive — real but degraded
    Waymos, eval-only.

Usage:
  confuser_gate.py --export                 # on the VPS: build data/confuser_suite/ + manifest
  confuser_gate.py --weights W [--bar 0.67] # anywhere (GPU box / laptop): score + PASS/FAIL

RUN_3 ship gate = eval_gate recall >= RUN_2 on the pinned val AND this suite's confuser max < 0.67
(RUN_2's measured novel ceiling). The full-pool rescore top-N human check (GPU_RENT_NOTES) remains
the companion for confusers nobody has labelled yet. Powered by TfL Open Data.
"""
import argparse
import csv
import glob
import os
import shutil

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUITE = os.path.join(BASE, "data", "confuser_suite")
GALLERIES = ("funny", "i-pac", "roof-box", "van_roof")


def export(suite_dir):
    """Collect full frames (never crops) from the galleries + run2 hard negs into a portable
    suite dir with a manifest — bundled with the train tgz like dataset_real."""
    if os.path.isdir(suite_dir):
        shutil.rmtree(suite_dir)
    os.makedirs(suite_dir)
    rows = []
    src = [(os.path.join(BASE, "data", "special", g), g, "confuser", 0) for g in GALLERIES]
    src.append((os.path.join(BASE, "data", "hard_negatives", "run2"), "run2_hardneg", "confuser", 1))
    src.append((os.path.join(BASE, "data", "special", "edge_positive"), "edge_positive", "positive", 0))
    for d, group, kind, trained in src:
        files = sorted(glob.glob(os.path.join(d, "*_frame.jpg")))
        for f in files:
            name = f"{group}__{os.path.basename(f)}"
            shutil.copy(f, os.path.join(suite_dir, name))
            rows.append({"name": name, "group": group, "kind": kind, "trained": trained})
        print(f"  {group}: {len(files)} frames ({'trained' if trained else 'held-out'})")
    with open(os.path.join(suite_dir, "manifest.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["name", "group", "kind", "trained"])
        w.writeheader()
        w.writerows(rows)
    print(f"suite -> {suite_dir}  ({len(rows)} frames + manifest.csv)")


def score(suite_dir, weights, imgsz, bar):
    from ultralytics import YOLO
    model = YOLO(weights)
    rows = list(csv.DictReader(open(os.path.join(suite_dir, "manifest.csv"))))
    for r in rows:                       # per-frame predict — NEVER a list (the 15.4 GB OOM rule)
        p = os.path.join(suite_dir, r["name"])
        res = model.predict(p, conf=0.01, verbose=False, imgsz=imgsz)[0]
        r["conf"] = max((float(b.conf[0]) for b in res.boxes), default=0.0)

    print(f"weights: {weights} | suite: {len(rows)} frames\n")
    print(f"{'group':<15} {'n':>4} {'max':>6} {'mean':>6}  top offender")
    for g in sorted({r["group"] for r in rows}):
        sub = sorted((r for r in rows if r["group"] == g), key=lambda r: -r["conf"])
        confs = [r["conf"] for r in sub]
        print(f"{g:<15} {len(sub):>4} {max(confs):>6.3f} {sum(confs)/len(confs):>6.3f}  "
              f"{sub[0]['name']} ({sub[0]['conf']:.3f})")

    conf_rows = [r for r in rows if r["kind"] == "confuser"]
    held = max((r["conf"] for r in conf_rows if r["trained"] in (0, "0")), default=0.0)
    trained = max((r["conf"] for r in conf_rows if r["trained"] in (1, "1")), default=0.0)
    worst = max(held, trained)
    edge = sorted(r["conf"] for r in rows if r["kind"] == "positive")
    print(f"\nconfuser max: {worst:.3f}  (held-out galleries {held:.3f} | trained run2 set {trained:.3f})")
    if edge:
        print(f"edge positives (informational recall floor): min {edge[0]:.3f} / max {edge[-1]:.3f}")
    top = sorted(conf_rows, key=lambda r: -r["conf"])[:10]
    print("top confusers:")
    for r in top:
        print(f"  {r['conf']:.3f}  {r['name']}")
    out = os.path.join(suite_dir, "scores_" + os.path.basename(weights).replace(".pt", "") + ".csv")
    with open(out, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["name", "group", "kind", "trained", "conf"])
        w.writeheader()
        w.writerows(rows)
    print(f"scores -> {out}")
    if worst < bar:
        print(f"CONFUSER GATE: PASS — max {worst:.3f} < bar {bar}")
    else:
        print(f"CONFUSER GATE: FAIL — max {worst:.3f} >= bar {bar} (do not drop the auto-bank cut)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", action="store_true", help="build the suite dir (run on the VPS)")
    ap.add_argument("--suite", default=SUITE)
    ap.add_argument("--weights", help="score the suite with these weights")
    ap.add_argument("--imgsz", type=int, default=704)
    ap.add_argument("--bar", type=float, default=0.67, help="ship bar: confuser max must be BELOW this")
    a = ap.parse_args()
    if a.export:
        export(a.suite)
    elif a.weights:
        score(a.suite, a.weights, a.imgsz, a.bar)
    else:
        raise SystemExit("nothing to do: pass --export (VPS) or --weights (score)")


if __name__ == "__main__":
    main()
