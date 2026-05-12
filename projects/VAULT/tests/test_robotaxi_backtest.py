"""Backtest: would the discovery + entry pipeline have caught the
12 May 2026 Tesla-robotaxi move?

Market: 676817 "Will Tesla launch robotaxis in California by June 30?"
  - 24h vol $2,700, all-time $104k, liquidity $3,747 (sub-threshold)
  - YES went 0.085 → 0.350 in ~3h on the afternoon of 12 May
  - Below VAULT's old `momentum_min_volume: 5000` discovery floor and
    below rank-500 on every gamma sort we tried — invisible to discovery.

This test gates three changes:
  1. Discovery: paginate default sort to 2000, drop the $5k floor.
  2. Entry gate decoupled from discovery (lower floor).
  3. Orderbook depth probe (new clob_client helper).

If any assertion regresses, the change set is unsafe to deploy.
"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest


ROBOTAXI_MARKET_ID = "676817"
ROBOTAXI_YES_TOKEN = (
    "49110018287300804234584571000145517689767265512333035272204822023052123364689"
)
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"


# ── Discovery ────────────────────────────────────────────────────────────


def test_widened_discovery_finds_robotaxi():
    """Default-sort pagination to 2000 must surface this market.

    Pre-change: top 500 by `order=volume` does NOT include it.
    Post-change: default-sort top 2000 does. Anything above rank 2000
    is acceptable to miss; we're widening, not exhausting."""
    try:
        for offset in range(0, 2000, 500):
            r = httpx.get(
                f"{GAMMA}/markets",
                params={
                    "active": "true",
                    "closed": "false",
                    "limit": 500,
                    "offset": offset,
                },
                timeout=15,
            )
            r.raise_for_status()
            for m in r.json():
                if str(m.get("id")) == ROBOTAXI_MARKET_ID:
                    return  # found, pass
    except Exception as e:
        pytest.skip(f"gamma unreachable: {e}")
    pytest.fail(
        f"robotaxi market {ROBOTAXI_MARKET_ID} not in top 2000 by default sort — "
        "discovery widening is insufficient."
    )


# ── Velocity calc ────────────────────────────────────────────────────────


@pytest.fixture
def robotaxi_history():
    """Pull live price history; skip if unreachable. The 12 May surge is
    durable enough that this works post-hoc too — we filter to the surge
    window explicitly."""
    try:
        # `interval=1d&fidelity=10` gives ~144 points/day, ~6 per hour —
        # enough density that calculate_velocity's 5-min span requirement
        # is satisfiable. The 1w/60 endpoint is too sparse.
        r = httpx.get(
            f"{CLOB}/prices-history",
            params={"market": ROBOTAXI_YES_TOKEN, "interval": "1d", "fidelity": 10},
            timeout=15,
        )
        r.raise_for_status()
        pts = r.json().get("history", [])
        if not pts:
            pytest.skip("no price history returned")
        return pts
    except Exception as e:
        pytest.skip(f"CLOB prices-history unreachable: {e}")


def _seed_snapshots_for_velocity(conn, market_id: str, points: list[dict],
                                  anchor_t: int | None = None):
    """Insert raw (timestamp, yes_price) into odds_snapshots, with `ts`
    rewritten to be relative to NOW so calculate_velocity()'s "-24h" window
    sees them. Mirrors the live shape used by record_odds_snapshot().

    `anchor_t` — the original epoch of the point we want to treat as "now"
    minus 1 minute. Letting the test pick the moment the daemon would have
    observed the surge (rather than the most recent stale point)."""
    if not points:
        return 0
    if anchor_t is None:
        anchor_t = max(p["t"] for p in points)
    now = datetime.now(timezone.utc) - timedelta(minutes=1)
    inserted = 0
    for p in points:
        if p["t"] > anchor_t:
            continue  # future from the daemon's POV at observation time
        delta_s = anchor_t - p["t"]
        ts = now - timedelta(seconds=delta_s)
        ts_str = ts.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts.microsecond // 1000:03d}Z"
        conn.execute(
            "INSERT INTO odds_snapshots (market_id, yes_price, no_price, ts) "
            "VALUES (?, ?, ?, ?)",
            (market_id, float(p["p"]), 1.0 - float(p["p"]), ts_str),
        )
        inserted += 1
    conn.commit()
    return inserted


def _find_steepest_1h(points: list[dict]) -> int:
    """Return the epoch `t` of the snapshot that ends the steepest 1-hour
    window in the series. Pick the point at the END of the steepest hour
    so v_1h, computed from snapshots in (anchor-1h, anchor], captures it."""
    pts = sorted(points, key=lambda p: p["t"])
    best_t = pts[-1]["t"]
    best_delta = 0.0
    for i, end in enumerate(pts):
        for j in range(i, -1, -1):
            if end["t"] - pts[j]["t"] > 3600 + 600:  # 10-min slack
                break
            if end["t"] - pts[j]["t"] >= 3600 - 600:
                delta = abs(end["p"] - pts[j]["p"])
                if delta > best_delta:
                    best_delta = delta
                    best_t = end["t"]
                break
    return best_t


