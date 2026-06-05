# WaymoWatch — Inference & Compute Plan

Reference doc: how to run WaymoNet inference 24/7, the hardware it needs, rent-vs-buy
economics, and an upgradable self-hosted inference cluster for this project + others.
Training is a separate ~£1 one-off (see `train/RUNBOOK.md`); this is about **serving**.

## 1. The inference workload
- Each TfL camera posts a fresh ~11s / 25fps / 277-frame / 352×288 clip every ~3–8 min.
- Per full sweep: **779 cams × ~56 sampled frames (5fps) ≈ 43,600 frames**.
- At a 3-min sweep → **~240 fps** to keep up. Entirely tunable (cameras × sweep interval × fps).
- Per-clip pipeline: download → decode (OpenCV) → sample frames → WaymoNet detect →
  ByteTrack collapse (the dozens of frames a passing car spans → **one** sighting) → log + alert.

## 2. Compute required (modest)
| Box | ~YOLO11s throughput | Covers full feed? |
|---|---|---|
| CPU-only VPS (2 cores) | ~70 fps | ❌ (~10 min/sweep) |
| i7 laptop | ~210 fps | ⚠️ borderline, not a server |
| 1× NVIDIA T4 (TensorRT FP16) | ~320 fps | ✅ ~2.3 min/sweep |
| 1× RTX 3060 / 3090 / 4090 | ~400–600+ fps | ✅ with idle headroom |

Model is tiny (~5 MB, ~1–2 GB VRAM) → **VRAM is not the constraint; throughput is, and it's low.**
One mid GPU covers the entire London feed. Scoped (Waymo boroughs + slower sweep), a CPU can suffice.

## 3. Rent vs self-host
| | One-off | Monthly | Year 1 | Year 2+ |
|---|---|---|---|---|
| Rent Vast T4 (always-on) | — | ~£70 | ~£840 | ~£840/yr |
| Self-host, used RTX 3060 | ~£200 | ~£15–25 elec | ~£440 | ~£240/yr |
| Self-host on a GPU you already own | £0 | ~£15–25 elec | ~£240 | ~£240/yr |

**Verdict: self-host for 24/7.** GPU pays for itself in ~3 months; inference idles between sweeps
(~80–120 W realistic draw). Rent a 4090 only for the one-off ~£1 training run.

## 4. Self-hosted inference cluster (upgradable)

### Don't start with Kubernetes
| Tool | Good for | When for you |
|---|---|---|
| Kubernetes | many nodes/teams, autoscale | overkill at 1 box / solo |
| K3s / Ray / Nomad | lightweight multi-node | **when you add a 2nd GPU node** |
| Docker (+ Triton/Ray Serve) | one node, many models | **start here** |

### Hardware foundation (the real upgrade lever — lanes + power + slots)
| Platform | Usable PCIe lanes | Realistic GPUs | Cost (used) |
|---|---|---|---|
| Consumer AM5 / LGA1700 | ~20–28 | 1–2 | new-ish |
| HEDT/workstation (Threadripper, Xeon-W) | 48–128 | 3–4 | board+CPU ~£300–600 |
| Used server / EPYC (Supermicro H11/H12, Dell R730) | 64–128 | 4–7 | ~£500–900 |

**Inference is NOT PCIe-bandwidth-bound** (unlike multi-GPU training) → run cards at x8/x4 via
risers → cheaper boards + open-air/mining frames are fine.

### Recommended starting build (1 GPU → grows to 4)
- Foundation: used **Threadripper (X399/TRX40)** or single-socket **EPYC** workstation (64–128 lanes,
  ECC RAM, 4+ x16 slots) — ~£400–800.
- GPU #1: **used RTX 3090 24 GB (~£600)** — does WaymoWatch *and* future local LLMs/vision; NVLink-pairable.
  (Vision-only? A £200 RTX 3060 12 GB is plenty.)
- PSU: **1200–1600 W** up front (~£200) so adding GPUs isn't a rebuild.
- Case/cooling: airflow case or open frame + PCIe risers (~£60–120).
- **~£1,000–1,400 to start; add 3090s later (slots/lanes/power already there).**
- YAGNI: buy the upgradable foundation + **one** GPU now; your current real GPU need is one mid card
  (WaymoWatch is light; AXIOM/VAULT/autosnipe are Anthropic-API, not local GPU).

### Software stack (simple → grow)
- Now: Docker per project. Serve many models via **NVIDIA Triton** (multi-model/GPU, dynamic batching)
  or **Ray Serve** (Python-native, scales to multi-node). WaymoWatch worker = one container off a queue.
- Pack light models on one GPU via **MPS / time-slicing**.
- Multi-node later: **K3s** or a **Ray cluster** — add the orchestrator only when a 2nd box appears.

### VPS hybrid
Keep the Hetzner VPS as the **public, always-up front** (collector, Leaflet map, webhooks); the
**home box does GPU inference**. Link over **Tailscale/WireGuard** — no exposed home IP, no open ports.

## 5. Cost levers (dial it down)
1. **Scope to Waymo's ~20 boroughs** (~200–400 of 779 cams) — biggest lever (2–4×).
2. Slower sweep (5–10 min vs 3) — 2–3×. 3. Lower fps (3 vs 5) — ~1.7×.
4. INT8 + yolo11n fallback — ~2–3×. 5. Two-stage: cheap full-frame pass, SAHI only on candidate roofs.

## 6. Caveats
- Power/heat/noise at scale (each 3090 ≈ 350 W; cap with `nvidia-smi -pl`).
- Home power/internet blips → coverage gaps (VPS covers must-stay-up bits).
- Bandwidth: full feed ≈ ~1 TB/month down (conditional-GET + scoping trims it).

## 7. Recommended path
1. **Validate:** scoped cameras, CPU or one cheap GPU (or hourly bursts ~£18/mo) — prove sightings land.
2. **Scale:** full feed on one self-hosted RTX 3090; VPS + Tailscale hybrid.
3. **Grow:** add GPUs, then a 2nd node + K3s/Ray as other projects need local compute.

> The `inference.py` worker (to be built) runs identically on rented or owned CUDA — `--device 0` either way.
> Powered by TfL Open Data.
