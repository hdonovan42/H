#!/usr/bin/env python3
"""WaymoNet head-to-head: RUN_1 vs RUN_2 on IDENTICAL data (the only honest cross-run comparison).

Feed it two `rescore_all.py` outputs over the SAME manifest+frames — one produced with RUN_1's weights,
one with RUN_2's (the fresh score lands in the `run2_conf` column of each). It joins them by candidate
id and reports, per model:

  * Confirmed-Waymo score distribution: n, min/max, mean, median, std, p10/p25/p75/p90.
    A better model = HIGHER mean + TIGHTER std (more confident, more consistent on real Waymos).
  * At conf thresholds (default 0.10/0.20/0.30): recall (% of Waymos caught) and leaks
    (# of vetted non-Waymos = status='reject' that sneak in), + precision over waymo∪reject.
  * Edge positives (eval-only) reported separately.

Optional --val-cams restricts to RUN_2's held-out cameras (the unbiased generalisation cut — most
confirmed Waymos were TRAINING data for both models, so the all-Waymos numbers are in-domain/optimistic).

  headtohead.py --r1 r1_scored.csv --r2 r2_scored.csv [--val-cams a,b,c] [--thresholds 0.1,0.2,0.3]

Powered by TfL Open Data.
"""
import argparse
import csv
import statistics as st


def pct(data, q):
    if not data:
        return float("nan")
    s = sorted(data)
    i = q * (len(s) - 1)
    lo = int(i)
    return s[lo] if lo + 1 >= len(s) else s[lo] + (i - lo) * (s[lo + 1] - s[lo])


def load(path):
    """id -> (conf or None, status, special, camera_id). conf None = frame absent (unscored)."""
    out = {}
    for r in csv.DictReader(open(path)):
        c = r.get("run2_conf", "")
        conf = None if c is None or str(c).strip() == "" else float(c)
        out[r["id"]] = (conf, r.get("status", ""), (r.get("special") or "").strip(), r.get("camera_id", ""))
    return out


def describe(scores):
    if not scores:
        return None
    return {
        "n": len(scores), "min": min(scores), "max": max(scores),
        "mean": st.mean(scores), "median": st.median(scores),
        "std": st.pstdev(scores) if len(scores) > 1 else 0.0,
        "p10": pct(scores, 0.10), "p25": pct(scores, 0.25),
        "p75": pct(scores, 0.75), "p90": pct(scores, 0.90),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--r1", required=True, help="rescore_all output with RUN_1 weights")
    ap.add_argument("--r2", required=True, help="rescore_all output with RUN_2 weights")
    ap.add_argument("--thresholds", default="0.1,0.2,0.3")
    ap.add_argument("--val-cams", default="", help="comma list of RUN_2 held-out cameras (optional cut)")
    a = ap.parse_args()
    ths = [float(x) for x in a.thresholds.split(",")]
    val_cams = set(c.strip() for c in a.val_cams.split(",") if c.strip())

    d1, d2 = load(a.r1), load(a.r2)
    ids = [i for i in d1 if i in d2]

    def cohort(model_d, status_pred, cam_filter=False):
        """scores (conf not None) for ids whose row matches the status predicate."""
        out = []
        for i in ids:
            conf, status, special, cam = model_d[i]
            if cam_filter and cam not in val_cams:
                continue
            if status_pred(status, special):
                if conf is not None:
                    out.append(conf)
        return out

    is_waymo = lambda s, sp: s == "waymo" and not sp           # confirmed real positives (excl. edge)
    is_edge = lambda s, sp: sp == "edge_positive"
    is_reject = lambda s, sp: s == "reject"                    # vetted non-Waymos

    def block(title, cam_filter=False):
        print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")
        w1, w2 = cohort(d1, is_waymo, cam_filter), cohort(d2, is_waymo, cam_filter)
        r1, r2 = cohort(d1, is_reject, cam_filter), cohort(d2, is_reject, cam_filter)
        e1, e2 = cohort(d1, is_edge, cam_filter), cohort(d2, is_edge, cam_filter)
        s1, s2 = describe(w1), describe(w2)
        if not s1 or not s2:
            print("  (no scored Waymos in this cut)")
            return
        print(f"\nCONFIRMED-WAYMO SCORE DISTRIBUTION   (RUN_1 n={s1['n']}, RUN_2 n={s2['n']}; "
              f"higher mean + lower std = better)")
        print(f"  {'stat':<8}{'RUN_1':>10}{'RUN_2':>10}{'Δ(R2-R1)':>12}")
        for k in ("mean", "median", "std", "min", "max", "p10", "p25", "p75", "p90"):
            print(f"  {k:<8}{s1[k]:>10.3f}{s2[k]:>10.3f}{s2[k] - s1[k]:>+12.3f}")
        print(f"\nCATCH RATE (Waymos ≥ t) & LEAKS (vetted rejects ≥ t; reject n: "
              f"R1={len(r1)}, R2={len(r2)})")
        print(f"  {'conf≥':<7}{'R1 recall':>12}{'R2 recall':>12}{'R1 leaks':>11}{'R2 leaks':>11}"
              f"{'R1 prec':>9}{'R2 prec':>9}")
        for t in ths:
            c1 = sum(1 for x in w1 if x >= t); c2 = sum(1 for x in w2 if x >= t)
            l1 = sum(1 for x in r1 if x >= t); l2 = sum(1 for x in r2 if x >= t)
            p1 = c1 / (c1 + l1) if (c1 + l1) else float("nan")
            p2 = c2 / (c2 + l2) if (c2 + l2) else float("nan")
            print(f"  {t:<7.2f}{c1 / len(w1) * 100:>11.1f}%{c2 / len(w2) * 100:>11.1f}%"
                  f"{l1:>11}{l2:>11}{p1 * 100:>8.1f}%{p2 * 100:>8.1f}%")
        if e1 and e2:
            print(f"\nEDGE POSITIVES (eval-only, deliberately hard): "
                  f"R1 mean {st.mean(e1):.3f}, R2 mean {st.mean(e2):.3f}  (n={len(e2)})")

    block("ALL CONFIRMED WAYMOS — operational, in-domain (most were TRAINING data for both models)")
    if val_cams:
        block(f"RUN_2 HELD-OUT CAMERAS ONLY — unbiased generalisation cut ({len(val_cams)} cams)",
              cam_filter=True)
    print("\nNote: clean train/test only for the held-out cut; the all-Waymos block is optimistic "
          "(in-training). The gate (eval_gate.py, held-out cameras) is the formal ship decision.")


if __name__ == "__main__":
    main()
