# chess.com → analysis pipeline

Goal: games played on chess.com land in a store automatically, so play patterns
and repertoire become queryable instead of anecdotal.

Integration constraint (established, not assumed): chess.com has no webhook and
no OAuth for own-game access. The Published-Data API is anonymous, sends
`access-control-allow-origin: *`, and carries ETag/Last-Modified. So: poll the
current month's archive conditionally. A quiet run is one 304.

Dataset starts FRESH — the 42 archives back to 2021/11 are deliberately skipped.

## Phase 1 — Ingest  ✅ done 2026-09-07
- [x] `pipeline/ingest.py`, stdlib only (runs on a 2-core VPS)
- [x] `init` seeds the single most recent game, sets watermark; `poll` takes only
      games with `end_time > watermark`; `status` reports
- [x] SQLite: `games` keyed on chess.com `uuid` (idempotent re-runs) + `plies`
- [x] Per-ply clocks parsed from PGN `{[%clk ...]}`; `spent = own clock delta + increment`
- [x] Opening name derived from the ECOUrl slug (moves suffix stripped) — no book needed
- [x] Deployed: `/home/hq/chess-ingest.sh` + hq cron `*/15`, store at
      `/home/hq/chess-pipeline/` (outside the git tree, via `CHESS_DATA_DIR`)

Verified: SAN sequence diffed move-for-move against raw movetext (57/57 identical);
ETag 304 path confirmed; incremental path proven by rewinding the watermark
(40 games in one request) then re-initialising to a clean single-game store.

Two traps worth remembering. The VPS clone is a **sparse checkout** — a new
directory is invisible until `git sparse-checkout add`, and `git pull` reports
success regardless. And a log file created by a *root* shell's `>>` redirect is
root-owned, so an hq cron job silently fails to open it; the redirect must be
exercised as the cron user, not just the command.

## Phase 2 — Engine analysis  (next)
- [ ] Install native Stockfish on vps-hel1 (absent; only the browser WASM exists)
- [ ] Analyse each new game, fill `plies.eval_cp`
- [ ] Derive ACPL, blunder/mistake/inaccuracy counts, first-out-of-book ply
- [ ] Nice'd, incremental — only games with NULL evals

## Phase 3 — Export + front-end
- [ ] Commit derived JSON only (raw DB stays on the VPS): `summary`, `repertoire`,
      `games` index, sharded `evals`
- [ ] Reuse the all-in cron pattern: `VPS Cron <vps@hjd.ai>`, push to main
- [ ] `repertoire.html`; deep-link games into `analysis.html`
      (`loadPGNFromText()`, js/script.js)
- [ ] Extension: chess.com content script mirroring the Lichess one
      (no fetch-one-game endpoint — pass `?chesscom=<id>&d=<YYYY-MM>`, match on url)
