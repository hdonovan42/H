import React from 'react';

function balanceColor(balance) {
  if (balance > 25) return 'green';
  if (balance > 10) return 'amber';
  return 'red';
}

function formatCost(n) {
  if (n == null) return 'N/A';
  return `$${n.toFixed(2)}`;
}

export default function StatusBar({ status }) {
  if (!status) return null;

  const {
    balance, positions_value, total_value, burn_rate, runway_days, cycle_count,
    total_api_costs, total_pnl, account_pnl, verified_deposits, alive_days, paused,
  } = status;

  const displayBalance = total_value ?? balance;
  // Account P&L (value − verified deposits) is the honest figure; total_pnl is
  // a gross per-trade tally that drifts from reality. Fall back if API is old.
  const acctPnl = account_pnl ?? total_pnl;

  return (
    <div className="status-bar">
      <div className="stat">
        <div className="stat-label">Total Value</div>
        <div className={`stat-value ${balanceColor(displayBalance)}`}>
          ${displayBalance.toFixed(2)}
        </div>
        <div className="stat-sub">
          {positions_value > 0
            ? `cash + mark-to-market`
            : 'cash only (no open positions)'}
        </div>
      </div>

      <div className="stat">
        <div className="stat-label">Cash</div>
        <div className="stat-value">${balance.toFixed(2)}</div>
        <div className="stat-sub">available to bet</div>
      </div>

      <div className="stat">
        <div className="stat-label">P/L</div>
        <div className={`stat-value ${acctPnl > 0 ? 'green' : acctPnl < 0 ? 'red' : ''}`}>
          {acctPnl >= 0 ? '+' : ''}{formatCost(acctPnl)}
        </div>
        <div className="stat-sub">
          {verified_deposits != null ? `vs ${formatCost(verified_deposits)} in` : 'since inception'}
        </div>
      </div>

      <div className="stat">
        <div className="stat-label">Runway</div>
        <div className={`stat-value ${runway_days != null && runway_days < 7 ? 'red' : runway_days != null && runway_days < 30 ? 'amber' : ''}`}>
          {runway_days != null ? `${runway_days} days` : 'N/A'}
        </div>
        <div className="stat-sub">until death</div>
      </div>

      <div className="stat">
        <div className="stat-label">Burn Rate</div>
        <div className="stat-value">
          {burn_rate != null ? `${formatCost(burn_rate)}/day` : 'N/A'}
        </div>
        <div className="stat-sub">API costs per day</div>
      </div>

      <div className="stat">
        <div className="stat-label">Time Alive</div>
        <div className="stat-value">{alive_days != null ? `${alive_days}d` : 'N/A'}</div>
        <div className="stat-sub">{cycle_count} cycles{paused ? ' (paused)' : ''}</div>
      </div>
    </div>
  );
}
