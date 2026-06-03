# WaymoWatch

Spot and log Waymo autonomous test vehicles on London's streets from TfL's public
traffic-camera (JamCam) feeds, using a purpose-trained detector (**WaymoNet**), then
turn confirmed sightings into analytics (concurrency, testing radius, heatmaps).

> **Powered by TfL Open Data.** Contains OS data © Crown copyright and database rights.
> Imagery is used under the Open Government Licence v2.0.

## What we're detecting

As of mid-2026 Waymo really is testing in London: heavily-modified **left-hand-drive white
Jaguar I-PACEs** carrying a tall **central roof lidar dome** plus four corner sensor pods,
mapping and running supervised-autonomous tests across ~100 sq miles / 20 boroughs (depot at
Park Royal, NW10). The fleet is small (~tens scaling toward ~100 vehicles).

The single visual cue that survives a 352×288 traffic-camera frame is the **roof dome**:

- **DOME on the roof → Waymo**
- **flat low roof BAR → Wayve / Uber** (the main false positive; Wayve also uses I-PACEs, so
  the base car model is *not* a discriminator — only the roof hardware is)

## The feed (verified live, 3 Jun 2026)

- `GET https://api.tfl.gov.uk/Place/Type/JamCam` → **882 cameras** (779 available), each with
  lat/lon + an S3 `imageUrl` (.jpg) and `videoUrl` (.mp4).
- Image/clip host: `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/<short_id>.{jpg,mp4}`
  (`short_id` = camera id with the `JamCams_` prefix stripped).
- **Each clip is H.264, 25 fps, ~11 s, ~277 frames, 352×288** — *not* a single snapshot. It's
  the latest 11-second clip, refreshed roughly every 3–8 min per camera (staggered).
- ETag / Last-Modified headers allow conditional GET, so unchanged clips cost nothing.

## Honest scope

This is a **"surface rare candidates for human confirmation"** system, not a live fleet
tracker. Two hard limits, neither fixable by a better model:

1. Each camera only gives ~11 s of footage every ~3 min, so most Waymo passes are never on
   camera. "How many out at once" can only ever be a **lower bound** (or a modelled occupancy
   estimate), never a census.
2. At 352×288 the roof dome is ~5–15 px and only resolvable for near/mid-field vehicles. Recall
   will be modest; a human gate buys precision. Expect possibly days between confirmable sightings.

## Legal / privacy

JamCam imagery is Open Government Licence v2 (commercial reuse permitted with the attribution
above). The feeds are deliberately downsampled so number plates and faces are **not** legible —
we log a *corporate fleet's* presence, never identifiable individuals, so UK-GDPR is not engaged.
TfL explicitly endorses ML vehicle detection on this feed. We do not enrich sightings with any
plate/driver-identifying data.

## Status

- [x] Data plane proven end-to-end against the live feed (`collector/data_plane.py`)
- [ ] Training data acquired + WaymoNet fine-tuned
- [ ] Video-clip inference runtime
- [ ] Sighting feed: WhatsApp alerts + Leaflet map + confirm queue
- [ ] Analytics (concurrency, alpha-shape footprint, KDE heatmap)
