# Migration: WSL working copy → native Ubuntu clone (Option A)

Old tree `/home/h/H/hjd.ai` was a **git-less snapshot** copied from WSL.
Verified against `hdonovan42/H`: 720 tracked files, 712 byte-identical,
**0 locally modified**, 8 missing (dotfiles). Nothing unique was at risk.

## Steps

- [x] Verify local tree has no unpushed work (file-by-file vs origin/main)
- [x] Clone `hdonovan42/H` → `~/dev/hjd.ai` (restores .git, .gitignore,
      .github/workflows/deploy.yml, .claude/skills/*)
- [ ] Migrate gitignored local-only payload (NOT in git, irreplaceable):
      - [ ] projects/waymowatch/data/   (474M training dataset)
      - [ ] projects/waymowatch/eval/   (39M)
      - [ ] projects/waymowatch/*.pt    (25M model weights)
      - [ ] runs/                       (11M YOLO output)
      - [ ] temp/, dist/
      - [ ] .claude/settings.local.json  ×3
- [ ] Do NOT migrate: node_modules/, .venv/ (3.3G, WSL-pathed, regenerable),
      __pycache__/ (1821 dirs), *:Zone.Identifier (9 Windows artifacts)
- [ ] Track Claude Code config properly:
      - [ ] promote merged permissions → tracked `.claude/settings.json`
      - [ ] gitignore `.claude/settings.local.json` (machine-local by design)
      - [ ] delete `.claude/claude.md` (byte-identical dup of CLAUDE.md)
- [ ] Repoint `~/.local/bin/portfolio` at the new path
- [ ] Verify: portfolio CLI works, git status clean, deploy workflow intact
- [ ] Quarantine old tree → `~/H.OLD-WSL/` (delete after a soak period)

## Review

(filled in on completion)
