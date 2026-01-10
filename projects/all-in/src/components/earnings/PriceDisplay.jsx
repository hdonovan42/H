import { MarketState } from '../../utils/marketState';
import PostMarketChart from './PostMarketChart';

export default function PriceDisplay({ quote, marketState, postMarketData }) {
  if (!quote) return null;

  // Determine which price to show prominently (keep post-market visible after close)
  const showExtended = (marketState.state === MarketState.POST_MARKET || marketState.state === MarketState.CLOSED) && quote.extendedHoursPrice;
  const displayPrice = showExtended ? quote.extendedHoursPrice : quote.c;

  // Show today's close if market has closed, otherwise show yesterday's close
  const marketClosed = marketState.state === MarketState.POST_MARKET || marketState.state === MarketState.CLOSED;
  const closePrice = marketClosed ? quote.c : quote.pc;

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
        <span className={`price-value ${displayPrice >= closePrice ? 'positive' : 'negative'}`}>${displayPrice?.toFixed(2)}</span>
      </div>

      {showExtended && (
        <div className="price-extended">
          <span className={`price-post ${extendedPositive ? 'positive' : 'negative'}`}>
            Post: {extendedPositive ? '+' : ''}${Math.abs(extendedChange).toFixed(2)} {extendedPositive ? '+' : ''}{extendedChangePercent.toFixed(2)}%
          </span>
        </div>
      )}

      <div className="price-close">Close: ${closePrice?.toFixed(2)}</div>

      <PostMarketChart data={postMarketData} closePrice={closePrice} />
    </div>
  );
}