def test_velocity_fires_on_robotaxi_surge(db, robotaxi_history):
    """Replay the 12 May trajectory through calculate_velocity().
    v_1h must clear momentum_min_velocity_1h (0.10) by a large margin."""
    from vault.edge_calculator import calculate_velocity
    from vault.config_loader import load_config

    # Pick the steepest 24h window: snapshots in the 24h ENDING at the
    # daemon's observation moment (the close of the steepest 1h window).
    pts = sorted(robotaxi_history, key=lambda p: p["t"])
    anchor = _find_steepest_1h(pts)
    cutoff = anchor - 24 * 3600
    pts_24h = [p for p in pts if cutoff <= p["t"] <= anchor]

    inserted = _seed_snapshots_for_velocity(
        db, ROBOTAXI_MARKET_ID, pts_24h, anchor_t=anchor
    )
    assert inserted >= 20, f"expected dense history, got {inserted} points"

    cfg = load_config()
    vel = calculate_velocity(db, ROBOTAXI_MARKET_ID, cfg=cfg)
    assert vel is not None, "velocity calc returned None on real surge data"

    v_1h = vel["v_1h"]
    assert v_1h is not None, f"v_1h is None: {vel}"

    # The surge: 0.085 → 0.35 over ~3h, with the steepest hour > +0.20.
    # Allow either direction in case the test runs after the move reverses,
    # but require the magnitude to clear the entry threshold by 1.5x.
    threshold = cfg.get("velocity", {}).get("momentum_min_velocity_1h", 0.10)
    assert abs(v_1h) >= threshold * 1.5, (
        f"v_1h={v_1h:.4f} did not clear 1.5×{threshold} = {threshold * 1.5:.4f}; "
        f"either the data window is too narrow or thresholds drifted."
    )
    assert vel["sharp"] is True, f"sharp flag not set on |v_1h|={abs(v_1h):.4f}"


# ── Orderbook depth probe ───────────────────────────────────────────────


def test_orderbook_depth_probe_accepts_small_buy_on_robotaxi():
    """A $1.50 BUY at the current ask must pass the 30%-of-depth-within-2¢
    threshold on this market's book. If it doesn't, our discovery+entry
    won't actually be able to execute — the whole change is theatre."""
    try:
        from vault.clob_client import check_orderbook_depth
    except ImportError:
        pytest.fail("check_orderbook_depth not yet implemented in clob_client.py")

    try:
        r = httpx.get(
            f"{CLOB}/book",
            params={"token_id": ROBOTAXI_YES_TOKEN},
            timeout=10,
        )
        r.raise_for_status()
        book = r.json()
    except Exception as e:
        pytest.skip(f"CLOB /book unreachable: {e}")

    asks = book.get("asks", [])
    if not asks:
        pytest.skip("no asks on robotaxi book at test time")

    # Pick the cheapest ask price as our notional fill price
    best_ask_price = min(float(a["price"]) for a in asks)
    shares_for_1_50 = 1.50 / best_ask_price

    # Use the production-config thresholds so this test fails the day we
    # tune defaults too aggressively.
    from vault.config_loader import load_config
    vel_cfg = load_config().get("velocity", {})
    result = check_orderbook_depth(
        token_id=ROBOTAXI_YES_TOKEN,
        side="BUY",
        shares_needed=shares_for_1_50,
        max_consume_pct=vel_cfg.get("orderbook_max_consume_pct", 0.50),
        price_band=vel_cfg.get("orderbook_price_band", 0.02),
    )
    assert result["ok"] is True, (
        f"$1.50 BUY rejected on robotaxi book at production thresholds: {result}. "
        f"Either the book has thinned past usability, or thresholds are too tight "
        f"for the kind of market we want to catch."
    )
    assert result["depth_shares"] > 0


def test_orderbook_depth_probe_rejects_oversized_order():
    """Sanity: same book, an absurd 100,000-share order must be refused."""
    try:
        from vault.clob_client import check_orderbook_depth
    except ImportError:
        pytest.fail("check_orderbook_depth not yet implemented in clob_client.py")

    try:
        result = check_orderbook_depth(
            token_id=ROBOTAXI_YES_TOKEN,
            side="BUY",
            shares_needed=100_000,
            max_consume_pct=0.30,
            price_band=0.02,
        )
    except Exception as e:
        pytest.skip(f"CLOB /book unreachable: {e}")
    assert result["ok"] is False, f"oversized order accepted: {result}"
