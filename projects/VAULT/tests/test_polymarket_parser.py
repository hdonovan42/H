"""Regression tests for vault.polymarket._parse_market.

Pinned to the 28 Apr 2026 incident: when the gamma API returned a market
record without `outcomePrices` populated, the parser silently defaulted to
0.5/0.5. That fake reading flowed into odds_snapshots, predictions_value,
and pred #12's peak_roi (which got pinned to +146% from a 20-minute window
of bogus reads). The fix sets has_prices=False instead so callers can detect
and skip stale data.
"""
from vault.polymarket import _parse_market, get_current_odds


GAMMA_OK = {
    "id": "999",
    "conditionId": "0xabc",
    "question": "Will it rain?",
    "slug": "will-it-rain",
    "outcomePrices": '["0.32","0.68"]',
    "volume": 1000,
}


def test_parse_market_with_prices_sets_has_prices_true():
    parsed = _parse_market(GAMMA_OK)
    assert parsed["yes_price"] == 0.32
    assert parsed["no_price"] == 0.68
    assert parsed["has_prices"] is True


def test_parse_market_missing_outcome_prices_does_not_default_to_50_50():
    """Regression: previously yielded yes=0.5, no=0.5 silently.
    Now: yields None and has_prices=False so callers know data is missing."""
    raw = dict(GAMMA_OK)
    del raw["outcomePrices"]
    parsed = _parse_market(raw)
    assert parsed is not None
    assert parsed["yes_price"] is None
    assert parsed["no_price"] is None
    assert parsed["has_prices"] is False


def test_parse_market_null_outcome_prices_does_not_default_to_50_50():
    raw = dict(GAMMA_OK, outcomePrices=None)
    parsed = _parse_market(raw)
    assert parsed["has_prices"] is False
    assert parsed["yes_price"] is None


def test_parse_market_unparseable_outcome_prices_does_not_default_to_50_50():
    raw = dict(GAMMA_OK, outcomePrices="this is not json")
    parsed = _parse_market(raw)
    assert parsed["has_prices"] is False
    assert parsed["yes_price"] is None


def test_parse_market_short_outcome_prices_does_not_default_to_50_50():
    """A single-element list is invalid for binary markets. Don't fake the missing side."""
    raw = dict(GAMMA_OK, outcomePrices='["0.5"]')
    parsed = _parse_market(raw)
    assert parsed["has_prices"] is False


def test_get_current_odds_returns_none_when_prices_missing(monkeypatch):
    """Regression: get_current_odds previously returned {yes_price: 0.5, no_price: 0.5}
    when the parser silently defaulted. Now: returns None so MTM, peak_roi
    updates, and odds_snapshots all skip cleanly."""
    fake = {"id": "999", "yes_price": None, "no_price": None, "has_prices": False}
    monkeypatch.setattr("vault.polymarket.fetch_market", lambda conn, mid: fake)
    assert get_current_odds(None, "999") is None


def test_get_current_odds_returns_prices_when_present(monkeypatch):
    fake = {"id": "999", "yes_price": 0.32, "no_price": 0.68, "has_prices": True}
    monkeypatch.setattr("vault.polymarket.fetch_market", lambda conn, mid: fake)
    odds = get_current_odds(None, "999")
    assert odds == {"yes_price": 0.32, "no_price": 0.68}
