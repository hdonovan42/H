import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as THREE from "three";

// === EXPORTED DATA ===

export const TAB_OPTIONS = [
  { id: "globe", label: "Solar Map", icon: "\u25C9" },
  { id: "space", label: "Space vs Earth", icon: "\u25C8" },
  { id: "panels", label: "Panel Specs", icon: "\u2B21" },
  { id: "calculator", label: "Calculator", icon: "\u229E" },
];

export const SOLAR_REGIONS = [
  { lat: 23.5, lng: 25.0, ghi: 2600, region: "Sahara Desert", country: "Egypt/Libya", tier: "S" },
  { lat: 24.0, lng: 45.0, ghi: 2500, region: "Arabian Peninsula", country: "Saudi Arabia", tier: "S" },
  { lat: -22.5, lng: 17.0, ghi: 2450, region: "Namib Desert", country: "Namibia", tier: "S" },
  { lat: 32.0, lng: 6.0, ghi: 2300, region: "Algerian Sahara", country: "Algeria", tier: "A" },
  { lat: -25.0, lng: 28.0, ghi: 2200, region: "Highveld", country: "South Africa", tier: "A" },
  { lat: 15.0, lng: 40.0, ghi: 2400, region: "Horn of Africa", country: "Ethiopia/Eritrea", tier: "S" },
  { lat: 27.0, lng: 31.0, ghi: 2350, region: "Upper Egypt", country: "Egypt", tier: "A" },
  { lat: 33.5, lng: -112.0, ghi: 2350, region: "Sonoran Desert", country: "USA (Arizona)", tier: "A" },
  { lat: 36.0, lng: -115.0, ghi: 2300, region: "Mojave Desert", country: "USA (Nevada)", tier: "A" },
  { lat: -24.0, lng: -68.0, ghi: 2550, region: "Atacama Desert", country: "Chile", tier: "S" },
  { lat: 24.0, lng: -110.0, ghi: 2200, region: "Baja California", country: "Mexico", tier: "A" },
  { lat: -15.0, lng: -45.0, ghi: 2100, region: "Minas Gerais", country: "Brazil", tier: "A" },
  { lat: 35.0, lng: -106.0, ghi: 2200, region: "New Mexico", country: "USA", tier: "A" },
  { lat: 40.0, lng: -74.0, ghi: 1500, region: "Northeast US", country: "USA (New York)", tier: "C" },
  { lat: 47.6, lng: -122.3, ghi: 1250, region: "Pacific Northwest", country: "USA (Seattle)", tier: "D" },
  { lat: 26.0, lng: 71.0, ghi: 2200, region: "Thar Desert", country: "India", tier: "A" },
  { lat: 40.0, lng: 95.0, ghi: 2000, region: "Gobi Desert", country: "China", tier: "B" },
  { lat: -25.0, lng: 134.0, ghi: 2300, region: "Central Australia", country: "Australia", tier: "A" },
  { lat: 35.0, lng: 137.0, ghi: 1400, region: "Honshu", country: "Japan", tier: "C" },
  { lat: 36.0, lng: 128.0, ghi: 1350, region: "Central Korea", country: "South Korea", tier: "C" },
  { lat: 22.5, lng: 114.0, ghi: 1300, region: "Pearl River Delta", country: "China (Guangdong)", tier: "C" },
  { lat: 37.0, lng: -4.0, ghi: 2000, region: "Andalusia", country: "Spain", tier: "B" },
  { lat: 38.0, lng: 23.7, ghi: 1900, region: "Attica", country: "Greece", tier: "B" },
  { lat: 37.5, lng: 15.0, ghi: 1950, region: "Sicily", country: "Italy", tier: "B" },
  { lat: 48.8, lng: 2.3, ghi: 1200, region: "\u00CEle-de-France", country: "France (Paris)", tier: "D" },
  { lat: 51.5, lng: -0.1, ghi: 1050, region: "Southeast England", country: "UK (London)", tier: "D" },
  { lat: 52.5, lng: 13.4, ghi: 1100, region: "Brandenburg", country: "Germany (Berlin)", tier: "D" },
  { lat: 48.1, lng: 11.6, ghi: 1200, region: "Bavaria", country: "Germany (Munich)", tier: "D" },
  { lat: 59.3, lng: 18.0, ghi: 950, region: "Stockholm Region", country: "Sweden", tier: "D" },
  { lat: 60.2, lng: 25.0, ghi: 900, region: "Uusimaa", country: "Finland", tier: "D" },
  { lat: 29.0, lng: -13.6, ghi: 2150, region: "Canary Islands", country: "Spain", tier: "A" },
  { lat: 31.0, lng: 35.0, ghi: 2300, region: "Negev Desert", country: "Israel", tier: "A" },
  { lat: -20.0, lng: 57.5, ghi: 1800, region: "Mauritius", country: "Mauritius", tier: "B" },
  { lat: 1.3, lng: 103.8, ghi: 1650, region: "Singapore", country: "Singapore", tier: "C" },
  { lat: -33.9, lng: 18.4, ghi: 2000, region: "Cape Town", country: "South Africa", tier: "B" },
];

