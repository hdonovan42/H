import React, { useState, useEffect } from 'react';
import { useVaultData } from './hooks/useVaultData';
import StatusBar from './components/StatusBar';
import BalanceChart from './components/BalanceChart';
import CycleLog from './components/CycleLog';
import BetsPanel from './components/BetsPanel';
import EventTimeline from './components/EventTimeline';
import ReconciliationPanel from './components/ReconciliationPanel';
import CashflowPanel from './components/CashflowPanel';


function useHash() {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const handler = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  return hash;
}

function DashboardPage({ status, balanceHistory, cycles, positions, predictions }) {
  return (
    <div className="page">
      <StatusBar status={status} />
      <BalanceChart data={balanceHistory} />
      <div className="grid" style={{ marginTop: '16px', gridTemplateRows: '500px' }}>
        <CycleLog cycles={cycles} />
        <div className="card" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div className="card-title">Positions</div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <BetsPanel positions={positions} predictions={predictions} />
          </div>
        </div>
      </div>
      {status?.live && (
        <div style={{ marginTop: '16px' }}>
          <ReconciliationPanel />
        </div>
      )}
    </div>
  );
}

function LogPage({ cycles, events }) {
  return (
    <div className="page">
      <CashflowPanel />
      <div style={{ marginTop: '16px' }}>
        <EventTimeline events={events} />
      </div>
      <div className="card" style={{ marginTop: '16px' }}>
        <div className="card-title">Full Cycle Log</div>
        {(!cycles || cycles.length === 0) ? (
          <div className="empty">No cycles recorded yet</div>
        ) : (
          <ul className="log-list" style={{ maxHeight: '600px', overflowY: 'auto' }}>
            {cycles.map((c) => (
              <li key={c.id} className="cycle-item">
                <span className={`action-badge ${c.action || 'wait'}`}>
                  {c.action || 'pending'}
                </span>
                <div style={{ flex: 1 }}>
                  <div className="cycle-meta">
                    #{c.id} | {c.ts_start?.slice(0, 16).replace('T', ' ')}
                    {' | '}${(c.total_cost || 0).toFixed(2)}
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
    </div>
  );
}

export default function App() {
  const hash = useHash();
  const { status, balanceHistory, cycles, positions, events, predictions, error, loading } = useVaultData();

  const alive = status?.alive ?? true;

  const pulseClass = !status ? 'offline' : alive ? 'alive' : 'dead';

  const navItems = [
    { hash: '#/', label: 'Home' },
    { hash: '#/log', label: 'Log' },
  ];

  let page;
  switch (hash) {
    case '#/log':
      page = <LogPage cycles={cycles} events={events} />;
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
              className={`nav-link ${hash === item.hash || (item.hash === '#/' && (hash === '' || hash === '#')) ? 'active' : ''}`}
              onClick={(e) => { e.preventDefault(); window.location.hash = item.hash; }}
            >
              {item.label}
            </a>
          ))}
        </div>
      </nav>

      {error && (
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
