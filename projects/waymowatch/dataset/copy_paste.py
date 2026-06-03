#!/usr/bin/env python3
"""Copy-paste synthetic-positive engine + JamCam domain degradation.

Core idea: real Waymo dome imagery is scarce, so we manufacture training positives
by compositing real dome/vehicle crops onto real empty London JamCam backplates and
degrading them to the 352x288 / JPEG domain the detector actually sees.

This module also provides `simulate_at_scale`, used to sanity-check whether the roof
dome is even resolvable at the pixel sizes a JamCam renders a vehicle.
"""
import cv2
import numpy as np


def jamcam_degrade(img, jpeg_q=38, blur=0.0):
    """Push an image through the JamCam codec/optics signature: optional slight blur
    then a low-quality JPEG round-trip (the feed is libavcodec-encoded ~CIF)."""
    out = img
    if blur > 0:
        k = max(1, int(blur)) | 1
        out = cv2.GaussianBlur(out, (k, k), 0)
    enc = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, jpeg_q])[1]
    return cv2.imdecode(enc, cv2.IMREAD_COLOR)


def simulate_at_scale(crop, target_h, jpeg_q=35):
    """Render a vehicle crop at the height (px) it would occupy in a JamCam frame,
    with JPEG degradation. Returns the small image (not upscaled)."""
    h, w = crop.shape[:2]
    s = target_h / h
    small = cv2.resize(crop, (max(1, int(w * s)), target_h), interpolation=cv2.INTER_AREA)
    return jamcam_degrade(small, jpeg_q=jpeg_q)


def feathered_alpha(h, w, feather=0.18):
    """Soft elliptical alpha for blending a roughly-cropped patch."""
    m = np.zeros((h, w), np.float32)
    cv2.ellipse(m, (w // 2, h // 2), (int(w * 0.5) - 1, int(h * 0.5) - 1), 0, 0, 360, 1, -1)
    k = max(1, int(min(h, w) * feather)) | 1
    return cv2.GaussianBlur(m, (k, k), 0)


def composite(backplate, patch, cx, cy, scale, alpha=None, brightness_match=True):
    """Alpha-blend `patch` onto `backplate` centred at (cx,cy), scaled. Returns
    (image, (x0,y0,w,h)) where the box is the pasted region (for a YOLO label)."""
    ph, pw = patch.shape[:2]
    nw, nh = max(2, int(pw * scale)), max(2, int(ph * scale))
    patch = cv2.resize(patch, (nw, nh), interpolation=cv2.INTER_AREA)
    a = cv2.resize(alpha, (nw, nh)) if alpha is not None else feathered_alpha(nh, nw)
    x0, y0 = int(cx - nw / 2), int(cy - nh / 2)
    H, W = backplate.shape[:2]
    xs, ys = max(0, x0), max(0, y0)
    xe, ye = min(W, x0 + nw), min(H, y0 + nh)
    if xe <= xs or ye <= ys:
        return backplate, None
    px0, py0 = xs - x0, ys - y0
    sub = patch[py0:py0 + (ye - ys), px0:px0 + (xe - xs)].astype(np.float32)
    asub = a[py0:py0 + (ye - ys), px0:px0 + (xe - xs)][:, :, None]
    bg = backplate[ys:ye, xs:xe].astype(np.float32)
    if brightness_match:
        bm, sm = bg.mean(), sub.mean() + 1e-6
        sub = np.clip(sub * (bm / sm), 0, 255)
    out = backplate.copy()
    out[ys:ye, xs:xe] = (asub * sub + (1 - asub) * bg).astype(np.uint8)
    return out, (xs, ys, xe - xs, ye - ys)


def _label(img, text):
    cv2.rectangle(img, (0, 0), (8 + 9 * len(text), 22), (0, 0, 0), -1)
    cv2.putText(img, text, (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 1)
    return img


if __name__ == "__main__":
    # Resolvability experiment: render the real Miami Waymo (05) at JamCam vehicle scales.
    import os
    BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = cv2.imread(os.path.join(BASE, "data/sources/waymo/05_Waymo_Driverless_Vehicle_Brickell_Miami_April_.jpg"))
    car = src[150:620, 180:1130]  # whole I-PACE incl. roof dome (px in the 1280x960 source)
    cv2.imwrite(os.path.join(BASE, "data/sources/waymo05_car.jpg"), car)
    cv2.imwrite(os.path.join(BASE, "data/sources/waymo05_dome.jpg"), src[150:300, 500:760])
    panels, ZOOM = [], 8
    for h, tag in [(18, "18px far"), (30, "30px mid"), (48, "48px near"), (80, "80px close")]:
        small = simulate_at_scale(car, h)
        big = cv2.resize(small, (small.shape[1] * ZOOM, small.shape[0] * ZOOM), interpolation=cv2.INTER_NEAREST)
        canvas = np.full((80 * ZOOM, max(big.shape[1], 120), 3), 35, np.uint8)
        canvas[:big.shape[0], :big.shape[1]] = big
        panels.append(_label(canvas, tag))
    montage = np.hstack([cv2.copyMakeBorder(p, 2, 2, 2, 2, cv2.BORDER_CONSTANT, value=(80, 80, 80)) for p in panels])
    out = os.path.join(BASE, "data/sources/dome_scale_test.jpg")
    cv2.imwrite(out, montage)
    print("wrote", out, montage.shape, "(8x nearest-neighbour zoom of JamCam-scale renders)")