export const PANEL_SPECS = {
  residential: {
    name: "Standard Residential",
    efficiency: 0.20,
    wattPerPanel: 400,
    panelArea_sqft: 17.6,
    costPerWatt: 2.50,
    degradation: 0.005,
    techType: "Monocrystalline Silicon",
  },
  premium: {
    name: "Premium (SunPower/REC)",
    efficiency: 0.225,
    wattPerPanel: 440,
    panelArea_sqft: 17.6,
    costPerWatt: 3.20,
    degradation: 0.004,
    techType: "IBC / HJT Silicon",
  },
  commercial: {
    name: "Commercial Utility-Scale",
    efficiency: 0.21,
    wattPerPanel: 550,
    panelArea_sqft: 24.0,
    costPerWatt: 1.80,
    degradation: 0.005,
    techType: "Bifacial PERC",
  },
  cuttingEdge: {
    name: "Perovskite-Tandem (Lab)",
    efficiency: 0.335,
    wattPerPanel: 600,
    panelArea_sqft: 17.6,
    costPerWatt: null,
    degradation: 0.02,
    techType: "Perovskite/Silicon Tandem",
  },
  space: {
    name: "Space-Grade (GaAs MJ)",
    efficiency: 0.32,
    wattPerPanel: 450,
    panelArea_sqft: 10.8,
    costPerWatt: 300,
    degradation: 0.01,
    techType: "Triple-Junction GaAs",
  },
};

export const SPACE_EARTH = {
  irradiance: { space: 1361, earth_peak: 1000, earth_avg: 164 },
  hoursPerDay: { space_geo: 24, space_leo: 16, earth_best: 6.5, earth_avg: 4.5 },
  efficiency: { space_current: 0.32, space_lab: 0.47, earth_current: 0.225, earth_lab: 0.335 },
  temperature: { space_sun: 120, space_shadow: -170, earth_optimal: 25, earth_hot: 65 },
  atmosphere: { absorption_pct: 23, scattering_pct: 8, cloud_loss_pct: 20 },
  costPerWatt: { space: 40000, earth_utility: 0.70, earth_residential: 2.50 },
  annualYield_kwh_per_m2: { space_geo: 3500, earth_sahara: 2600, earth_uk: 1050, earth_global_avg: 1700 },
};

export const TIER_COLORS = {
  S: { bg: "#FF3B00", glow: "#FF6B3B", label: "Exceptional" },
  A: { bg: "#FF8C00", glow: "#FFB347", label: "Excellent" },
  B: { bg: "#FFD700", glow: "#FFEC8B", label: "Good" },
  C: { bg: "#4FC3F7", glow: "#81D4FA", label: "Moderate" },
  D: { bg: "#7986CB", glow: "#9FA8DA", label: "Low" },
};

// === STYLES ===
const inputGroupStyle = { display: "flex", flexDirection: "column", gap: 6 };
const labelStyle = { color: "#999", fontSize: 12, fontFamily: "'DM Sans', sans-serif", letterSpacing: "0.04em", textTransform: "uppercase" };
const sliderStyle = { width: "100%", accentColor: "#FF8C00", cursor: "pointer" };
const selectStyle = { padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: "#ddd", fontSize: 14, fontFamily: "'DM Sans', sans-serif", cursor: "pointer", outline: "none" };
const dimText = { color: "#888", fontSize: 13, fontFamily: "'Space Mono', monospace" };

// NASA CERES solar insolation — real satellite data, equirectangular projection
// Source: NASA Earth Observations (NEO), CERES instrument
const NASA_INSOLATION_URL = "https://neo.gsfc.nasa.gov/servlet/RenderData?si=2044480&cs=rgb&format=PNG&width=2048&height=1024";

