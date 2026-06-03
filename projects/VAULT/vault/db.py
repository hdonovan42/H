"""SQLite schema and connection factory."""

import logging
import sqlite3
from pathlib import Path
from vault.config_loader import get_db_path

log = logging.getLogger("vault.db")

SCHEMA_VERSION = 24

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_calls (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cycle_id     INTEGER,
    model        TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd     REAL NOT NULL,
    purpose      TEXT,
    FOREIGN KEY (cycle_id) REFERENCES cycles(id)
);

CREATE TABLE IF NOT EXISTS cycles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_start      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ts_end        TEXT,
    action        TEXT,            -- buy/sell/hold/wait
    asset         TEXT,
    reasoning     TEXT,
    alternatives  TEXT,            -- JSON array
    total_cost    REAL DEFAULT 0,
    rounds_used   INTEGER DEFAULT 0,
    balance_after REAL
);

CREATE TABLE IF NOT EXISTS positions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset       TEXT NOT NULL,
    quantity    REAL NOT NULL,
    cost_basis  REAL NOT NULL,     -- USD paid
    opened_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    closed_at   TEXT,
    close_price REAL,
    pnl         REAL,
    status      TEXT NOT NULL DEFAULT 'open'  -- open/closed
);

CREATE TABLE IF NOT EXISTS trades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cycle_id    INTEGER,
    side        TEXT NOT NULL,      -- buy/sell
    asset       TEXT NOT NULL,
    quantity    REAL NOT NULL,
    price       REAL NOT NULL,      -- per unit
    total_usd   REAL NOT NULL,
    position_id INTEGER,
    FOREIGN KEY (cycle_id) REFERENCES cycles(id),
    FOREIGN KEY (position_id) REFERENCES positions(id)
);

CREATE TABLE IF NOT EXISTS ledger (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    entry_type      TEXT NOT NULL,   -- seed/api_cost/trade_buy/trade_sell/pnl
    amount          REAL NOT NULL,   -- positive = credit, negative = debit
    description     TEXT,
    reference_id    INTEGER,         -- api_call.id or trade.id
    balance_after   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    category    TEXT NOT NULL,       -- strategy/observation/lesson/rule
    content     TEXT NOT NULL,
    relevance   REAL DEFAULT 1.0,    -- 0.0-1.0, decays or agent-set
    active      INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS market_cache (
    asset       TEXT NOT NULL,
    source      TEXT NOT NULL,       -- coingecko/yahoo
    price_usd   REAL NOT NULL,
    fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    data_json   TEXT,                -- full response for context
    PRIMARY KEY (asset, source)
);

CREATE TABLE IF NOT EXISTS objectives (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    balance      REAL NOT NULL,
    burn_rate    REAL,               -- USD/day
    runway_days  REAL,
    positions_value REAL DEFAULT 0,
    total_pnl    REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    event     TEXT NOT NULL,         -- start/stop/death/pause/resume/resurrect/error
    detail    TEXT
);

CREATE TABLE IF NOT EXISTS predictions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id     TEXT NOT NULL,
    condition_id  TEXT,
    question      TEXT NOT NULL,
    slug          TEXT,
    side          TEXT NOT NULL,          -- YES/NO
    shares        REAL NOT NULL,
    entry_odds    REAL NOT NULL,          -- probability at entry (0-1)
    cost_basis    REAL NOT NULL,          -- USD paid
    clob_token_id TEXT,
    end_date      TEXT,
    entry_edge    REAL,                    -- edge at time of entry (v6)
    entry_confidence REAL,               -- confidence at time of entry (v9)
    entry_reasoning TEXT,                 -- why we entered (v6)
    opened_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    closed_at     TEXT,
    resolution    TEXT,                   -- won/lost/sold
    payout        REAL,
    pnl           REAL,
    peak_roi      REAL DEFAULT 0,               -- trailing stop high-water mark (v12)
    execution_mode TEXT DEFAULT 'paper',        -- paper/real (v19)
    status        TEXT NOT NULL DEFAULT 'open', -- pending/open/reconciling/closed/cancelled (v20)
    pending_since TEXT,                         -- when status='pending' was set (v20)
    clob_attempt_id TEXT,                       -- dedupe key for CLOB retries (v20)
    fill_verified_at TEXT                       -- when post-trade CTF balance was confirmed (v20)
);

-- ── Wallet-level cashflow (v21) ────────────────────────────────

