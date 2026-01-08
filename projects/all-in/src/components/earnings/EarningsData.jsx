export default function EarningsData({ data }) {
  if (!data || !data.length) {
    return (
      <div className="earnings-data">
        <div className="section-header">
          <h3>Earnings</h3>
        </div>
        <div className="earnings-loading-msg">Loading estimates...</div>
      </div>
    );
  }

  // Get the most recent earnings (first in array is usually most recent/upcoming)
  const latest = data[0];
  const hasActual = latest.actual !== null && latest.actual !== undefined;

  // Calculate beat/miss
  const epsBeat = hasActual && latest.estimate ? latest.actual - latest.estimate : null;
  const epsBeatPercent = hasActual && latest.estimate ? (epsBeat / Math.abs(latest.estimate)) * 100 : null;

  return (
    <div className="earnings-data">
      <div className="section-header">
        <h3>Earnings</h3>
        <span className="earnings-period">{latest.period}</span>
      </div>

      <div className="earnings-grid-data">
        {/* EPS Section */}
        <div className="earnings-metric">
          <div className="metric-label">EPS</div>
          <div className="metric-row">
            <span className="metric-sublabel">Estimate</span>
            <span className="metric-value">${latest.estimate?.toFixed(2) ?? 'N/A'}</span>
          </div>
          {hasActual && (
            <>
              <div className="metric-row">
                <span className="metric-sublabel">Actual</span>
                <span className="metric-value">${latest.actual?.toFixed(2)}</span>
              </div>
              <div className={`metric-result ${epsBeat >= 0 ? 'beat' : 'miss'}`}>
                {epsBeat >= 0 ? 'BEAT' : 'MISS'} by ${Math.abs(epsBeat).toFixed(2)} ({epsBeat >= 0 ? '+' : ''}{epsBeatPercent?.toFixed(1)}%)
              </div>
            </>
          )}
          {!hasActual && (
            <div className="metric-pending">Awaiting results...</div>
          )}
        </div>

        {/* Revenue Section - if available */}
        {latest.revenueEstimate && (
          <div className="earnings-metric">
            <div className="metric-label">Revenue</div>
            <div className="metric-row">
              <span className="metric-sublabel">Estimate</span>
              <span className="metric-value">${(latest.revenueEstimate / 1e9).toFixed(2)}B</span>
            </div>
            {latest.revenueActual && (
              <>
                <div className="metric-row">
                  <span className="metric-sublabel">Actual</span>
                  <span className="metric-value">${(latest.revenueActual / 1e9).toFixed(2)}B</span>
                </div>
                <div className={`metric-result ${latest.revenueActual >= latest.revenueEstimate ? 'beat' : 'miss'}`}>
                  {latest.revenueActual >= latest.revenueEstimate ? 'BEAT' : 'MISS'}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Historical quick view */}
      {data.length > 1 && (
        <div className="earnings-history">
          <div className="history-label">Recent Quarters</div>
          <div className="history-items">
            {data.slice(1, 5).map((q, i) => (
              <div key={i} className="history-item">
                <span className="history-period">{q.period}</span>
                <span className={`history-result ${q.surprise >= 0 ? 'beat' : 'miss'}`}>
                  {q.surprise >= 0 ? '+' : ''}{q.surprise?.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