// ========== 3D GLOBE ==========
function SolarGlobe({ data, hoveredRegion, setHoveredRegion }) {
  const mountRef = useRef(null);
  const frameRef = useRef(null);
  const mouseRef = useRef({ x: 0, y: 0, isDown: false, prevX: 0, prevY: 0 });
  const rotationRef = useRef({ x: 0.3, y: 0 });
  const mouseVec = useRef(new THREE.Vector2());

  useEffect(() => {
    if (!mountRef.current) return;
    const container = mountRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    const scene = new THREE.Scene();
    const fov = 45;
    const camera = new THREE.PerspectiveCamera(fov, width / height, 0.1, 1000);
    // Pull camera back so the full globe (r=1.06 with atmos) fits in the smaller dimension
    const fitRadius = 1.1;
    const vFov = (fov * Math.PI) / 180;
    const fitZ = fitRadius / Math.sin(vFov / 2);
    // Also account for horizontal — if wider than tall, vertical is the constraint; if taller, horizontal is
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (width / height));
    const fitZh = fitRadius / Math.sin(hFov / 2);
    camera.position.z = Math.max(fitZ, fitZh) + 0.2;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    // Lighting
    scene.add(new THREE.AmbientLight(0x667788, 1.0));
    const sunLight = new THREE.DirectionalLight(0xfff5e0, 1.4);
    sunLight.position.set(5, 3, 5);
    scene.add(sunLight);
    const rimLight = new THREE.DirectionalLight(0x4488ff, 0.3);
    rimLight.position.set(-3, -1, -3);
    scene.add(rimLight);

    // Globe group
    const globeGroup = new THREE.Group();
    scene.add(globeGroup);

    const sphereGeo = new THREE.SphereGeometry(1, 64, 64);
    const textureLoader = new THREE.TextureLoader();

    // Layer 1: Solid dark core
    const globe = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0x060b14 }));
    globeGroup.add(globe);

    // Layer 2: Glowing continent hologram (alpha-masked by land/water texture)
    // earth-water.png from three-globe: land=dark, water=light — we invert for alphaMap
    const holoMat = new THREE.MeshBasicMaterial({
      color: 0xFF8C00,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
    });
    const holoMesh = new THREE.Mesh(sphereGeo, holoMat);
    holoMesh.scale.set(1.001, 1.001, 1.001);
    globeGroup.add(holoMesh);

    // Load water mask, invert it so land=white(visible), ocean=black(transparent)
    const maskImg = new Image();
    maskImg.crossOrigin = "anonymous";
    maskImg.onload = () => {
      const c = document.createElement("canvas");
      c.width = maskImg.width; c.height = maskImg.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(maskImg, 0, 0);
      const imgData = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < imgData.data.length; i += 4) {
        // Invert: water (bright) → black, land (dark) → white
        imgData.data[i] = 255 - imgData.data[i];
        imgData.data[i + 1] = 255 - imgData.data[i + 1];
        imgData.data[i + 2] = 255 - imgData.data[i + 2];
      }
      ctx.putImageData(imgData, 0, 0);
      holoMat.alphaMap = new THREE.CanvasTexture(c);
      holoMat.needsUpdate = true;
    };
    maskImg.src = "https://unpkg.com/three-globe@2.31.1/example/img/earth-water.png";

    // Layer 3: NASA irradiance overlay (GSA color ramp, normal blend so colors read true)
    const heatMat = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
    });
    const heatSphere = new THREE.Mesh(new THREE.SphereGeometry(1.003, 64, 64), heatMat);
    globeGroup.add(heatSphere);

    const GSA_RAMP = [
      [0.00, 30, 10, 80],
      [0.15, 20, 40, 160],
      [0.30, 0, 140, 180],
      [0.45, 30, 180, 60],
      [0.60, 220, 220, 0],
      [0.78, 240, 140, 0],
      [1.00, 180, 0, 0],
    ];

    function sampleRamp(t) {
      t = Math.max(0, Math.min(1, t));
      for (let i = 0; i < GSA_RAMP.length - 1; i++) {
        const [t0, r0, g0, b0] = GSA_RAMP[i];
        const [t1, r1, g1, b1] = GSA_RAMP[i + 1];
        if (t >= t0 && t <= t1) {
          const f = (t - t0) / (t1 - t0);
          return [Math.round(r0 + (r1 - r0) * f), Math.round(g0 + (g1 - g0) * f), Math.round(b0 + (b1 - b0) * f)];
        }
      }
      const last = GSA_RAMP[GSA_RAMP.length - 1];
      return [last[1], last[2], last[3]];
    }

    const nasaImg = new Image();
    nasaImg.crossOrigin = "anonymous";
    nasaImg.onload = () => {
      const W = nasaImg.width, H = nasaImg.height;
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const ctx = c.getContext("2d");
      ctx.drawImage(nasaImg, 0, 0);
      const src = ctx.getImageData(0, 0, W, H);
      const out = ctx.createImageData(W, H);

      // Pass 1: find actual min/max brightness in the image
      let bMin = 1, bMax = 0;
      for (let i = 0; i < src.data.length; i += 4) {
        const b = (src.data[i] * 0.299 + src.data[i+1] * 0.587 + src.data[i+2] * 0.114) / 255;
        if (b < bMin) bMin = b;
        if (b > bMax) bMax = b;
      }
      const bRange = bMax - bMin || 1;

      // Pass 2: normalize relative to actual range, then map through color ramp
      for (let i = 0; i < src.data.length; i += 4) {
        const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2];
        const brightness = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
        const t = (brightness - bMin) / bRange; // 0 = darkest pixel on earth, 1 = brightest
        const [cr, cg, cb] = sampleRamp(t);
        const alpha = Math.round(40 + t * 120);

        out.data[i] = cr;
        out.data[i + 1] = cg;
        out.data[i + 2] = cb;
        out.data[i + 3] = alpha;
      }

      ctx.putImageData(out, 0, 0);
      heatMat.map = new THREE.CanvasTexture(c);
      heatMat.needsUpdate = true;
    };
    nasaImg.src = NASA_INSOLATION_URL;

    // Layer 4: Faint wireframe grid
    const gridMesh = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({
      color: 0xFF8C00,
      wireframe: true,
      transparent: true,
      opacity: 0.08,
    }));
    gridMesh.scale.set(1.004, 1.004, 1.004);
    globeGroup.add(gridMesh);

    // Layer 5: Atmospheric glow
    const glow = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({
      color: 0xFF8C00,
      transparent: true,
      opacity: 0.15,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    }));
    glow.scale.set(1.15, 1.15, 1.15);
    globeGroup.add(glow);

    // Raycaster — hit the globe surface, find nearest data point
    const raycaster = new THREE.Raycaster();
    const el = renderer.domElement;
    const HOVER_THRESHOLD_DEG = 8; // degrees proximity to snap to a data point

    function hitToLatLng(point, group) {
      // Transform hit point from world space into group local space
      const local = group.worldToLocal(point.clone());
      const r = local.length();
      const lat = 90 - Math.acos(local.y / r) * (180 / Math.PI);
      const lng = Math.atan2(local.z, local.x) * (180 / Math.PI) - 180;
      return { lat, lng: lng < -180 ? lng + 360 : lng };
    }

    function findNearest(lat, lng) {
      let best = null, bestDist = Infinity;
      data.forEach((p) => {
        const dlat = p.lat - lat, dlng = p.lng - lng;
        const d = Math.sqrt(dlat * dlat + dlng * dlng);
        if (d < bestDist) { bestDist = d; best = p; }
      });
      return bestDist < HOVER_THRESHOLD_DEG ? best : null;
    }

    // Mouse
    const onMouseDown = (e) => { mouseRef.current.isDown = true; mouseRef.current.prevX = e.clientX; mouseRef.current.prevY = e.clientY; };
    const onMouseUp = () => { mouseRef.current.isDown = false; };
    const onMouseMove = (e) => {
      const rect = container.getBoundingClientRect();
      mouseVec.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseVec.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      if (mouseRef.current.isDown) {
        const dx = e.clientX - mouseRef.current.prevX;
        const dy = e.clientY - mouseRef.current.prevY;
        rotationRef.current.y += dx * 0.005;
        rotationRef.current.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotationRef.current.x + dy * 0.005));
        mouseRef.current.prevX = e.clientX;
        mouseRef.current.prevY = e.clientY;
      }
    };
    const onTouchStart = (e) => { if (e.touches.length === 1) { mouseRef.current.isDown = true; mouseRef.current.prevX = e.touches[0].clientX; mouseRef.current.prevY = e.touches[0].clientY; } };
    const onTouchMove = (e) => {
      if (e.touches.length === 1 && mouseRef.current.isDown) {
        const dx = e.touches[0].clientX - mouseRef.current.prevX;
        const dy = e.touches[0].clientY - mouseRef.current.prevY;
        rotationRef.current.y += dx * 0.005;
        rotationRef.current.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotationRef.current.x + dy * 0.005));
        mouseRef.current.prevX = e.touches[0].clientX;
        mouseRef.current.prevY = e.touches[0].clientY;
      }
    };
    const onTouchEnd = () => { mouseRef.current.isDown = false; };

    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("mouseup", onMouseUp);
    el.addEventListener("mousemove", onMouseMove);
    el.addEventListener("mouseleave", onMouseUp);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd);

    // Animate
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      if (!mouseRef.current.isDown) rotationRef.current.y += 0.002;
      globeGroup.rotation.x = rotationRef.current.x;
      globeGroup.rotation.y = rotationRef.current.y;

      // Raycast against globe surface for hover
      raycaster.setFromCamera(mouseVec.current, camera);
      const hits = raycaster.intersectObject(globe);

      if (hits.length > 0 && !mouseRef.current.isDown) {
        const { lat, lng } = hitToLatLng(hits[0].point, globeGroup);
        const nearest = findNearest(lat, lng);
        if (nearest) {
          setHoveredRegion(nearest);
          el.style.cursor = "pointer";
        } else {
          setHoveredRegion(null);
          el.style.cursor = "grab";
        }
      } else if (!mouseRef.current.isDown) {
        setHoveredRegion(null);
        el.style.cursor = "grab";
      }

      renderer.render(scene, camera);
    };
    animate();

    // Resize — recalculate camera distance so globe always fits
    const onResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      const newVFov = (fov * Math.PI) / 180;
      const newHFov = 2 * Math.atan(Math.tan(newVFov / 2) * (w / h));
      const zV = fitRadius / Math.sin(newVFov / 2);
      const zH = fitRadius / Math.sin(newHFov / 2);
      camera.position.z = Math.max(zV, zH) + 0.2;
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("resize", onResize);
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("mouseup", onMouseUp);
      el.removeEventListener("mousemove", onMouseMove);
      el.removeEventListener("mouseleave", onMouseUp);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      if (container && el.parentNode === container) container.removeChild(el);
      renderer.dispose();
    };
  }, [data]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%", cursor: "grab" }} />;
}

