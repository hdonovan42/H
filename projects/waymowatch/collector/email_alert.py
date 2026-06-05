#!/usr/bin/env python3
"""Email the operator via Resend (reuses autosnipe's verified domain).

Low-risk: sends only to the operator's own inbox. RESEND_API_KEY is read from
projects/waymowatch/.env (gitignored) or the environment.
"""
import base64
import os

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
TO = "donovanh59@gmail.com"
FROM = "WaymoWatch <noreply@autosnipe.co.uk>"   # verified Resend domain (shared w/ autosnipe)


def _key():
    k = os.environ.get("RESEND_API_KEY")
    if k:
        return k
    envp = os.path.join(BASE, ".env")
    if os.path.exists(envp):
        for line in open(envp):
            if line.startswith("RESEND_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def send_email(subject, html, attachments=None):
    key = _key()
    if not key:
        print("[email] no RESEND_API_KEY found")
        return False
    payload = {"from": FROM, "to": [TO], "subject": subject, "html": html}
    if attachments:
        payload["attachments"] = [
            {"filename": os.path.basename(p), "content": base64.b64encode(open(p, "rb").read()).decode()}
            for p in attachments if os.path.exists(p)]
    try:
        r = requests.post("https://api.resend.com/emails",
                          headers={"Authorization": f"Bearer {key}"}, json=payload, timeout=30)
        if r.status_code >= 300:
            print(f"[email] failed {r.status_code}: {r.text[:200]}")
            return False
        print(f"[email] sent to {TO}: {subject!r}")
        return True
    except Exception as e:
        print(f"[email] error: {e}")
        return False


if __name__ == "__main__":
    import sys
    sheet = os.path.join(BASE, "data/candidates/review_sheet.jpg")
    send_email("WaymoWatch — email test ✅",
               "<p>WaymoWatch email alerts are wired up. Candidate digests will arrive here.</p>",
               attachments=[sheet] if ("--sheet" in sys.argv and os.path.exists(sheet)) else None)
