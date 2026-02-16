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
  const { status, balanceHistory, cycles, costs, positions, events, memories, predictions, calibration, error, loading } = useVaultData();

  const alive = status?.alive ?? true;
  const daemonRunning = status?.daemon_running ?? false;

  const pulseClass = !status ? 'offline' : alive ? 'alive' : 'dead';

  const navItems = [
    { hash: '#/', label: 'Dashboard' },
    { hash: '#/pipeline', label: 'Pipeline' },
    { hash: '#/smart-money', label: 'Smart $' },
    { hash: '#/log', label: 'Log' },
    { hash: '#/memory', label: 'Memory' },
  ];

  let page;
  switch (hash) {
    case '#/pipeline':
      page = <PipelineView calibration={calibration} />;
      break;
    case '#/smart-money':
      page = <SmartMoneyPanel />;
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
