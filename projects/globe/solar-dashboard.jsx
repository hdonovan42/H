import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as THREE from "three";

// ============================================================
// CLAUDE BACKEND — Solar Energy Intelligence Dashboard
// ============================================================
// INTEGRATION WITH GEMINI FRONTEND:
// This component exposes all data and state via props/callbacks.
// Gemini's frontend should:
//   1. Import this component or consume its data API
//   2. The globe, charts, and calculator are self-contained
//   3. Wrap in Gemini's layout/navigation shell
//   4. Connect Gemini's routing to the tab system via setActiveTab prop
//
// Data contract (what this component provides):
//   - SOLAR_DATA: Array of {lat, lng, ghi, region, country, yield_kwh}
//   - PANEL_SPECS: Object with efficiency tiers and calculations
//   - SPACE_VS_EARTH: Comparative metrics for the efficiency page
//   - Globe component with interactive 3D blocks
//   - Calculator functions for sq ft → power output
//
// To integrate:
//   <SolarDashboard
//     onDataReady={(data) => geminiState.setSolarData(data)}
//     activeTab={geminiRouter.currentTab}
//     theme={geminiTheme}
//   />
// ============================================================

// === REAL SOLAR IRRADIANCE DATA ===
// Source: Global Solar Atlas (Solargis/World Bank), NREL, NASA
// GHI values in kWh/m²/year — annual average
const SOLAR_REGIONS = [
  // Africa & Middle East — highest yields globally
  { lat: 23.5, lng: 25.0, ghi: 2600, region: "Sahara Desert", country: "Egypt/Libya", tier: "S" },
  { lat: 24.0, lng: 45.0, ghi: 2500, region: "Arabian Peninsula", country: "Saudi Arabia", tier: "S" },
  { lat: -22.5, lng: 17.0, ghi: 2450, region: "Namib Desert", country: "Namibia", tier: "S" },
  { lat: 32.0, lng: 6.0, ghi: 2300, region: "Algerian Sahara", country: "Algeria", tier: "A" },
  { lat: -25.0, lng: 28.0, ghi: 2200, region: "Highveld", country: "South Africa", tier: "A" },
  { lat: 15.0, lng: 40.0, ghi: 2400, region: "Horn of Africa", country: "Ethiopia/Eritrea", tier: "S" },
  { lat: 27.0, lng: 31.0, ghi: 2350, region: "Upper Egypt", country: "Egypt", tier: "A" },

  // Americas
  { lat: 33.5, lng: -112.0, ghi: 2350, region: "Sonoran Desert", country: "USA (Arizona)", tier: "A" },
  { lat: 36.0, lng: -115.0, ghi: 2300, region: "Mojave Desert", country: "USA (Nevada)", tier: "A" },
  { lat: -24.0, lng: -68.0, ghi: 2550, region: "Atacama Desert", country: "Chile", tier: "S" },
  { lat: 24.0, lng: -110.0, ghi: 2200, region: "Baja California", country: "Mexico", tier: "A" },
  { lat: -15.0, lng: -45.0, ghi: 2100, region: "Minas Gerais", country: "Brazil", tier: "A" },
  { lat: 35.0, lng: -106.0, ghi: 2200, region: "New Mexico", country: "USA", tier: "A" },
  { lat: 40.0, lng: -74.0, ghi: 1500, region: "Northeast US", country: "USA (New York)", tier: "C" },
  { lat: 47.6, lng: -122.3, ghi: 1250, region: "Pacific Northwest", country: "USA (Seattle)", tier: "D" },

  // Asia & Oceania
  { lat: 26.0, lng: 71.0, ghi: 2200, region: "Thar Desert", country: "India", tier: "A" },
  { lat: 40.0, lng: 95.0, ghi: 2000, region: "Gobi Desert", country: "China", tier: "B" },
  { lat: -25.0, lng: 134.0, ghi: 2300, region: "Central Australia", country: "Australia", tier: "A" },
  { lat: 35.0, lng: 137.0, ghi: 1400, region: "Honshu", country: "Japan", tier: "C" },
  { lat: 36.0, lng: 128.0, ghi: 1350, region: "Central Korea", country: "South Korea", tier: "C" },
  { lat: 22.5, lng: 114.0, ghi: 1300, region: "Pearl River Delta", country: "China (Guangdong)", tier: "C" },

  // Europe
  { lat: 37.0, lng: -4.0, ghi: 2000, region: "Andalusia", country: "Spain", tier: "B" },
  { lat: 38.0, lng: 23.7, ghi: 1900, region: "Attica", country: "Greece", tier: "B" },
  { lat: 37.5, lng: 15.0, ghi: 1950, region: "Sicily", country: "Italy", tier: "B" },
  { lat: 48.8, lng: 2.3, ghi: 1200, region: "Île-de-France", country: "France (Paris)", tier: "D" },
  { lat: 51.5, lng: -0.1, ghi: 1050, region: "Southeast England", country: "UK (London)", tier: "D" },
  { lat: 52.5, lng: 13.4, ghi: 1100, region: "Brandenburg", country: "Germany (Berlin)", tier: "D" },
  { lat: 48.1, lng: 11.6, ghi: 1200, region: "Bavaria", country: "Germany (Munich)", tier: "D" },
  { lat: 59.3, lng: 18.0, ghi: 950, region: "Stockholm Region", country: "Sweden", tier: "D" },
  { lat: 60.2, lng: 25.0, ghi: 900, region: "Uusimaa", country: "Finland", tier: "D" },

  // Additional high-yield locations
  { lat: 29.0, lng: -13.6, ghi: 2150, region: "Canary Islands", country: "Spain", tier: "A" },
  { lat: 31.0, lng: 35.0, ghi: 2300, region: "Negev Desert", country: "Israel", tier: "A" },
  { lat: -20.0, lng: 57.5, ghi: 1800, region: "Mauritius", country: "Mauritius", tier: "B" },
  { lat: 1.3, lng: 103.8, ghi: 1650, region: "Singapore", country: "Singapore", tier: "C" },
  { lat: -33.9, lng: 18.4, ghi: 2000, region: "Cape Town", country: "South Africa", tier: "B" },
];

