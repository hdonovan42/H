// Convert period date to quarter format (e.g., "2025-09-30" -> "Q3 2025")
const formatPeriod = (dateStr) => {
  if (!dateStr) return '';
  const [year, month] = dateStr.split('-');
  const quarter = Math.ceil(parseInt(month) / 3);
  return `Q${quarter} ${year}`;
};

export default function EarningsData({ data, revenueData }) {
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

  // Get revenue estimate for the matching period
  const revenueEstimate = revenueData?.data?.find(r => r.period === latest.period);

  return (
    <div className="earnings-data">
      <div className="section-header">
        <h3>Earnings</h3>
        <span className="earnings-period">{formatPeriod(latest.period)}</span>
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
        {revenueEstimate?.revenueAvg && (
          <div className="earnings-metric">
            <div className="metric-label">Revenue</div>
            <div className="metric-row">
              <span className="metric-sublabel">Estimate</span>
              <span className="metric-value">${(revenueEstimate.revenueAvg / 1e9).toFixed(2)}B</span>
            </div>
            {!hasActual && (
              <div className="metric-pending">Awaiting results...</div>
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
                <span className="history-period">{formatPeriod(q.period)}</span>
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