CREATE TABLE IF NOT EXISTS wallet_transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash         TEXT NOT NULL UNIQUE,
    block_number    INTEGER NOT NULL,
    ts              TEXT NOT NULL,
    direction       TEXT NOT NULL CHECK (direction IN ('deposit','withdrawal')),
    amount_usd      REAL NOT NULL,
    token           TEXT NOT NULL,
    counterparty    TEXT NOT NULL,
    notes           TEXT,
    ledger_id       INTEGER,
    FOREIGN KEY (ledger_id) REFERENCES ledger(id)
);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_ts ON wallet_transactions(ts DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_direction ON wallet_transactions(direction);

-- ── Pipeline tables (v3) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id         INTEGER NOT NULL,
    ts               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    tweets_collected INTEGER DEFAULT 0,
    markets_found    INTEGER DEFAULT 0,
    estimates_made   INTEGER DEFAULT 0,
    edges_found      INTEGER DEFAULT 0,
    duration_ms      INTEGER,
    FOREIGN KEY (cycle_id) REFERENCES cycles(id)
);

CREATE TABLE IF NOT EXISTS x_posts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id     TEXT UNIQUE,
    author       TEXT,
    text         TEXT NOT NULL,
    created_at   TEXT,
    likes        INTEGER DEFAULT 0,
    retweets     INTEGER DEFAULT 0,
    retweeted_by TEXT,
    cycle_id     INTEGER,
    collected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (cycle_id) REFERENCES cycles(id)
);

CREATE TABLE IF NOT EXISTS musk_markets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id   TEXT UNIQUE NOT NULL,
    question    TEXT NOT NULL,
    slug        TEXT,
    yes_price   REAL,
    no_price    REAL,
    volume      REAL,
    end_date    TEXT,
    first_seen  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    description TEXT,                           -- (v13)
    volume_24h  REAL,                           -- (v13)
    liquidity   REAL,                           -- (v13)
    spread      REAL,                           -- (v13)
    competitive REAL,                           -- (v13)
    game_start_time TEXT,                       -- (v13)
    event_title TEXT                            -- (v13)
);

CREATE TABLE IF NOT EXISTS odds_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id   TEXT NOT NULL,
    yes_price   REAL NOT NULL,
    no_price    REAL NOT NULL,
    ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cycle_id    INTEGER,
    FOREIGN KEY (cycle_id) REFERENCES cycles(id)
);
-- Hot path: velocity calc queries WHERE market_id=? AND ts>? every cycle, per
-- tracked market. Without this index that's a full scan × hundreds of markets.
CREATE INDEX IF NOT EXISTS idx_odds_snapshots_market_ts ON odds_snapshots(market_id, ts);

CREATE TABLE IF NOT EXISTS shadow_fades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cycle_id      INTEGER,
    market_id     TEXT NOT NULL,
    question      TEXT,
    follow_side   TEXT,
    fade_side     TEXT,
    entry_price   REAL,
    stake         REAL,
    v_1h          REAL,
    v_6h          REAL,
    z_1h          REAL,
    spread        REAL,
    horizon_hours REAL,
    status        TEXT NOT NULL DEFAULT 'open',
    exit_price    REAL,
    exit_ts       TEXT,
    fade_pnl      REAL,
    resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_shadow_fades_status ON shadow_fades(status);
CREATE INDEX IF NOT EXISTS idx_shadow_fades_market ON shadow_fades(market_id, status);

CREATE TABLE IF NOT EXISTS estimates (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id         INTEGER NOT NULL,
    market_id        TEXT NOT NULL,
    vault_probability REAL NOT NULL,
    confidence       REAL NOT NULL,
    reasoning        TEXT,
    model_used       TEXT,
    ts               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (cycle_id) REFERENCES cycles(id)
);

CREATE TABLE IF NOT EXISTS edge_calculations (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id             INTEGER NOT NULL,
    market_id            TEXT NOT NULL,
    vault_prob           REAL NOT NULL,
    market_odds          REAL NOT NULL,
    edge                 REAL NOT NULL,
    side                 TEXT NOT NULL,       -- YES/NO
    confidence           REAL NOT NULL,
    recommended_size_usd REAL,
    action               TEXT NOT NULL,       -- bet/hold/exit
    reasoning            TEXT,
    ts                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (cycle_id) REFERENCES cycles(id)
);