// === PANEL SPECIFICATIONS ===
// Source: NREL Best Research-Cell Efficiency Chart (2024), manufacturer datasheets
const PANEL_SPECS = {
  residential: {
    name: "Standard Residential",
    efficiency: 0.20,
    wattPerPanel: 400,
    panelArea_sqft: 17.6, // ~1.64 m²
    costPerWatt: 2.50,
    degradation: 0.005, // 0.5% per year
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
    panelArea_sqft: 24.0, // ~2.2 m²
    costPerWatt: 1.80,
    degradation: 0.005,
    techType: "Bifacial PERC",
  },
  cuttingEdge: {
    name: "Perovskite-Tandem (Lab)",
    efficiency: 0.335,
    wattPerPanel: 600,
    panelArea_sqft: 17.6,
    costPerWatt: null, // not commercially available
    degradation: 0.02, // still high
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

// === SPACE vs EARTH DATA ===
const SPACE_EARTH = {
  irradiance: { space: 1361, earth_peak: 1000, earth_avg: 164 },
  hoursPerDay: { space_geo: 24, space_leo: 16, earth_best: 6.5, earth_avg: 4.5 },
  efficiency: { space_current: 0.32, space_lab: 0.47, earth_current: 0.225, earth_lab: 0.335 },
  temperature: { space_sun: 120, space_shadow: -170, earth_optimal: 25, earth_hot: 65 },
  atmosphere: { absorption_pct: 23, scattering_pct: 8, cloud_loss_pct: 20 },
  costPerWatt: { space: 40000, earth_utility: 0.70, earth_residential: 2.50 },
  annualYield_kwh_per_m2: { space_geo: 3500, earth_sahara: 2600, earth_uk: 1050, earth_global_avg: 1700 },
};

// === TIER COLOR MAPPING ===
const TIER_COLORS = {
  S: { bg: "#FF3B00", glow: "#FF6B3B", label: "Exceptional" },
  A: { bg: "#FF8C00", glow: "#FFB347", label: "Excellent" },
  B: { bg: "#FFD700", glow: "#FFEC8B", label: "Good" },
  C: { bg: "#4FC3F7", glow: "#81D4FA", label: "Moderate" },
  D: { bg: "#7986CB", glow: "#9FA8DA", label: "Low" },
};

// ========== 3D GLOBE COMPONENT ==========
function SolarGlobe({ data, hoveredRegion, setHoveredRegion }) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const globeRef = useRef(null);
  const blocksRef = useRef([]);
  const frameRef = useRef(null);
  const mouseRef = useRef({ x: 0, y: 0, isDown: false, prevX: 0, prevY: 0 });
  const rotationRef = useRef({ x: 0.3, y: 0 });
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseVec = useRef(new THREE.Vector2());

  useEffect(() => {
    if (!mountRef.current) return;

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.z = 3.5;
    cameraRef.current = camera;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0x404050, 0.6);
    scene.add(ambientLight);
    const sunLight = new THREE.DirectionalLight(0xfff5e0, 1.4);
    sunLight.position.set(5, 3, 5);
    scene.add(sunLight);
    const rimLight = new THREE.DirectionalLight(0x4488ff, 0.3);
    rimLight.position.set(-3, -1, -3);
    scene.add(rimLight);

    // Globe — wireframe sphere
    const globeGeo = new THREE.SphereGeometry(1, 48, 48);
    const globeMat = new THREE.MeshPhongMaterial({
      color: 0x0a1628,
      transparent: true,
      opacity: 0.85,
      shininess: 30,
    });
    const globe = new THREE.Mesh(globeGeo, globeMat);
    scene.add(globe);
    globeRef.current = globe;

    // Wireframe overlay
    const wireGeo = new THREE.SphereGeometry(1.003, 36, 36);
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0x1a3a5c,
      wireframe: true,
      transparent: true,
      opacity: 0.15,
    });
    scene.add(new THREE.Mesh(wireGeo, wireMat));

    // Atmosphere glow
    const atmosGeo = new THREE.SphereGeometry(1.06, 48, 48);
    const atmosMat = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        void main() {
          float intensity = pow(0.65 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.5);
          gl_FragColor = vec4(0.2, 0.5, 1.0, intensity * 0.4);
        }
      `,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true,
    });
    scene.add(new THREE.Mesh(atmosGeo, atmosMat));

    // Data blocks
    const blocks = [];
    data.forEach((point) => {
      const phi = (90 - point.lat) * (Math.PI / 180);
      const theta = (point.lng + 180) * (Math.PI / 180);

      // Block height proportional to GHI
      const maxGhi = 2600;
      const minGhi = 900;
      const normalized = (point.ghi - minGhi) / (maxGhi - minGhi);
      const blockHeight = 0.02 + normalized * 0.18;

      const blockGeo = new THREE.BoxGeometry(0.04, blockHeight, 0.04);
      const tierColor = TIER_COLORS[point.tier];
      const blockMat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(tierColor.bg),
        emissive: new THREE.Color(tierColor.bg),
        emissiveIntensity: 0.3,
        shininess: 80,
      });

      const block = new THREE.Mesh(blockGeo, blockMat);

      // Position on sphere surface
      const surfaceR = 1.01;
      const x = surfaceR * Math.sin(phi) * Math.cos(theta);
      const y = surfaceR * Math.cos(phi);
      const z = surfaceR * Math.sin(phi) * Math.sin(theta);

      block.position.set(x, y, z);
      block.lookAt(0, 0, 0);
      block.rotateX(Math.PI / 2);
      // Push block outward by half its height
      const dir = new THREE.Vector3(x, y, z).normalize();
      block.position.add(dir.multiplyScalar(blockHeight / 2));

      block.userData = point;
      scene.add(block);
      blocks.push(block);
    });
    blocksRef.current = blocks;

    // Mouse handling
    const handleMouseDown = (e) => {
      mouseRef.current.isDown = true;
      mouseRef.current.prevX = e.clientX;
      mouseRef.current.prevY = e.clientY;
    };
    const handleMouseUp = () => { mouseRef.current.isDown = false; };
    const handleMouseMove = (e) => {
      const rect = mountRef.current.getBoundingClientRect();
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;
      mouseVec.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseVec.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      if (mouseRef.current.isDown) {
        const dx = e.clientX - mouseRef.current.prevX;
        const dy = e.clientY - mouseRef.current.prevY;
        rotationRef.current.y += dx * 0.005;
        rotationRef.current.x += dy * 0.005;
        rotationRef.current.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotationRef.current.x));
        mouseRef.current.prevX = e.clientX;
        mouseRef.current.prevY = e.clientY;
      }
    };

    const el = renderer.domElement;
    el.addEventListener("mousedown", handleMouseDown);
    el.addEventListener("mouseup", handleMouseUp);
    el.addEventListener("mousemove", handleMouseMove);
    el.addEventListener("mouseleave", handleMouseUp);

    // Touch support
    const handleTouchStart = (e) => {
      if (e.touches.length === 1) {
        mouseRef.current.isDown = true;
        mouseRef.current.prevX = e.touches[0].clientX;
        mouseRef.current.prevY = e.touches[0].clientY;
      }
    };
    const handleTouchMove = (e) => {
      if (e.touches.length === 1 && mouseRef.current.isDown) {
        const dx = e.touches[0].clientX - mouseRef.current.prevX;
        const dy = e.touches[0].clientY - mouseRef.current.prevY;
        rotationRef.current.y += dx * 0.005;
        rotationRef.current.x += dy * 0.005;
        rotationRef.current.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotationRef.current.x));
        mouseRef.current.prevX = e.touches[0].clientX;
        mouseRef.current.prevY = e.touches[0].clientY;
      }
    };
    const handleTouchEnd = () => { mouseRef.current.isDown = false; };

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: true });
    el.addEventListener("touchend", handleTouchEnd);

    // Animation loop
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);

      if (!mouseRef.current.isDown) {
        rotationRef.current.y += 0.002;
      }

      globe.rotation.x = rotationRef.current.x;
      globe.rotation.y = rotationRef.current.y;

      // Rotate all children with globe
      scene.children.forEach((child) => {
        if (child !== globe && child.type === "Mesh" && child.userData.ghi) {
          // blocks don't auto-rotate; they're in world space
        }
      });

      // Apply rotation to block group
      blocks.forEach((b) => {
        // We need a parent group approach
      });

      // Raycast for hover
      raycasterRef.current.setFromCamera(mouseVec.current, camera);
      const intersects = raycasterRef.current.intersectObjects(blocks);
      if (intersects.length > 0) {
        const hit = intersects[0].object;
        setHoveredRegion(hit.userData);
        el.style.cursor = "pointer";
      } else {
        if (!mouseRef.current.isDown) {
          setHoveredRegion(null);
          el.style.cursor = "grab";
        }
      }

      renderer.render(scene, camera);
    };

    // Actually, let's use a group for rotation
    const globeGroup = new THREE.Group();
    scene.remove(globe);
    scene.children.filter(c => c.type === "Mesh" && !c.material.vertexShader).forEach(c => {
      if (c.userData.ghi || c === globe || c.material.wireframe) {
        scene.remove(c);
        globeGroup.add(c);
      }
    });
    // Re-add everything to group
    globeGroup.add(globe);
    blocks.forEach(b => {
      scene.remove(b);
      globeGroup.add(b);
    });
    // Add wireframe
    scene.children.filter(c => c.material && c.material.wireframe).forEach(c => {
      scene.remove(c);
      globeGroup.add(c);
    });
    scene.add(globeGroup);

    // Fix animation to rotate group
    cancelAnimationFrame(frameRef.current);
    const animate2 = () => {
      frameRef.current = requestAnimationFrame(animate2);
      if (!mouseRef.current.isDown) rotationRef.current.y += 0.002;
      globeGroup.rotation.x = rotationRef.current.x;
      globeGroup.rotation.y = rotationRef.current.y;

      raycasterRef.current.setFromCamera(mouseVec.current, camera);
      const hits = raycasterRef.current.intersectObjects(blocks);

      blocks.forEach((b) => {
        b.material.emissiveIntensity = 0.3;
        b.scale.set(1, 1, 1);
      });

      if (hits.length > 0) {
        const hit = hits[0].object;
        hit.material.emissiveIntensity = 0.9;
        hit.scale.set(1.3, 1.3, 1.3);
        setHoveredRegion(hit.userData);
        el.style.cursor = "pointer";
      } else {
        if (!mouseRef.current.isDown) {
          setHoveredRegion(null);
          el.style.cursor = "grab";
        }
      }

      renderer.render(scene, camera);
    };
    animate2();

    // Resize
    const onResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("resize", onResize);
      el.removeEventListener("mousedown", handleMouseDown);
      el.removeEventListener("mouseup", handleMouseUp);
      el.removeEventListener("mousemove", handleMouseMove);
      el.removeEventListener("mouseleave", handleMouseUp);
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
      if (mountRef.current && renderer.domElement.parentNode === mountRef.current) {
        mountRef.current.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, [data]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%", cursor: "grab" }} />;
}

// ========== CALCULATOR COMPONENT ==========
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
  const co2Saved = annualKwh * 0.42; // kg CO2 per kWh from grid avg
  const homesEquiv = annualKwh / 10500; // US avg household use

  const regionSunHours = {
    earth_sahara: 6.5,
    earth_arizona: 6.2,
    earth_spain: 5.2,
    earth_uk: 2.8,
    earth_germany: 3.0,
    space_geo: 24,
    space_leo: 16,
  };

  useEffect(() => {
    setSunHours(regionSunHours[region] || 5);
  }, [region]);

  return (
    <div style={{ padding: "24px" }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: "16px",
        marginBottom: "32px",
      }}>
        {/* Area Input */}
        <div style={inputGroupStyle}>
          <label style={labelStyle}>Panel Area (sq ft)</label>
          <input
            type="range"
            min={100}
            max={50000}
            step={100}
            value={sqft}
            onChange={(e) => setSqft(Number(e.target.value))}
            style={sliderStyle}
          />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            <span style={dimText}>{sqft.toLocaleString()} sq ft</span>
            <span style={dimText}>{sqm.toFixed(0)} m²</span>
          </div>
        </div>

        {/* Panel Type */}
        <div style={inputGroupStyle}>
          <label style={labelStyle}>Panel Technology</label>
          <select
            value={panelType}
            onChange={(e) => setPanelType(e.target.value)}
            style={selectStyle}
          >
            <option value="residential">Standard (20% eff.)</option>
            <option value="premium">Premium (22.5% eff.)</option>
            <option value="commercial">Utility-Scale (21% eff.)</option>
            <option value="cuttingEdge">Perovskite Lab (33.5% eff.)</option>
            <option value="space">Space-Grade GaAs (32% eff.)</option>
          </select>
        </div>

        {/* Location */}
        <div style={inputGroupStyle}>
          <label style={labelStyle}>Location</label>
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            style={selectStyle}
          >
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

      {/* Results */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: "16px",
      }}>
        <ResultCard
          value={panelCount}
          unit="panels"
          label="Panel Count"
          sublabel={`${spec.panelArea_sqft} sq ft each`}
          color="#FF8C00"
        />
        <ResultCard
          value={`${(totalWatts / 1000).toFixed(1)}`}
          unit="kW"
          label="Peak Capacity"
          sublabel={`${totalWatts.toLocaleString()} watts`}
          color="#FFD700"
        />
        <ResultCard
          value={dailyKwh.toFixed(1)}
          unit="kWh/day"
          label="Daily Output"
          sublabel={`${sunHours} sun hours`}
          color="#4FC3F7"
        />
        <ResultCard
          value={annualMwh < 1 ? annualKwh.toFixed(0) : annualMwh.toFixed(1)}
          unit={annualMwh < 1 ? "kWh/yr" : "MWh/yr"}
          label="Annual Energy"
          sublabel={`≈ ${homesEquiv.toFixed(1)} US homes`}
          color="#66BB6A"
        />
        <ResultCard
          value={`${(co2Saved / 1000).toFixed(1)}`}
          unit="tonnes CO₂/yr"
          label="Carbon Offset"
          sublabel="vs. grid average"
          color="#26A69A"
        />
        {spec.costPerWatt && (
          <ResultCard
            value={`$${((totalWatts * spec.costPerWatt) / 1000).toFixed(0)}k`}
            unit=""
            label="Estimated Cost"
            sublabel={`$${spec.costPerWatt}/W installed`}
            color="#AB47BC"
          />
        )}
      </div>

      {/* Common sense reference */}
      <div style={{
        marginTop: 32,
        padding: "20px 24px",
        background: "rgba(255,255,255,0.03)",
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.06)",
      }}>
        <h4 style={{ color: "#e0e0e0", margin: "0 0 12px", fontSize: 14, fontFamily: "'DM Sans', sans-serif", letterSpacing: "0.03em" }}>
          QUICK REFERENCE — How much space do you need?
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
            <div key={row.power} style={{
              padding: "10px 14px",
              background: "rgba(255,140,0,0.06)",
              borderRadius: 8,
              borderLeft: "3px solid #FF8C00",
            }}>
              <div style={{ color: "#FF8C00", fontWeight: 700, fontSize: 16, fontFamily: "'Space Mono', monospace" }}>{row.power}</div>
              <div style={{ color: "#ccc", fontSize: 13 }}>≈ {row.sqft} sq ft</div>
              <div style={{ color: "#888", fontSize: 12 }}>{row.use}</div>
            </div>
          ))}
        </div>
        <p style={{ color: "#777", fontSize: 11, marginTop: 12, fontStyle: "italic" }}>
          Based on 20% efficient panels, 5 peak sun hours/day, standard residential conditions.
          Actual results vary by location, tilt, shading, and weather.
        </p>
      </div>
    </div>
  );
}

function ResultCard({ value, unit, label, sublabel, color }) {
  return (
    <div style={{
      padding: "20px",
      background: `linear-gradient(135deg, ${color}08, ${color}03)`,
      borderRadius: 12,
      border: `1px solid ${color}25`,
      textAlign: "center",
    }}>
      <div style={{ fontSize: 32, fontWeight: 800, color, fontFamily: "'Space Mono', monospace", lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 13, color: `${color}cc`, marginTop: 2 }}>{unit}</div>
      <div style={{ fontSize: 12, color: "#aaa", marginTop: 8 }}>{label}</div>
      <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{sublabel}</div>
    </div>
  );
}

// ========== SPACE VS EARTH PAGE ==========
function SpaceVsEarth() {
  const [selectedMetric, setSelectedMetric] = useState("irradiance");

  const metrics = {
    irradiance: {
      title: "Solar Irradiance",
      unit: "W/m²",
      bars: [
        { label: "Space (solar constant)", value: 1361, color: "#FF3B00" },
        { label: "Earth peak (clear noon)", value: 1000, color: "#FFD700" },
        { label: "Earth avg (24hr global)", value: 164, color: "#4FC3F7" },
      ],
      insight: "Space gets 36% more raw power than Earth's best, and ~8x the global 24-hour average. No clouds, no night (in GEO orbit), no atmosphere absorbing UV and IR."
    },
    efficiency: {
      title: "Panel Efficiency",
      unit: "%",
      bars: [
        { label: "Space (multi-junction lab)", value: 47, color: "#FF3B00" },
        { label: "Space (current deployed)", value: 32, color: "#FF8C00" },
        { label: "Earth (perovskite lab)", value: 33.5, color: "#FFD700" },
        { label: "Earth (commercial best)", value: 22.5, color: "#4FC3F7" },
      ],
      insight: "Multi-junction gallium arsenide cells in space hit 47% efficiency in the lab. On Earth, the perovskite-silicon tandem record is 33.5%. The gap is closing, but space cells cost 100x more per watt."
    },
    annual_yield: {
      title: "Annual Energy Yield",
      unit: "kWh/m²/yr",
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
      title: "Cost per Delivered Watt",
      unit: "$/W",
      bars: [
        { label: "Space-based solar (est.)", value: 40000, color: "#FF3B00" },
        { label: "Earth residential", value: 2.5, color: "#4FC3F7" },
        { label: "Earth utility-scale", value: 0.7, color: "#66BB6A" },
      ],
      insight: "The brutal reality: even with 36% more irradiance, getting panels to orbit costs ~$10,000-20,000/kg to launch. Space solar is ~16,000x more expensive per watt than utility-scale on Earth. It only makes sense for satellites that have no alternative."
    },
  };

  const m = metrics[selectedMetric];
  const maxVal = Math.max(...m.bars.map((b) => b.value));

  return (
    <div style={{ padding: "24px" }}>
      {/* Metric selector */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 28 }}>
        {Object.entries(metrics).map(([key, val]) => (
          <button
            key={key}
            onClick={() => setSelectedMetric(key)}
            style={{
              padding: "8px 16px",
              borderRadius: 20,
              border: selectedMetric === key ? "1px solid #FF8C00" : "1px solid rgba(255,255,255,0.1)",
              background: selectedMetric === key ? "rgba(255,140,0,0.15)" : "rgba(255,255,255,0.03)",
              color: selectedMetric === key ? "#FF8C00" : "#999",
              cursor: "pointer",
              fontSize: 13,
              fontFamily: "'DM Sans', sans-serif",
              fontWeight: selectedMetric === key ? 600 : 400,
              transition: "all 0.2s",
            }}
          >
            {val.title}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div style={{
        background: "rgba(255,255,255,0.02)",
        borderRadius: 16,
        padding: 28,
        border: "1px solid rgba(255,255,255,0.05)",
      }}>
        <h3 style={{
          color: "#e0e0e0",
          fontSize: 20,
          margin: "0 0 4px",
          fontFamily: "'DM Sans', sans-serif",
        }}>{m.title}</h3>
        <span style={{ color: "#666", fontSize: 13 }}>Unit: {m.unit}</span>

        <div style={{ marginTop: 24 }}>
          {m.bars.map((bar, i) => {
            const pct = selectedMetric === "cost"
              ? Math.log10(bar.value + 1) / Math.log10(maxVal + 1) * 100
              : (bar.value / maxVal) * 100;
            return (
              <div key={i} style={{ marginBottom: 16 }}>
                <div style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 6,
                  alignItems: "baseline",
                }}>
                  <span style={{ color: "#ccc", fontSize: 14 }}>{bar.label}</span>
                  <span style={{
                    color: bar.color,
                    fontFamily: "'Space Mono', monospace",
                    fontWeight: 700,
                    fontSize: 16,
                  }}>
                    {selectedMetric === "cost" && bar.value > 100
                      ? `$${(bar.value / 1000).toFixed(0)}k`
                      : selectedMetric === "cost"
                        ? `$${bar.value}`
                        : bar.value.toLocaleString()
                    }
                  </span>
                </div>
                <div style={{
                  height: 12,
                  background: "rgba(255,255,255,0.04)",
                  borderRadius: 6,
                  overflow: "hidden",
                }}>
                  <div
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      background: `linear-gradient(90deg, ${bar.color}99, ${bar.color})`,
                      borderRadius: 6,
                      transition: "width 0.6s ease",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <p style={{
          color: "#999",
          fontSize: 14,
          lineHeight: 1.6,
          marginTop: 20,
          padding: "16px",
          background: "rgba(255,255,255,0.02)",
          borderRadius: 8,
          borderLeft: "3px solid #FF8C00",
        }}>
          {m.insight}
        </p>
      </div>

      {/* Space compute efficiency section */}
      <div style={{
        marginTop: 32,
        background: "rgba(255,255,255,0.02)",
        borderRadius: 16,
        padding: 28,
        border: "1px solid rgba(255,255,255,0.05)",
      }}>
        <h3 style={{
          color: "#e0e0e0",
          fontSize: 20,
          margin: "0 0 16px",
          fontFamily: "'DM Sans', sans-serif",
        }}>Compute Power: Space vs Earth</h3>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: "16px",
        }}>
          <CompareCard
            title="Data Center on Earth"
            items={[
              { k: "Power available", v: "~200 W/m² panel output" },
              { k: "Cooling overhead", v: "30-40% of total power (PUE ~1.3)" },
              { k: "Net compute power", v: "~120-140 W/m² equivalent" },
              { k: "Uptime (solar only)", v: "5-6.5 hrs/day peak" },
              { k: "Cost", v: "$0.70/W installed" },
            ]}
            accent="#4FC3F7"
          />
          <CompareCard
            title="Data Center in Orbit"
            items={[
              { k: "Power available", v: "~435 W/m² (32% of 1361)" },
              { k: "Cooling overhead", v: "Radiative only — no air, ~15%" },
              { k: "Net compute power", v: "~370 W/m² equivalent" },
              { k: "Uptime (GEO)", v: "~23.5 hrs/day (eclipses brief)" },
              { k: "Cost", v: "$40,000+/W delivered" },
            ]}
            accent="#FF8C00"
          />
        </div>

        <p style={{ color: "#888", fontSize: 13, marginTop: 16, lineHeight: 1.6 }}>
          Space wins on raw energy density (~2.6x more W/m²) and cooling efficiency
          (no air resistance, radiate heat directly to cold void). But launch costs make
          it economically absurd for most compute. The only current use case: powering
          satellites that are already there. Future exception: if manufacturing moves
          to space (asteroid mining, Lunar factories), local solar becomes the obvious choice.
        </p>
      </div>
    </div>
  );
}

function CompareCard({ title, items, accent }) {
  return (
    <div style={{
      padding: 20,
      background: `linear-gradient(135deg, ${accent}06, transparent)`,
      borderRadius: 12,
      border: `1px solid ${accent}20`,
    }}>
      <h4 style={{
        color: accent,
        fontSize: 15,
        margin: "0 0 14px",
        fontFamily: "'DM Sans', sans-serif",
        fontWeight: 600,
      }}>{title}</h4>
      {items.map((item, i) => (
        <div key={i} style={{
          display: "flex",
          justifyContent: "space-between",
          padding: "6px 0",
          borderBottom: i < items.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
        }}>
          <span style={{ color: "#999", fontSize: 13 }}>{item.k}</span>
          <span style={{ color: "#ddd", fontSize: 13, fontFamily: "'Space Mono', monospace" }}>{item.v}</span>
        </div>
      ))}
    </div>
  );
}

// ========== PANEL SPECS PAGE ==========
function PanelFigures() {
  return (
    <div style={{ padding: "24px" }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
        gap: "20px",
      }}>
        {Object.entries(PANEL_SPECS).map(([key, spec]) => (
          <div key={key} style={{
            background: "rgba(255,255,255,0.02)",
            borderRadius: 16,
            padding: 24,
            border: "1px solid rgba(255,255,255,0.06)",
            transition: "border-color 0.3s",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h3 style={{
                  color: "#e0e0e0",
                  fontSize: 17,
                  margin: "0 0 4px",
                  fontFamily: "'DM Sans', sans-serif",
                }}>{spec.name}</h3>
                <span style={{ color: "#888", fontSize: 12 }}>{spec.techType}</span>
              </div>
              <div style={{
                padding: "4px 12px",
                borderRadius: 20,
                background: key === "space" ? "rgba(255,59,0,0.15)" : "rgba(255,140,0,0.12)",
                color: key === "space" ? "#FF3B00" : "#FF8C00",
                fontSize: 13,
                fontWeight: 700,
                fontFamily: "'Space Mono', monospace",
              }}>
                {(spec.efficiency * 100).toFixed(1)}%
              </div>
            </div>

            {/* Efficiency bar */}
            <div style={{ margin: "16px 0" }}>
              <div style={{
                height: 8,
                background: "rgba(255,255,255,0.04)",
                borderRadius: 4,
                overflow: "hidden",
              }}>
                <div style={{
                  width: `${spec.efficiency * 100 * 2}%`,
                  height: "100%",
                  background: `linear-gradient(90deg, #FF8C00, #FFD700)`,
                  borderRadius: 4,
                }} />
              </div>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 4,
              }}>
                <span style={{ color: "#666", fontSize: 10 }}>0%</span>
                <span style={{ color: "#666", fontSize: 10 }}>50%</span>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <StatItem label="Watts/Panel" value={`${spec.wattPerPanel}W`} />
              <StatItem label="Panel Size" value={`${spec.panelArea_sqft} ft²`} />
              <StatItem label="W per sq ft" value={`${(spec.wattPerPanel / spec.panelArea_sqft).toFixed(1)}`} />
              <StatItem label="Degradation" value={`${(spec.degradation * 100).toFixed(1)}%/yr`} />
              {spec.costPerWatt && (
                <StatItem label="Cost" value={`$${spec.costPerWatt}/W`} />
              )}
              {!spec.costPerWatt && (
                <StatItem label="Cost" value="N/A (lab)" />
              )}
              <StatItem
                label="25yr output"
                value={`${((1 - spec.degradation * 12.5) * 100).toFixed(0)}%`}
              />
            </div>

            {/* Plain English explanation */}
            <div style={{
              marginTop: 14,
              padding: "10px 12px",
              background: "rgba(255,255,255,0.02)",
              borderRadius: 8,
              fontSize: 12,
              color: "#999",
              lineHeight: 1.5,
            }}>
              {key === "residential" && "The standard rooftop panel. One panel covers about the area of a large desk and powers a few appliances."}
              {key === "premium" && "Top-tier home panels. Slightly more power from the same roof space. Worth it if you have limited area."}
              {key === "commercial" && "Bigger panels for solar farms. Lower cost per watt at scale, but each panel is physically larger."}
              {key === "cuttingEdge" && "Lab record-holder. Not sold yet. Could eventually make a small rooftop produce like a current large array."}
              {key === "space" && "Built to survive cosmic radiation and temperature swings of 290°C. Costs 100x+ more but there's no alternative in orbit."}
            </div>
          </div>
        ))}
      </div>

      {/* Human-scale reference */}
      <div style={{
        marginTop: 32,
        background: "rgba(255,255,255,0.02)",
        borderRadius: 16,
        padding: 28,
        border: "1px solid rgba(255,255,255,0.05)",
      }}>
        <h3 style={{
          color: "#e0e0e0",
          fontSize: 18,
          margin: "0 0 16px",
          fontFamily: "'DM Sans', sans-serif",
        }}>What can solar actually power? (Common sense edition)</h3>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "14px",
        }}>
          {[
            { thing: "Phone charger", watts: "5W", panels: "0.01", area: "0.2 ft²", icon: "📱" },
            { thing: "Laptop", watts: "60W", panels: "0.15", area: "2.6 ft²", icon: "💻" },
            { thing: "Refrigerator", watts: "150W avg", panels: "0.4", area: "6.6 ft²", icon: "🧊" },
            { thing: "Air conditioning (room)", watts: "1,500W", panels: "4", area: "70 ft²", icon: "❄️" },
            { thing: "Electric vehicle (daily)", watts: "7,500W", panels: "19", area: "334 ft²", icon: "🚗" },
            { thing: "Average US home", watts: "1,200W avg", panels: "20", area: "352 ft²", icon: "🏠" },
            { thing: "Tesla Supercharger (1 stall)", watts: "250,000W", panels: "625", area: "11,000 ft²", icon: "⚡" },
            { thing: "Small data center", watts: "1 MW", panels: "2,500", area: "44,000 ft²", icon: "🖥️" },
          ].map((item) => (
            <div key={item.thing} style={{
              padding: "14px 16px",
              background: "rgba(255,255,255,0.02)",
              borderRadius: 10,
              borderLeft: "3px solid #FFD700",
            }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>{item.icon}</div>
              <div style={{ color: "#ddd", fontSize: 14, fontWeight: 600 }}>{item.thing}</div>
              <div style={{ color: "#FF8C00", fontSize: 13, fontFamily: "'Space Mono', monospace", marginTop: 4 }}>
                {item.watts}
              </div>
              <div style={{ color: "#888", fontSize: 12, marginTop: 2 }}>
                {item.panels} panels · {item.area}
              </div>
            </div>
          ))}
        </div>

        <p style={{ color: "#777", fontSize: 11, marginTop: 16, fontStyle: "italic" }}>
          Panel counts assume standard 400W residential panels. Area assumes 17.6 sq ft per panel.
          "Average watts" means average draw over 24 hours, accounting for duty cycles.
          Source: NREL, EIA.
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

// ========== MAIN DASHBOARD ==========
const TABS = [
  { id: "globe", label: "Solar Map", icon: "◉" },
  { id: "space", label: "Space vs Earth", icon: "◈" },
  { id: "panels", label: "Panel Specs", icon: "⬡" },
  { id: "calculator", label: "Calculator", icon: "⊞" },
];

// Styles
const inputGroupStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const labelStyle = {
  color: "#999",
  fontSize: 12,
  fontFamily: "'DM Sans', sans-serif",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
};
const sliderStyle = {
  width: "100%",
  accentColor: "#FF8C00",
  cursor: "pointer",
};
const selectStyle = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.04)",
  color: "#ddd",
  fontSize: 14,
  fontFamily: "'DM Sans', sans-serif",
  cursor: "pointer",
  outline: "none",
};
const dimText = { color: "#888", fontSize: 13, fontFamily: "'Space Mono', monospace" };

