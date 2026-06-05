# WaymoWatch — live capture & manual review (King's Cross phase)

Runs on the **local machine** (the VPS is RAM-maxed). Goal: collect real Waymo positives at
the true JamCam viewpoint to fix the synthetic→real gap.

## Running now (cron, every 10 min)
```
*/10 * * * * cd /home/hdonovan/hjd.ai/H/projects/waymowatch && .venv/bin/python collector/live_capture.py >> data/candidates/capture.log 2>&1
```
- 8 cameras: British Library corner (Euston Rd/Gray's Inn Rd), King's Cross station, Euston Rd/St Pancras corridor.
- Generic car detector → roof crop → similarity to 39 real domes → top-3/camera → `candidates` table + `data/candidates/`.
- Parked-vehicle dedup; 7-day retention. Log: `data/candidates/capture.log`.

## Review (the manual detection step)
- Latest queue image: `data/candidates/review_sheet.jpg` (rebuild: `… live_capture.py --review`).
- A real Waymo (white I-PACE + dark roof dome) stands out among the vans/buses.
- Confirm a real one: `… collector/live_capture.py --confirm <ids>` → copies crop+frame to
  `data/real_positives/` (gold, on-angle data). Reject: `--reject <ids>`.
- After a handful of confirmed reals → re-seed the surfacer from those real CCTV crops; it then
  stops flagging vans and becomes genuinely discriminative.

## Email alerts (ACTIVE → donovanh59@gmail.com)
Digest email with the review sheet attached, via Resend (autosnipe's verified domain), 4×/day:
```
0 8,12,16,20 * * * cd /home/hdonovan/hjd.ai/H/projects/waymowatch && .venv/bin/python collector/live_capture.py --email-digest >> data/candidates/capture.log 2>&1
```
- Goes to donovanh59@gmail.com only. `RESEND_API_KEY` in `.env` (gitignored). Tune cadence via cron.
- Manual send: `… collector/live_capture.py --email-digest` · test: `… collector/email_alert.py --sheet`
- Scan the attached sheet for a white I-PACE + dark roof dome; confirm reals with `--confirm <ids>`.

## WhatsApp alerts (OPTIONAL — later, needs moltbot re-link)
moltbot's gateway is up but its **WhatsApp session expired** (nothing sent in months). The pipe and
target are already verified (dry-run; recipient hard-locked to +447702188120). To activate:
1. `ssh hq@89.167.4.126` → `ssh moltbot@localhost`
2. `cd ~/moltbot && node scripts/run-node.mjs channels login --verbose` → scan the QR with the
   **older moltbot account's** phone (WhatsApp → Linked Devices → Link a Device).
3. Verify: `node scripts/run-node.mjs status` (channel health + recent recipients) · `… doctor`.
4. One confirmed test from here: `… collector/whatsapp_alert.py "test" --send` (omit `--send` = dry-run).
5. Enable the daily digest:
   `0 19 * * * cd /home/hdonovan/hjd.ai/H/projects/waymowatch && .venv/bin/python collector/live_capture.py --digest >> data/candidates/capture.log 2>&1`

**Safety:** `whatsapp_alert.py` is hard-locked to +447702188120 and refuses any other recipient —
alerts can never land in a group chat. Uses `message send` (verbatim, no LLM key required).
