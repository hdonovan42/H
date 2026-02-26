"""Check event_title and condition_id population for theme concentration cap design."""
import sqlite3
conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

# Check event_title population in musk_markets
total = conn.execute("SELECT COUNT(*) as c FROM musk_markets").fetchone()["c"]
with_event = conn.execute(
    "SELECT COUNT(*) as c FROM musk_markets WHERE event_title IS NOT NULL AND event_title != ''"
).fetchone()["c"]
print("musk_markets: %d total, %d with event_title (%d%%)" % (
    total, with_event, 100 * with_event // total if total else 0))

# Show distinct event_titles and how many markets each has
rows = conn.execute(
    "SELECT event_title, COUNT(*) as cnt FROM musk_markets "
    "WHERE event_title IS NOT NULL AND event_title != '' "
    "GROUP BY event_title ORDER BY cnt DESC LIMIT 20"
).fetchall()
print("\nTop event_titles by market count:")
for r in rows:
    print("  %3d markets | %s" % (r["cnt"], r["event_title"][:70]))

# Check condition_id in predictions
total_p = conn.execute("SELECT COUNT(*) as c FROM predictions").fetchone()["c"]
with_cid = conn.execute(
    "SELECT COUNT(*) as c FROM predictions WHERE condition_id IS NOT NULL AND condition_id != ''"
).fetchone()["c"]
print("\npredictions: %d total, %d with condition_id (%d%%)" % (
    total_p, with_cid, 100 * with_cid // total_p if total_p else 0))

# Markets with predictions, grouped by event_title (worst losses first)
print("\nMarkets with predictions, grouped by event_title (worst losses first):")
rows2 = conn.execute(
    "SELECT m.event_title, COUNT(DISTINCT p.market_id) as mkts, COUNT(*) as preds, "
    "SUM(CASE WHEN p.pnl < 0 THEN p.pnl ELSE 0 END) as losses, "
    "SUM(CASE WHEN p.pnl > 0 THEN p.pnl ELSE 0 END) as wins "
    "FROM predictions p "
    "JOIN musk_markets m ON p.market_id = m.market_id "
    "WHERE m.event_title IS NOT NULL AND m.event_title != '' "
    "AND p.status = 'closed' AND p.pnl IS NOT NULL "
    "GROUP BY m.event_title ORDER BY losses ASC LIMIT 15"
).fetchall()
for r in rows2:
    net = r["wins"] + r["losses"]
    print("  %2d mkts, %3d preds | L=$%7.2f W=$%6.2f net=$%+7.2f | %s" % (
        r["mkts"], r["preds"], r["losses"], r["wins"], net, r["event_title"][:50]))

# Markets WITHOUT event_title that have predictions
print("\nMarkets WITHOUT event_title that have predictions:")
rows3 = conn.execute(
    "SELECT p.market_id, p.question, COUNT(*) as preds, "
    "SUM(p.pnl) as net_pnl "
    "FROM predictions p "
    "LEFT JOIN musk_markets m ON p.market_id = m.market_id "
    "WHERE (m.event_title IS NULL OR m.event_title = '') "
    "AND p.status = 'closed' AND p.pnl IS NOT NULL "
    "GROUP BY p.market_id ORDER BY net_pnl ASC LIMIT 10"
).fetchall()
for r in rows3:
    print("  %2d preds | net=$%+.2f | %s" % (r["preds"], r["net_pnl"], r["question"][:55]))

# Count open predictions by event_title (current exposure)
print("\nCurrent open predictions by event_title:")
rows4 = conn.execute(
    "SELECT m.event_title, COUNT(DISTINCT p.market_id) as mkts, COUNT(*) as preds, "
    "SUM(p.cost_basis) as exposure "
    "FROM predictions p "
    "JOIN musk_markets m ON p.market_id = m.market_id "
    "WHERE p.status = 'open' "
    "GROUP BY m.event_title ORDER BY mkts DESC"
).fetchall()
for r in rows4:
    evt = r["event_title"] if r["event_title"] else "(no event_title)"
    print("  %2d mkts, %2d preds, $%.2f exposure | %s" % (
        r["mkts"], r["preds"], r["exposure"], evt[:55]))

conn.close()
