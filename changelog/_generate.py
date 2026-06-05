#!/usr/bin/env python3
"""Generate changelog/<YYYY-MM-DD>.md — one succinct file per day a commit was made,
commits grouped by project. Idempotent: regenerates from git history. Run from repo root."""
import os
import re
import subprocess
from collections import defaultdict

OUT = "changelog"
os.makedirs(OUT, exist_ok=True)

log = subprocess.run(
    ["git", "log", "--date=short", "--pretty=%cd%x09%h%x09%s"],
    capture_output=True, text=True, check=True).stdout.strip().splitlines()

# friendlier headings for known prefixes (several raw prefixes can map to one project)
NAME = {"WaymoWatch": "WaymoWatch", "WaymoNet": "WaymoWatch", "VAULT": "VAULT",
        "portfolio": "Portfolio", "all-in": "All-In", "Update": "All-In",
        "axiom": "AXIOM", "AXIOM": "AXIOM", "command-centre": "Command Centre",
        "autosnipe": "AutoSnipe", "misc": "Misc"}

days = defaultdict(lambda: defaultdict(list))   # date -> display name -> [(hash, text)]
for line in log:
    date, h, subj = line.split("\t", 2)
    if subj.startswith("Merge "):
        cat, text = "misc", subj
    else:
        cat = subj.split()[0].rstrip(":")
        text = re.sub(rf"^{re.escape(cat)}\b\s*", "", subj)   # drop leading project word
        text = re.sub(r"^v[\d.]+:?\s*", "", text)             # drop leading version token
        text = re.sub(r"^[:\-]\s*", "", text).strip()         # drop leftover colon/dash
        text = text or subj
    days[date][NAME.get(cat, cat)].append((h, text))

for date, cats in days.items():
    lines = [f"# {date}", ""]
    for name in sorted(cats, key=str.lower):
        lines.append(f"## {name}")
        for h, text in cats[name]:
            lines.append(f"- {text} (`{h}`)")
        lines.append("")
    with open(os.path.join(OUT, f"{date}.md"), "w") as f:
        f.write("\n".join(lines).rstrip() + "\n")

print(f"wrote {len(days)} day files to {OUT}/")
