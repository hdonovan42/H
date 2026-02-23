import React, { useState, useEffect } from 'react';
import SolarDashboard, { TAB_OPTIONS, SOLAR_REGIONS } from './solar-dashboard';

// --- GLOBAL & RESPONSIVE CSS ---
const shellStyles = `
  :root {
    --bg-dark: #060b14;
    --primary-orange: #FF8C00;
    --secondary-gold: #FFD700;
  }

  body {
    margin: 0;
    background-color: var(--bg-dark);
    color: #f0f4f8;
    font-family: 'DM Sans', sans-serif;
  }

  .fade-in {
    opacity: 0;
    animation: fadeIn 0.8s ease-out forwards;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .nav-container {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 2rem;
    border-bottom: 1px solid rgba(255, 140, 0, 0.2);
    background: rgba(6, 11, 20, 0.85);
    backdrop-filter: blur(8px);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .nav-tabs {
    display: flex;
    gap: 1.5rem;
  }

  @media (max-width: 768px) {
    .nav-container {
      padding: 1rem;
    }

    .nav-tabs {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: rgba(6, 11, 20, 0.95);
      backdrop-filter: blur(12px);
      border-top: 1px solid rgba(255, 140, 0, 0.2);
      border-bottom: none;
      justify-content: space-around;
      padding: 0.5rem 0;
      gap: 0;
      z-index: 999;
    }

    .nav-tab-label {
      display: none;
    }

    .nav-tab-btn {
      flex-direction: column;
      font-size: 1.5rem;
      padding: 0.5rem;
    }

    .app-wrapper {
      padding-bottom: 60px;
    }
  }
`;

function HeroSection({ onStart }) {
  const locationCount = SOLAR_REGIONS ? SOLAR_REGIONS.length : 35;

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '2rem' }}>
      <h1 style={{
        fontSize: 'clamp(3rem, 8vw, 6rem)',
        margin: 0,
        background: 'linear-gradient(to right, #FF8C00, #FFD700)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        letterSpacing: '0.1em'
      }}>
        SOLARIS
      </h1>
      <p style={{ fontSize: 'clamp(1rem, 2vw, 1.5rem)', color: '#8b9bb4', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '3rem' }}>
        Global Solar Intelligence
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '2rem', marginBottom: '4rem', fontFamily: "'Space Mono', monospace", color: '#FFD700' }}>
        <div style={{ background: 'rgba(255, 140, 0, 0.05)', padding: '1rem 2rem', borderRadius: '8px', border: '1px solid rgba(255, 140, 0, 0.2)' }}>
          <div style={{ fontSize: '2rem' }}>{locationCount}</div>
          <div style={{ fontSize: '0.75rem', color: '#8b9bb4', marginTop: '0.25rem' }}>LOCATIONS TRACKED</div>
        </div>
        <div style={{ background: 'rgba(255, 140, 0, 0.05)', padding: '1rem 2rem', borderRadius: '8px', border: '1px solid rgba(255, 140, 0, 0.2)' }}>
          <div style={{ fontSize: '2rem' }}>2,600+</div>
          <div style={{ fontSize: '0.75rem', color: '#8b9bb4', marginTop: '0.25rem' }}>PEAK GHI (kWh/m²)</div>
        </div>
      </div>

      <button
        onClick={onStart}
        style={{
          background: '#FF8C00',
          color: '#060b14',
          padding: '1rem 3rem',
          fontSize: '1.1rem',
          fontFamily: "'Space Mono', monospace",
          fontWeight: 'bold',
          borderRadius: '4px',
          textTransform: 'uppercase',
          letterSpacing: '1px',
          border: 'none',
          cursor: 'pointer',
          boxShadow: '0 0 20px rgba(255, 140, 0, 0.3)',
          transition: 'transform 0.1s ease'
        }}
        onMouseDown={e => e.currentTarget.style.transform = 'scale(0.98)'}
        onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
      >
        Initialize System
      </button>
    </div>
  );
}

function GlobalNav({ tabs, activeTab, onTabChange }) {
  return (
    <nav className="nav-container">
      <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#FF8C00', letterSpacing: '0.1em' }}>
        SOLARIS
      </div>
      <div className="nav-tabs">
        {tabs.map(tab => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              className="nav-tab-btn"
              onClick={() => onTabChange(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: isActive ? '#FF8C00' : '#8b9bb4',
                fontFamily: "'Space Mono', monospace",
                fontSize: '0.9rem',
                padding: '0.5rem 0.75rem',
                transition: 'color 0.2s ease',
              }}
            >
              <span>{tab.icon}</span>
              <span className="nav-tab-label" style={{ fontWeight: isActive ? 'bold' : 'normal' }}>
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function Footer() {
  return (
    <footer style={{
      padding: '1.5rem 1rem',
      textAlign: 'center',
      fontFamily: "'Space Mono', monospace",
      fontSize: '0.7rem',
      color: '#4a5568',
      borderTop: '1px solid rgba(255,140,0,0.1)',
      lineHeight: '1.6'
    }}>
      Data Sources: Global Solar Atlas (Solargis/World Bank) &bull; NREL Best Research-Cell Efficiency Chart &bull; NASA Solar Constant &bull; EIA RECS &bull; UCSD &ldquo;Do the Math&rdquo;
    </footer>
  );
}

export default function App() {
  const [currentView, setCurrentView] = useState('globe');
  const [isRendering, setIsRendering] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setIsRendering(false), 400);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <style>{shellStyles}</style>
      <div className="app-wrapper" style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <GlobalNav tabs={TAB_OPTIONS} activeTab={currentView} onTabChange={setCurrentView} />

        <main style={{ flex: '1 1 0', minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
          {isRendering && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, background: '#060b14' }}>
              <div style={{ color: '#FF8C00', fontFamily: "'Space Mono', monospace" }}>
                Loading Telemetry...
              </div>
            </div>
          )}

          <div className={!isRendering ? "fade-in" : ""} style={{ opacity: isRendering ? 0 : 1, flex: '1 1 0', minHeight: 0 }}>
            <SolarDashboard activeTab={currentView} onTabChange={setCurrentView} />
          </div>
        </main>

        <Footer />
      </div>
    </>
  );
}
