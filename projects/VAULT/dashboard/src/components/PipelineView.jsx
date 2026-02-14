import React, { useState, useEffect, useCallback } from 'react';
import EstimateCard from './EstimateCard';
import XFeedPanel from './XFeedPanel';
import CalibrationChart from './CalibrationChart';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export default function PipelineView({ calibration }) {
  const [pipeline, setPipeline] = useState(null);
  const [digests, setDigests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cycleId, setCycleId] = useState(null);

  const fetchPipeline = useCallback(async (cid) => {
    try {
      const url = cid ? `/api/v1/pipeline/${cid}` : '/api/v1/pipeline/latest';
      const [data, digestsData] = await Promise.all([
        fetchJSON(url),
        fetchJSON('/api/v1/digests').catch(() => []),
      ]);
      setPipeline(data);
      if (Array.isArray(digestsData)) setDigests(digestsData);
      setError(null);
      if (!cid && data.cycle_id) setCycleId(data.cycle_id);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPipeline(); }, [fetchPipeline]);

  if (loading) return <div className="page"><div className="empty">Loading pipeline data...</div></div>;
  if (error) return <div className="page"><div className="empty">Pipeline error: {error}</div></div>;
  if (!pipeline || pipeline.error) return <div className="page"><div className="empty">{pipeline?.error || 'No pipeline runs yet'}</div></div>;

  const tweets = pipeline.tweets || [];
  const estimates = pipeline.estimates || [];
  const edges = pipeline.edges || [];
  const decision = pipeline.decision || {};

  // Create edge lookup by market_id
  const edgeMap = {};
  edges.forEach(e => { edgeMap[e.market_id] = e; });

  const bets = edges.filter(e => e.action === 'bet');
  const exits = edges.filter(e => e.action === 'exit');

  return (
    <div className="page">
      {/* Pipeline header */}
      <div className="pipeline-header">
        <div className="card-title">Pipeline Run — Cycle #{pipeline.cycle_id}</div>
        <div className="pipeline-stats">
          <span>{tweets.length} tweets</span>
          <span>{estimates.length} estimates</span>
          <span>{bets.length} bets</span>
          <span>{exits.length} exits</span>
          {pipeline.duration_ms && <span>{pipeline.duration_ms}ms</span>}
        </div>
      </div>

      {/* Phase 1: Data */}
      <div className="grid" style={{ marginTop: '16px' }}>
        <XFeedPanel tweets={tweets} />
        <div className="card">
          <div className="card-title">Markets Found ({edges.length})</div>
          {edges.length === 0 ? (
            <div className="empty">No Musk-ecosystem markets found</div>
          ) : (
            <div className="market-list">
              {edges.map((e, i) => (
                <div key={e.market_id || i} className="market-item">
                  <div className="market-question">{e.question || e.market_id}</div>
                  <div className="market-odds">
                    YES: {(e.market_odds * 100).toFixed(0)}% | NO: {((1 - e.market_odds) * 100).toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Intelligence Digest — latest only */}
      {digests.length > 0 && (
        <div style={{ marginTop: '16px' }}>
          <div className="card-title" style={{ padding: '0 0 12px 0' }}>
            Intelligence Digest
          </div>
          <div className="card digest-card">
            <div className="digest-header">
              <span className="digest-label">Current</span>
              <span className="digest-meta">
                {digests[0].ts?.slice(0, 16).replace('T', ' ')} — {digests[0].tweet_count} tweets
              </span>
            </div>
            <div className="digest-text">{digests[0].digest_text}</div>
          </div>
        </div>
      )}

      {/* Phase 2 + 3: Estimates with edges */}
      {estimates.length > 0 && (
        <div style={{ marginTop: '16px' }}>
          <div className="card-title" style={{ padding: '0 0 12px 0' }}>
            Probability Estimates &amp; Edge Analysis
          </div>
          <div className="estimate-grid">
            {estimates.map((est, i) => (
              <EstimateCard
                key={est.market_id || i}
                estimate={est}
                edge={edgeMap[est.market_id]}
              />
            ))}
          </div>
        </div>
      )}

      {/* Phase 4: Decision */}
      {decision.action && (
        <div className="card" style={{ marginTop: '16px' }}>
          <div className="card-title">Decision</div>
          <div className="decision-row">
            <span className={`action-badge ${decision.action}`}>
              {decision.action}
            </span>
            <span className="decision-cost">${(decision.total_cost || 0).toFixed(4)}</span>
            {decision.balance_after != null && (
              <span className="decision-balance">bal: ${decision.balance_after.toFixed(2)}</span>
            )}
          </div>
          {decision.reasoning && (
            <div className="decision-reasoning">{decision.reasoning}</div>
          )}
        </div>
      )}

      {/* Calibration */}
      <div style={{ marginTop: '16px' }}>
        <CalibrationChart data={calibration} />
      </div>

      {/* Notes link */}
      <div style={{ marginTop: '24px', textAlign: 'center', paddingBottom: '16px' }}>
        <a
          href="/pipeline-notes.txt"
          target="_blank"
          rel="noopener noreferrer"
          className="notes-link"
        >
          Notes
        </a>
      </div>
    </div>
  );
}
