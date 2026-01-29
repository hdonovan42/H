/**
 * Earnings Data Types
 *
 * @typedef {'single' | 'partial' | 'validated'} ConfidenceLevel
 * - single: Data from one source only
 * - partial: Multiple sources but with discrepancies
 * - validated: Multiple sources agree
 *
 * @typedef {Object} EarningsMetric
 * @property {number|null} estimate - Analyst consensus estimate
 * @property {number|null} actual - Reported actual value
 * @property {number|null} surprise - Actual minus estimate
 * @property {number|null} surprisePercent - Surprise as percentage of estimate
 *
 * @typedef {Object} SourceTracking
 * @property {string[]} estimate - Sources that provided estimate
 * @property {string[]} actual - Sources that provided actual
 *
 * @typedef {Object} Discrepancy
 * @property {string} field - e.g., "eps.actual"
 * @property {number} existing - Value from first source
 * @property {string} existingSource - First source name
 * @property {number} new - Value from conflicting source
 * @property {string} newSource - Conflicting source name
 *
 * @typedef {Object} QuarterEarnings
 * @property {string} ticker
 * @property {number} fiscalYear
 * @property {number} fiscalQuarter
 * @property {string} quarter - e.g., "2025-Q4"
 * @property {EarningsMetric} eps
 * @property {EarningsMetric} revenue
 * @property {{ eps: SourceTracking, revenue: SourceTracking }} sources
 * @property {ConfidenceLevel} confidence
 * @property {Discrepancy[]} discrepancies
 * @property {string} lastUpdated - ISO timestamp
 *
 * @typedef {Object} EarningsState
 * @property {QuarterEarnings|null} current
 * @property {string[]} availableQuarters
 * @property {boolean} isLoading
 * @property {boolean} isEarningsNight
 * @property {string|null} error
 * @property {number} pollInterval - Current poll interval in ms
 */

// Confidence level constants
export const CONFIDENCE = {
  SINGLE: 'single',
  PARTIAL: 'partial',
  VALIDATED: 'validated'
};

// Source constants with display info
export const SOURCES = {
  FMP: { key: 'fmp', label: 'FMP', color: '#6b9fff' },
  ALPHAVANTAGE: { key: 'alphavantage', label: 'Alpha', color: '#fbbf24' },
  EDGAR: { key: 'edgar', label: 'SEC', color: '#4ade80' },
  FINNHUB: { key: 'finnhub', label: 'Finnhub', color: '#f472b6' }
};

// Source color lookup
export const SOURCE_COLORS = {
  fmp: '#6b9fff',
  'fmp-surprises': '#6b9fff',
  alphavantage: '#fbbf24',
  edgar: '#4ade80',
  finnhub: '#f472b6'
};

// Polling intervals in ms
export const POLL_INTERVALS = {
  EARNINGS_NIGHT: 5000,     // 5 seconds during earnings
  EARNINGS_NIGHT_HIDDEN: 30000, // 30 seconds when tab hidden during earnings
  NORMAL: 30000,            // 30 seconds normal
  BACKGROUND: 300000        // 5 minutes when tab not visible
};

// Default earnings state
export const DEFAULT_EARNINGS_STATE = {
  current: null,
  availableQuarters: [],
  isLoading: true,
  isEarningsNight: false,
  error: null,
  pollInterval: POLL_INTERVALS.NORMAL
};

/**
 * Format revenue for display
 * @param {number|null} value - Revenue in dollars
 * @returns {string} Formatted string like "$25.8B"
 */
export function formatRevenue(value) {
  if (value == null) return 'N/A';
  if (value >= 1e9) return `$${(value / 1e9).toPrecision(3)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toPrecision(3)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toPrecision(3)}K`;
  return `$${value.toLocaleString()}`;
}

/**
 * Format quarter for display
 * @param {number} quarter - 1-4
 * @param {number} year - e.g., 2025
 * @returns {string} Formatted string like "Q4 2025"
 */
export function formatQuarter(quarter, year) {
  if (!quarter || !year) return '';
  return `Q${quarter} ${year}`;
}

/**
 * Parse quarter key to components
 * @param {string} quarterKey - e.g., "2025-Q4"
 * @returns {{ year: number, quarter: number } | null}
 */
export function parseQuarterKey(quarterKey) {
  if (!quarterKey) return null;
  const match = quarterKey.match(/(\d{4})-Q(\d)/);
  if (!match) return null;
  return {
    year: parseInt(match[1]),
    quarter: parseInt(match[2])
  };
}
