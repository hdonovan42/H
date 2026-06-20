#!/usr/bin/env python3
"""WaymoNet coverage map: every camera we watch (grey) vs where Waymos were spotted (red)."""
import json
from staticmap import StaticMap, CircleMarker
from PIL import Image, ImageDraw, ImageFont

d = json.load(open("/tmp/coverage.json"))
covered, sightings = d["covered"], d["sightings"]
W, H = 1500, 1500

m = StaticMap(W, H, padding_x=50, padding_y=50,
              url_template="https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png")
# layer 1: every covered camera (the "looking" mesh)
for la, lo in covered:
    m.add_marker(CircleMarker((lo, la), "#8A9098", 3))
# layer 2: Waymo sightings (the "found"), white halo + red, sized by count
for la, lo, n in sightings:
    r = 7 + 3 * min(n - 1, 4)
    m.add_marker(CircleMarker((lo, la), "#FFFFFF", r + 3))
    m.add_marker(CircleMarker((lo, la), "#E32017", r))

img = m.render().convert("RGB")

# --- annotate: title bar + legend ---
draw = ImageDraw.Draw(img)
def font(sz, bold=True):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
              else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",):
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()

# top title strip
draw.rectangle([0, 0, W, 96], fill="#16161F")
draw.text((30, 16), "WaymoNet — London coverage", font=font(38), fill="#FFFFFF")
draw.text((30, 62), f"{len(covered)} cameras watched   ·   {sum(s[2] for s in sightings)} Waymos confirmed at {len(sightings)} cameras",
          font=font(22, False), fill="#C9CDD3")

# legend (bottom-left card)
lx, ly = 30, H - 118
draw.rectangle([lx, ly, lx + 360, ly + 88], fill="#FFFFFF", outline="#16161F", width=2)
draw.ellipse([lx + 18, ly + 20, lx + 30, ly + 32], fill="#8A9098")
draw.text((lx + 44, ly + 16), "camera we watch", font=font(20, False), fill="#16161F")
draw.ellipse([lx + 16, ly + 52, lx + 32, ly + 68], fill="#E32017")
draw.text((lx + 44, ly + 50), "Waymo spotted here", font=font(20, False), fill="#16161F")

# attribution
att = "Map © OpenStreetMap, © CARTO · Powered by TfL Open Data"
draw.text((W - 8 - draw.textlength(att, font=font(14, False)), H - 22), att, font=font(14, False), fill="#6E6E73")

img.save("/tmp/coverage_map.png", quality=92)
print("saved /tmp/coverage_map.png", img.size)
