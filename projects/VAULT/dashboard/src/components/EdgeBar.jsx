import React from 'react';

export default function EdgeBar({ vaultProb, marketOdds, side }) {
  const edge = vaultProb - marketOdds;
  const edgePct = Math.abs(edge * 100).toFixed(0);
  const isPositive = edge > 0;

  // Position markers on a 0-100 scale
  const vaultPos = Math.max(2, Math.min(98, vaultProb * 100));
  const marketPos = Math.max(2, Math.min(98, marketOdds * 100));
  const left = Math.min(vaultPos, marketPos);
  const width = Math.abs(vaultPos - marketPos);

  const edgeColor = side === 'YES' ? 'var(--alive)' : 'var(--danger)';

  return (
    <div className="edge-bar-container">
      <div className="edge-bar-track">
        <div
          className="edge-bar-fill"
          style={{
            left: `${left}%`,
            width: `${Math.max(width, 1)}%`,
            background: edgeColor,
            opacity: 0.25,
          }}
        />
        <div
          className="edge-bar-marker vault"
          style={{ left: `${vaultPos}%` }}
          title={`VAULT: ${(vaultProb * 100).toFixed(0)}%`}
        />
        <div
          className="edge-bar-marker market"
          style={{ left: `${marketPos}%` }}
          title={`Market: ${(marketOdds * 100).toFixed(0)}%`}
        />
      </div>
      <div className="edge-bar-labels">
        <span style={{ color: 'var(--warning)' }}>V:{(vaultProb * 100).toFixed(0)}%</span>
        <span style={{ color: edgeColor }}>{isPositive ? '+' : '-'}{edgePct}% edge</span>
        <span style={{ color: 'var(--text-dim)' }}>M:{(marketOdds * 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}
