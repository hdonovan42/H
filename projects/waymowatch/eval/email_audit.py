#!/usr/bin/env python3
"""Email WaymoNet's verdict on a scored batch — RUNS ON THE VPS.

Two attachments in one mail:
  1. CLAIMS  — the candidates WaymoNet detected as a Waymo (conf >= CLAIM_TH),
               full frame with the detection box drawn.
  2. AUDIT   — the top-N highest dome-scored candidates from the SAME batch, each
               labelled d=<dome score> / m=<WaymoNet conf> (green if flagged, grey if
               not), so a real Waymo the model gave a low m= (a recall miss) stands out.

Feed it the scored CSV produced locally by eval/score_candidates.py (rsync it over
first). Crops, the DB and the Resend key all live here on the VPS.

  .venv/bin/python eval/email_audit.py --scored eval/scored.csv --top 100
"""
import argparse
import csv
import json
import os
import sqlite3
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
DB = os.path.join(BASE, "data", "waymo.db")
CLAIM_TH = 0.10
sys.path.insert(0, os.path.join(BASE, "collector"))
from email_alert import send_email   # noqa: E402


def db_meta(ids):
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=60)
    out = {}
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        q = ",".join("?" * len(chunk))
        for r in con.execute(f"SELECT id,crop_path,frame_path,bbox FROM candidates "
                             f"WHERE id IN ({q})", chunk):
            out[r[0]] = {"crop": r[1], "frame": r[2],
                         "bbox": json.loads(r[3]) if r[3] else None}
    return out


def audit_sheet(rows, meta, out_path, cols=10):
    cw, ch = 200, 150
    rn = (len(rows) + cols - 1) // cols
    sheet = np.full((rn * ch, cols * cw, 3), 25, np.uint8)
    for k, r in enumerate(rows):
        m = meta.get(r["id"], {})
        im = cv2.imread(m["crop"]) if m.get("crop") else None
        if im is None and m.get("frame"):
            im = cv2.imread(m["frame"])
        if im is None:
            continue
        c = cv2.resize(im, (cw, ch), interpolation=cv2.INTER_NEAREST)
        gy, gx = (k // cols) * ch, (k % cols) * cw
        sheet[gy:gy + ch, gx:gx + cw] = c
        cv2.putText(sheet, f"#{r['id']} d{r['dome']:.2f}", (gx + 3, gy + 15),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1, cv2.LINE_AA)
        col = (0, 255, 0) if r["model"] >= CLAIM_TH else (150, 150, 150)
        cv2.putText(sheet, f"m{r['model']:.2f}", (gx + 3, gy + ch - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, col, 1, cv2.LINE_AA)
    cv2.imwrite(out_path, sheet)
    return len(rows)


def claims_sheet(rows, meta, out_path):
    if not rows:
        return 0
    cw, ch = 352, 288
    sheet = np.full((ch + 26, len(rows) * cw, 3), 25, np.uint8)
    for k, r in enumerate(rows):
        m = meta.get(r["id"], {})
        im = cv2.imread(m["frame"]) if m.get("frame") else None
        if im is None:
            continue
        if m.get("bbox"):
            x1, y1, x2, y2 = (int(v) for v in m["bbox"])
            cv2.rectangle(im, (x1, y1), (x2, y2), (0, 230, 0), 2)
        im = cv2.resize(im, (cw, ch))
        gx = k * cw
        sheet[0:ch, gx:gx + cw] = im
        cv2.putText(sheet, f"#{r['id']}  model={r['model']:.2f}  dome={r['dome']:.2f}",
                    (gx + 4, ch + 19), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (0, 255, 0), 1, cv2.LINE_AA)
    cv2.imwrite(out_path, sheet)
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scored", required=True, help="scored CSV from score_candidates.py")
    ap.add_argument("--top", type=int, default=100, help="audit set size (highest dome score)")
    a = ap.parse_args()

    rows = [{"id": int(d["id"]), "camera": d["camera_id"], "ts": d["captured_at"],
             "dome": float(d["dome_score"]), "model": float(d["model_conf"])}
            for d in csv.DictReader(open(a.scored))]
    claims = sorted([r for r in rows if r["model"] >= CLAIM_TH],
                    key=lambda r: r["model"], reverse=True)
    audit = sorted(rows, key=lambda r: r["dome"], reverse=True)[:a.top]

    meta = db_meta(list({r["id"] for r in claims + audit}))
    outdir = os.path.join(BASE, "data", "candidates")
    cs = os.path.join(outdir, "waymonet_claims.jpg")
    aus = os.path.join(outdir, "waymonet_audit.jpg")
    nclaims = claims_sheet(claims, meta, cs)
    naudit = audit_sheet(audit, meta, aus)
    domecut = audit[-1]["dome"] if audit else 0.0

    html = (
        f"<p><b>WaymoNet verdict</b> on the {len(rows)} candidates emailed since 13:58 "
        f"(scored locally by the trained model — Run&nbsp;1 best.pt @704).</p>"
        f"<p><b>1. WaymoNet's claims ({nclaims})</b> — candidates the model detected as a "
        f"Waymo (conf&nbsp;&ge;&nbsp;{CLAIM_TH}). Full frame, green box = the detection. "
        f"See <i>waymonet_claims.jpg</i>.</p>"
        f"<p><b>2. Recall audit ({naudit})</b> — the {naudit} highest dome-scored candidates "
        f"from the same batch (dome&nbsp;&ge;&nbsp;{domecut:.2f}). Each is labelled "
        f"<b>d</b>=dome score, <b>m</b>=WaymoNet confidence (green if &ge;&nbsp;{CLAIM_TH}, "
        f"grey if below). Scan for any real Waymo with a <b>low m=</b> — that's one WaymoNet "
        f"missed. See <i>waymonet_audit.jpg</i>.</p>"
        f"<p>Reply with the <b>#</b> of any real Waymo (white Jaguar I-PACE, dark roof dome), "
        f"including any WaymoNet missed.</p>"
        f"<p style='color:#888'>Powered by TfL Open Data.</p>")
    subj = (f"WaymoWatch: WaymoNet verdict — {nclaims} claimed Waymo(s) + top-{naudit} recall audit")
    ok = send_email(subj, html, attachments=[cs, aus, a.scored])
    print(f"claims={nclaims} audit={naudit} domecut={domecut:.3f} -> {'SENT' if ok else 'SEND FAILED'}")


if __name__ == "__main__":
    main()
