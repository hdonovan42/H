# SOLARIS — Global Solar Intelligence Dashboard

## Claude Code Instructions

### What You're Building

A React component for a solar energy dashboard with 4 pages: 3D globe, space vs earth comparison, panel specs, and a calculator. Gemini is building the outer shell (hero, nav, layout). Your component accepts tab control via props and renders only page content.

---

### Step 1: Scaffold

```bash
npm create vite@latest solaris -- --template react
cd solaris
npm install three
```

Add to `index.html` `<head>`:
```html
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
```

### Step 2: Create the component

Create `src/solar-dashboard.jsx` with the exact code from the **Full Component Code** section at the end of this file.

Then set up `src/App.jsx`:
```jsx
import SolarDashboard from './solar-dashboard';
function App() { return <SolarDashboard />; }
export default App;
```

### Step 3: Verify

```bash
npm run dev
```

Expected: dark background, 3D rotating globe with colored blocks, sidebar ranking, all 4 tabs functional.

---

### Component Interface

```jsx
// Props (all optional — falls back to internal state):
//   activeTab: "globe" | "space" | "panels" | "calculator"
//   onTabChange: (tab: string) => void
//
// Named exports: TAB_OPTIONS, SOLAR_REGIONS, PANEL_SPECS, SPACE_EARTH, TIER_COLORS
```

No header, no nav, no footer rendered. Parent shell owns navigation.

---

### Known Issues to Fix

1. **Mobile**: `grid-template-columns: 1fr 320px` in GlobePage needs `@media (max-width: 768px)` to stack.
2. **Raycaster**: Hover can miss blocks at extreme tilt. Normalize against group world matrix.
3. **Calculator state**: Resets on tab switch. Lift state or add localStorage if needed.

---

### Data Sources

| Source | Data | License |
|---|---|---|
| Global Solar Atlas (Solargis/World Bank) | GHI per region | CC BY 4.0 |
| NREL Best Research-Cell Efficiency Chart | Panel specs | Public domain |
| NASA | Solar constant 1,361 W/m² | Public domain |
| EIA RECS | US household 10,500 kWh/yr | Public domain |
| UCSD Do the Math | Space solar economics | Educational |

---

### Deployment

```bash
npm run build
```
Static output. No env vars, no API keys, no server. Deploy anywhere.

---

## GEMINI HANDOFF

After Claude Code has it working, copy everything below and send to Gemini.

---

### For Gemini: Integration Spec

**Import:**
```jsx
import SolarDashboard, { TAB_OPTIONS, SOLAR_REGIONS, TIER_COLORS } from './solar-dashboard';
```

**TAB_OPTIONS:**
```js
[
  { id: "globe", label: "Solar Map", icon: "◉" },
  { id: "space", label: "Space vs Earth", icon: "◈" },
  { id: "panels", label: "Panel Specs", icon: "⬡" },
  { id: "calculator", label: "Calculator", icon: "⊞" },
]
```

**Your App.jsx:**
```jsx
import React, { useState } from 'react';
import SolarDashboard, { TAB_OPTIONS } from './solar-dashboard';

export default function App() {
  const [currentView, setCurrentView] = useState('globe');
  const [isStarted, setIsStarted] = useState(false);

  if (!isStarted) return <HeroSection onStart={() => setIsStarted(true)} />;

  return (
    <div className="min-h-screen bg-[#060b14] flex flex-col">
      <GlobalNav tabs={TAB_OPTIONS} activeTab={currentView} onTabChange={setCurrentView} />
      <main className="flex-grow relative overflow-hidden">
        <SolarDashboard activeTab={currentView} onTabChange={setCurrentView} />
      </main>
      <footer>{/* Global Solar Atlas · NREL · NASA · EIA */}</footer>
    </div>
  );
}
```

**What Gemini builds:**

| Component | Purpose | Notes |
|---|---|---|
| `HeroSection` | Landing page | Call `onStart()` to enter. Pull hero stats from `SOLAR_REGIONS` if wanted. |
| `GlobalNav` | Top nav | Use `TAB_OPTIONS` for labels + icons. Pass `activeTab`/`onTabChange`. |
| Mobile nav | Responsive | Globe sidebar (320px) assumes desktop. On <768px hide or convert to bottom sheet. |
| Loading | Transition | Three.js globe takes a frame. Fade-in or skeleton. |
| Footer | Credits | Global Solar Atlas, NREL, NASA, EIA, UCSD Do the Math |

**Do NOT rebuild:** 3D globe, calculator, charts, panel cards, solar data.

**Design tokens:** bg `#060b14`, primary `#FF8C00`, secondary `#FFD700`, fonts DM Sans + Space Mono.

**Deps:** `three`, React 18+. Nothing else.

---

## Full Component Code

Copy this entire block into `src/solar-dashboard.jsx`:

The base component code is provided as `solar-dashboard.jsx` alongside this file. Before using it, apply these refactors:

1. **Remove internal navigation**: Delete the `<header>` element containing "SOLARIS" title and tab buttons from the `SolarDashboard` default export. Delete the `<footer>` with data sources. The component should render only the active page content.

2. **Accept external tab control**: Change the default export signature to:
```jsx
export default function SolarDashboard({ activeTab: externalTab, onTabChange: externalOnTabChange }) {
  const [internalTab, setInternalTab] = useState("globe");
  const activeTab = externalTab ?? internalTab;
  const setActiveTab = externalOnTabChange ?? setInternalTab;
  // ... rest renders based on activeTab
}
```

3. **Export constants**: Add `export` to these declarations so Gemini can import them:
```jsx
export const TAB_OPTIONS = [
  { id: "globe", label: "Solar Map", icon: "◉" },
  { id: "space", label: "Space vs Earth", icon: "◈" },
  { id: "panels", label: "Panel Specs", icon: "⬡" },
  { id: "calculator", label: "Calculator", icon: "⊞" },
];
export const SOLAR_REGIONS = [ ... ];  // already defined
export const PANEL_SPECS = { ... };     // already defined
export const SPACE_EARTH = { ... };     // already defined
export const TIER_COLORS = { ... };     // already defined
```

4. **Extract GlobePage**: Move the globe + sidebar rendering out of the main export into its own `GlobePage` component so the main export is just a tab switcher:
```jsx
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
```

These are surgical changes. The data, Three.js globe, calculator, charts, and all page content remain exactly as-is.
