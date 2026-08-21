# Migration: WSL working copy → native Ubuntu clone (Option A)

Old tree `/home/h/H/hjd.ai` was a **git-less snapshot** copied from WSL.
Verified against `hdonovan42/H`: 720 tracked files, 712 byte-identical,
**0 locally modified**, 8 missing (dotfiles). Nothing unique was at risk.

## Steps

- [x] Verify local tree has no unpushed work (file-by-file vs origin/main)
- [x] Clone `hdonovan42/H` → `~/dev/hjd.ai` (restores .git, .gitignore,
      .github/workflows/deploy.yml, .claude/skills/*)
- [x] Migrate gitignored local-only payload (NOT in git, irreplaceable):
      - [x] projects/waymowatch/data/   (474M training dataset)
      - [x] projects/waymowatch/eval/   (39M)
      - [x] projects/waymowatch/*.pt    (25M model weights)
      - [x] runs/                       (11M YOLO output)
      - [x] temp/, dist/
      - [x] .claude/settings.local.json  ×3
- [x] Do NOT migrate: node_modules/, .venv/ (3.3G, WSL-pathed, regenerable),
      __pycache__/ (1821 dirs), *:Zone.Identifier (9 Windows artifacts)
- [x] Track Claude Code config properly:
      - [x] promote merged permissions → tracked `.claude/settings.json`
      - [x] gitignore `.claude/settings.local.json` (machine-local by design)
      - [x] delete `.claude/claude.md` (byte-identical dup of CLAUDE.md)
- [x] Repoint `~/.local/bin/portfolio` at the new path
- [x] Verify: portfolio CLI works, git status clean, deploy workflow intact
- [x] Quarantine old tree → `~/H.OLD-WSL/` (delete after a soak period)

## Review

**Done.** New working copy: `~/dev/hjd.ai` (real git clone, tracking origin/main).
Old tree quarantined at `~/H.OLD-WSL-hjd.ai` — delete after a soak period.

Migrated (gitignored, so git could not have restored it):
- waymowatch `data/` 474M (10,234 files), `eval/`, `yolo26s.pt` + `yolo11n.pt`
- 6 x `.env` (all-in, VAULT, axiom/server, command-centre x2, waymowatch)
- live DBs: `VAULT/vault.db`, `autosnipe/server/data/autosnipe.db` (+wal/shm)
- curated exports, rightmove fixtures, `runs/`, `temp/`, `dist/`, task docs

Dropped deliberately: 3.3G `node_modules`/`.venv`, 1821 `__pycache__`,
9 `*:Zone.Identifier`, `.pytest_cache`, `vault.egg-info`, `.wrangler` state,
`.claude/claude.md` (byte-identical dup of `CLAUDE.md`).

Caught in review: the WSL copy had stripped the exec bit from
`waymowatch/eval/score_candidates.py` (755 -> 644); restored from git.

Verified: `portfolio value` works from any cwd; `git status` clean;
Deploy Site workflow green on the config commit; hjd.ai serving 200.

### Outstanding — needs sudo, so left for the user

Neither toolchain is installed on this machine, so no dependency rebuild
could run:
- **Node/npm absent** -> 13 npm project dirs have no `node_modules`
- **`python3-venv`/`python3-pip` absent** (no `ensurepip`) -> no venvs

Also note the old venvs were **Python 3.12**; this machine ships **3.14**,
so waymowatch's torch/ultralytics stack needs a wheel-availability check
rather than a straight reinstall.

`portfolio` itself is unaffected — it runs on the apt-installed
python3-click/rich/requests.
