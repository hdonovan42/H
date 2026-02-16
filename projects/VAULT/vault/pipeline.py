"""Pipeline orchestrator — Collect → Sentinel → Edge in streamlined phases."""

import json
import logging
import time
from dataclasses import dataclass, field
from vault.config_loader import load_config
from vault.x_feed import collect_x_data
from vault.market_discovery import discover_markets
from vault.edge_calculator import calculate_edges
from vault.sentinel import run_sentinel
from vault.intelligence import (
    should_update_intelligence, update_intelligence,
    get_latest_intelligence, get_latest_opus_estimates,
)

log = logging.getLogger("vault.pipeline")


@dataclass
class PipelineResult:
    """Result of a full pipeline run — passed to the prompt builder."""
    enabled: bool = True
    cycle_id: int = 0
    tweets: list = field(default_factory=list)
    markets: list = field(default_factory=list)
    estimates: list = field(default_factory=list)
    edges: list = field(default_factory=list)
    sentinel_results: dict = field(default_factory=dict)
    digest: str | None = None
    themes: list = field(default_factory=list)
    duration_ms: int = 0
    error: str | None = None


def run_pipeline(conn, cycle_id: int) -> PipelineResult:
    """Run the full edge-detection pipeline.

    Phase 1: Collect tweets — $0
    Phase 1b: Daily intelligence update if due (Opus: analysis + estimation) — ~$0.20
    Phase 1c: Load master intelligence + themes — $0
    Phase 2: Sentinel check (Haiku: thesis monitoring + event detection) — ~$0.001
    Phase 2b: Load latest Opus estimates from DB — $0
    Phase 3: Discover markets — $0
    Phase 4: Calculate edges (pure math) — $0

    Returns PipelineResult with all data for the prompt builder.
    """
    cfg = load_config()

    # Check if pipeline is enabled
    pipeline_cfg = cfg.get("pipeline", {})
    if not pipeline_cfg.get("enabled", True):
        log.info("Pipeline disabled in config")
        return PipelineResult(enabled=False, cycle_id=cycle_id)

    start = time.monotonic()
    result = PipelineResult(cycle_id=cycle_id)

    try:
        # ── Phase 1a: Collect tweets ──────────────────────────────
        log.info(f"Pipeline Phase 1a: collecting tweets (cycle {cycle_id})")
        result.tweets = collect_x_data(conn, cycle_id, cfg)

        # ── Phase 1b: Daily intelligence update if due ────────────
        # Now also produces Opus probability estimates
        log.info("Pipeline Phase 1b: intelligence updates paused (intel disabled)")

        # ── Phase 1c: Load master intelligence + themes ───────────
        intel = get_latest_intelligence(conn)
        if intel:
            result.digest = intel["document"]
            result.themes = json.loads(intel["themes_json"]) if intel.get("themes_json") else []
            log.info(f"Pipeline Phase 1c: loaded intelligence ({len(result.digest)} chars, {len(result.themes)} themes)")
        else:
            log.warning("Pipeline Phase 1c: no intelligence document — seed one with 'vault seed-intel'")
            result.digest = None
            result.themes = []

        # ── Phase 2: Sentinel check ───────────────────────────────
        # Scans new tweets for thesis breaks + major events
        log.info("Pipeline Phase 2: sentinel check")
        result.sentinel_results = run_sentinel(conn, cycle_id, cfg)

        # Emergency Opus re-estimation paused (intel disabled)
        if result.sentinel_results.get("major_event"):
            event = result.sentinel_results["major_event"]
            log.info(f"Pipeline Phase 2: MAJOR EVENT detected — {event['event']} (intel paused, skipping Opus)")

        # ── Phase 2b: Load latest Opus estimates from DB ──────────
        log.info("Pipeline Phase 2b: loading Opus estimates")
        result.estimates = get_latest_opus_estimates(conn)
        log.info(f"Pipeline Phase 2b: {len(result.estimates)} Opus estimates loaded")

        if not result.estimates:
            log.info("Pipeline Phase 2b: no Opus estimates (intel paused) — continuing for velocity detection")

        # ── Phase 3: Discover markets ─────────────────────────────
        log.info(f"Pipeline Phase 3: discovering markets ({len(result.themes)} themes)")
        result.markets = discover_markets(conn, cycle_id, result.themes, cfg)

        # ── Phase 4: Edge Calculation ─────────────────────────────
        log.info(f"Pipeline Phase 4: calculating edges for {len(result.estimates)} estimates")

        result.edges = calculate_edges(
            conn, cycle_id, result.estimates, result.markets, cfg,
            sentinel_results=result.sentinel_results,
        )

    except Exception as e:
        log.error(f"Pipeline error: {e}", exc_info=True)
        result.error = str(e)

    result.duration_ms = int((time.monotonic() - start) * 1000)
    _record_run(conn, cycle_id, result)

    bets = [e for e in result.edges if e["action"] == "bet"]
    exits = [e for e in result.edges if e["action"] == "exit"]
    log.info(
        f"Pipeline complete: {len(result.tweets)} tweets, {len(result.markets)} markets, "
        f"{len(result.estimates)} Opus estimates, {len(bets)} bets, {len(exits)} exits "
        f"({result.duration_ms}ms, cycle {cycle_id})"
    )

    return result


