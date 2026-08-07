# WaymoWatch — disk-full outage (21 Jul – 7 Aug 2026): diagnosis + fix

## Incident

VPS `/dev/sda1` (75G) hit **100% full at 2026-07-21 10:12 UTC**. `waymo.db` is WAL, so SQLite
must write `-wal`/`-shm` **even to read** → every query threw `disk I/O error`. Three surfaces
died from one cause:

- `waymowatch-loop` crash-looped **42,758×** (~15 days of 30 s systemd restarts)
- `sightings_api` 500'd every request → **waymonet.com down**
- `waymonet_digest.py` died in `auto_bank()` before sending → **no emails for ~17 days**

**No data lost.** `PRAGMA quick_check` = ok; 1,237 confirmed waymos (1,232 training reals)
intact; 615 pending `wn_hit` reviews with **all 615 crop jpgs present**.

## Root causes (three distinct defects)

1. **The archive keeps everything, forever.** `backup_github.sh` rsyncs *all* of
   `data/candidates` (`--ignore-existing`, no `--delete`) and commits hourly, so `.git` holds a
   second full copy. 45G of a 75G disk = 19G tree + 27G history. Only ~1.3% of candidates ever
   register a WaymoNet detection.
2. **Merge-path orphan leak** — `ingest()` merge branch (`live_capture.py:460`) writes a
   *new-stamped* crop+frame and repoints the row **without unlinking the superseded pair**.
   ~4,800 files/day. Source of June's 97,946 orphans.
3. **Write-before-score** — `cv2.imwrite` + `write_frame` run *before* `wn_safe()`, so under
   ENOSPC the jpgs land and the INSERT fails → orphan. Source of the August orphans.

Net: **430,412 orphaned jpgs / 9.04 GB** locally (95% of `data/candidates`); only 22,625 jpgs
are referenced by any row.

## Measurements

Selectivity, from a pre-outage git snapshot (rows inside the 7-day window, nothing pruned):

| Day | Candidates | `wn_hit` | Keep |
|---|---|---|---|
| 14 Jul | 4,353 | 90 | 2.07% |
| 16 Jul | 5,213 | 62 | 1.19% |
| 18 Jul | 5,269 | 91 | 1.73% |
| 20 Jul | 6,723 | 59 | 0.88% |

Sizes: frame **37.4 KB**, crop **3.4 KB** (pair 40.8 KB). Archive grew **~323 MB/day** mean,
~520 MB/day on healthy days.

Referenced bytes by status: waymo 50.9 MB · reject 338.5 MB · new 56.0 MB · near 34.2 MB
= **~480 MB total worth keeping**.

**Negatives already froze on their own:** rejects banked June **7,976** → July **79**. And
**8,019 of 8,055 rejects are `wn_hit=0`** — they were vetted in June under the old dome-score
review. A naive hits-only archive filter would have destroyed the entire vetted negative set;
the filter MUST include `status IN ('waymo','reject')`.

## Decisions (user, 2026-08-07)

- Archive = positives + frozen rejects + `wn_hit` review pool + curated sets. Raw non-hit
  funnel stays **local only**, reviewable/re-scorable for its 7-day retention window, never
  archived. ~3 MB/day.
- **No hard-freeze** on the negative set — accrual is already ~2-3/month and a new hard negative
  from a WaymoNet false positive is genuinely useful. Leave it emergent.
- Preserve the existing GitHub history (non-destructive): prune locally + shallow re-clone,
  **no force-push**. Old raw funnel archive stays recoverable from GitHub.

## Runway

| Scenario | Free after | Growth/day | Runway |
|---|---|---|---|
| No further action | 2.2 GB | ~420 MB | ~5 days |
| Reap orphans + plug merge leak only | 11.2 GB | ~440 MB | ~25 days |
| Freeze negatives, keep raw candidates | ~11 GB | ~220 MB | ~50 days |
| **Chosen: archive hits + curated only** | **~56 GB** | **~6 MB** | **~25 years** |

## Plan

- [x] 1. `collector/reap_orphans.py` — delete `data/candidates/*.jpg` with no referencing row.
      Grace period so in-flight writes are never touched. Dry-run first.
- [x] 2. Reap the existing orphans — **430,496 files / 9.04 GB**
- [x] 3. Plug the merge-path leak in `ingest()` — unlink superseded crop/frame
- [x] 4. Rewrite `backup_github.sh` to archive selectively (keep-set only)
- [x] 5. ~~Push the 3 pending commits~~ — **deliberately NOT pushed.** They held 1.1 GB of exactly
      the raw funnel jpgs being retired, and git pushes ancestors regardless. Rebuilt the tip on
      `origin/main` instead, so their keep-set content was re-added from the live filesystem and
      the rest never left the box.
- [x] 6. Commit the archive prune, push, shallow re-clone → **45G → 918M**
- [x] 7. Disk guard: `backup_github.sh` aborts <4 GB free; DISK LOW alarm <8 GB in check_loop_health
- [x] 8. Weekly reaper cron (Sun 05:30 London)
- [x] 9. Verified: disk, loop, site, API, DB integrity, digest email delivered
- [x] 10. CHANGELOG + lessons + commit + push to `main`

