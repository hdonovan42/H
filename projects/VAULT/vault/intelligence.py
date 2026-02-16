"""Master intelligence document — Opus-maintained daily analysis + probability estimation."""

import json
import logging
import subprocess
from datetime import datetime, timezone, timedelta
from vault.config_loader import load_config
from vault.claude_client import call_claude
from vault import ledger
from vault.polymarket import get_current_odds

INTELLIGENCE_REPO_PATH = "/home/hq/vault/intelligence"

log = logging.getLogger("vault.intelligence")

# Account descriptions for the Opus analyst
ACCOUNT_DESCRIPTIONS = {
    "elonmusk": "Primary source. CEO of Tesla, SpaceX, xAI. Direct announcements, policy positions.",
    "SawyerMerritt": "Tesla/SpaceX news aggregator. Often first on developments.",
    "farzyness": "Tesla manufacturing/delivery analysis. Technical production knowledge.",
    "TeslaLarry": "Investor perspective. Earnings, valuation, institutional sentiment.",
    "jamesdouma": "SpaceX/Starship technical analysis. Launch readiness, engineering.",
}


def _git_commit_intelligence(document: str, themes_json: str | None, commit_msg: str):
    """Write intelligence doc + themes to git repo and push to GitHub.

    Never breaks the pipeline — git failures are warnings only.
    """
    try:
        repo = INTELLIGENCE_REPO_PATH
        with open(f"{repo}/master_intelligence.md", "w") as f:
            f.write(document)
        if themes_json:
            themes = json.loads(themes_json)
            with open(f"{repo}/themes.json", "w") as f:
                json.dump(themes, f, indent=2)
        subprocess.run(
            ["git", "add", "-A"],
            cwd=repo, capture_output=True, timeout=10,
        )
        result = subprocess.run(
            ["git", "commit", "-m", commit_msg],
            cwd=repo, capture_output=True, timeout=10,
        )
        if result.returncode != 0:
            output = (result.stdout.decode(errors="replace")
                      + result.stderr.decode(errors="replace"))
            if "nothing to commit" in output:
                log.info("Git: no changes to commit")
                return
            log.warning(f"Git commit failed: {output}")
            return
        push = subprocess.run(
            ["git", "push"],
            cwd=repo, capture_output=True, timeout=30,
        )
        if push.returncode != 0:
            log.warning(f"Git push failed: {push.stderr.decode(errors='replace')}")
        else:
            log.info(f"Git: committed and pushed — {commit_msg}")
    except Exception as e:
        log.warning(f"Git intelligence commit failed (non-fatal): {e}")


def seed_intelligence(conn, document_text: str, themes_json: str | None = None):
    """Insert initial user-provided document into master_intelligence.

    Called once manually via CLI to bootstrap the system.
    """
    conn.execute(
        "INSERT INTO master_intelligence (document, themes_json, tweet_count, model_used) "
        "VALUES (?, ?, 0, 'user-seeded')",
        (document_text, themes_json),
    )
    conn.commit()
    _git_commit_intelligence(document_text, themes_json, "Seed: user-provided")
    log.info(f"Seeded master intelligence document ({len(document_text)} chars)")


def should_update_intelligence(conn, cfg: dict | None = None) -> bool:
    """Return True if latest master_intelligence.ts is before today's update hour UTC."""
    if cfg is None:
        cfg = load_config()

    intel_cfg = cfg.get("intelligence", {})
    update_hour = intel_cfg.get("update_hour_utc", 0)

    latest = conn.execute(
        "SELECT ts FROM master_intelligence ORDER BY id DESC LIMIT 1"
    ).fetchone()

    if not latest:
        return False  # No document seeded yet — can't update nothing

    now = datetime.now(timezone.utc)
    today_update = now.replace(hour=update_hour, minute=0, second=0, microsecond=0)

    # If we haven't passed today's update hour yet, use yesterday's
    if now < today_update:
        today_update -= timedelta(days=1)

    last_ts = datetime.fromisoformat(latest["ts"].replace("Z", "+00:00"))
    return last_ts < today_update


