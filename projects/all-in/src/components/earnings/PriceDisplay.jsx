import { useState, useCallback } from 'react';
import { MarketState } from '../../utils/marketState';
import { formatRevenue } from '../../types/earnings';
import PostMarketChart from './PostMarketChart';
import FullscreenChart from './FullscreenChart';

export default function PriceDisplay({ quote, marketState, postMarketData, earningsData }) {
  const [fullscreen, setFullscreen] = useState(false);

  const handleDoubleClick = useCallback(() => {
    setFullscreen(prev => !prev);
  }, []);

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

  const eps = earningsData?.eps;
  const rev = earningsData?.revenue;
  const hasEarnings = eps?.actual != null || rev?.actual != null;

  return (
    <div
      className={`price-display${fullscreen ? ' price-display--fullscreen' : ''}`}
      onDoubleClick={handleDoubleClick}
    >
      <div className={fullscreen ? 'fs-top-row' : ''}>
        <div>
          <div className="section-header">
            <h3>TSLA</h3>
            <span className="price-label">
              {showExtended ? 'After Hours' : 'Regular'}
            </span>
          </div>

          <div className="price-main">
            <span className={`price-value ${displayPrice >= closePrice ? 'positive' : 'negative'}`}>${displayPrice?.toFixed(2)}</span>
            {showExtended && (
              <span className={`price-post ${extendedPositive ? 'positive' : 'negative'}`}>
                Post: {extendedPositive ? '+' : ''}${Math.abs(extendedChange).toFixed(2)} {extendedPositive ? '+' : ''}{extendedChangePercent.toFixed(2)}%
              </span>
            )}
          </div>
        </div>

        {fullscreen && hasEarnings && (
          <div className="fs-earnings-summary">
            {eps?.actual != null && (
              <div className="fs-metric-row">
                <span className="fs-metric-label">EPS</span>
                <span className="fs-metric-actual">${eps.actual.toFixed(2)}</span>
                {eps.estimate != null && (
                  <>
                    <span className="fs-metric-vs">vs ${eps.estimate.toFixed(2)}</span>
                    <span className={`fs-badge ${eps.actual >= eps.estimate ? 'fs-badge--beat' : 'fs-badge--miss'}`}>
                      {eps.actual >= eps.estimate ? 'BEAT' : 'MISS'}
                    </span>
                  </>
                )}
              </div>
            )}
            {rev?.actual != null && (
              <div className="fs-metric-row">
                <span className="fs-metric-label">Rev</span>
                <span className="fs-metric-actual">{formatRevenue(rev.actual)}</span>
                {rev.estimate != null && (
                  <>
                    <span className="fs-metric-vs">vs {formatRevenue(rev.estimate)}</span>
                    <span className={`fs-badge ${rev.actual >= rev.estimate ? 'fs-badge--beat' : 'fs-badge--miss'}`}>
                      {rev.actual >= rev.estimate ? 'BEAT' : 'MISS'}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {fullscreen
        ? <FullscreenChart data={postMarketData} closePrice={closePrice} />
        : <PostMarketChart data={postMarketData} closePrice={closePrice} />
      }
    </div>
  );
}
