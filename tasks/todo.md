# WaymoNet inference dashboard (tailnet-only)

Goal: browse VPS images / upload an image -> run WaymoNet (best.pt) -> visualise boxes.
Access: tailnet-only via Tailscale Serve (no public exposure). Model: run-1 best.pt.

- [x] Backend `dashboard/server.py` (stdlib http.server + ultralytics, port 3105)
      - GET /api/tree (confirmed / galleries / recent-candidates), GET /img/<id>
      - GET /api/infer?id=&  + POST /api/infer (upload bytes) -> {w,h,time_ms,boxes>=0.03}
      - serialise inference with a lock (2-vCPU box; live loop shares CPU)
- [x] Frontend `dashboard/index.html` (dark / IBM Plex Mono, waymonet aesthetic)
      - file explorer, image viewer w/ box overlay + conf labels, live conf slider, drag-drop upload
- [x] Test backend locally (curl /api/tree, /api/infer) on laptop dirs
- [x] Deploy: scp best.pt + rsync dashboard/ to VPS; run under PM2; `tailscale serve` on :8443
- [x] Verify over tailnet; CHANGELOG + commit
