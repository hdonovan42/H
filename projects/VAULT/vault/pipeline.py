"""Pipeline orchestrator — Data → Estimate → Edge in three phases."""

import logging
import time
from dataclasses import dataclass, field
from vault.config_loader import load_config
from vault.x_feed import collect_x_data
from vault.musk_markets import collect_musk_markets
from vault.estimator import estimate_probabilities
from vault.edge_calculator import calculate_edges

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
    duration_ms: int = 0
    error: str | None = None


def run_pipeline(conn, cycle_id: int) -> PipelineResult:
    """Run the full edge-detection pipeline.

    Phase 1: Collect data (X tweets + Polymarket markets) — $0
    Phase 2: Estimate probabilities (Claude call, blind to odds) — ~$0.003-0.005
    Phase 3: Calculate edges (pure Python math) — $0

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
        # ── Phase 1: Data Collection ────────────────────────────
        log.info(f"Pipeline Phase 1: collecting data (cycle {cycle_id})")

        result.tweets = collect_x_data(conn, cycle_id, cfg)
        result.markets = collect_musk_markets(conn, cycle_id, cfg)

        if not result.markets:
            log.warning("Pipeline: no markets found, skipping estimation")
            result.duration_ms = int((time.monotonic() - start) * 1000)
            _record_run(conn, cycle_id, result)
            return result

        # ── Phase 2: Probability Estimation ─────────────────────
        log.info(f"Pipeline Phase 2: estimating probabilities for {len(result.markets)} markets")

        result.estimates = estimate_probabilities(
            conn, cycle_id, result.markets, result.tweets, cfg
        )

        if not result.estimates:
            log.warning("Pipeline: no estimates produced")
            result.duration_ms = int((time.monotonic() - start) * 1000)
            _record_run(conn, cycle_id, result)
            return result

        # ── Phase 3: Edge Calculation ───────────────────────────
        log.info(f"Pipeline Phase 3: calculating edges for {len(result.estimates)} estimates")

        result.edges = calculate_edges(
            conn, cycle_id, result.estimates, result.markets, cfg
        )

    except Exception as e:
        log.error(f"Pipeline error: {e}", exc_info=True)
        result.error = str(e)

    result.duration_ms = int((time.monotonic() - start) * 1000)
    _record_run(conn, cycle_id, result)

    bets = [e for e in result.edges if e["action"] == "bet"]
    log.info(
        f"Pipeline complete: {len(result.tweets)} tweets, {len(result.markets)} markets, "
        f"{len(result.estimates)} estimates, {len(bets)} actionable edges "
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

    # Attach tweets
    run["tweets"] = [dict(r) for r in conn.execute(
        "SELECT tweet_id, author, text, created_at, likes, retweets, retweeted_by "
        "FROM x_posts WHERE cycle_id = ? ORDER BY id",
        (cycle_id,),
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
