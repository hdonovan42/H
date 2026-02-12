import React from 'react';
import EdgeBar from './EdgeBar';

export default function EstimateCard({ estimate, edge }) {
  if (!estimate) return null;

  const question = estimate.question || edge?.question || estimate.market_id;
  const vaultProb = estimate.vault_probability;
  const confidence = estimate.confidence;
  const reasoning = estimate.reasoning;

  const marketOdds = edge?.market_odds ?? 0.5;
  const edgeVal = edge?.edge ?? 0;
  const side = edge?.side ?? (edgeVal >= 0 ? 'YES' : 'NO');
  const action = edge?.action ?? 'hold';
  const recommendedSize = edge?.recommended_size_usd ?? 0;

  const actionColors = {
    bet: 'var(--warning)',
    exit: 'var(--sell)',
    hold: 'var(--text-dim)',
  };

  return (
    <div className={`estimate-card ${action}`}>
      <div className="estimate-question">{question}</div>
      <EdgeBar vaultProb={vaultProb} marketOdds={marketOdds} side={side} />
      <div className="estimate-details">
        <div className="estimate-row">
          <span>Confidence</span>
          <span className="estimate-value">{(confidence * 100).toFixed(0)}%</span>
        </div>
        <div className="estimate-row">
          <span>Action</span>
          <span className="estimate-value" style={{ color: actionColors[action] || 'var(--text)' }}>
            {action.toUpperCase()} {side}
            {action === 'bet' && recommendedSize > 0 && ` $${recommendedSize.toFixed(2)}`}
          </span>
        </div>
      </div>
      {reasoning && <div className="estimate-reasoning">{reasoning}</div>}
    </div>
  );
}
