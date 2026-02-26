import React, { useState, useEffect } from 'react';
import { useVaultData } from './hooks/useVaultData';
import StatusBar from './components/StatusBar';
import BalanceChart from './components/BalanceChart';
import CycleLog from './components/CycleLog';
import CostBreakdown from './components/CostBreakdown';
import BetsPanel from './components/BetsPanel';
import EventTimeline from './components/EventTimeline';
import PipelineView from './components/PipelineView';
import SmartMoneyPanel from './components/SmartMoneyPanel';

function useHash() {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const handler = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  return hash;
}

function LandingPage() {
  return (
    <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '70vh' }}>
      <div style={{ textAlign: 'center', maxWidth: '520px' }}>
        <div style={{ fontSize: '48px', fontWeight: 700, letterSpacing: '8px', color: 'var(--text-bright)', marginBottom: '16px' }}>
          VAULT
        </div>
        <div style={{ fontSize: '14px', color: 'var(--text-dim)', lineHeight: 1.7, marginBottom: '32px' }}>
          Autonomous AI financial agent. Seeded with $50, it trades prediction markets on Polymarket to survive. If the balance hits zero, it dies permanently.
        </div>
        <button
          onClick={() => { window.location.hash = '#/login'; }}
          style={{
            background: 'none',
            border: '1px solid var(--border-light)',
            color: 'var(--text)',
            fontFamily: 'var(--font)',
            fontSize: '13px',
            padding: '8px 24px',
            borderRadius: '4px',
            cursor: 'pointer',
            letterSpacing: '2px',
            textTransform: 'uppercase',
          }}
        >
          Enter
        </button>
      </div>
    </div>
  );
}

function LoginPage({ onLogin, error }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');

  const submit = (e) => {
    e.preventDefault();
    onLogin(user, pass);
  };

  const inputStyle = {
    background: 'var(--bg-dark)',
    border: '1px solid var(--border-light)',
    color: 'var(--text)',
    fontFamily: 'var(--font)',
    fontSize: '13px',
    padding: '8px 12px',
    borderRadius: '4px',
    width: '100%',
  };

  return (
    <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '70vh' }}>
      <form onSubmit={submit} style={{ width: '280px' }}>
        <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: '20px', textAlign: 'center' }}>
          Authenticate
        </div>
        <input
          type="text"
          placeholder="Username"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          autoFocus
          style={{ ...inputStyle, marginBottom: '8px' }}
        />
        <input
          type="password"
          placeholder="Password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          style={{ ...inputStyle, marginBottom: '16px' }}
        />
        {error && (
          <div style={{ fontSize: '12px', color: 'var(--danger)', marginBottom: '12px', textAlign: 'center' }}>
            Invalid credentials
          </div>
        )}
        <button
          type="submit"
          style={{
            background: 'none',
            border: '1px solid var(--border-light)',
            color: 'var(--text)',
            fontFamily: 'var(--font)',
            fontSize: '13px',
            padding: '8px 0',
            borderRadius: '4px',
            cursor: 'pointer',
            letterSpacing: '2px',
            textTransform: 'uppercase',
            width: '100%',
          }}
        >
          Login
        </button>
      </form>
    </div>
  );
}

function DashboardPage({ status, balanceHistory, cycles, positions, predictions }) {
  return (
    <div className="page">
      <StatusBar status={status} />
      <BalanceChart data={balanceHistory} />
      <div className="grid" style={{ marginTop: '16px' }}>
        <CycleLog cycles={cycles} />
        <BetsPanel positions={positions} predictions={predictions} />
      </div>
    </div>
  );
}

