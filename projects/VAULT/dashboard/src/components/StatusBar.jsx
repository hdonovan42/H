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
    total_api_costs, total_pnl, alive_days, paused,
  } = status;

  const displayBalance = total_value ?? balance;

  return (
    <div className="status-bar">
      <div className="stat">
        <div className="stat-label">Total Value</div>
        <div className={`stat-value ${balanceColor(displayBalance)}`}>
          ${displayBalance.toFixed(2)}
        </div>
        <div className="stat-sub">
          {positions_value > 0
            ? `$${balance.toFixed(2)} cash + $${positions_value.toFixed(2)} positions`
            : 'of $50.00 seed'}
        </div>
      </div>

      <div className="stat">
        <div className="stat-label">Trading P&L</div>
        <div className={`stat-value ${total_pnl >= 0 ? 'green' : 'red'}`}>
          {total_pnl >= 0 ? '+' : ''}{formatCost(total_pnl)}
        </div>
        <div className="stat-sub">realised</div>
      </div>

      <div className="stat">
        <div className="stat-label">Runway</div>
        <div className={`stat-value ${runway_days != null && runway_days < 30 ? 'amber' : runway_days != null && runway_days < 7 ? 'red' : ''}`}>
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
        <div className="stat-label">ARR</div>
        <div className={`stat-value ${total_pnl === 0 ? '' : alive_days >= 1 ? ((total_value - 50) / 50 / alive_days * 365 >= 0 ? 'green' : 'red') : ''}`}>
          {total_pnl === 0 ? '0%' : alive_days >= 1 ? `${(total_value - 50) / 50 / alive_days * 365 * 100 >= 0 ? '+' : ''}${Math.round((total_value - 50) / 50 / alive_days * 365 * 100)}%` : 'N/A'}
        </div>
        <div className="stat-sub">annualised return</div>
      </div>

      <div className="stat">
        <div className="stat-label">Cycles</div>
        <div className="stat-value">{cycle_count}</div>
        <div className="stat-sub">{alive_days > 0 ? `${alive_days} days alive` : ''}{paused ? ' (paused)' : ''}</div>
      </div>
    </div>
  );
}