CREATE TABLE IF NOT EXISTS calibration (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id       TEXT NOT NULL,
    estimated_prob  REAL NOT NULL,
    actual_outcome  INTEGER,                 -- 1=YES won, 0=NO won, NULL=unresolved
    resolved_at     TEXT
);

CREATE TABLE IF NOT EXISTS digests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cycle_id    INTEGER,
    tweet_count INTEGER NOT NULL,
    hours_back  INTEGER NOT NULL DEFAULT 48,
    digest_text TEXT NOT NULL,
    model_used  TEXT,
    cost_usd    REAL DEFAULT 0,
    FOREIGN KEY (cycle_id) REFERENCES cycles(id)
);

CREATE TABLE IF NOT EXISTS master_intelligence (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    document    TEXT NOT NULL,
    themes_json TEXT,
    tweet_count INTEGER DEFAULT 0,
    model_used  TEXT,
    cost_usd    REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS opus_estimates (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ts               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    intelligence_id  INTEGER NOT NULL,
    market_id        TEXT NOT NULL,
    question         TEXT,
    vault_probability REAL NOT NULL,
    confidence       REAL NOT NULL,
    reasoning        TEXT
);

CREATE TABLE IF NOT EXISTS sentinel_alerts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ts               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cycle_id         INTEGER NOT NULL,
    prediction_id    INTEGER NOT NULL,
    market_id        TEXT NOT NULL,
    status           TEXT NOT NULL,
    event            TEXT,
    source           TEXT
);

CREATE TABLE IF NOT EXISTS smart_money_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cycle_id            INTEGER NOT NULL,
    market_id           TEXT NOT NULL,
    question            TEXT,
    v_1h                REAL,
    v_6h                REAL,
    direction           TEXT,
    sharp               INTEGER NOT NULL DEFAULT 0,
    action_taken        TEXT NOT NULL,
    vault_estimate      REAL,
    market_odds         REAL,
    side                TEXT,
    amount_usd          REAL,
    prediction_id       INTEGER,
    counterfactual_size REAL,
    counterfactual_side TEXT,
    outcome             TEXT DEFAULT 'pending',
    outcome_pnl         REAL,
    counterfactual_pnl  REAL,
    resolved_at         TEXT,
    z_1h                REAL,
    confidence          REAL,
    FOREIGN KEY (cycle_id) REFERENCES cycles(id)
);