// ========== GLOBE PAGE ==========
function GlobePage() {
  const [hoveredRegion, setHoveredRegion] = useState(null);
  const sortedData = useMemo(() => [...SOLAR_REGIONS].sort((a, b) => b.ghi - a.ghi), []);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", height: "100%", minHeight: 0 }}>
      <div style={{ position: "relative", minHeight: 0 }}>
        <SolarGlobe data={SOLAR_REGIONS} hoveredRegion={hoveredRegion} setHoveredRegion={setHoveredRegion} />

        {hoveredRegion && (
          <div style={{
            position: "absolute", top: 20, left: 20, padding: "16px 20px",
            background: "rgba(6,11,20,0.92)", borderRadius: 12,
            border: `1px solid ${TIER_COLORS[hoveredRegion.tier].bg}40`,
            backdropFilter: "blur(10px)", minWidth: 200, pointerEvents: "none",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: TIER_COLORS[hoveredRegion.tier].bg, boxShadow: `0 0 8px ${TIER_COLORS[hoveredRegion.tier].bg}80` }} />
              <span style={{ fontWeight: 700, fontSize: 16 }}>{hoveredRegion.region}</span>
            </div>
            <div style={{ color: "#999", fontSize: 13, marginBottom: 4 }}>{hoveredRegion.country}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: TIER_COLORS[hoveredRegion.tier].bg, fontFamily: "'Space Mono', monospace", lineHeight: 1, margin: "8px 0 4px" }}>
              {hoveredRegion.ghi.toLocaleString()}
            </div>
            <div style={{ color: "#888", fontSize: 12 }}>kWh/m\u00B2/year GHI</div>
            <div style={{ marginTop: 8, padding: "4px 10px", background: `${TIER_COLORS[hoveredRegion.tier].bg}15`, borderRadius: 6, display: "inline-block", color: TIER_COLORS[hoveredRegion.tier].bg, fontSize: 12, fontWeight: 600 }}>
              Tier {hoveredRegion.tier} \u2014 {TIER_COLORS[hoveredRegion.tier].label}
            </div>
          </div>
        )}

        <div style={{ position: "absolute", bottom: 20, left: 20, display: "flex", gap: 12, padding: "10px 16px", background: "rgba(6,11,20,0.85)", borderRadius: 10, backdropFilter: "blur(8px)" }}>
          {Object.entries(TIER_COLORS).map(([tier, c]) => (
            <div key={tier} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: c.bg }} />
              <span style={{ color: "#999", fontSize: 11 }}>{tier}: {c.label}</span>
            </div>
          ))}
        </div>

        <div style={{ position: "absolute", bottom: 20, right: 20, color: "#555", fontSize: 11, textAlign: "right" }}>
          Drag to rotate &middot; Hover blocks for data
        </div>
      </div>

      <div style={{ borderLeft: "1px solid rgba(255,255,255,0.06)", overflowY: "auto", padding: "16px 0" }}>
        <h3 style={{ padding: "0 16px 12px", margin: 0, fontSize: 13, color: "#888", letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
          GHI Rankings (kWh/m\u00B2/yr)
        </h3>
        {sortedData.map((r, i) => (
          <div key={i} onMouseEnter={() => setHoveredRegion(r)} onMouseLeave={() => setHoveredRegion(null)}
            style={{
              padding: "10px 16px", display: "flex", alignItems: "center", gap: 10,
              borderBottom: "1px solid rgba(255,255,255,0.02)", cursor: "pointer",
              background: hoveredRegion?.region === r.region ? "rgba(255,140,0,0.08)" : "transparent",
              transition: "background 0.15s",
            }}>
            <span style={{ color: "#555", fontSize: 11, fontFamily: "'Space Mono', monospace", width: 20, textAlign: "right" }}>{i + 1}</span>
            <div style={{ width: 6, height: 6, borderRadius: 1, background: TIER_COLORS[r.tier].bg, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: "#ccc", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.region}</div>
              <div style={{ fontSize: 11, color: "#666" }}>{r.country}</div>
            </div>
            <span style={{ fontSize: 14, fontWeight: 700, color: TIER_COLORS[r.tier].bg, fontFamily: "'Space Mono', monospace", flexShrink: 0 }}>{r.ghi}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ========== CALCULATOR ==========
function SolarCalculator() {
  const [sqft, setSqft] = useState(500);
  const [panelType, setPanelType] = useState("residential");
  const [region, setRegion] = useState("earth_sahara");
  const [sunHours, setSunHours] = useState(5.5);

  const spec = PANEL_SPECS[panelType];
  const sqm = sqft * 0.0929;
  const panelCount = Math.floor(sqft / spec.panelArea_sqft);
  const totalWatts = panelCount * spec.wattPerPanel;
  const dailyKwh = (totalWatts / 1000) * sunHours;
  const annualKwh = dailyKwh * 365;
  const annualMwh = annualKwh / 1000;
  const co2Saved = annualKwh * 0.42;
  const homesEquiv = annualKwh / 10500;

  const regionSunHours = {
    earth_sahara: 6.5, earth_arizona: 6.2, earth_spain: 5.2,
    earth_uk: 2.8, earth_germany: 3.0, space_geo: 24, space_leo: 16,
  };

  useEffect(() => { setSunHours(regionSunHours[region] || 5); }, [region]);

  return (
    <div style={{ padding: "24px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px", marginBottom: "32px" }}>
        <div style={inputGroupStyle}>
          <label style={labelStyle}>Panel Area (sq ft)</label>
          <input type="range" min={100} max={50000} step={100} value={sqft} onChange={(e) => setSqft(Number(e.target.value))} style={sliderStyle} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            <span style={dimText}>{sqft.toLocaleString()} sq ft</span>
            <span style={dimText}>{sqm.toFixed(0)} m\u00B2</span>
          </div>
        </div>
        <div style={inputGroupStyle}>
          <label style={labelStyle}>Panel Technology</label>
          <select value={panelType} onChange={(e) => setPanelType(e.target.value)} style={selectStyle}>
            <option value="residential">Standard (20% eff.)</option>
            <option value="premium">Premium (22.5% eff.)</option>
            <option value="commercial">Utility-Scale (21% eff.)</option>
            <option value="cuttingEdge">Perovskite Lab (33.5% eff.)</option>
            <option value="space">Space-Grade GaAs (32% eff.)</option>
          </select>
        </div>
        <div style={inputGroupStyle}>
          <label style={labelStyle}>Location</label>
          <select value={region} onChange={(e) => setRegion(e.target.value)} style={selectStyle}>
            <option value="earth_sahara">Sahara Desert (6.5 hrs/day)</option>
            <option value="earth_arizona">Arizona, USA (6.2 hrs/day)</option>
            <option value="earth_spain">Southern Spain (5.2 hrs/day)</option>
            <option value="earth_germany">Germany (3.0 hrs/day)</option>
            <option value="earth_uk">UK (2.8 hrs/day)</option>
            <option value="space_geo">Geostationary Orbit (24 hrs/day)</option>
            <option value="space_leo">Low Earth Orbit (16 hrs/day)</option>
          </select>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "16px" }}>
        <ResultCard value={panelCount} unit="panels" label="Panel Count" sublabel={`${spec.panelArea_sqft} sq ft each`} color="#FF8C00" />
        <ResultCard value={`${(totalWatts / 1000).toFixed(1)}`} unit="kW" label="Peak Capacity" sublabel={`${totalWatts.toLocaleString()} watts`} color="#FFD700" />
        <ResultCard value={dailyKwh.toFixed(1)} unit="kWh/day" label="Daily Output" sublabel={`${sunHours} sun hours`} color="#4FC3F7" />
        <ResultCard value={annualMwh < 1 ? annualKwh.toFixed(0) : annualMwh.toFixed(1)} unit={annualMwh < 1 ? "kWh/yr" : "MWh/yr"} label="Annual Energy" sublabel={`\u2248 ${homesEquiv.toFixed(1)} US homes`} color="#66BB6A" />
        <ResultCard value={`${(co2Saved / 1000).toFixed(1)}`} unit="tonnes CO\u2082/yr" label="Carbon Offset" sublabel="vs. grid average" color="#26A69A" />
        {spec.costPerWatt && <ResultCard value={`$${((totalWatts * spec.costPerWatt) / 1000).toFixed(0)}k`} unit="" label="Estimated Cost" sublabel={`$${spec.costPerWatt}/W installed`} color="#AB47BC" />}
      </div>

      <div style={{ marginTop: 32, padding: "20px 24px", background: "rgba(255,255,255,0.03)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.06)" }}>
        <h4 style={{ color: "#e0e0e0", margin: "0 0 12px", fontSize: 14, fontFamily: "'DM Sans', sans-serif", letterSpacing: "0.03em" }}>
          QUICK REFERENCE \u2014 How much space do you need?
        </h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
          {[
            { power: "1 kW", sqft: "50", use: "Small appliances" },
            { power: "5 kW", sqft: "250", use: "Average US home" },
            { power: "10 kW", sqft: "500", use: "Large home + EV" },
            { power: "100 kW", sqft: "5,000", use: "Small business" },
            { power: "1 MW", sqft: "50,000", use: "100 homes / warehouse" },
            { power: "1 GW", sqft: "50M (~2 sq mi)", use: "Large city" },
          ].map((row) => (
            <div key={row.power} style={{ padding: "10px 14px", background: "rgba(255,140,0,0.06)", borderRadius: 8, borderLeft: "3px solid #FF8C00" }}>
              <div style={{ color: "#FF8C00", fontWeight: 700, fontSize: 16, fontFamily: "'Space Mono', monospace" }}>{row.power}</div>
              <div style={{ color: "#ccc", fontSize: 13 }}>\u2248 {row.sqft} sq ft</div>
              <div style={{ color: "#888", fontSize: 12 }}>{row.use}</div>
            </div>
          ))}
        </div>
        <p style={{ color: "#777", fontSize: 11, marginTop: 12, fontStyle: "italic" }}>
          Based on 20% efficient panels, 5 peak sun hours/day, standard residential conditions.
        </p>
      </div>
    </div>
  );
}

function ResultCard({ value, unit, label, sublabel, color }) {
  return (
    <div style={{ padding: "20px", background: `linear-gradient(135deg, ${color}08, ${color}03)`, borderRadius: 12, border: `1px solid ${color}25`, textAlign: "center" }}>
      <div style={{ fontSize: 32, fontWeight: 800, color, fontFamily: "'Space Mono', monospace", lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 13, color: `${color}cc`, marginTop: 2 }}>{unit}</div>
      <div style={{ fontSize: 12, color: "#aaa", marginTop: 8 }}>{label}</div>
      <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{sublabel}</div>
    </div>
  );
}

// ========== SPACE VS EARTH ==========
function SpaceVsEarth() {
  const [selectedMetric, setSelectedMetric] = useState("irradiance");

  const metrics = {
    irradiance: {
      title: "Solar Irradiance", unit: "W/m\u00B2",
      bars: [
        { label: "Space (solar constant)", value: 1361, color: "#FF3B00" },
        { label: "Earth peak (clear noon)", value: 1000, color: "#FFD700" },
        { label: "Earth avg (24hr global)", value: 164, color: "#4FC3F7" },
      ],
      insight: "Space gets 36% more raw power than Earth\u2019s best, and ~8x the global 24-hour average. No clouds, no night (in GEO orbit), no atmosphere absorbing UV and IR."
    },
    efficiency: {
      title: "Panel Efficiency", unit: "%",
      bars: [
        { label: "Space (multi-junction lab)", value: 47, color: "#FF3B00" },
        { label: "Space (current deployed)", value: 32, color: "#FF8C00" },
        { label: "Earth (perovskite lab)", value: 33.5, color: "#FFD700" },
        { label: "Earth (commercial best)", value: 22.5, color: "#4FC3F7" },
      ],
      insight: "Multi-junction gallium arsenide cells in space hit 47% efficiency in the lab. On Earth, the perovskite-silicon tandem record is 33.5%. The gap is closing, but space cells cost 100x more per watt."
    },
    annual_yield: {
      title: "Annual Energy Yield", unit: "kWh/m\u00B2/yr",
      bars: [
        { label: "Geostationary orbit", value: 3500, color: "#FF3B00" },
        { label: "Sahara Desert", value: 2600, color: "#FF8C00" },
        { label: "Arizona, USA", value: 2300, color: "#FFD700" },
        { label: "Global average", value: 1700, color: "#4FC3F7" },
        { label: "UK", value: 1050, color: "#7986CB" },
      ],
      insight: "A square meter in geostationary orbit produces ~3.3x what the same panel in London would. The Sahara gets you 75% of space yield at a fraction of the cost."
    },
    cost: {
      title: "Cost per Delivered Watt", unit: "$/W",
      bars: [
        { label: "Space-based solar (est.)", value: 40000, color: "#FF3B00" },
        { label: "Earth residential", value: 2.5, color: "#4FC3F7" },
        { label: "Earth utility-scale", value: 0.7, color: "#66BB6A" },
      ],
      insight: "The brutal reality: even with 36% more irradiance, getting panels to orbit costs ~$10,000-20,000/kg to launch. Space solar is ~16,000x more expensive per watt than utility-scale on Earth."
    },
  };

  const m = metrics[selectedMetric];
  const maxVal = Math.max(...m.bars.map((b) => b.value));

  return (
    <div style={{ padding: "24px" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 28 }}>
        {Object.entries(metrics).map(([key, val]) => (
          <button key={key} onClick={() => setSelectedMetric(key)} style={{
            padding: "8px 16px", borderRadius: 20,
            border: selectedMetric === key ? "1px solid #FF8C00" : "1px solid rgba(255,255,255,0.1)",
            background: selectedMetric === key ? "rgba(255,140,0,0.15)" : "rgba(255,255,255,0.03)",
            color: selectedMetric === key ? "#FF8C00" : "#999",
            cursor: "pointer", fontSize: 13, fontFamily: "'DM Sans', sans-serif",
            fontWeight: selectedMetric === key ? 600 : 400, transition: "all 0.2s",
          }}>{val.title}</button>
        ))}
      </div>

      <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 16, padding: 28, border: "1px solid rgba(255,255,255,0.05)" }}>
        <h3 style={{ color: "#e0e0e0", fontSize: 20, margin: "0 0 4px", fontFamily: "'DM Sans', sans-serif" }}>{m.title}</h3>
        <span style={{ color: "#666", fontSize: 13 }}>Unit: {m.unit}</span>
        <div style={{ marginTop: 24 }}>
          {m.bars.map((bar, i) => {
            const pct = selectedMetric === "cost"
              ? Math.log10(bar.value + 1) / Math.log10(maxVal + 1) * 100
              : (bar.value / maxVal) * 100;
            return (
              <div key={i} style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, alignItems: "baseline" }}>
                  <span style={{ color: "#ccc", fontSize: 14 }}>{bar.label}</span>
                  <span style={{ color: bar.color, fontFamily: "'Space Mono', monospace", fontWeight: 700, fontSize: 16 }}>
                    {selectedMetric === "cost" && bar.value > 100 ? `$${(bar.value / 1000).toFixed(0)}k` : selectedMetric === "cost" ? `$${bar.value}` : bar.value.toLocaleString()}
                  </span>
                </div>
                <div style={{ height: 12, background: "rgba(255,255,255,0.04)", borderRadius: 6, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: `linear-gradient(90deg, ${bar.color}99, ${bar.color})`, borderRadius: 6, transition: "width 0.6s ease" }} />
                </div>
              </div>
            );
          })}
        </div>
        <p style={{ color: "#999", fontSize: 14, lineHeight: 1.6, marginTop: 20, padding: "16px", background: "rgba(255,255,255,0.02)", borderRadius: 8, borderLeft: "3px solid #FF8C00" }}>{m.insight}</p>
      </div>

      <div style={{ marginTop: 32, background: "rgba(255,255,255,0.02)", borderRadius: 16, padding: 28, border: "1px solid rgba(255,255,255,0.05)" }}>
        <h3 style={{ color: "#e0e0e0", fontSize: 20, margin: "0 0 16px", fontFamily: "'DM Sans', sans-serif" }}>Compute Power: Space vs Earth</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px" }}>
          <CompareCard title="Data Center on Earth" items={[
            { k: "Power available", v: "~200 W/m\u00B2 panel output" },
            { k: "Cooling overhead", v: "30-40% of total power (PUE ~1.3)" },
            { k: "Net compute power", v: "~120-140 W/m\u00B2 equivalent" },
            { k: "Uptime (solar only)", v: "5-6.5 hrs/day peak" },
            { k: "Cost", v: "$0.70/W installed" },
          ]} accent="#4FC3F7" />
          <CompareCard title="Data Center in Orbit" items={[
            { k: "Power available", v: "~435 W/m\u00B2 (32% of 1361)" },
            { k: "Cooling overhead", v: "Radiative only \u2014 no air, ~15%" },
            { k: "Net compute power", v: "~370 W/m\u00B2 equivalent" },
            { k: "Uptime (GEO)", v: "~23.5 hrs/day (eclipses brief)" },
            { k: "Cost", v: "$40,000+/W delivered" },
          ]} accent="#FF8C00" />
        </div>
        <p style={{ color: "#888", fontSize: 13, marginTop: 16, lineHeight: 1.6 }}>
          Space wins on raw energy density (~2.6x more W/m\u00B2) and cooling efficiency (no air resistance, radiate heat directly to cold void). But launch costs make it economically absurd for most compute.
        </p>
      </div>
    </div>
  );
}