def update_intelligence(conn, cycle_id: int, cfg: dict | None = None) -> tuple[str, list, list]:
    """Update the master intelligence document + estimate probabilities with a single Opus call.

    Loads current document + all tweets since last update + discoverable markets,
    sends to Opus for combined intelligence analysis + probability estimation.
    Stores new row in master_intelligence and opus_estimates.

    Returns (document, themes, estimates).
    """
    if cfg is None:
        cfg = load_config()

    intel_cfg = cfg.get("intelligence", {})
    model = intel_cfg.get("model", "claude-opus-4-6")

    # Load current document
    current = conn.execute(
        "SELECT id, ts, document, themes_json FROM master_intelligence ORDER BY id DESC LIMIT 1"
    ).fetchone()

    if not current:
        log.warning("No master intelligence document to update — seed one first")
        return ("", [], [])

    current_doc = current["document"]
    last_ts = current["ts"]

    # Load all tweets since last update, grouped by account
    tweets = conn.execute(
        "SELECT tweet_id, author, text, created_at, likes, retweets, retweeted_by, collected_at "
        "FROM x_posts WHERE collected_at > ? ORDER BY collected_at ASC",
        (last_ts,),
    ).fetchall()
    tweets = [dict(r) for r in tweets]

    if not tweets:
        log.info("No new tweets since last intelligence update — keeping current document")
        themes = json.loads(current["themes_json"]) if current["themes_json"] else []
        return (current_doc, themes, [])

    # Group tweets by account
    by_account = {}
    for t in tweets:
        author = t.get("author", "unknown")
        group_key = t.get("retweeted_by") or author
        if group_key not in by_account:
            by_account[group_key] = []
        by_account[group_key].append(t)

    # Format tweets for prompt
    tweet_block = _format_tweets_for_opus(by_account)

    # Build account descriptions block
    acct_lines = []
    for handle, desc in ACCOUNT_DESCRIPTIONS.items():
        count = len(by_account.get(handle, []))
        acct_lines.append(f"- @{handle} ({count} posts) — {desc}")
    acct_block = "\n".join(acct_lines)

    # ── Gather markets to estimate ──────────────────────────────────
    # Discover markets using current themes (before update)
    from vault.market_discovery import discover_markets
    current_themes = json.loads(current["themes_json"]) if current["themes_json"] else []
    markets = discover_markets(conn, cycle_id, current_themes, cfg)

    # Also include open positions not already in discovered markets
    open_preds = ledger.get_open_predictions(conn)
    market_ids_in_list = {m["id"] for m in markets}
    for pred in open_preds:
        if pred["market_id"] not in market_ids_in_list:
            markets.append({
                "id": pred["market_id"],
                "question": pred["question"],
            })
            market_ids_in_list.add(pred["market_id"])

    # Build markets block for prompt (questions only, NO odds — anti-anchoring)
    # Include velocity context where available (momentum info, not actual prices)
    from vault.edge_calculator import calculate_velocity
    from vault.config_loader import load_config as _load_cfg
    _vel_cfg = _load_cfg()

    markets_block = ""
    if markets:
        markets_block = "\n\nMARKETS TO ESTIMATE:\n"
        markets_block += "For each market, estimate the probability of YES based on your analysis.\n"
        markets_block += "You do NOT have access to market odds — form your own independent view.\n\n"
        for i, m in enumerate(markets):
            vel = calculate_velocity(conn, m["id"], cfg=_vel_cfg)
            vel_note = ""
            if vel:
                parts = []
                if vel.get("v_1h") is not None:
                    parts.append(f"{vel['v_1h']:+.0%}/1h")
                if vel.get("v_6h") is not None:
                    parts.append(f"{vel['v_6h']:+.0%}/6h")
                if parts:
                    vel_note = f" [odds moved {', '.join(parts)}]"
            markets_block += f"  {i + 1}. \"{m.get('question', m['id'])}\"{vel_note}\n"

    # ── Build system prompt ─────────────────────────────────────────
    estimation_rules = ""
    if markets:
        estimation_rules = (
            '\n3. "estimates" — Array of probability estimates for each market:\n'
            '   [{"market_index": 1, "probability": 0.65, "confidence": 0.7, '
            '"reasoning": "Brief 1-2 sentence explanation"}]\n\n'
            "Estimation rules:\n"
            "- probability: your estimate of YES happening (0.0 to 1.0)\n"
            "- confidence: how sure you are of your estimate (0.0 to 1.0)\n"
            "- Be well-calibrated. Don't default to 50% — commit to a view.\n"
            "- STATISTICAL/COUNTING markets (tweet counts, follower milestones, weekly post counts, "
            "engagement metrics) → SET CONFIDENCE TO 0.2-0.3. You have no informational edge on "
            "these — they are essentially random.\n"
            "- EVENT markets (policy decisions, product launches, regulatory actions, legal outcomes) → "
            "confidence should reflect your SPECIFIC evidence for that event.\n"
        )

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    system = (
        "You are a senior intelligence analyst maintaining a master intelligence document "
        "for a prediction market trading system. This document is updated daily and used to "
        "inform betting decisions on Polymarket.\n\n"
        f"CURRENT DATE/TIME: {now_str}\n\n"
        f"You are tracking these curated Twitter/X accounts:\n{acct_block}\n\n"
        "Your task: UPDATE the existing intelligence document by incorporating new tweets. "
        "This is a LIVING DOCUMENT — preserve all existing analysis that remains valid. "
        "Only modify sections where new tweets provide new information. "
        "Do not discard prior analysis just because this update has few tweets. "
        "The document should grow more accurate over time, not get rewritten from scratch"
    )
    if markets:
        system += ", and estimate probabilities for prediction markets"
    system += ".\n\n"

    system += (
        "Output a JSON object with these fields:\n"
        '1. "document" — The updated master intelligence document.\n\n'
        "   TARGET LENGTH: 1,500-2,000 words. This is a hard constraint.\n\n"
        "   EDITING RULES:\n"
        "   - Start from the EXISTING document and make targeted edits\n"
        "   - Add new developments where tweets provide genuinely new information\n"
        "   - DECAY: Developments older than ~7 days with no new signals → compress to one line or remove\n"
        "   - PRUNE: Events that have fully resolved → remove entirely (they served their purpose)\n"
        "   - PRUNE: Narrative arcs that played out or are no longer actionable → remove\n"
        "   - If only 1-2 tweets came in, the output should be ~95% identical to the input\n"
        "   - Do NOT rewrite from scratch. Do NOT let the document grow unbounded.\n"
        "   - The document should always read like a FRESH BRIEFING for someone making trading "
        "decisions TODAY — not a historical archive\n\n"
        "   SECTIONS:\n"
        "   - KEY DEVELOPMENTS — What happened? What changed? (only currently relevant items)\n"
        "   - NARRATIVE ARCS — Ongoing stories (drop arcs that have concluded)\n"
        "   - SOURCE CREDIBILITY — Who is reporting vs speculating? (compact table)\n"
        "   - PREDICTION MARKET IMPLICATIONS — Events that could resolve markets, tradeable edge\n\n"
        '2. "themes" — Array of actionable themes:\n'
        '   [{"theme": "...", "keywords": ["..."], "edge_type": "event|sentiment"}]\n\n'
    )
    system += estimation_rules
    system += (
        "- TRACK RECORD: If a YOUR TRACK RECORD section is included below, use it to check your calibration. "
        "If you see systematic overconfidence in a category, adjust down. If underconfident, adjust up. "
        "Your estimates should improve over time as you see results.\n"
    )
    system += (
        "Exclude themes about: tweet counts, follower milestones, engagement metrics.\n"
        "Focus on: policy decisions, product launches, regulatory actions, executive moves, "
        "legal outcomes, scientific/engineering milestones.\n\n"
        "Respond ONLY with valid JSON — no markdown, no explanation outside the JSON."
    )

    user_prompt = (
        f"CURRENT INTELLIGENCE DOCUMENT:\n\n{current_doc}\n\n"
        f"NEW TWEETS SINCE LAST UPDATE ({len(tweets)} total):\n\n{tweet_block}"
        f"{markets_block}"
    )

    track_record = _build_track_record(conn)
    if track_record:
        user_prompt += f"\n\n{track_record}"

    try:
        response = call_claude(
            conn=conn,
            ledger_mod=ledger,
            model=model,
            system=system,
            messages=[{"role": "user", "content": user_prompt}],
            cycle_id=cycle_id,
            purpose="intelligence_update",
            max_tokens=8192,
        )
    except Exception as e:
        log.error(f"Intelligence update failed: {e}")
        themes = json.loads(current["themes_json"]) if current["themes_json"] else []
        return (current_doc, themes, [])

    # Parse response
    text = ""
    for block in response.get("content", []):
        if block.get("type") == "text":
            text += block["text"]

    document, themes, raw_estimates = _parse_intelligence_response(text)
    cost = response.get("cost", 0)

    if not document:
        log.warning("Empty document from intelligence update — keeping current")
        themes = json.loads(current["themes_json"]) if current["themes_json"] else []
        return (current_doc, themes, [])

    themes_json = json.dumps(themes) if themes else None

    # Store new intelligence row
    conn.execute(
        "INSERT INTO master_intelligence (document, themes_json, tweet_count, model_used, cost_usd) "
        "VALUES (?, ?, ?, ?, ?)",
        (document, themes_json, len(tweets), model, cost),
    )
    conn.commit()

    # Get the intelligence_id we just inserted
    intel_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    # Parse and store Opus estimates
    estimates = _resolve_estimates(raw_estimates, markets, model)
    if estimates:
        store_opus_estimates(conn, estimates, intel_id)

    # Git-back the intelligence document
    _git_commit_intelligence(document, themes_json, f"{len(tweets)} tweets, ${cost:.4f}")

    # Prune old intelligence rows (keep only latest)
    conn.execute(
        "DELETE FROM master_intelligence WHERE id < (SELECT MAX(id) FROM master_intelligence)"
    )
    conn.execute(
        "DELETE FROM opus_estimates WHERE intelligence_id NOT IN (SELECT id FROM master_intelligence)"
    )
    conn.commit()

    log.info(
        f"Intelligence update: {len(tweets)} tweets → {len(document)} chars, "
        f"{len(themes)} themes, {len(estimates)} estimates (${cost:.4f})"
    )
    return (document, themes, estimates)