## Review

**Outcome: 100% → 24% disk used (55 GB free). Runway ~5 days → effectively unbounded (~6 MB/day).**

Service was restored *before* any code changed — the journal vacuum and cache clear alone brought
back the loop, the site and the API, which confirmed the whole outage was one shared-resource
failure rather than three bugs.

| | before | after |
|---|---|---|
| Disk used | 72G / 75G (100%) | **17G / 75G (24%)** |
| `waymo-backup` | 45 GB | **918 MB** |
| `data/candidates` | 9.8 GB (453k jpgs) | **558 MB (23k jpgs)** |
| Archive growth | ~323 MB/day | **~3 MB/day** |

Verified after the fix: `quick_check` ok · **1,239 waymos** (1,234 training reals, up 2 — auto-bank
resumed mid-session) · 8,055 rejects unchanged · loop active · waymonet.com 200 · API 200 ·
review email delivered (9 candidates, conf 0.03–0.67) · `real_positives` 2,466 = 2,466 and
**0 of 2,478 waymo jpgs missing from the archive**.

### Judgement calls worth recording

- **Nothing was force-pushed.** Every pruned jpg is still recoverable from GitHub history. The
  local repo is a `--depth 1` clone, which is what reclaims the 27 GB of history locally.
- **The keep-set filter is status-based AND hit-based on purpose.** 8,019 of 8,055 rejects are
  `wn_hit=0`; a hits-only filter would have destroyed the negative corpus. See lessons.md.
- **No hard-freeze on negatives.** Accrual already fell 7,976 (Jun) → 79 (Jul) on its own, and a
  new hard negative from a WaymoNet false positive is still worth banking.

### Training dataset: verified complete ON DISK (not just GitHub)

The reaper only ever deleted files **no DB row referenced**, so training data was never in scope.
Verified explicitly afterwards:

| On disk | count | missing |
|---|---|---|
| Training positives (`waymo`, `special IS NULL`) | 1,234 | **0 crops, 0 frames** |
| Training negatives (`reject`, `special IS NULL`) | 8,003 | **0 crops, 0 frames** |
| incl. specials | 1,239 / 8,055 | 0 / 0 |
| `real_positives` | 2,466 | matches archive |
| `hard_negatives` | **1,168** | matches archive **after restoring 8** |
| `special` | 113 | matches archive |
| Built YOLO sets | `dataset_real` 224 MB + `dataset_real_full` 258 MB | present |

**`hard_negatives` had 4 pairs (8 files) that existed ONLY in the archive** — deleted from disk
some time in June and surviving purely because the archive is append-only. Restored to disk with
`rsync --ignore-existing` from `waymo-backup/images/hard_negatives/`. Local is now the primary
copy everywhere; GitHub is redundancy. Total training footprint on disk ~1.4 GB.

### Runway (measured, not estimated)

**54.8 GB free (24% used).** Permanent growth:

| Term | /day |
|---|---|
| Local candidate jpgs (`wn_hit` is retention-exempt, ~75/day × 40.8 KB) | 3.1 MB |
| Archive working tree (same files) | 3.1 MB |
| Archive `.git` blobs (JPEGs don't compress) | 3.1 MB |
| Archive CSV churn (packed) | 0.44 MB |
| `waymo.db` rows kept forever | 0.45 MB |
| **Total** | **~10 MB/day** (~3.7 GB/year) |

One-time: `data/candidates` held only 1,990 transient rows post-outage; at the pre-outage rate it
refills to a **~1.5 GB** 7-day plateau over the following week. **Runway ≈ 53 GB ÷ 10 MB/day ≈
14 years** (was ~5 days: 42× lower growth, 25× more free space).

The real long-term term is not disk: the `wn_hit` review pool is retention-exempt and accrues
~75/day (~27k rows/year) whether reviewed or not. That becomes a review-throughput question long
before a storage one.

### Git housekeeping

Measured empirically: 24 hourly commits of `candidates.csv` leave **~15 MB/day of loose objects
that pack to ~0.44 MB/day**. Left alone that sawtooths to ~1.4 GB before git's default
`gc.auto=6700` triggers. Set `gc.auto=500` + `gc.autoDetach=false` on the archive repo and added a
weekly repack (Sun 06:00, alongside the reaper at Sun 05:30).

Hourly cron backup verified end-to-end on the new script:
`2026-08-07T12:37:06Z pushed: 11887 rows, 23560 jpgs (56094 MB free)`.

### Follow-ups (not done, not blocking)

- **GitHub repo is still ~26 GB** — well past the 5 GB soft limit, since history was preserved.
  New commits are tiny now, so it will not grow meaningfully, but GitHub may still make contact.
  Truncating it needs a force-push: a decision, not a fix.
- `/home/hq/.cache/puppeteer` (619 MB) left in place — could not confirm nothing uses it.
- Write-before-score ordering in `ingest()` left as-is: the 7-day local window intentionally keeps
  a frame for every candidate so it stays re-scorable. The reaper covers the orphan class it can
  create under ENOSPC.
