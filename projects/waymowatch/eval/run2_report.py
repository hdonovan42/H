#!/usr/bin/env python3
"""RUN_2 vs RUN_1: store the rescore durably and surface label CONTRADICTIONS (run on the VPS).

Reads run2_scored.csv (eval/rescore_all.py output — every candidate with run1_conf + run2_conf) and:
  1. STORES both verdicts in a durable `model_scores(run_tag, candidate_id, ...)` table in waymo.db
     (run1 frozen + run2), so RUN_1/RUN_2/any future run compare via a self-join — wn_* is untouched.
  2. CONTRADICTIONS (the point) — where RUN_2 disagrees with the human label:
       - status='reject' but RUN_2 says WAYMO (>= --contra-conf)  -> a Waymo poisoning the negatives.
       - status='waymo'  but RUN_2 scores ~nothing (< --miss-conf) -> a miss or a mislabelled positive.
  3. RUN_1 -> RUN_2 movement per status (how the new model shifted) + the contradiction CSV.
Optional --email sends the summary (recipient hard-locked, key from BASE/.env).

  .venv/bin/python eval/run2_report.py --csv run2_scored.csv [--email]

Powered by TfL Open Data.
"""
import argparse
import csv
import json
import os
import sqlite3
import time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALERT_TO = "donovanh59@gmail.com"


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _email(subject, html):
    key = None
    try:
        for line in open(os.path.join(BASE, ".env")):
            if line.startswith("RESEND_API_KEY"):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    if not key:
        print("  (no RESEND_API_KEY in .env — skipping email)")
        return
    import urllib.request
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps({"from": "WaymoWatch <noreply@autosnipe.co.uk>", "to": [ALERT_TO],
                         "subject": subject, "html": html}).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=20).read()
        print(f"  emailed summary to {ALERT_TO}")
    except Exception as e:
        print(f"  email failed: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--db", default=os.path.join(BASE, "data", "waymo.db"))
    ap.add_argument("--contra-conf", type=float, default=0.10,
                    help="a reject scored >= this = a Waymo in the negatives (gate operating point)")
    ap.add_argument("--miss-conf", type=float, default=0.05,
                    help="a waymo scored < this = a miss / mislabel")
    ap.add_argument("--run2-tag", default="run2")
    ap.add_argument("--email", action="store_true")
    a = ap.parse_args()

    rows = list(csv.DictReader(open(a.csv)))
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # 1. durable store (run1 frozen + run2) — never overwrites the live wn_* columns
    con = sqlite3.connect(a.db, timeout=60)
    con.execute("CREATE TABLE IF NOT EXISTS model_scores ("
                "run_tag TEXT, candidate_id INTEGER, conf REAL, bbox TEXT, n_dets INTEGER, "
                "scored_at TEXT, PRIMARY KEY(run_tag, candidate_id))")
    n1 = n2 = 0
    for r in rows:
        cid = int(r["id"])
        c1 = _f(r.get("run1_conf"))
        if c1 is not None:
            con.execute("INSERT OR REPLACE INTO model_scores VALUES('run1',?,?,?,?,?)",
                        (cid, c1, None, None, now))
            n1 += 1
        c2 = _f(r.get("run2_conf"))
        if c2 is not None:
            con.execute("INSERT OR REPLACE INTO model_scores VALUES(?,?,?,?,?,?)",
                        (a.run2_tag, cid, c2, r.get("run2_bbox") or None,
                         int(r["run2_n_dets"]) if r.get("run2_n_dets") else None, now))
            n2 += 1
    con.commit()
    print(f"stored model_scores: run1={n1}, {a.run2_tag}={n2} (waymo.db)")

    # 2. contradictions
    contra_rej = sorted([r for r in rows if r["status"] == "reject"
                         and (_f(r["run2_conf"]) or 0) >= a.contra_conf],
                        key=lambda r: -(_f(r["run2_conf"]) or 0))
    contra_way = sorted([r for r in rows if r["status"] == "waymo" and not (r.get("special") or "").strip()
                         and _f(r["run2_conf"]) is not None and _f(r["run2_conf"]) < a.miss_conf],
                        key=lambda r: (_f(r["run2_conf"]) or 0))   # exclude edge positives (eval-only, low-conf)

    def show(title, rs, lim=40):
        print(f"\n{title}: {len(rs)}")
        if rs:
            print(f"  {'#id':>7} {'run2':>6} {'run1':>6}  {'camera':<22} captured_at")
            for r in rs[:lim]:
                print(f"  {r['id']:>7} {(_f(r['run2_conf']) or 0):>6.3f} {(_f(r['run1_conf']) or 0):>6.3f}  "
                      f"{r['camera_id']:<22} {r['captured_at']}")
            if len(rs) > lim:
                print(f"  … +{len(rs) - lim} more (see CSV)")

    print("\n" + "=" * 72)
    print(f"RUN_2 vs human labels — CONTRADICTIONS (contra>={a.contra_conf}, miss<{a.miss_conf})")
    print("=" * 72)
    show("REJECTS the model now calls WAYMO (Waymos poisoning the negatives — review + recover)", contra_rej)
    show("WAYMOS the model now scores ~0 (a miss or a mislabel — review)", contra_way)

    # 3. RUN_1 -> RUN_2 movement per status
    print("\n" + "=" * 72)
    print("RUN_1 -> RUN_2 movement (hit = conf >= 0.10)")
    print("=" * 72)
    by_status = {}
    for r in rows:
        by_status.setdefault(r["status"], []).append((_f(r["run1_conf"]), _f(r["run2_conf"])))
    print(f"  {'status':<8} {'n':>7} {'run1 hit%':>10} {'run2 hit%':>10}")
    for st, vals in sorted(by_status.items(), key=lambda kv: -len(kv[1])):
        n = len(vals)
        h1 = 100 * sum(1 for c1, _ in vals if (c1 or 0) >= 0.10) / n
        h2 = 100 * sum(1 for _, c2 in vals if (c2 or 0) >= 0.10) / n
        print(f"  {st:<8} {n:>7} {h1:>9.1f}% {h2:>9.1f}%")

    out = a.csv.rsplit(".", 1)[0] + "_contradictions.csv"
    with open(out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["kind", "id", "camera_id", "captured_at", "run1_conf", "run2_conf"])
        for r in contra_rej:
            w.writerow(["reject_is_waymo", r["id"], r["camera_id"], r["captured_at"],
                        r["run1_conf"], r["run2_conf"]])
        for r in contra_way:
            w.writerow(["waymo_is_zero", r["id"], r["camera_id"], r["captured_at"],
                        r["run1_conf"], r["run2_conf"]])
    print(f"\ncontradictions CSV -> {out}")

    if a.email:
        html = (f"<p>RUN_2 rescore vs labels:</p><ul>"
                f"<li><b>{len(contra_rej)}</b> rejects the model now calls Waymo "
                f"(&ge;{a.contra_conf}) — possible Waymos in the negatives</li>"
                f"<li><b>{len(contra_way)}</b> confirmed Waymos the model now scores &lt;{a.miss_conf} "
                f"— misses/mislabels</li></ul><p>Full lists in {os.path.basename(out)}.</p>")
        _email(f"WaymoNet RUN_2: {len(contra_rej)} reject→Waymo, {len(contra_way)} Waymo→0", html)


if __name__ == "__main__":
    main()
