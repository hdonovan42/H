"""Shadow-fade logging — paper-track what FADING (mean-reverting) each momentum
signal would return, out-of-sample, alongside the live FOLLOW trades.

OBSERVE-ONLY: must never affect the follow trading path. Every public function
is fully defensive (never raises into the caller).

For each momentum signal that passes the live quality gates, log a hypothetical
FADE entry (opposite side at the mirror mid, gated to the same favourite-cap band
as the real system). After `horizon_hours`, close it at the fade-side mid and
record spread-aware P&L using the SAME model as vault/fade_backtest.py
(round-trip spread = spread x shares). Accumulates an out-of-sample fade record
to validate the #4 lagging-signal hypothesis before committing real capital.
"""
import logging
from datetime import datetime, timezone, timedelta

log = logging.getLogger("vault.shadow_fade")


def _now():
    return datetime.now(timezone.utc)


def _parse_ts(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def log_shadow_fade(conn, *, cycle_id, market_id, question, follow_side,
                    follow_entry_price, v_1h, v_6h, z_1h, spread, cfg):
    """Record a hypothetical fade entry for a qualifying momentum signal.
    No-op if disabled, gated out, deduped, or in cooldown. Never raises."""
    try:
        sf = (cfg or {}).get("shadow_fade", {})
        if not sf.get("enabled", False):
            return

        fade_side = "NO" if follow_side == "YES" else "YES"
        entry_price = round(1.0 - follow_entry_price, 6)
        # Gate the FADE entry the same way the live system gates real entries
        # (favourite cap + low floor), so the record matches the gated backtest.
        vel = (cfg or {}).get("velocity", {})
        cap = vel.get("momentum_max_entry_odds", 0.90)
        if entry_price < 0.10 or entry_price > cap:
            return

        # dedup: one open fade per market; cooldown: not re-logged too soon
        if conn.execute("SELECT 1 FROM shadow_fades WHERE market_id=? AND status='open' LIMIT 1",
                        (market_id,)).fetchone():
            return
        cutoff = (_now() - timedelta(minutes=sf.get("cooldown_minutes", 30))).strftime("%Y-%m-%dT%H:%M:%S")
        if conn.execute("SELECT 1 FROM shadow_fades WHERE market_id=? AND ts > ? LIMIT 1",
                        (market_id, cutoff)).fetchone():
            return

        stake = sf.get("stake", 1.00)
        horizon = sf.get("horizon_hours", 3.0)
        conn.execute(
            "INSERT INTO shadow_fades "
            "(cycle_id, market_id, question, follow_side, fade_side, entry_price, "
            "stake, v_1h, v_6h, z_1h, spread, horizon_hours, status) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open')",
            (cycle_id, market_id, question, follow_side, fade_side, entry_price,
             stake, v_1h, v_6h, z_1h, spread, horizon),
        )
        conn.commit()
        log.info(f"Shadow-fade logged: {fade_side} '{question[:45]}' @ {entry_price:.2f} "
                 f"(fading {follow_side} momentum, {horizon}h horizon)")
    except Exception as e:
        log.warning(f"Shadow-fade log failed (non-fatal): {e}")


def _fade_side_mid(conn, market_id, fade_side, max_snapshot_age_min=20):
    """Current fade-side mid: fresh odds_snapshot if recent, else a live fetch,
    else the stale snapshot. Returns (mid, ts) or (None, None)."""
    row = conn.execute(
        "SELECT yes_price, no_price, ts FROM odds_snapshots WHERE market_id=? "
        "ORDER BY ts DESC LIMIT 1", (market_id,),
    ).fetchone()

    def _side(yes, no):
        return yes if fade_side == "YES" else no

    if row:
        ts = _parse_ts(row[2])
        if ts and (_now() - ts).total_seconds() / 60.0 <= max_snapshot_age_min:
            return _side(row[0], row[1]), row[2]
    # stale or missing → try a live fetch
    try:
        from vault.polymarket import get_current_odds
        od = get_current_odds(conn, market_id)
        if od and od.get("yes_price") is not None:
            return _side(od["yes_price"], od["no_price"]), _now().strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        pass
    if row:  # fall back to stale snapshot rather than nothing
        return _side(row[0], row[1]), row[2]
    return None, None


def resolve_shadow_fades(conn, cfg):
    """Close open shadow-fades past their horizon at the current fade-side mid,
    recording spread-aware P&L. Never raises."""
    try:
        sf = (cfg or {}).get("shadow_fade", {})
        if not sf.get("enabled", False):
            return
        rows = conn.execute(
            "SELECT id, market_id, fade_side, entry_price, stake, spread, "
            "horizon_hours, ts FROM shadow_fades WHERE status='open'"
        ).fetchall()
        now = _now()
        closed = 0
        for sid, market_id, fade_side, entry, stake, spread, horizon, ts in rows:
            t0 = _parse_ts(ts)
            if t0 is None:
                continue
            age_h = (now - t0).total_seconds() / 3600.0
            if age_h < (horizon or 3.0):
                continue
            mid, mid_ts = _fade_side_mid(conn, market_id, fade_side)
            if mid is None:
                if age_h > 24.0:   # can't price it after a day — expire
                    conn.execute("UPDATE shadow_fades SET status='expired', resolved_at=? WHERE id=?",
                                 (now.strftime("%Y-%m-%dT%H:%M:%SZ"), sid))
                continue
            exit_price = max(0.0, min(1.0, mid))
            shares = (stake / entry) if entry and entry > 0 else 0.0
            pnl = round(shares * exit_price - stake - (spread or 0.0) * shares, 6)
            conn.execute(
                "UPDATE shadow_fades SET status='closed', exit_price=?, exit_ts=?, "
                "fade_pnl=?, resolved_at=? WHERE id=?",
                (round(exit_price, 6), mid_ts, pnl, now.strftime("%Y-%m-%dT%H:%M:%SZ"), sid),
            )
            closed += 1
        if closed:
            conn.commit()
            log.info(f"Resolved {closed} shadow-fade(s) at horizon")
    except Exception as e:
        log.warning(f"Shadow-fade resolve failed (non-fatal): {e}")


def shadow_fade_summary(conn):
    """Aggregate the live shadow-fade record. Never raises."""
    try:
        r = conn.execute(
            "SELECT COUNT(*) n, "
            "SUM(status='open') opn, SUM(status='closed') closed, "
            "SUM(status='expired') expired, "
            "COALESCE(SUM(CASE WHEN status='closed' THEN fade_pnl ELSE 0 END),0) total, "
            "SUM(CASE WHEN status='closed' AND fade_pnl>0 THEN 1 ELSE 0 END) wins "
            "FROM shadow_fades"
        ).fetchone()
        n, opn, closed, expired, total, wins = (x or 0 for x in r)
        return {
            "logged": n, "open": opn, "closed": closed, "expired": expired,
            "fade_pnl": round(total, 2),
            "win_rate": round(100 * wins / closed) if closed else None,
            "avg_pnl": round(total / closed, 3) if closed else None,
        }
    except Exception:
        return {"logged": 0, "open": 0, "closed": 0, "expired": 0,
                "fade_pnl": 0.0, "win_rate": None, "avg_pnl": None}
