import React, { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || '';

const STATUS_COLOUR = {
  ok: 'var(--green, #3fb950)',
  'not-live': 'var(--text-dim, #8b949e)',
  pending: 'var(--amber, #d29922)',
  'positive-drift': 'var(--amber, #d29922)',
  'rpc-down': 'var(--danger, #f85149)',
  'negative-drift': 'var(--danger, #f85149)',
};

const STATUS_LABEL = {
  ok: 'OK',
  'not-live': 'PAPER MODE',
  pending: 'PENDING',
  'positive-drift': 'POSITIVE DRIFT',
  'rpc-down': 'RPC DOWN',
  'negative-drift': 'NEGATIVE DRIFT',
};

export default function ReconciliationPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`${API_BASE}/api/v1/reconciliation`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!cancelled) { setData(j); setErr(null); }
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    }
    load();
    const t = setInterval(load, 30_000);  // poll every 30s
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (err) return <div className="card" style={{ padding: 16, color: 'var(--danger, #f85149)' }}>Reconciliation: {err}</div>;
  if (!data) return <div className="card" style={{ padding: 16 }}>Loading reconciliation…</div>;

  const colour = STATUS_COLOUR[data.status] || 'var(--text-dim, #8b949e)';
  const label = STATUS_LABEL[data.status] || data.status;

  const fmt = (v) => v == null ? '—' : `$${Number(v).toFixed(2)}`;
  const fmtSigned = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}$${Number(v).toFixed(2)}`;

  return (
    <div className="card" style={{ padding: '12px 16px', borderLeft: `3px solid ${colour}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div className="card-title" style={{ margin: 0 }}>Balance Reconciliation</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: colour, letterSpacing: '0.06em' }}>{label}</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, fontSize: 12, marginBottom: 8 }}>
        <div>
          <div style={{ color: 'var(--text-dim, #8b949e)', fontSize: 10, textTransform: 'uppercase' }}>Internal</div>
          <div style={{ fontFamily: 'monospace', fontSize: 14 }}>{fmt(data.expected_onchain)}</div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim, #8b949e)', fontSize: 10, textTransform: 'uppercase' }}>On-chain USDC</div>
          <div style={{ fontFamily: 'monospace', fontSize: 14 }}>{fmt(data.actual_onchain)}</div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim, #8b949e)', fontSize: 10, textTransform: 'uppercase' }}>Drift</div>
          <div style={{ fontFamily: 'monospace', fontSize: 14, color: colour }}>{fmtSigned(data.drift)}</div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim, #8b949e)', fontSize: 10, textTransform: 'uppercase' }}>Tolerance</div>
          <div style={{ fontFamily: 'monospace', fontSize: 14 }}>±{fmt(data.tolerance)}</div>
        </div>
      </div>

      {(data.pending?.length > 0 || data.reconciling?.length > 0) && (
        <div style={{ marginTop: 8, padding: 8, background: 'rgba(210,153,34,0.08)', borderRadius: 4, fontSize: 11 }}>
          {data.pending?.length > 0 && (
            <div style={{ marginBottom: 4 }}>
              <strong>Pending ({data.pending.length}):</strong>{' '}
              {data.pending.slice(0, 3).map((p) => `#${p.id} ${p.side} ${p.question?.slice(0, 40)}`).join('; ')}
              {data.pending.length > 3 && ` (+${data.pending.length - 3} more)`}
            </div>
          )}
          {data.reconciling?.length > 0 && (
            <div style={{ color: 'var(--danger, #f85149)' }}>
              <strong>Reconciling ({data.reconciling.length}):</strong>{' '}
              {data.reconciling.slice(0, 3).map((p) => `#${p.id} ${p.side} ${p.question?.slice(0, 40)}`).join('; ')}
              — manual review needed
            </div>
          )}
        </div>
      )}

      {data.status === 'rpc-down' && (
        <div style={{ marginTop: 8, padding: 8, background: 'rgba(248,81,73,0.1)', borderRadius: 4, fontSize: 11 }}>
          All Polygon RPC providers failed. Daemon will auto-pause after the configured threshold. Check <code>trading.clob.rpc_fallback</code>.
        </div>
      )}
    </div>
  );
}
