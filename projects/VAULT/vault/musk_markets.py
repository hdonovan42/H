"""Musk ecosystem market discovery — thin compatibility shim.

All functionality has moved to vault.market_discovery.
This module re-exports for backward compatibility.
"""

from vault.market_discovery import (  # noqa: F401
    discover_markets as collect_musk_markets,
    _upsert_market,
    record_odds_snapshot,
    get_odds_history,
    get_tracked_markets,
)

# collect_musk_markets is now discover_markets with a themes parameter.
# When called without themes (old-style), it falls back to config keywords.
# The pipeline now calls discover_markets directly with themes.
