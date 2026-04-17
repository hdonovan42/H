"""Tests for go_live_reset and the on-chain anchoring logic.

Regression target: 15 March 2026 incident. The paper ledger must not carry
forward as real money when `simulated: false` is set.
"""
import pytest

from vault import ledger
from vault.ledger import go_live_reset, is_live, compute_expected_onchain, get_balance


def test_is_live_false_on_fresh_db(seeded_db):
    """A newly seeded paper DB should NOT be live."""
    assert is_live(seeded_db) is False


def test_expected_onchain_is_zero_before_golive(seeded_db):
    """Before go_live, compute_expected_onchain returns 0 — no real money expected."""
    assert compute_expected_onchain(seeded_db) == 0.0


def test_go_live_zeros_the_paper_balance(seeded_db):
    """Paper $50 + $2 API costs → on-chain $50. Balance snaps to $50 exactly, not $52."""
    # Simulate a run that accumulated some paper activity
    ledger.deduct_api_cost(seeded_db, 1.0, "test-api-1")
    ledger.deduct_api_cost(seeded_db, 1.0, "test-api-2")
    assert get_balance(seeded_db) == pytest.approx(48.0)

    # User deposits $50 real USDC → we go live
    new_balance = go_live_reset(seeded_db, 50.0)

    assert new_balance == pytest.approx(50.0)
    assert get_balance(seeded_db) == pytest.approx(50.0)
    assert is_live(seeded_db) is True


def test_go_live_with_higher_paper_balance(seeded_db):
    """Paper balance has grown to $100 from P&L; on-chain is $50. Reset to $50 (not $100)."""
    # Fake a paper trade profit by recording a resolve that adds money
    seeded_db.execute(
        "INSERT INTO ledger (entry_type, amount, description, balance_after) "
        "VALUES ('prediction_resolve', 50.0, 'paper win', 100.0)"
    )
    seeded_db.commit()
    assert get_balance(seeded_db) == pytest.approx(100.0)

    go_live_reset(seeded_db, 50.0)
    assert get_balance(seeded_db) == pytest.approx(50.0)


def test_go_live_refuses_with_open_real_predictions(seeded_db):
    """Cannot go live if there are open real predictions from a previous life."""
    seeded_db.execute(
        "INSERT INTO predictions "
        "(market_id, question, side, shares, entry_odds, cost_basis, execution_mode, status) "
        "VALUES ('m1', 'q', 'YES', 10.0, 0.5, 5.0, 'real', 'open')"
    )
    seeded_db.commit()
    with pytest.raises(RuntimeError, match="open real predictions"):
        go_live_reset(seeded_db, 50.0)


def test_expected_onchain_after_golive_matches_anchor(seeded_db):
    """Immediately after go-live, expected_onchain equals the anchor."""
    go_live_reset(seeded_db, 50.0)
    assert compute_expected_onchain(seeded_db) == pytest.approx(50.0)


def test_expected_onchain_subtracts_real_costs(seeded_db):
    """Opening a real prediction reduces expected on-chain by its cost_basis."""
    go_live_reset(seeded_db, 50.0)
    seeded_db.execute(
        "INSERT INTO predictions "
        "(market_id, question, side, shares, entry_odds, cost_basis, execution_mode, status) "
        "VALUES ('m1', 'q', 'YES', 10.0, 0.5, 5.0, 'real', 'open')"
    )
    seeded_db.commit()
    assert compute_expected_onchain(seeded_db) == pytest.approx(45.0)


def test_expected_onchain_includes_pending(seeded_db):
    """Pending predictions are included in expected costs (worst-case accounting)."""
    go_live_reset(seeded_db, 50.0)
    seeded_db.execute(
        "INSERT INTO predictions "
        "(market_id, question, side, shares, entry_odds, cost_basis, execution_mode, status) "
        "VALUES ('m1', 'q', 'YES', 10.0, 0.5, 5.0, 'real', 'pending')"
    )
    seeded_db.commit()
    assert compute_expected_onchain(seeded_db) == pytest.approx(45.0)


def test_expected_onchain_excludes_cancelled(seeded_db):
    """Cancelled predictions don't affect on-chain math (USDC never moved)."""
    go_live_reset(seeded_db, 50.0)
    seeded_db.execute(
        "INSERT INTO predictions "
        "(market_id, question, side, shares, entry_odds, cost_basis, execution_mode, status) "
        "VALUES ('m1', 'q', 'YES', 10.0, 0.5, 5.0, 'real', 'cancelled')"
    )
    seeded_db.commit()
    assert compute_expected_onchain(seeded_db) == pytest.approx(50.0)


def test_expected_onchain_adds_payouts(seeded_db):
    """Closed real predictions with payouts add to expected on-chain balance."""
    go_live_reset(seeded_db, 50.0)
    seeded_db.execute(
        "INSERT INTO predictions "
        "(market_id, question, side, shares, entry_odds, cost_basis, execution_mode, status, payout) "
        "VALUES ('m1', 'q', 'YES', 10.0, 0.5, 5.0, 'real', 'closed', 10.0)"
    )
    seeded_db.commit()
    # 50 (anchor) - 5 (cost) + 10 (payout) = 55
    assert compute_expected_onchain(seeded_db) == pytest.approx(55.0)


def test_deposits_before_anchor_are_ignored(seeded_db):
    """A deposit recorded before go_live doesn't inflate post-golive expected."""
    ledger.record_deposit(seeded_db, 10.0)  # pre-golive stray deposit (shouldn't happen, but test the accounting)
    go_live_reset(seeded_db, 50.0)
    # Anchor is 50. Pre-golive deposit not counted (ids < anchor_id).
    assert compute_expected_onchain(seeded_db) == pytest.approx(50.0)


def test_deposits_after_anchor_add_to_expected(seeded_db):
    """Post-golive deposits are counted."""
    go_live_reset(seeded_db, 50.0)
    ledger.record_deposit(seeded_db, 25.0)
    assert compute_expected_onchain(seeded_db) == pytest.approx(75.0)