export default function SolarDashboard() {
  const [activeTab, setActiveTab] = useState("globe");
  const [hoveredRegion, setHoveredRegion] = useState(null);

  // Sort data by GHI for the sidebar ranking
  const sortedData = useMemo(() =>
    [...SOLAR_REGIONS].sort((a, b) => b.ghi - a.ghi),
    []
  );

  return (
    <div style={{
      minHeight: "100vh",
      background: "#060b14",
      color: "#e0e0e0",
      fontFamily: "'DM Sans', sans-serif",
    }}>
      {/* Load fonts */}
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />

      {/* Header */}
      <header style={{
        padding: "20px 28px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 12,
      }}>
        <div>
          <h1 style={{
            fontSize: 22,
            fontWeight: 700,
            margin: 0,
            background: "linear-gradient(135deg, #FF8C00, #FFD700)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            letterSpacing: "-0.02em",
          }}>
            SOLARIS
          </h1>
          <p style={{ color: "#666", fontSize: 12, margin: "2px 0 0", letterSpacing: "0.05em" }}>
            GLOBAL SOLAR INTELLIGENCE
          </p>
        </div>

        {/* Tabs */}
        <nav style={{ display: "flex", gap: 4 }}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "none",
                background: activeTab === tab.id ? "rgba(255,140,0,0.12)" : "transparent",
                color: activeTab === tab.id ? "#FF8C00" : "#777",
                cursor: "pointer",
                fontSize: 13,
                fontFamily: "'DM Sans', sans-serif",
                fontWeight: activeTab === tab.id ? 600 : 400,
                transition: "all 0.2s",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span style={{ fontSize: 14 }}>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      {/* Content */}
      <main>
        {activeTab === "globe" && (
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 320px",
            height: "calc(100vh - 80px)",
          }}>
            {/* Globe */}
            <div style={{ position: "relative" }}>
              <SolarGlobe
                data={SOLAR_REGIONS}
                hoveredRegion={hoveredRegion}
                setHoveredRegion={setHoveredRegion}
              />

              {/* Hover tooltip */}
              {hoveredRegion && (
                <div style={{
                  position: "absolute",
                  top: 20,
                  left: 20,
                  padding: "16px 20px",
                  background: "rgba(6,11,20,0.92)",
                  borderRadius: 12,
                  border: `1px solid ${TIER_COLORS[hoveredRegion.tier].bg}40`,
                  backdropFilter: "blur(10px)",
                  minWidth: 200,
                  pointerEvents: "none",
                }}>
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 8,
                  }}>
                    <div style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: TIER_COLORS[hoveredRegion.tier].bg,
                      boxShadow: `0 0 8px ${TIER_COLORS[hoveredRegion.tier].bg}80`,
                    }} />
                    <span style={{ fontWeight: 700, fontSize: 16 }}>{hoveredRegion.region}</span>
                  </div>
                  <div style={{ color: "#999", fontSize: 13, marginBottom: 4 }}>
                    {hoveredRegion.country}
                  </div>
                  <div style={{
                    fontSize: 28,
                    fontWeight: 800,
                    color: TIER_COLORS[hoveredRegion.tier].bg,
                    fontFamily: "'Space Mono', monospace",
                    lineHeight: 1,
                    margin: "8px 0 4px",
                  }}>
                    {hoveredRegion.ghi.toLocaleString()}
                  </div>
                  <div style={{ color: "#888", fontSize: 12 }}>kWh/m²/year GHI</div>
                  <div style={{
                    marginTop: 8,
                    padding: "4px 10px",
                    background: `${TIER_COLORS[hoveredRegion.tier].bg}15`,
                    borderRadius: 6,
                    display: "inline-block",
                    color: TIER_COLORS[hoveredRegion.tier].bg,
                    fontSize: 12,
                    fontWeight: 600,
                  }}>
                    Tier {hoveredRegion.tier} — {TIER_COLORS[hoveredRegion.tier].label}
                  </div>
                </div>
              )}

              {/* Legend */}
              <div style={{
                position: "absolute",
                bottom: 20,
                left: 20,
                display: "flex",
                gap: 12,
                padding: "10px 16px",
                background: "rgba(6,11,20,0.85)",
                borderRadius: 10,
                backdropFilter: "blur(8px)",
              }}>
                {Object.entries(TIER_COLORS).map(([tier, c]) => (
                  <div key={tier} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <div style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: c.bg,
                    }} />
                    <span style={{ color: "#999", fontSize: 11 }}>{tier}: {c.label}</span>
                  </div>
                ))}
              </div>

              {/* Instructions */}
              <div style={{
                position: "absolute",
                bottom: 20,
                right: 20,
                color: "#555",
                fontSize: 11,
                textAlign: "right",
              }}>
                Drag to rotate · Hover blocks for data
              </div>
            </div>

            {/* Sidebar ranking */}
            <div style={{
              borderLeft: "1px solid rgba(255,255,255,0.06)",
              overflowY: "auto",
              padding: "16px 0",
            }}>
              <h3 style={{
                padding: "0 16px 12px",
                margin: 0,
                fontSize: 13,
                color: "#888",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
              }}>
                GHI Rankings (kWh/m²/yr)
              </h3>
              {sortedData.map((r, i) => (
                <div
                  key={i}
                  onMouseEnter={() => setHoveredRegion(r)}
                  onMouseLeave={() => setHoveredRegion(null)}
                  style={{
                    padding: "10px 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    borderBottom: "1px solid rgba(255,255,255,0.02)",
                    cursor: "pointer",
                    background: hoveredRegion?.region === r.region
                      ? "rgba(255,140,0,0.08)"
                      : "transparent",
                    transition: "background 0.15s",
                  }}
                >
                  <span style={{
                    color: "#555",
                    fontSize: 11,
                    fontFamily: "'Space Mono', monospace",
                    width: 20,
                    textAlign: "right",
                  }}>{i + 1}</span>
                  <div style={{
                    width: 6,
                    height: 6,
                    borderRadius: 1,
                    background: TIER_COLORS[r.tier].bg,
                    flexShrink: 0,
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13,
                      color: "#ccc",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}>{r.region}</div>
                    <div style={{ fontSize: 11, color: "#666" }}>{r.country}</div>
                  </div>
                  <span style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: TIER_COLORS[r.tier].bg,
                    fontFamily: "'Space Mono', monospace",
                    flexShrink: 0,
                  }}>
                    {r.ghi}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "space" && <SpaceVsEarth />}
        {activeTab === "panels" && <PanelFigures />}
        {activeTab === "calculator" && <SolarCalculator />}
      </main>

      {/* Footer with sources */}
      <footer style={{
        padding: "16px 28px",
        borderTop: "1px solid rgba(255,255,255,0.04)",
        color: "#555",
        fontSize: 11,
        lineHeight: 1.6,
      }}>
        <strong style={{ color: "#777" }}>Data sources:</strong>{" "}
        Global Solar Atlas (Solargis/World Bank) · NREL Best Research-Cell Efficiency Chart ·
        NASA Solar Constant · EIA Residential Energy Consumption Survey ·
        A1SolarStore satellite data · UCSD "Do the Math" space solar analysis
      </footer>
    </div>
  );
}