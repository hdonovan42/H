# Edge (chokepoint) camera — self-hosted continuous capture

The JamCam sweep sees only ~2.7% of each camera's timeline (rolling ~10s clips). A **self-hosted
camera at a chokepoint** sees ~100% of one high-value spot. `collector/edge_capture.py` runs the
*same* surfacer (Stage-1 `is_white` + dome-similarity, shared `waymo.db`, same digest/alerts) on a
live stream, so edge sightings appear in the normal daily digest and instant alerts, tagged
`camera_id = EDGE_<name>`.

Status: **software prototype, validated on a test clip** (tracks vehicles, scores, writes candidates).
No hardware deployed yet.

## Where to put it (highest leverage first)
- **Park Royal depot egress** — every Waymo enters/leaves here daily. One camera ≈ catching the
  whole fleet at least twice a day.
- **A40 Western Avenue / A406 North Circular** near the depot — the fleet's arterials.
- A window/balcony with clear line-of-sight to the carriageway; aim so vehicles cross the frame at a
  decent size (so the roof dome is resolvable). Roughly side-on / rear-3⁄4 is ideal (matches templates).

## Hardware options (cheapest first)
1. **Old Android phone + "IP Webcam" app** (free, you may already own one). Mount it at a window,
   start the app → it serves `http://<phone-ip>:8080/video`. Zero cost, good for a first trial.
2. **USB webcam on a Raspberry Pi 4/5 or mini-PC** → `--source 0`.
3. **Outdoor IP/CCTV camera (RTSP)** for a permanent install → `--source rtsp://user:pass@<ip>:554/...`.

YOLO11n is CPU-only and processes one stream a few fps on a Pi 4/5 (a mini-PC does it comfortably).
A single stream is far lighter than the 95-camera sweep — one frame at a time.

## Running it
```bash
cd projects/waymowatch
# phone IP Webcam app:
.venv/bin/python collector/edge_capture.py --source http://192.168.1.51:8080/video --name depot
# USB webcam:        --source 0
# RTSP IP camera:    --source 'rtsp://user:pass@192.168.1.50:554/Streaming/Channels/101'
# offline test:      --source clip.mp4 --once
```
It writes candidates to the shared `waymo.db` (WAL mode, so it coexists with the JamCam cron) →
they ride the existing **23:00 daily digest + ≥0.90 instant alerts** automatically.

### 24/7 as a systemd service (on the camera host)
```ini
# /etc/systemd/system/waymowatch-edge.service
[Unit]
Description=WaymoWatch edge camera capture
After=network-online.target
[Service]
User=pi
WorkingDirectory=/home/pi/waymowatch
ExecStart=/home/pi/waymowatch/.venv/bin/python collector/edge_capture.py \
  --source rtsp://user:pass@192.168.1.50:554/Streaming/Channels/101 --name depot
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
```
The script also self-reconnects (`--reconnect` seconds) if a live stream drops.

## Tuning
- `--min-h` — raise it for a close camera where vehicles are large (cuts distant clutter).
- `--stride` — frames to skip (default 6 ≈ 4fps from a 25fps source); lower = more thorough, more CPU.
- `--imgsz 640` — default; a real camera is higher-res than JamCams, so 640 helps.
- Thresholds reuse `PROB_TH` / `ALERT_TH` from `live_capture.py`. NOTE: the dome centroid is built
  from JamCam-degraded templates and crops are passed through `jamcam()` for consistency. A close
  hi-res camera resolves the dome far better, so once we have a real positive from it, a **dedicated
  hi-res centroid** (skip the degrade) would sharpen accuracy a lot — and the bar could be raised.

## Legal
Filming a public road in the UK is lawful; vehicles are not personal data. The pipeline crops whole
vehicles for dome detection only — **no number-plate OCR, no faces**. Keep it that way.
