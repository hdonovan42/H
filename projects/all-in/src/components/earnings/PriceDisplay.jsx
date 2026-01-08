import { MarketState } from '../../utils/marketState';

export default function PriceDisplay({ quote, marketState }) {
  if (!quote) return null;

  const isPositive = quote.d >= 0;
  const changeClass = isPositive ? 'positive' : 'negative';
  const sign = isPositive ? '+' : '';

  // Determine which price to show prominently
  const showExtended = marketState.state === MarketState.POST_MARKET && quote.extendedHoursPrice;
  const displayPrice = showExtended ? quote.extendedHoursPrice : quote.c;

  // Calculate extended hours change from close
  const extendedChange = showExtended ? quote.extendedHoursPrice - quote.c : 0;
  const extendedChangePercent = showExtended ? (extendedChange / quote.c) * 100 : 0;
  const extendedPositive = extendedChange >= 0;

  return (
    <div className="price-display">
      <div className="section-header">
        <h3>TSLA</h3>
        <span className="price-label">
          {showExtended ? 'After Hours' : 'Regular'}
        </span>
      </div>

      <div className="price-main">
        <span className="price-value">${displayPrice?.toFixed(2)}</span>
        <span className={`price-change ${changeClass}`}>
          {sign}${quote.d?.toFixed(2)} ({sign}{quote.dp?.toFixed(2)}%)
        </span>
      </div>

      {showExtended && (
        <div className="price-extended">
          <span className="extended-label">Change from close:</span>
          <span className={`extended-change ${extendedPositive ? 'positive' : 'negative'}`}>
            {extendedPositive ? '+' : ''}${extendedChange.toFixed(2)} ({extendedPositive ? '+' : ''}{extendedChangePercent.toFixed(2)}%)
          </span>
        </div>
      )}

      <div className="price-details">
        <div className="price-row">
          <span>Open</span>
          <span>${quote.o?.toFixed(2)}</span>
        </div>
        <div className="price-row">
          <span>High</span>
          <span>${quote.h?.toFixed(2)}</span>
        </div>
        <div className="price-row">
          <span>Low</span>
          <span>${quote.l?.toFixed(2)}</span>
        </div>
        <div className="price-row">
          <span>Prev Close</span>
          <span>${quote.pc?.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
