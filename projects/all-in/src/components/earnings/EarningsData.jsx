import { useState } from 'react';
import { CONFIDENCE, SOURCE_COLORS, formatRevenue, formatQuarter, parseQuarterKey } from '../../types/earnings';

// Source indicator component - shows colored dots for data sources
function SourceIndicator({ sources, confidence }) {
  if (!sources || sources.length === 0) return null;

  const uniqueSources = [...new Set(sources)];

  return (
    <div className="source-indicator">
      <span className={`confidence-badge ${confidence}`} title={`Confidence: ${confidence}`}>
        {confidence === CONFIDENCE.VALIDATED && '✓'}
        {confidence === CONFIDENCE.PARTIAL && '~'}
        {confidence === CONFIDENCE.SINGLE && '•'}
      </span>
      <div className="source-dots">
        {uniqueSources.map(src => (
          <span
            key={src}
            className="source-dot"
            style={{ backgroundColor: SOURCE_COLORS[src] || '#888' }}
            title={src.toUpperCase()}
          />
        ))}
      </div>
    </div>
  );
}

// Quarter navigation buttons
function QuarterNav({ availableQuarters, currentQuarter, onSelect }) {
  if (!availableQuarters || availableQuarters.length <= 1) return null;

  return (
    <div className="quarter-nav">
      {availableQuarters.slice(0, 6).map(q => {
        const parsed = parseQuarterKey(q);
        const label = parsed ? `Q${parsed.quarter} '${String(parsed.year).slice(2)}` : q;
        return (
          <button
            key={q}
            className={`quarter-btn ${q === currentQuarter ? 'active' : ''}`}
            onClick={() => onSelect(q)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// Warning banner for data discrepancies
function DiscrepancyWarning({ discrepancies }) {
  if (!discrepancies || discrepancies.length === 0) return null;

  return (
    <div className="discrepancy-warning">
      <span className="warning-icon">⚠</span>
      <span>{discrepancies.length} data discrepanc{discrepancies.length > 1 ? 'ies' : 'y'} detected</span>
    </div>
  );
}

// Earnings night live indicator
function EarningsNightIndicator() {
  return (
    <div className="earnings-night-indicator">
      <span className="pulse-dot"></span>
      LIVE - Earnings Night
    </div>
  );
}

// Single metric display (EPS or Revenue)
function MetricDisplay({ label, metric, sources, isEarningsNight, formatValue }) {
  const hasActual = metric?.actual != null;
  const hasEstimate = metric?.estimate != null;

  // Collect all sources for this metric
  const allSources = [
    ...(sources?.estimate || []),
    ...(sources?.actual || [])
  ];

  // Determine metric confidence
  const metricConfidence = sources?.actual?.length >= 2
    ? CONFIDENCE.VALIDATED
    : sources?.actual?.length === 1
      ? CONFIDENCE.SINGLE
      : 'pending';

  return (
    <div className="earnings-metric">
      <div className="metric-header">
        <div className="metric-label">{label}</div>
        {allSources.length > 0 && (
          <SourceIndicator sources={allSources} confidence={metricConfidence} />
        )}
      </div>

      <div className="metric-row">
        <span className="metric-sublabel">Estimate</span>
        <span className="metric-value">
          {hasEstimate ? formatValue(metric.estimate) : 'N/A'}
        </span>
      </div>

      {hasActual ? (
        <>
          <div className="metric-row">
            <span className="metric-sublabel">Actual</span>
            <span className="metric-value">{formatValue(metric.actual)}</span>
          </div>
          <div className={`metric-result ${metric.surprise >= 0 ? 'beat' : 'miss'}`}>
            {metric.surprise >= 0 ? 'BEAT' : 'MISS'} by {formatValue(Math.abs(metric.surprise))}
            {metric.surprisePercent != null && (
              <span className="surprise-percent">
                {' '}({metric.surprise >= 0 ? '+' : ''}{metric.surprisePercent.toFixed(1)}%)
              </span>
            )}
          </div>
        </>
      ) : (
        <div className="metric-pending">
          {isEarningsNight ? 'Awaiting results...' : 'Results pending'}
        </div>
      )}
    </div>
  );
}

// Expandable details section
function DataDetails({ data, allSources }) {
  if (!data) return null;

  return (
    <div className="data-details">
      <div className="detail-row">
        <span>Last updated:</span>
        <span>{data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : 'N/A'}</span>
      </div>
      <div className="detail-row">
        <span>Confidence:</span>
        <span className={`confidence-${data.confidence}`}>{data.confidence}</span>
      </div>
      <div className="detail-row">
        <span>Sources:</span>
        <span>{allSources.length > 0 ? allSources.join(', ') : 'None'}</span>
      </div>

      {data.discrepancies && data.discrepancies.length > 0 && (
        <div className="discrepancies-list">
          <h4>Discrepancies</h4>
          {data.discrepancies.map((d, i) => (
            <div key={i} className="discrepancy-item">
              <span>{d.field}:</span>
              <span>
                {d.existingSource}: {d.existing} vs {d.newSource}: {d.new}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * EarningsData Component
 *
 * Displays earnings data (EPS and Revenue) with source indicators,
 * confidence badges, quarter navigation, and discrepancy warnings.
 */
export default function EarningsData({
  data,              // QuarterEarnings object
  availableQuarters, // string[] - available quarter keys
  onQuarterSelect,   // (quarter: string) => void
  isEarningsNight    // boolean
}) {
  const [showDetails, setShowDetails] = useState(false);

  // Loading state
  if (!data) {
    return (
      <div className="earnings-data">
        <div className="section-header">
          <h3>Earnings</h3>
        </div>
        <div className="earnings-loading-msg">Loading estimates...</div>
      </div>
    );
  }

  const {
    eps,
    revenue,
    sources,
    confidence,
    discrepancies,
    fiscalQuarter,
    fiscalYear,
    quarter
  } = data;

  // Collect all unique sources for header display
  const allSources = [...new Set([
    ...(sources?.eps?.estimate || []),
    ...(sources?.eps?.actual || []),
    ...(sources?.revenue?.estimate || []),
    ...(sources?.revenue?.actual || [])
  ])];

  // Format functions
  const formatEps = (val) => val != null ? `$${val.toFixed(2)}` : 'N/A';

  return (
    <div className="earnings-data">
      {/* Header */}
      <div className="section-header">
        <h3>Earnings</h3>
        <div className="header-right">
          <span className="earnings-period">{formatQuarter(fiscalQuarter, fiscalYear)}</span>
          <SourceIndicator sources={allSources} confidence={confidence} />
        </div>
      </div>

      {/* Quarter Navigation */}
      <QuarterNav
        availableQuarters={availableQuarters}
        currentQuarter={quarter}
        onSelect={onQuarterSelect}
      />

      {/* Discrepancy Warning */}
      <DiscrepancyWarning discrepancies={discrepancies} />

      {/* Earnings Night Indicator */}
      {isEarningsNight && <EarningsNightIndicator />}

      {/* Metrics Grid */}
      <div className="earnings-grid-data">
        <MetricDisplay
          label="EPS"
          metric={eps}
          sources={sources?.eps}
          isEarningsNight={isEarningsNight}
          formatValue={formatEps}
        />

        <MetricDisplay
          label="Revenue"
          metric={revenue}
          sources={sources?.revenue}
          isEarningsNight={isEarningsNight}
          formatValue={formatRevenue}
        />
      </div>

      {/* Details Toggle */}
      <button
        className="details-toggle"
        onClick={() => setShowDetails(!showDetails)}
      >
        {showDetails ? 'Hide' : 'Show'} data sources
      </button>

      {/* Expandable Details */}
      {showDetails && (
        <DataDetails data={data} allSources={allSources} />
      )}
    </div>
  );
}
