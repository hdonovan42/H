"""Fade backtest — counterfactual P&L if momentum signals had been FADED
(mean-reverted) instead of FOLLOWED, with realistic spread costs and the
current entry gates.

Read-only analysis. For each closed real momentum trade:
  - reconstruct the exit price the followed side actually got: p_exit = payout/shares
  - the FADE buys the opposite side over the same holding window: enters at the
    mirror mid (1 - p_entry), exits at (1 - p_exit)
  - charge the round-trip bid-ask spread as `spread * fade_shares` (you cross the
    full spread once per round trip per share; musk_markets.spread is the absolute
    bid-ask gap). This is what kills the frictionless favourite-fade illusion:
    fading a 0.98 favourite = buying a 0.02 longshot = 50x shares = 50x spread drag.
  - optionally apply the live entry gates (favourite cap, $ volume floor, spread
    filter) to the FADE side, i.e. only count fades the current system would take.

Modelling caveats (surfaced in the report):
  - Exit timing = the follow trade's exit. A real fade would use its own exits;
    this CONSERVATIVELY holds fade losers as long as follow held its winners and
    cuts fade winners as fast as follow cut its losers.
  - Spread is musk_markets.spread (a per-market snapshot), not the spread at the
    exact trade time. odds_snapshots are normalized mids, so the bid/ask is
    reconstructed from this spread.
  - No gas (Polymarket CLOB fills are gasless).
"""

DEFAULT_SPREAD = 0.02          # fallback when a market has no recorded spread
MOMENTUM_MIN_ID = 96           # momentum system starts at prediction #96


def _trade_rows(conn):
    return [dict(r) for r in conn.execute(
        """SELECT p.id, p.entry_odds AS p_entry, p.cost_basis AS c, p.payout,
                  p.shares, p.pnl,
                  COALESCE(m.spread, ?) AS spread, COALESCE(m.volume, 0) AS volume
           FROM predictions p
           LEFT JOIN musk_markets m ON p.market_id = m.market_id
           WHERE p.status = 'closed' AND p.execution_mode = 'real'
             AND p.id >= ?""",
        (DEFAULT_SPREAD, MOMENTUM_MIN_ID),
    )]


def _eval_trade(r, charge_spread=True):
    """Return per-trade dict, or None if the row can't be modelled."""
    p = r["p_entry"]
    c = r["c"]
    payout = r["payout"] or 0.0
    sh = r["shares"] or 0.0
    if not p or p <= 0.0 or p >= 1.0 or c <= 0.0 or sh <= 0.0:
        return None

    p_exit = max(0.0, min(1.0, payout / sh))      # per-share exit value of the held side
    follow_pnl = payout - c                         # = realized pnl

    fade_entry = 1.0 - p                            # mirror mid at entry
    fade_exit = 1.0 - p_exit                        # mirror mid at exit
    fade_shares = c / fade_entry
    fade_gross = fade_shares * fade_exit - c        # = c*(p - p_exit)/(1-p)
    spread_cost = (r["spread"] * fade_shares) if charge_spread else 0.0
    fade_net = fade_gross - spread_cost

    return {
        "id": r["id"], "follow": follow_pnl, "fade": fade_net,
        "fade_gross": fade_gross, "spread_cost": spread_cost,
        "fade_entry": fade_entry, "spread": r["spread"], "volume": r["volume"],
    }


def _summary(items, label):
    n = len(items)
    if n == 0:
        return {"label": label, "n": 0}
    fol = sum(i["follow"] for i in items)
    fad = sum(i["fade"] for i in items)
    return {
        "label": label, "n": n,
        "follow_total": round(fol, 2), "follow_avg": round(fol / n, 3),
        "follow_winrate": round(100 * sum(1 for i in items if i["follow"] > 0) / n),
        "fade_total": round(fad, 2), "fade_avg": round(fad / n, 3),
        "fade_winrate": round(100 * sum(1 for i in items if i["fade"] > 0) / n),
        "spread_cost": round(sum(i["spread_cost"] for i in items), 2),
    }


def run_fade_backtest(conn, cfg=None):
    """Compute follow-vs-fade P&L three ways: frictionless (shows the artifact),
    spread-aware on all momentum trades, and spread-aware on the gated subset the
    current config would actually fade. Returns a dict of summaries."""
    cfg = cfg or {}
    vel = cfg.get("velocity", {})
    cap = vel.get("momentum_max_entry_odds", 0.90)
    min_vol = vel.get("momentum_min_volume", 5000)
    low_floor = 0.10                  # agent.py extreme-low-entry floor
    max_spread = 0.10                 # agent.py wide-spread filter

    rows = _trade_rows(conn)
    priced = [_eval_trade(r, charge_spread=True) for r in rows]
    priced = [x for x in priced if x]
    frictionless = [_eval_trade(r, charge_spread=False) for r in rows]
    frictionless = [x for x in frictionless if x]

    gated = [x for x in priced
             if low_floor <= x["fade_entry"] <= cap
             and x["volume"] >= min_vol
             and x["spread"] <= max_spread]

    return {
        "gates": {"favourite_cap": cap, "min_volume": min_vol,
                  "max_spread": max_spread, "low_floor": low_floor},
        "frictionless_all": _summary(frictionless, "Fade ALL — FRICTIONLESS (artifact)"),
        "spread_all": _summary(priced, "Fade ALL — spread-aware"),
        "spread_gated": _summary(gated, "Fade GATED — spread-aware + current filters"),
    }


def format_report(res):
    lines = ["VAULT Fade Backtest — follow (actual) vs fade (mean-revert)", ""]
    g = res["gates"]
    lines.append(f"Gates applied to 'GATED': fade entry {g['low_floor']:.2f}-{g['favourite_cap']:.2f}, "
                 f"volume >= ${g['min_volume']:,}, spread <= {g['max_spread']:.0%}")
    lines.append("")
    hdr = f"{'scenario':<46} {'n':>3} {'follow$':>9} {'foll%':>5} {'fade$':>10} {'fade%':>5} {'sprd$':>7}"
    lines.append(hdr)
    lines.append("-" * len(hdr))
    for key in ("frictionless_all", "spread_all", "spread_gated"):
        s = res[key]
        if s["n"] == 0:
            lines.append(f"{s['label']:<46}   (no trades)")
            continue
        lines.append(
            f"{s['label']:<46} {s['n']:>3} {s['follow_total']:>+9.2f} {s['follow_winrate']:>4}% "
            f"{s['fade_total']:>+10.2f} {s['fade_winrate']:>4}% {s['spread_cost']:>7.2f}"
        )
    return "\n".join(lines)
