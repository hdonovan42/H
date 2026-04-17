"""End-to-end tests for the real-mode bet actuator with mocked CLOB/RPC.

Validates the pending→confirm/cancel flow through the full BetActuator.execute path.
The regression target is the 15 March 2026 loss pattern: bet placed on-chain but
not recorded in the DB.
"""
from unittest.mock import patch, MagicMock

import pytest

from vault import ledger
from vault.actuators.bet import BetActuator
from vault.clob_client import FillResult


MARKET = {
    "id": "mkt_1",
    "condition_id": "cond_1",
    "question": "Test market?",
    "slug": "test-market",
    "yes_price": 0.50,
    "no_price": 0.50,
    "end_date": "2026-12-31T23:59:59Z",
    "clob_token_ids": ["token_yes", "token_no"],
    "closed": False,
}


def _bet_params(**overrides):
    params = dict(market_id="mkt_1", side="YES", amount_usd=5.0, reasoning="test")
    params.update(overrides)
    return params


@pytest.fixture
def live_db(seeded_db):
    """seeded_db transitioned into real-money mode with $50 on-chain."""
    ledger.go_live_reset(seeded_db, 50.0)
    return seeded_db


@pytest.fixture
def real_mode_config(monkeypatch, tmp_path):
    """Force simulated=false by writing a config.yaml override."""
    from vault import config_loader
    root = config_loader._find_project_root()
    override = root / "config.yaml"
    preexisting = override.exists()
    original = override.read_text() if preexisting else None
    override.write_text("trading:\n  simulated: false\n")
    config_loader._config_cache = None
    yield
    # Restore
    if preexisting:
        override.write_text(original)
    else:
        override.unlink()
    config_loader._config_cache = None


def _patch_market(**overrides):
    m = dict(MARKET)
    m.update(overrides)
    return patch("vault.actuators.bet.fetch_market", return_value=m)


def test_happy_path_real_bet_atomically_recorded(live_db, real_mode_config):
    """CLOB success → prediction is 'open' with ledger debit. No orphan."""
    fill = FillResult(success=True, order_id="ord_1", side="BUY", token_id="token_yes",
                      amount_usd=5.0, shares=10.0, avg_price=0.50)

    with _patch_market(), \
         patch("vault.clob_client.buy_shares", return_value=fill), \
         patch("vault.clob_client.get_best_ask", return_value=0.50), \
         patch("vault.clob_client.get_usdc_balance", return_value=50.0), \
         patch("vault.clob_client.get_ctf_balance", side_effect=[0.0, 10.0]):  # pre-trade 0, post-trade 10
        result = BetActuator().execute(live_db, _bet_params(), {"cycle_id": 1})

    assert result["success"] is True
    assert result["execution_mode"] == "real"
    assert result["fill_verified"] is True

    row = live_db.execute(
        "SELECT status, cost_basis, shares FROM predictions WHERE id = ?",
        (result["prediction_id"],)
    ).fetchone()
    assert row["status"] == "open"
    assert row["cost_basis"] == pytest.approx(5.0)
    assert row["shares"] == pytest.approx(10.0)
    assert ledger.get_balance(live_db) == pytest.approx(45.0)


def test_clob_rejection_cancels_pending(live_db, real_mode_config):
    """CLOB returns success=False with no stealth fill → row cancelled, balance intact."""
    fill = FillResult(success=False, error="invalid signature")

    with _patch_market(), \
         patch("vault.clob_client.buy_shares", return_value=fill), \
         patch("vault.clob_client.get_best_ask", return_value=0.50), \
         patch("vault.clob_client.get_usdc_balance", return_value=50.0), \
         patch("vault.clob_client.get_ctf_balance", return_value=0.0), \
         patch("time.sleep"):  # skip the 1s wait
        result = BetActuator().execute(live_db, _bet_params(), {"cycle_id": 1})

    assert result["success"] is False

    row = live_db.execute(
        "SELECT status FROM predictions WHERE id = ?", (result["prediction_id"],)
    ).fetchone()
    assert row["status"] == "cancelled"
    assert ledger.get_balance(live_db) == pytest.approx(50.0)


def test_clob_failure_with_onchain_shares_goes_reconciling(live_db, real_mode_config):
    """CLOB says failure but CTF shows shares → row flagged 'reconciling' (do not cancel)."""
    fill = FillResult(success=False, error="invalid signature")

    with _patch_market(), \
         patch("vault.clob_client.buy_shares", return_value=fill), \
         patch("vault.clob_client.get_best_ask", return_value=0.50), \
         patch("vault.clob_client.get_usdc_balance", return_value=100.0), \
         patch("vault.clob_client.get_ctf_balance", side_effect=[0.0, 10.0]), \
         patch("time.sleep"):  # pre-trade 0 (Guard 4), post-fail sweep 10
        result = BetActuator().execute(live_db, _bet_params(amount_usd=5.0), {"cycle_id": 1})

    assert result["success"] is False
    assert result.get("reconciling") is True

    row = live_db.execute(
        "SELECT status FROM predictions WHERE id = ?", (result["prediction_id"],)
    ).fetchone()
    assert row["status"] == "reconciling"


