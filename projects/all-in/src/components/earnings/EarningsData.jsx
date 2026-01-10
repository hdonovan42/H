// Format quarter display (e.g., "Q4 2025")
const formatQuarter = (quarter, year) => {
  if (!quarter || !year) return '';
  return `Q${quarter} ${year}`;
};

export default function EarningsData({ data }) {
  // Finnhub returns array of earnings: [{ actual, estimate, period, quarter, year, surprise, surprisePercent }]
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

  // Most recent quarter (first in array)
  const latest = data[0];
  const hasActual = latest.actual != null;

  // Calculate beat/miss
  const epsBeat = hasActual ? latest.surprise : null;
  const epsBeatPercent = hasActual ? latest.surprisePercent : null;

  return (
    <div className="earnings-data">
      <div className="section-header">
        <h3>Earnings</h3>
        <span className="earnings-period">{formatQuarter(latest.quarter, latest.year)}</span>
      </div>

      <div className="earnings-grid-data">
        {/* EPS Section */}
        <div className="earnings-metric">
          <div className="metric-label">EPS</div>
          <div className="metric-row">
            <span className="metric-sublabel">Estimate</span>
            <span className="metric-value">${latest.estimate?.toFixed(2) ?? 'N/A'}</span>
          </div>
          {hasActual ? (
            <>
              <div className="metric-row">
                <span className="metric-sublabel">Actual</span>
                <span className="metric-value">${latest.actual?.toFixed(2)}</span>
              </div>
              <div className={`metric-result ${epsBeat >= 0 ? 'beat' : 'miss'}`}>
                {epsBeat >= 0 ? 'BEAT' : 'MISS'} by ${Math.abs(epsBeat).toFixed(2)} ({epsBeat >= 0 ? '+' : ''}{epsBeatPercent?.toFixed(1)}%)
              </div>
            </>
          ) : (
            <div className="metric-pending">Awaiting results...</div>
          )}
        </div>

        {/* Revenue Section - placeholder until free API found */}
        <div className="earnings-metric">
          <div className="metric-label">Revenue</div>
          <div className="metric-pending">Estimate not available</div>
        </div>
      </div>

      {/* Historical quick view */}
      {data.length > 1 && (
        <div className="earnings-history">
          <div className="history-label">Recent Quarters</div>
          <div className="history-items">
            {data.slice(1, 5).map((q, i) => (
              <div key={i} className="history-item">
                <span className="history-period">{formatQuarter(q.quarter, q.year)}</span>
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