CREATE TABLE IF NOT EXISTS backtest_results (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    safeguard      TEXT NOT NULL,
    param_value    TEXT NOT NULL,
    lookback_days  INTEGER,
    total_trades   INTEGER NOT NULL,
    trades_blocked INTEGER NOT NULL,
    wins_blocked   INTEGER NOT NULL,
    losses_blocked INTEGER NOT NULL,
    pnl_impact     REAL NOT NULL,
    p_value        REAL,
    cohens_d       REAL,
    significant    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shadow_trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cycle_id        INTEGER,
    market_id       TEXT NOT NULL,
    question        TEXT,
    side            TEXT NOT NULL CHECK (side IN ('YES','NO')),
    variant         TEXT NOT NULL,
    entry_price     REAL,
    shares          REAL,
    cost_basis      REAL,
    pyramid_mult    REAL,
    unrealised_roi  REAL,
    v_1h            REAL,
    v_6h            REAL,
    z_1h            REAL,
    resolved        INTEGER NOT NULL DEFAULT 0,
    winner          TEXT,
    shadow_pnl      REAL,
    resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_shadow_market_side_variant
    ON shadow_trades(market_id, side, variant);
CREATE INDEX IF NOT EXISTS idx_shadow_resolved
    ON shadow_trades(resolved);
"""


def get_connection(db_path: Path | None = None) -> sqlite3.Connection:
    """Get a SQLite connection with WAL mode and row factory.

    Uses check_same_thread=False so the connection can be shared with the
    daemon's ThreadPoolExecutor (single worker — no concurrent writes).
    """
    if db_path is None:
        db_path = get_db_path()
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _migrate(conn):
    """Run schema migrations based on current version."""
    current = get_meta(conn, "schema_version")
    version = int(current) if current else 1

    if version < 2:
        # v2: add predictions table
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS predictions (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                market_id     TEXT NOT NULL,
                condition_id  TEXT,
                question      TEXT NOT NULL,
                slug          TEXT,
                side          TEXT NOT NULL,
                shares        REAL NOT NULL,
                entry_odds    REAL NOT NULL,
                cost_basis    REAL NOT NULL,
                clob_token_id TEXT,
                end_date      TEXT,
                opened_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                closed_at     TEXT,
                resolution    TEXT,
                payout        REAL,
                pnl           REAL,
                status        TEXT NOT NULL DEFAULT 'open'
            );
        """)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "2"),
        )
        conn.commit()
        version = 2

    if version < 3:
        # v3: add pipeline tables
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS pipeline_runs (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                cycle_id         INTEGER NOT NULL,
                ts               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                tweets_collected INTEGER DEFAULT 0,
                markets_found    INTEGER DEFAULT 0,
                estimates_made   INTEGER DEFAULT 0,
                edges_found      INTEGER DEFAULT 0,
                duration_ms      INTEGER,
                FOREIGN KEY (cycle_id) REFERENCES cycles(id)
            );
            CREATE TABLE IF NOT EXISTS x_posts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                tweet_id    TEXT UNIQUE,
                author      TEXT,
                text        TEXT NOT NULL,
                created_at  TEXT,
                likes       INTEGER DEFAULT 0,
                retweets    INTEGER DEFAULT 0,
                cycle_id    INTEGER,
                collected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                FOREIGN KEY (cycle_id) REFERENCES cycles(id)
            );
            CREATE TABLE IF NOT EXISTS musk_markets (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                market_id   TEXT UNIQUE NOT NULL,
                question    TEXT NOT NULL,
                slug        TEXT,
                yes_price   REAL,
                no_price    REAL,
                volume      REAL,
                end_date    TEXT,
                first_seen  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                last_seen   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE TABLE IF NOT EXISTS odds_snapshots (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                market_id   TEXT NOT NULL,
                yes_price   REAL NOT NULL,
                no_price    REAL NOT NULL,
                ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                cycle_id    INTEGER,
                FOREIGN KEY (cycle_id) REFERENCES cycles(id)
            );
            CREATE TABLE IF NOT EXISTS estimates (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                cycle_id         INTEGER NOT NULL,
                market_id        TEXT NOT NULL,
                vault_probability REAL NOT NULL,
                confidence       REAL NOT NULL,
                reasoning        TEXT,
                model_used       TEXT,
                ts               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                FOREIGN KEY (cycle_id) REFERENCES cycles(id)
            );
            CREATE TABLE IF NOT EXISTS edge_calculations (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                cycle_id             INTEGER NOT NULL,
                market_id            TEXT NOT NULL,
                vault_prob           REAL NOT NULL,
                market_odds          REAL NOT NULL,
                edge                 REAL NOT NULL,
                side                 TEXT NOT NULL,
                confidence           REAL NOT NULL,
                recommended_size_usd REAL,
                action               TEXT NOT NULL,
                reasoning            TEXT,
                ts                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                FOREIGN KEY (cycle_id) REFERENCES cycles(id)
            );
            CREATE TABLE IF NOT EXISTS calibration (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                market_id       TEXT NOT NULL,
                estimated_prob  REAL NOT NULL,
                actual_outcome  INTEGER,
                resolved_at     TEXT
            );
        """)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "3"),
        )
        conn.commit()
        version = 3

    if version < 4:
        # v4: add retweeted_by to x_posts
        try:
            conn.execute("ALTER TABLE x_posts ADD COLUMN retweeted_by TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "4"),
        )
        conn.commit()
        version = 4

    if version < 5:
        # v5: add digests table
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS digests (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                cycle_id    INTEGER,
                tweet_count INTEGER NOT NULL,
                hours_back  INTEGER NOT NULL DEFAULT 48,
                digest_text TEXT NOT NULL,
                model_used  TEXT,
                cost_usd    REAL DEFAULT 0,
                FOREIGN KEY (cycle_id) REFERENCES cycles(id)
            );
        """)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "5"),
        )
        conn.commit()
        version = 5

    if version < 6:
        # v6: add entry_edge and entry_reasoning to predictions
        for col, coltype in [("entry_edge", "REAL"), ("entry_reasoning", "TEXT")]:
            try:
                conn.execute(f"ALTER TABLE predictions ADD COLUMN {col} {coltype}")
            except sqlite3.OperationalError:
                pass  # column already exists
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "6"),
        )
        conn.commit()
        version = 6

    if version < 7:
        # v7: add master_intelligence table
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS master_intelligence (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                document    TEXT NOT NULL,
                themes_json TEXT,
                tweet_count INTEGER DEFAULT 0,
                model_used  TEXT,
                cost_usd    REAL DEFAULT 0
            );
        """)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "7"),
        )
        conn.commit()
        version = 7

    if version < 8:
        # v8: add opus_estimates + sentinel_alerts tables
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS opus_estimates (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                ts               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                intelligence_id  INTEGER NOT NULL,
                market_id        TEXT NOT NULL,
                question         TEXT,
                vault_probability REAL NOT NULL,
                confidence       REAL NOT NULL,
                reasoning        TEXT
            );
            CREATE TABLE IF NOT EXISTS sentinel_alerts (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                ts               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                cycle_id         INTEGER NOT NULL,
                prediction_id    INTEGER NOT NULL,
                market_id        TEXT NOT NULL,
                status           TEXT NOT NULL,
                event            TEXT,
                source           TEXT
            );
        """)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "8"),
        )
        conn.commit()
        version = 8

    if version < 9:
        # v9: add entry_confidence to predictions
        try:
            conn.execute("ALTER TABLE predictions ADD COLUMN entry_confidence REAL")
        except sqlite3.OperationalError:
            pass  # column already exists
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "9"),
        )
        conn.commit()
        version = 9

    if version < 10:
        # v10: add smart_money_log table
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS smart_money_log (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                ts                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                cycle_id            INTEGER NOT NULL,
                market_id           TEXT NOT NULL,
                question            TEXT,
                v_1h                REAL,
                v_6h                REAL,
                direction           TEXT,
                sharp               INTEGER NOT NULL DEFAULT 0,
                action_taken        TEXT NOT NULL,
                vault_estimate      REAL,
                market_odds         REAL,
                side                TEXT,
                amount_usd          REAL,
                prediction_id       INTEGER,
                counterfactual_size REAL,
                counterfactual_side TEXT,
                outcome             TEXT DEFAULT 'pending',
                outcome_pnl         REAL,
                counterfactual_pnl  REAL,
                resolved_at         TEXT,
                FOREIGN KEY (cycle_id) REFERENCES cycles(id)
            );
        """)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "10"),
        )
        conn.commit()

    if version < 11:
        # v11: add z_1h and confidence to smart_money_log for z-score outcome tracking
        for col, coltype in [("z_1h", "REAL"), ("confidence", "REAL")]:
            try:
                conn.execute(f"ALTER TABLE smart_money_log ADD COLUMN {col} {coltype}")
            except sqlite3.OperationalError:
                pass  # column already exists
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "11"),
        )
        conn.commit()

    if version < 12:
        # v12: add peak_roi to predictions for trailing stop high-water mark
        try:
            conn.execute("ALTER TABLE predictions ADD COLUMN peak_roi REAL DEFAULT 0")
        except sqlite3.OperationalError:
            pass  # column already exists
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "12"),
        )
        conn.commit()

    if version < 13:
        # v13: enriched market data from Gamma API for momentum intelligence
        for col, coltype in [("description", "TEXT"), ("volume_24h", "REAL"),
                             ("liquidity", "REAL"), ("spread", "REAL"),
                             ("competitive", "REAL"), ("game_start_time", "TEXT"),
                             ("event_title", "TEXT")]:
            try:
                conn.execute(f"ALTER TABLE musk_markets ADD COLUMN {col} {coltype}")
            except sqlite3.OperationalError:
                pass  # column already exists
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "13"),
        )
        conn.commit()

    if version < 14:
        # v14: performance indexes for hot query paths
        indexes = [
            ("idx_odds_snapshots_market_ts", "odds_snapshots(market_id, ts)"),
            ("idx_predictions_status", "predictions(status)"),
            ("idx_api_calls_cycle_id", "api_calls(cycle_id)"),
            ("idx_api_calls_ts", "api_calls(ts)"),
            ("idx_smart_money_log_market_outcome", "smart_money_log(market_id, outcome)"),
        ]
        for idx_name, idx_def in indexes:
            try:
                conn.execute(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {idx_def}")
            except sqlite3.OperationalError as e:
                log.warning(f"Failed to create index {idx_name}: {e}")
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "14"),
        )
        conn.commit()

    if version < 15:
        # v15: compound index for burned-market guard + multi-flip guard queries
        try:
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_predictions_market_closed "
                "ON predictions(market_id, closed_at)"
            )
        except sqlite3.OperationalError as e:
            log.warning(f"Failed to create index idx_predictions_market_closed: {e}")
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "15"),
        )
        conn.commit()

    if version < 16:
        # v16: add backtest_results table for safeguard backtester
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS backtest_results (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                run_date       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                safeguard      TEXT NOT NULL,
                param_value    TEXT NOT NULL,
                lookback_days  INTEGER,
                total_trades   INTEGER NOT NULL,
                trades_blocked INTEGER NOT NULL,
                wins_blocked   INTEGER NOT NULL,
                losses_blocked INTEGER NOT NULL,
                pnl_impact     REAL NOT NULL,
                p_value        REAL,
                cohens_d       REAL,
                significant    INTEGER NOT NULL DEFAULT 0
            );
        """)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "16"),
        )
        conn.commit()


    if version < 17:
        # v17: shadow_trades table for pyramid A/B testing
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS shadow_trades (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                cycle_id        INTEGER NOT NULL,
                market_id       TEXT NOT NULL,
                question        TEXT,
                side            TEXT NOT NULL,
                variant         TEXT NOT NULL,
                entry_price     REAL NOT NULL,
                shares          REAL NOT NULL,
                cost_basis      REAL NOT NULL,
                pyramid_mult    REAL NOT NULL,
                unrealised_roi  REAL,
                v_1h            REAL,
                v_6h            REAL,
                z_1h            REAL,
                resolved        INTEGER NOT NULL DEFAULT 0,
                winner          TEXT,
                shadow_pnl      REAL,
                resolved_at     TEXT,
                FOREIGN KEY (cycle_id) REFERENCES cycles(id)
            );
            CREATE INDEX IF NOT EXISTS idx_shadow_market ON shadow_trades(market_id, resolved);
        """)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "17"),
        )
        conn.commit()

    if version < 18:
        # v18: seed peak_total_value for drawdown circuit-breaker
        # Use latest objectives snapshot (balance + positions_value) as fresh start
        row = conn.execute(
            "SELECT balance, COALESCE(positions_value, 0) as pv "
            "FROM objectives ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row:
            peak = round(row["balance"] + row["pv"], 6)
        else:
            # No objectives history — fall back to current ledger balance
            bal_row = conn.execute(
                "SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1"
            ).fetchone()
            peak = round(bal_row["balance_after"], 6) if bal_row else 50.0
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("peak_total_value", str(peak)),
        )
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "18"),
        )
        conn.commit()
        log.info(f"v18 migration: seeded peak_total_value = ${peak:.2f}")

    if version < 19:
        # v19: add execution_mode to predictions for real CLOB trading
        try:
            conn.execute("ALTER TABLE predictions ADD COLUMN execution_mode TEXT DEFAULT 'paper'")
        except sqlite3.OperationalError:
            pass  # column already exists
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "19"),
        )
        conn.commit()
        log.info("v19 migration: added execution_mode column to predictions")

    if version < 20:
        # v20: safeguards for real-money trading (post-15-Mar-2026 incident).
        # New prediction statuses: 'pending' (order placed, not confirmed),
        # 'reconciling' (orphan detected, needs manual review), 'cancelled' (never filled).
        # 'open' and 'closed' unchanged.
        # Track pending_since for orphan sweep timeout, and clob_attempt_id to dedupe retries.
        for col, coltype in (
            ("pending_since", "TEXT"),
            ("clob_attempt_id", "TEXT"),
            ("fill_verified_at", "TEXT"),
        ):
            try:
                conn.execute(f"ALTER TABLE predictions ADD COLUMN {col} {coltype}")
            except sqlite3.OperationalError:
                pass
        try:
            conn.execute("CREATE INDEX IF NOT EXISTS idx_predictions_status_mode ON predictions(status, execution_mode)")
        except sqlite3.OperationalError:
            pass
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "20"),
        )
        conn.commit()
        log.info("v20 migration: added pending_since/clob_attempt_id/fill_verified_at + index")

    if version < 21:
        # v21: wallet-level cashflow tracking. Rows appended by the wallet sync
        # loop when on-chain Transfer events to/from our wallet are detected with
        # a non-internal counterparty (i.e. not Polymarket exchanges or our own
        # DEX). `direction` is 'deposit' (external -> wallet) or 'withdrawal'
        # (wallet -> external).
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS wallet_transactions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                tx_hash         TEXT NOT NULL UNIQUE,
                block_number    INTEGER NOT NULL,
                ts              TEXT NOT NULL,
                direction       TEXT NOT NULL CHECK (direction IN ('deposit','withdrawal')),
                amount_usd      REAL NOT NULL,
                token           TEXT NOT NULL,
                counterparty    TEXT NOT NULL,
                notes           TEXT,
                ledger_id       INTEGER,
                FOREIGN KEY (ledger_id) REFERENCES ledger(id)
            );
            CREATE INDEX IF NOT EXISTS idx_wallet_tx_ts ON wallet_transactions(ts DESC);
            CREATE INDEX IF NOT EXISTS idx_wallet_tx_direction ON wallet_transactions(direction);
        """)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "21"),
        )
        conn.commit()
        log.info("v21 migration: added wallet_transactions table for cashflow tracking")

    if version < 22:
        # v22: backfill the shadow_trades table that agent.py has been writing
        # to (and reading from) without a CREATE TABLE in the original schema.
        # Once a real-mode position was open, every cycle hit the shadow eval
        # path on subsequent velocity alerts and threw 'no such table' — caught
        # at the cycle level but skipping the rest of momentum analysis.
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS shadow_trades (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                cycle_id        INTEGER,
                market_id       TEXT NOT NULL,
                question        TEXT,
                side            TEXT NOT NULL CHECK (side IN ('YES','NO')),
                variant         TEXT NOT NULL,
                entry_price     REAL,
                shares          REAL,
                cost_basis      REAL,
                pyramid_mult    REAL,
                unrealised_roi  REAL,
                v_1h            REAL,
                v_6h            REAL,
                z_1h            REAL,
                resolved        INTEGER NOT NULL DEFAULT 0,
                winner          TEXT,
                shadow_pnl      REAL,
                resolved_at     TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_shadow_market_side_variant
                ON shadow_trades(market_id, side, variant);
            CREATE INDEX IF NOT EXISTS idx_shadow_resolved
                ON shadow_trades(resolved);
        """)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "22"),
        )
        conn.commit()
        log.info("v22 migration: created shadow_trades table (was referenced but never declared)")

    if version < 23:
        # v23: create the odds_snapshots(market_id, ts) index on live DBs. It was
        # only ever declared in the v14 migration block, which fresh/reset DBs skip
        # (init seeds schema_version directly to SCHEMA_VERSION, bypassing v14). The
        # live DB has had ZERO indexes on odds_snapshots. Critical before re-widening
        # discovery (1 Jun 2026): velocity calc scans this table per market per cycle.
        try:
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_odds_snapshots_market_ts "
                "ON odds_snapshots(market_id, ts)"
            )
        except sqlite3.OperationalError as e:
            log.warning(f"Failed to create index idx_odds_snapshots_market_ts: {e}")
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "23"),
        )
        conn.commit()
        log.info("v23 migration: created idx_odds_snapshots_market_ts (was missing on live DB)")

    if version < 24:
        # v24: shadow_fades — paper-track the FADE counterfactual of each momentum
        # signal out-of-sample (observe-only, never affects trading). See
        # vault/shadow_fade.py and vault/fade_backtest.py.
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS shadow_fades (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                ts            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                cycle_id      INTEGER,
                market_id     TEXT NOT NULL,
                question      TEXT,
                follow_side   TEXT,
                fade_side     TEXT,
                entry_price   REAL,
                stake         REAL,
                v_1h          REAL,
                v_6h          REAL,
                z_1h          REAL,
                spread        REAL,
                horizon_hours REAL,
                status        TEXT NOT NULL DEFAULT 'open',
                exit_price    REAL,
                exit_ts       TEXT,
                fade_pnl      REAL,
                resolved_at   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_shadow_fades_status ON shadow_fades(status);
            CREATE INDEX IF NOT EXISTS idx_shadow_fades_market ON shadow_fades(market_id, status);
        """)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("schema_version", "24"),
        )
        conn.commit()
        log.info("v24 migration: created shadow_fades table (out-of-sample fade tracking)")


def init_db(db_path: Path | None = None) -> sqlite3.Connection:
    """Create tables and seed meta if needed."""
    conn = get_connection(db_path)
    conn.executescript(SCHEMA_SQL)

    # Set schema version
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)",
        ("schema_version", str(SCHEMA_VERSION)),
    )
    # Alive by default
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)",
        ("alive", "true"),
    )
    conn.commit()

    # Run migrations for existing DBs
    _migrate(conn)
    return conn


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str):
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()