def test_clob_exception_marks_reconciling(live_db, real_mode_config):
    """CLOB call raises a Python exception → row flagged 'reconciling' (not cancelled)."""
    with _patch_market(), \
         patch("vault.clob_client.buy_shares", side_effect=RuntimeError("network blew up")), \
         patch("vault.clob_client.get_best_ask", return_value=0.50), \
         patch("vault.clob_client.get_usdc_balance", return_value=50.0), \
         patch("vault.clob_client.get_ctf_balance", return_value=0.0):
        result = BetActuator().execute(live_db, _bet_params(), {"cycle_id": 1})

    assert result["success"] is False
    assert result.get("reconciling") is True

    row = live_db.execute(
        "SELECT status FROM predictions WHERE id = ?", (result["prediction_id"],)
    ).fetchone()
    assert row["status"] == "reconciling"


def test_real_mode_refuses_without_golive(seeded_db, real_mode_config):
    """Real mode must refuse to trade if the ledger has no go_live_reset entry."""
    # seeded_db has NOT been through go_live_reset — intentional
    with _patch_market():
        result = BetActuator().execute(seeded_db, _bet_params(), {"cycle_id": 1})

    assert result["success"] is False
    assert "go-live" in result["error"].lower()

    rows = seeded_db.execute("SELECT COUNT(*) FROM predictions WHERE execution_mode='real'").fetchone()[0]
    assert rows == 0


def test_rpc_unavailable_blocks_bet(live_db, real_mode_config):
    """If get_usdc_balance returns None (all RPCs dead), real mode must refuse."""
    with _patch_market(), \
         patch("vault.clob_client.get_usdc_balance", return_value=None):
        result = BetActuator().execute(live_db, _bet_params(), {"cycle_id": 1})

    assert result["success"] is False
    assert "RPC" in result["error"] or "unavailable" in result["error"].lower()


def test_onchain_cap_blocks_oversized_bet(live_db, real_mode_config):
    """max_bet_pct_onchain (10%) blocks bets larger than that slice of on-chain USDC."""
    # $50 on-chain, 10% cap = $5.00. Try to bet $10.
    with _patch_market(), \
         patch("vault.clob_client.get_usdc_balance", return_value=50.0):
        result = BetActuator().execute(live_db, _bet_params(amount_usd=10.0), {"cycle_id": 1})

    assert result["success"] is False
    assert "Real-mode cap" in result["error"]


def test_existing_onchain_position_blocks_entry(live_db, real_mode_config):
    """Guard 4: pre-existing CTF shares for this token block a new bet."""
    with _patch_market(), \
         patch("vault.clob_client.get_best_ask", return_value=0.50), \
         patch("vault.clob_client.get_usdc_balance", return_value=50.0), \
         patch("vault.clob_client.get_ctf_balance", return_value=5.0):  # already have 5 shares
        result = BetActuator().execute(live_db, _bet_params(), {"cycle_id": 1})

    assert result["success"] is False
    assert "On-chain position exists" in result["error"]


def test_regression_15_march_scenario_in_real_mode(seeded_db, real_mode_config):
    """Full regression: paper accumulates $51.29, user flips simulated=false without go-live.

    Pre-fix behaviour: the daemon would happily try to spend the phantom $51.29.
    Post-fix behaviour: the bet actuator refuses with a clear error message.
    """
    # Build up paper history matching the Mar 15 pre-incident state
    ledger.deduct_api_cost(seeded_db, 1.0, "paper day 1")
    seeded_db.execute(
        "INSERT INTO ledger (entry_type, amount, description, balance_after) "
        "VALUES ('prediction_resolve', 2.29, 'paper win', 51.29)"
    )
    seeded_db.commit()

    # At this point paper balance is $51.29 and is_live() is False.
    # Without the fix, the bet actuator would happily try to spend that money.
    with _patch_market():
        result = BetActuator().execute(seeded_db, _bet_params(amount_usd=5.0), {"cycle_id": 1})

    assert result["success"] is False
    assert "go-live" in result["error"].lower(), \
        f"Expected go-live gate to block the bet; got error: {result['error']}"

    # No real prediction was created
    real_count = seeded_db.execute(
        "SELECT COUNT(*) FROM predictions WHERE execution_mode='real'"
    ).fetchone()[0]
    assert real_count == 0