def _record_run(conn, cycle_id: int, result: PipelineResult):
    """Store pipeline run metadata."""
    try:
        conn.execute(
            "INSERT INTO pipeline_runs (cycle_id, tweets_collected, markets_found, "
            "estimates_made, edges_found, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
            (cycle_id, len(result.tweets), len(result.markets),
             len(result.estimates), len(result.edges), result.duration_ms),
        )
        conn.commit()
    except Exception as e:
        log.warning(f"Failed to record pipeline run: {e}")


def get_pipeline_run(conn, cycle_id: int) -> dict | None:
    """Get pipeline run data for a specific cycle."""
    run = conn.execute(
        "SELECT * FROM pipeline_runs WHERE cycle_id = ?", (cycle_id,)
    ).fetchone()
    if not run:
        return None

    run = dict(run)

    # Attach all tweets from DB (not just this cycle)
    run["tweets"] = [dict(r) for r in conn.execute(
        "SELECT tweet_id, author, text, created_at, likes, retweets, retweeted_by, collected_at "
        "FROM x_posts ORDER BY id DESC",
    ).fetchall()]

    # Attach estimates
    run["estimates"] = [dict(r) for r in conn.execute(
        "SELECT e.market_id, e.vault_probability, e.confidence, e.reasoning, e.model_used, "
        "m.question, m.yes_price as market_odds "
        "FROM estimates e LEFT JOIN musk_markets m ON e.market_id = m.market_id "
        "WHERE e.cycle_id = ? ORDER BY e.id",
        (cycle_id,),
    ).fetchall()]

    # Attach edge calculations
    run["edges"] = [dict(r) for r in conn.execute(
        "SELECT ec.market_id, ec.vault_prob, ec.market_odds, ec.edge, ec.side, "
        "ec.confidence, ec.recommended_size_usd, ec.action, ec.reasoning, m.question "
        "FROM edge_calculations ec LEFT JOIN musk_markets m ON ec.market_id = m.market_id "
        "WHERE ec.cycle_id = ? ORDER BY ABS(ec.edge) * ec.confidence DESC",
        (cycle_id,),
    ).fetchall()]

    # Attach cycle decision
    cycle = conn.execute(
        "SELECT action, reasoning, total_cost, balance_after FROM cycles WHERE id = ?",
        (cycle_id,),
    ).fetchone()
    if cycle:
        run["decision"] = dict(cycle)

    return run


def get_latest_pipeline_run(conn) -> dict | None:
    """Get the most recent pipeline run with full trace."""
    row = conn.execute(
        "SELECT cycle_id FROM pipeline_runs ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if not row:
        return None
    return get_pipeline_run(conn, row["cycle_id"])