def get_latest_intelligence(conn) -> dict | None:
    """Return latest row from master_intelligence as dict."""
    row = conn.execute(
        "SELECT id, ts, document, themes_json, tweet_count, model_used, cost_usd "
        "FROM master_intelligence ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return dict(row) if row else None


def _format_tweets_for_opus(by_account: dict[str, list[dict]]) -> str:
    """Format grouped tweets for the Opus prompt."""
    lines = []
    for account, tweets in sorted(by_account.items(), key=lambda x: -len(x[1])):
        lines.append(f"@{account} ({len(tweets)} posts):")
        for t in tweets:
            text = (t.get("text") or "")[:280]
            likes = t.get("likes", 0) or 0
            retweets = t.get("retweets", 0) or 0
            age = _format_age(t.get("collected_at") or t.get("created_at"))
            line = f"  [{age}] \"{text}\""
            if likes > 50 or retweets > 10:
                parts = []
                if likes > 0:
                    parts.append(f"{_compact_number(likes)} likes")
                if retweets > 0:
                    parts.append(f"{_compact_number(retweets)} RT")
                line += f" [{', '.join(parts)}]"
            if t.get("retweeted_by"):
                line += f" (RT'd by @{t['retweeted_by']})"
            lines.append(line)
        lines.append("")
    return "\n".join(lines)


def _format_age(ts_str: str | None) -> str:
    """Format a timestamp as a human-readable age."""
    if not ts_str:
        return "?"
    try:
        ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - ts
        hours = delta.total_seconds() / 3600
        if hours < 1:
            return f"{int(delta.total_seconds() / 60)}m ago"
        elif hours < 24:
            return f"{int(hours)}h ago"
        else:
            return f"{int(hours / 24)}d ago"
    except Exception:
        return "?"


def _compact_number(n: int) -> str:
    """Format number compactly: 1234 → 1.2k."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    elif n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def _build_track_record(conn) -> str:
    """Build YOUR TRACK RECORD section for the Opus intelligence prompt.

    Only includes pipeline-era bets (entry_confidence > 0) to avoid
    polluting feedback with legacy tool-loop positions.
    """
    sections = []

    # ── a) Open positions ────────────────────────────────────────────
    open_pos = conn.execute(
        "SELECT id, market_id, question, side, shares, entry_odds, cost_basis, "
        "entry_edge, entry_confidence "
        "FROM predictions "
        "WHERE status = 'open' AND entry_confidence IS NOT NULL AND entry_confidence > 0 "
        "ORDER BY id ASC"
    ).fetchall()

    if open_pos:
        lines = ["OPEN POSITIONS:"]
        for p in [dict(r) for r in open_pos]:
            # Reconstruct vault estimate (always as P(YES))
            edge = p["entry_edge"] or 0
            if p["side"] == "YES":
                vault_est = p["entry_odds"] + edge
            else:
                vault_est = 1 - p["entry_odds"] - edge
            vault_est = max(0.0, min(1.0, vault_est))

            # Current market odds + unrealised P&L
            odds = get_current_odds(conn, p["market_id"])
            if odds:
                current_yes = odds["yes_price"]
                current_price = current_yes if p["side"] == "YES" else (1 - current_yes)
                unrealised = p["shares"] * current_price - p["cost_basis"]
                market_str = f"market now: {current_yes:.0%}"
                pnl_str = f"unrealised: ${unrealised:+.2f}"
            else:
                market_str = "market: unavailable"
                pnl_str = "unrealised: N/A"

            q = (p["question"] or "")[:60]
            lines.append(
                f"  [{p['id']}] {p['side']} \"{q}\" — "
                f"your estimate: {vault_est:.0%} (conf {p['entry_confidence']:.2f}, "
                f"edge {edge:+.0%}) — {market_str} — {pnl_str}"
            )
        sections.append("\n".join(lines))

    # ── b) Resolved positions ────────────────────────────────────────
    closed = conn.execute(
        "SELECT id, market_id, question, side, entry_odds, entry_edge, "
        "entry_confidence, resolution, pnl "
        "FROM predictions "
        "WHERE status = 'closed' AND entry_confidence IS NOT NULL AND entry_confidence > 0 "
        "ORDER BY id ASC"
    ).fetchall()
    closed = [dict(r) for r in closed]

    if closed:
        lines = ["RESOLVED:"]
        wins, losses, total_pnl = 0, 0, 0.0
        for p in closed:
            edge = p["entry_edge"] or 0
            if p["side"] == "YES":
                vault_est = p["entry_odds"] + edge
            else:
                vault_est = 1 - p["entry_odds"] - edge
            vault_est = max(0.0, min(1.0, vault_est))

            won = p["resolution"] == "won"
            if won:
                wins += 1
            else:
                losses += 1
            pnl = p["pnl"] or 0
            total_pnl += pnl

            q = (p["question"] or "")[:60]
            result = f"WON ${pnl:+.2f}" if won else f"LOST ${pnl:+.2f}"
            lines.append(
                f"  [{p['id']}] {p['side']} \"{q}\" — "
                f"your estimate: {vault_est:.0%} (conf {p['entry_confidence']:.2f}) — {result}"
            )
        lines.append(f"  Record: {wins}W/{losses}L | P&L: ${total_pnl:+.2f}")
        sections.append("\n".join(lines))

    # ── c) Calibration summary (>= 3 resolved) ──────────────────────
    if len(closed) >= 3:
        bands = {
            "0-40%": {"count": 0, "yes_actual": 0, "est_sum": 0.0},
            "40-60%": {"count": 0, "yes_actual": 0, "est_sum": 0.0},
            "60-100%": {"count": 0, "yes_actual": 0, "est_sum": 0.0},
        }
        for p in closed:
            edge = p["entry_edge"] or 0
            if p["side"] == "YES":
                vault_est = p["entry_odds"] + edge
            else:
                vault_est = 1 - p["entry_odds"] - edge
            vault_est = max(0.0, min(1.0, vault_est))

            if vault_est < 0.4:
                band = "0-40%"
            elif vault_est < 0.6:
                band = "40-60%"
            else:
                band = "60-100%"

            bands[band]["count"] += 1
            bands[band]["est_sum"] += vault_est
            # Did the market resolve YES?
            resolved_yes = (
                (p["side"] == "YES" and p["resolution"] == "won")
                or (p["side"] == "NO" and p["resolution"] == "lost")
            )
            if resolved_yes:
                bands[band]["yes_actual"] += 1

        cal_lines = ["CALIBRATION:"]
        for band_name, b in bands.items():
            if b["count"] == 0:
                continue
            avg_est = b["est_sum"] / b["count"]
            actual_rate = b["yes_actual"] / b["count"]
            hint = ""
            if actual_rate > avg_est + 0.1:
                hint = " — you may be underconfident here"
            elif actual_rate < avg_est - 0.1:
                hint = " — overconfident?"
            cal_lines.append(
                f"  Estimates {band_name}: {b['count']} markets, "
                f"{b['yes_actual']} resolved YES "
                f"({actual_rate:.0%} actual vs {avg_est:.0%} estimated{hint})"
            )
        if len(cal_lines) > 1:
            sections.append("\n".join(cal_lines))

    # ── d) Smart money summary ───────────────────────────────────────
    sm_rows = conn.execute(
        "SELECT action_taken, outcome, outcome_pnl FROM smart_money_log"
    ).fetchall()

    if sm_rows:
        vetoes = {"total": 0, "correct": 0, "wrong": 0, "pending": 0}
        boosts = 0
        net_pnl = 0.0
        for r in [dict(r) for r in sm_rows]:
            action = (r["action_taken"] or "").lower()
            outcome = (r["outcome"] or "pending").lower()
            if "veto" in action:
                vetoes["total"] += 1
                if outcome in ("won", "correct"):
                    vetoes["correct"] += 1
                elif outcome in ("lost", "wrong"):
                    vetoes["wrong"] += 1
                else:
                    vetoes["pending"] += 1
            elif "boost" in action:
                boosts += 1
            net_pnl += r["outcome_pnl"] or 0

        parts = []
        if vetoes["total"]:
            parts.append(
                f"{vetoes['total']} vetoes ({vetoes['correct']} correct, "
                f"{vetoes['wrong']} wrong, {vetoes['pending']} pending)"
            )
        if boosts:
            parts.append(f"{boosts} boosts")
        if net_pnl:
            parts.append(f"net: ${net_pnl:+.2f}")
        if parts:
            sections.append(f"SMART MONEY SIGNALS: {', '.join(parts)}")

    if not sections:
        return ""

    return "YOUR TRACK RECORD (pipeline bets only):\n\n" + "\n\n".join(sections)


def store_opus_estimates(conn, estimates: list[dict], intelligence_id: int):
    """Write Opus probability estimates to opus_estimates table."""
    for est in estimates:
        try:
            conn.execute(
                "INSERT INTO opus_estimates "
                "(intelligence_id, market_id, question, vault_probability, confidence, reasoning) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (intelligence_id, est["market_id"], est.get("question", ""),
                 est["vault_probability"], est["confidence"], est.get("reasoning", "")),
            )
        except Exception as e:
            log.warning(f"Failed to store opus estimate for {est['market_id']}: {e}")
    if estimates:
        conn.commit()
    log.info(f"Stored {len(estimates)} Opus estimates (intelligence_id={intelligence_id})")


def get_latest_opus_estimates(conn) -> list[dict]:
    """Return the latest Opus estimate per market_id (from the most recent intelligence run)."""
    # Get the latest intelligence_id that has estimates
    latest = conn.execute(
        "SELECT MAX(intelligence_id) as max_id FROM opus_estimates"
    ).fetchone()
    if not latest or not latest["max_id"]:
        return []

    rows = conn.execute(
        "SELECT oe.market_id, oe.question, oe.vault_probability, oe.confidence, "
        "oe.reasoning, oe.intelligence_id, oe.ts, mi.model_used "
        "FROM opus_estimates oe "
        "LEFT JOIN master_intelligence mi ON oe.intelligence_id = mi.id "
        "WHERE oe.intelligence_id = ?",
        (latest["max_id"],),
    ).fetchall()
    return [dict(r) for r in rows]


def _resolve_estimates(raw_estimates: list[dict], markets: list[dict], model: str) -> list[dict]:
    """Map raw estimate dicts (with market_index) to market_ids."""
    estimates = []
    for item in raw_estimates:
        idx = item.get("market_index", 0) - 1  # 1-indexed to 0-indexed
        if 0 <= idx < len(markets):
            prob = float(item.get("probability", 0.5))
            conf = float(item.get("confidence", 0.5))
            prob = max(0.01, min(0.99, prob))
            conf = max(0.1, min(1.0, conf))
            estimates.append({
                "market_id": markets[idx]["id"],
                "question": markets[idx].get("question", ""),
                "vault_probability": prob,
                "confidence": conf,
                "reasoning": item.get("reasoning", ""),
                "model_used": model,
            })
    return estimates


def _parse_intelligence_response(text: str) -> tuple[str, list, list]:
    """Parse Opus JSON response into (document, themes, estimates)."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        text = text.strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # Try to find JSON object in text
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                log.warning(f"Failed to parse intelligence response: {text[:200]}")
                return ("", [], [])
        else:
            log.warning(f"No JSON in intelligence response: {text[:200]}")
            return ("", [], [])

    document = parsed.get("document", "")
    themes = parsed.get("themes", [])
    estimates = parsed.get("estimates", [])

    # Validate themes
    valid_themes = []
    for t in themes:
        if isinstance(t, dict) and "keywords" in t:
            valid_themes.append({
                "theme": t.get("theme", ""),
                "keywords": t.get("keywords", []),
                "edge_type": t.get("edge_type", "event"),
            })

    # Validate estimates (raw — will be resolved by caller)
    valid_estimates = []
    for e in estimates:
        if isinstance(e, dict) and "market_index" in e:
            valid_estimates.append(e)

    return (document, valid_themes, valid_estimates)