function CompareCard({ title, items, accent }) {
  return (
    <div style={{ padding: 20, background: `linear-gradient(135deg, ${accent}06, transparent)`, borderRadius: 12, border: `1px solid ${accent}20` }}>
      <h4 style={{ color: accent, fontSize: 15, margin: "0 0 14px", fontFamily: "'DM Sans', sans-serif", fontWeight: 600 }}>{title}</h4>
      {items.map((item, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: i < items.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
          <span style={{ color: "#999", fontSize: 13 }}>{item.k}</span>
          <span style={{ color: "#ddd", fontSize: 13, fontFamily: "'Space Mono', monospace" }}>{item.v}</span>
        </div>
      ))}
    </div>
  );
}

// ========== PANEL SPECS ==========
function PanelFigures() {
  return (
    <div style={{ padding: "24px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "20px" }}>
        {Object.entries(PANEL_SPECS).map(([key, spec]) => (
          <div key={key} style={{ background: "rgba(255,255,255,0.02)", borderRadius: 16, padding: 24, border: "1px solid rgba(255,255,255,0.06)", transition: "border-color 0.3s" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h3 style={{ color: "#e0e0e0", fontSize: 17, margin: "0 0 4px", fontFamily: "'DM Sans', sans-serif" }}>{spec.name}</h3>
                <span style={{ color: "#888", fontSize: 12 }}>{spec.techType}</span>
              </div>
              <div style={{ padding: "4px 12px", borderRadius: 20, background: key === "space" ? "rgba(255,59,0,0.15)" : "rgba(255,140,0,0.12)", color: key === "space" ? "#FF3B00" : "#FF8C00", fontSize: 13, fontWeight: 700, fontFamily: "'Space Mono', monospace" }}>
                {(spec.efficiency * 100).toFixed(1)}%
              </div>
            </div>
            <div style={{ margin: "16px 0" }}>
              <div style={{ height: 8, background: "rgba(255,255,255,0.04)", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${spec.efficiency * 100 * 2}%`, height: "100%", background: "linear-gradient(90deg, #FF8C00, #FFD700)", borderRadius: 4 }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                <span style={{ color: "#666", fontSize: 10 }}>0%</span>
                <span style={{ color: "#666", fontSize: 10 }}>50%</span>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <StatItem label="Watts/Panel" value={`${spec.wattPerPanel}W`} />
              <StatItem label="Panel Size" value={`${spec.panelArea_sqft} ft\u00B2`} />
              <StatItem label="W per sq ft" value={`${(spec.wattPerPanel / spec.panelArea_sqft).toFixed(1)}`} />
              <StatItem label="Degradation" value={`${(spec.degradation * 100).toFixed(1)}%/yr`} />
              {spec.costPerWatt ? <StatItem label="Cost" value={`$${spec.costPerWatt}/W`} /> : <StatItem label="Cost" value="N/A (lab)" />}
              <StatItem label="25yr output" value={`${((1 - spec.degradation * 12.5) * 100).toFixed(0)}%`} />
            </div>
            <div style={{ marginTop: 14, padding: "10px 12px", background: "rgba(255,255,255,0.02)", borderRadius: 8, fontSize: 12, color: "#999", lineHeight: 1.5 }}>
              {key === "residential" && "The standard rooftop panel. One panel covers about the area of a large desk and powers a few appliances."}
              {key === "premium" && "Top-tier home panels. Slightly more power from the same roof space. Worth it if you have limited area."}
              {key === "commercial" && "Bigger panels for solar farms. Lower cost per watt at scale, but each panel is physically larger."}
              {key === "cuttingEdge" && "Lab record-holder. Not sold yet. Could eventually make a small rooftop produce like a current large array."}
              {key === "space" && "Built to survive cosmic radiation and temperature swings of 290\u00B0C. Costs 100x+ more but there\u2019s no alternative in orbit."}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 32, background: "rgba(255,255,255,0.02)", borderRadius: 16, padding: 28, border: "1px solid rgba(255,255,255,0.05)" }}>
        <h3 style={{ color: "#e0e0e0", fontSize: 18, margin: "0 0 16px", fontFamily: "'DM Sans', sans-serif" }}>What can solar actually power? (Common sense edition)</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px" }}>
          {[
            { thing: "Phone charger", watts: "5W", panels: "0.01", area: "0.2 ft\u00B2", icon: "\uD83D\uDCF1" },
            { thing: "Laptop", watts: "60W", panels: "0.15", area: "2.6 ft\u00B2", icon: "\uD83D\uDCBB" },
            { thing: "Refrigerator", watts: "150W avg", panels: "0.4", area: "6.6 ft\u00B2", icon: "\uD83E\uDDCA" },
            { thing: "Air conditioning (room)", watts: "1,500W", panels: "4", area: "70 ft\u00B2", icon: "\u2744\uFE0F" },
            { thing: "Electric vehicle (daily)", watts: "7,500W", panels: "19", area: "334 ft\u00B2", icon: "\uD83D\uDE97" },
            { thing: "Average US home", watts: "1,200W avg", panels: "20", area: "352 ft\u00B2", icon: "\uD83C\uDFE0" },
            { thing: "Tesla Supercharger (1 stall)", watts: "250,000W", panels: "625", area: "11,000 ft\u00B2", icon: "\u26A1" },
            { thing: "Small data center", watts: "1 MW", panels: "2,500", area: "44,000 ft\u00B2", icon: "\uD83D\uDDA5\uFE0F" },
          ].map((item) => (
            <div key={item.thing} style={{ padding: "14px 16px", background: "rgba(255,255,255,0.02)", borderRadius: 10, borderLeft: "3px solid #FFD700" }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>{item.icon}</div>
              <div style={{ color: "#ddd", fontSize: 14, fontWeight: 600 }}>{item.thing}</div>
              <div style={{ color: "#FF8C00", fontSize: 13, fontFamily: "'Space Mono', monospace", marginTop: 4 }}>{item.watts}</div>
              <div style={{ color: "#888", fontSize: 12, marginTop: 2 }}>{item.panels} panels \u00B7 {item.area}</div>
            </div>
          ))}
        </div>
        <p style={{ color: "#777", fontSize: 11, marginTop: 16, fontStyle: "italic" }}>
          Panel counts assume standard 400W residential panels. Area assumes 17.6 sq ft per panel.
        </p>
      </div>
    </div>
  );
}

function StatItem({ label, value }) {
  return (
    <div>
      <div style={{ color: "#666", fontSize: 11 }}>{label}</div>
      <div style={{ color: "#ddd", fontSize: 15, fontWeight: 600, fontFamily: "'Space Mono', monospace" }}>{value}</div>
    </div>
  );
}

// ========== MAIN EXPORT ==========
export default function SolarDashboard({ activeTab: externalTab, onTabChange: externalOnTabChange }) {
  const [internalTab, setInternalTab] = useState("globe");
  const activeTab = externalTab ?? internalTab;

  return (
    <div style={{ width: "100%", height: "100%", background: "#060b14", color: "#e0e0e0", fontFamily: "'DM Sans', sans-serif" }}>
      {activeTab === "globe" && <GlobePage />}
      {activeTab === "space" && <SpaceVsEarth />}
      {activeTab === "panels" && <PanelFigures />}
      {activeTab === "calculator" && <SolarCalculator />}
    </div>
  );
}
