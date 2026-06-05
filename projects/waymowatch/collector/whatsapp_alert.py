#!/usr/bin/env python3
"""Send a WhatsApp message to the OPERATOR ONLY, via the moltbot bridge on the VPS.

SAFETY: hard-locked to the operator's number — refuses any other recipient, so an alert
can never land in a group chat. Routes  local -> hq@VPS -> moltbot@localhost  (the older
`moltbot` account that AXIOM/autosnipe already DM the user through, --to a phone number =
individual chat).

Requires moltbot's WhatsApp session to be live. If it's expired, see train/RUNBOOK or the
project README for re-linking; until then send_to_user() returns False (non-fatal).
"""
import os
import subprocess
import tempfile
import time

ALLOWED = "+447702188120"          # operator only — DO NOT change to a group/other number
VPS = "hq@89.167.4.126"


def send_to_user(message, number=ALLOWED, dry_run=False):
    if number != ALLOWED:
        raise ValueError(f"refusing recipient {number!r}; WhatsApp is locked to the operator")
    remote = f"/tmp/waymowatch-msg-{int(time.time())}.txt"
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(message)
        local = f.name
    try:
        subprocess.run(["scp", "-q", "-o", "BatchMode=yes", local, f"{VPS}:{remote}"],
                       check=True, timeout=30)
        # raw verbatim send (no LLM agent); --target = recipient (E.164) -> individual DM
        flags = "--dry-run " if dry_run else ""
        inner = (f"cd ~/moltbot && node scripts/run-node.mjs message send "
                 f'--channel whatsapp --target "{ALLOWED}" {flags}'
                 f'--message "$(cat {remote})"')
        remote_cmd = f"chmod 644 {remote}; ssh -o BatchMode=yes moltbot@localhost '{inner}'; rm -f {remote}"
        r = subprocess.run(["ssh", "-o", "BatchMode=yes", VPS, remote_cmd],
                           timeout=120, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"[whatsapp] send failed (moltbot WhatsApp session likely needs re-linking): "
                  f"{(r.stderr or r.stdout).strip()[:300]}")
            return False
        print(f"[whatsapp] delivered to operator ({len(message)} chars)")
        return True
    except Exception as e:
        print(f"[whatsapp] send error: {e}")
        return False
    finally:
        try:
            os.unlink(local)
        except Exception:
            pass


if __name__ == "__main__":
    import sys
    args = [a for a in sys.argv[1:] if a != "--send"]
    dry = "--send" not in sys.argv  # safety: CLI dry-runs unless --send is given
    msg = args[0] if args else "WaymoWatch test alert"
    print(f"({'DRY-RUN' if dry else 'SEND'}) -> {ALLOWED}")
    send_to_user(msg, dry_run=dry)
