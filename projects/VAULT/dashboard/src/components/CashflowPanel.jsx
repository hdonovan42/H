import React, { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || '';

function truncAddr(s) {
  if (!s) return '';
  if (s.length <= 16) return s;  // labelled counterparty
  return s.slice(0, 6) + '…' + s.slice(-4);
}

function truncTx(s) {
  if (!s) return '';
  if (s.startsWith('reset-seed-')) return 'reset-seed';
  return s.slice(0, 10) + '…';
}

function polygonscanUrl(tx_hash) {
  if (!tx_hash || tx_hash.startsWith('reset-seed-')) return null;
  return `https://polygonscan.com/tx/${tx_hash}`;
}

function fmtDate(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  } catch {
    return ts.slice(0, 16).replace('T', ' ');
  }
}

export default function CashflowPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`${API_BASE}/api/v1/wallet-transactions?limit=200`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!cancelled) { setData(j); setErr(null); }
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (err) return (
    <div className="card" style={{ padding: 16, color: 'var(--danger, #f85149)' }}>
      Cashflow: {err}
    </div>
  );
  if (!data) return (
    <div className="card" style={{ padding: 16 }}>Loading wallet transactions…</div>
  );

  const items = data.items || [];
  const fmt = (v) => `$${Number(v).toFixed(2)}`;

  return (
    <div className="card" style={{ padding: '12px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <div className="card-title" style={{ margin: 0 }}>Wallet Cashflow</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim, #8b949e)' }}>
          {data.count_deposits} deposits ({fmt(data.total_deposits_usd)}) &middot;{' '}
          {data.count_withdrawals} withdrawals ({fmt(data.total_withdrawals_usd)}) &middot;{' '}
          net <strong>{fmt(data.net_deposits_usd)}</strong>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty" style={{ padding: '12px 0' }}>No wallet transactions yet</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
            <thead>
              <tr style={{ color: 'var(--text-dim, #8b949e)', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px', fontWeight: 400, textTransform: 'uppercase', fontSize: 10 }}>Time (UTC)</th>
                <th style={{ padding: '6px 8px', fontWeight: 400, textTransform: 'uppercase', fontSize: 10 }}>Direction</th>
                <th style={{ padding: '6px 8px', fontWeight: 400, textTransform: 'uppercase', fontSize: 10, textAlign: 'right' }}>Amount</th>
                <th style={{ padding: '6px 8px', fontWeight: 400, textTransform: 'uppercase', fontSize: 10 }}>Token</th>
                <th style={{ padding: '6px 8px', fontWeight: 400, textTransform: 'uppercase', fontSize: 10 }}>Counterparty</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const isDeposit = it.direction === 'deposit';
                const colour = isDeposit ? 'var(--green, #3fb950)' : 'var(--danger, #f85149)';
                const url = polygonscanUrl(it.tx_hash);
                return (
                  <tr key={it.id} style={{ borderTop: '1px solid var(--border, rgba(255,255,255,0.06))' }}>
                    <td style={{ padding: '6px 8px', color: 'var(--text-dim, #8b949e)' }}>{fmtDate(it.ts)}</td>
                    <td style={{ padding: '6px 8px', color: colour, fontWeight: 600 }}>
                      {isDeposit ? 'deposit' : 'withdrawal'}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: colour }}>
                      {isDeposit ? '+' : '−'}{fmt(it.amount_usd)}
                    </td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-dim, #8b949e)' }}>{it.token}</td>
                    <td style={{ padding: '6px 8px' }} title={it.counterparty}>
                      {it.counterparty.startsWith('0x')
                        ? truncAddr(it.counterparty)
                        : it.counterparty}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