function LogPage({ cycles, costs, events }) {
  return (
    <div className="page">
      <div className="card">
        <div className="card-title">Full Cycle Log</div>
        {(!cycles || cycles.length === 0) ? (
          <div className="empty">No cycles recorded yet</div>
        ) : (
          <ul className="cycle-list">
            {cycles.map((c) => (
              <li key={c.id} className="cycle-item">
                <span className={`action-badge ${c.action || 'wait'}`}>
                  {c.action || 'pending'}
                </span>
                <div style={{ flex: 1 }}>
                  <div className="cycle-meta">
                    #{c.id} | {c.ts_start?.slice(0, 16).replace('T', ' ')}
                    {' | '}${(c.total_cost || 0).toFixed(4)}
                    {' | '}{c.rounds_used || 0} rounds
                    {c.balance_after != null && ` | bal: $${c.balance_after.toFixed(2)}`}
                    {c.asset && ` | ${c.asset}`}
                  </div>
                  {c.reasoning && (
                    <div className="cycle-reasoning">{c.reasoning}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid" style={{ marginTop: '16px' }}>
        <CostBreakdown costs={costs} />
        <EventTimeline events={events} />
      </div>
    </div>
  );
}

function MemoryPage({ memories }) {
  return (
    <div className="page">
      <div className="card">
        <div className="card-title">Agent Strategy Memories</div>
        {(!memories || memories.length === 0) ? (
          <div className="empty">No strategy memories recorded yet</div>
        ) : (
          <div>
            {memories.map((m) => (
              <div key={m.id} className="memory-item">
                <span className={`memory-category ${m.category}`}>{m.category}</span>
                <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                  rel: {m.relevance?.toFixed(1)}
                </span>
                <div className="memory-content">{m.content}</div>
                <div className="memory-meta">{m.ts?.slice(0, 16).replace('T', ' ')}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const hash = useHash();
  const [creds, setCreds] = useState(() => {
    const saved = sessionStorage.getItem('vault_creds');
    return saved ? JSON.parse(saved) : null;
  });
  const [loginError, setLoginError] = useState(false);

  const { status, balanceHistory, cycles, costs, positions, events, memories, predictions, calibration, error, loading } = useVaultData(creds);

  // If API returns 401, clear creds
  useEffect(() => {
    if (error === '401 Unauthorised') {
      setCreds(null);
      sessionStorage.removeItem('vault_creds');
      setLoginError(true);
      window.location.hash = '#/login';
    }
  }, [error]);

  const isLanding = hash === '#/' || hash === '' || hash === '#';
  const isLogin = hash === '#/login';
  const isAuthed = !!creds;

  // Public landing page — no auth needed
  if (isLanding && !isAuthed) {
    return (
      <>
        <nav className="nav">
          <div className="nav-brand">
            <span className="pulse offline" />
            VAULT
          </div>
        </nav>
        <LandingPage />
      </>
    );
  }

  // Login page
  if (isLogin && !isAuthed) {
    return (
      <>
        <nav className="nav">
          <div className="nav-brand">
            <span className="pulse offline" />
            VAULT
          </div>
        </nav>
        <LoginPage
          error={loginError}
          onLogin={(user, pass) => {
            const newCreds = { user, pass };
            setCreds(newCreds);
            sessionStorage.setItem('vault_creds', JSON.stringify(newCreds));
            setLoginError(false);
            window.location.hash = '#/dashboard';
          }}
        />
      </>
    );
  }

  // Not authed and trying to access a protected page — redirect to login
  if (!isAuthed) {
    window.location.hash = '#/login';
    return null;
  }

  // Authed — show full app
  const alive = status?.alive ?? true;
  const pulseClass = !status ? 'offline' : alive ? 'alive' : 'dead';

  const navItems = [
    { hash: '#/dashboard', label: 'Dashboard' },
    { hash: '#/pipeline', label: 'Pipeline' },
    { hash: '#/smart-money', label: 'Smart $' },
    { hash: '#/log', label: 'Log' },
    { hash: '#/memory', label: 'Memory' },
  ];

  const activeHash = (isLanding || hash === '#/dashboard') ? '#/dashboard' : hash;

  let page;
  switch (activeHash) {
    case '#/pipeline':
      page = <PipelineView calibration={calibration} creds={creds} />;
      break;
    case '#/smart-money':
      page = <SmartMoneyPanel creds={creds} />;
      break;
    case '#/log':
      page = <LogPage cycles={cycles} costs={costs} events={events} />;
      break;
    case '#/memory':
      page = <MemoryPage memories={memories} />;
      break;
    default:
      page = (
        <DashboardPage
          status={status}
          balanceHistory={balanceHistory}
          cycles={cycles}
          positions={positions}
          predictions={predictions}
        />
      );
  }

  return (
    <>
      {!alive && status && <div className="dead-overlay" />}
      <nav className="nav">
        <div className="nav-brand">
          <span className={`pulse ${pulseClass}`} />
          VAULT
        </div>
        <div className="nav-links">
          {navItems.map((item) => (
            <a
              key={item.hash}
              href={item.hash}
              className={`nav-link ${activeHash === item.hash ? 'active' : ''}`}
              onClick={(e) => { e.preventDefault(); window.location.hash = item.hash; }}
            >
              {item.label}
            </a>
          ))}
        </div>
      </nav>

      {error && error !== '401 Unauthorised' && (
        <div style={{ padding: '12px 24px', background: 'rgba(255,0,64,0.1)', color: 'var(--danger)', fontSize: '13px', borderBottom: '1px solid var(--danger)' }}>
          API Error: {error}
        </div>
      )}

      {loading ? (
        <div className="page">
          <div className="empty">Connecting to VAULT API...</div>
        </div>
      ) : page}
    </>
  );
}
