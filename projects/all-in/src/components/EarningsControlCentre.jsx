import { useState, useEffect, useRef } from 'react';
import { getMarketState, getTodayEST, MarketState } from '../utils/marketState';
import { fetchPriceData, fetchMarketClock } from '../utils/api';
import { WORKER_URL } from '../utils/config';
import VideoEmbed from './earnings/VideoEmbed';
import TranscriptEmbed from './earnings/TranscriptEmbed';
import PriceDisplay from './earnings/PriceDisplay';
import EarningsData from './earnings/EarningsData';
import NewsFeed from './earnings/NewsFeed';
import TwitterEmbed from './earnings/TwitterEmbed';
import '../styles/earnings.css';

// Configuration - update these before each earnings call
const CONFIG = {
  youtubeUrl: '', // e.g., 'https://www.youtube.com/embed/LIVE_STREAM_ID'
  quartrUrl: 'https://quartr.com/companies/tesla-inc',
  ticker: 'TSLA'
};

export default function EarningsControlCentre() {
  const [quote, setQuote] = useState(null);
  const [currentMarketState, setCurrentMarketState] = useState(getMarketState());
  const [clockData, setClockData] = useState(null);
  const [earningsData, setEarningsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const clockDataRef = useRef(null);

  // Fetch market clock
  useEffect(() => {
    const loadClock = async () => {
      const clock = await fetchMarketClock();
      if (clock) {
        clockDataRef.current = clock;
        setClockData(clock);
      }
    };
    loadClock();
    const interval = setInterval(loadClock, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Update market state
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentMarketState(getMarketState(clockDataRef.current));
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Fetch price data
  useEffect(() => {
    const fetchData = async () => {
      try {
        const { data: priceData } = await fetchPriceData(CONFIG.ticker, clockDataRef.current);
        if (priceData) {
          setQuote({
            c: priceData.currentPrice,
            pc: priceData.previousClose,
            o: priceData.open,
            h: priceData.high,
            l: priceData.low,
            d: priceData.currentPrice - priceData.previousClose,
            dp: ((priceData.currentPrice - priceData.previousClose) / priceData.previousClose) * 100,
            extendedHoursPrice: priceData.extendedHoursPrice,
            extendedHoursType: priceData.extendedHoursType
          });
        }
        setLoading(false);
      } catch (error) {
        console.error('Error fetching price:', error);
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5000); // Poll every 5s during earnings
    return () => clearInterval(interval);
  }, []);

  // Fetch earnings estimates
  useEffect(() => {
    const fetchEarnings = async () => {
      try {
        const res = await fetch(`${WORKER_URL}/finnhub/earnings/${CONFIG.ticker}`);
        if (res.ok) {
          const data = await res.json();
          setEarningsData(data);
        }
      } catch (error) {
        console.error('Error fetching earnings:', error);
      }
    };
    fetchEarnings();
    const interval = setInterval(fetchEarnings, 30000); // Poll for actuals
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <div className="earnings-loading">Loading...</div>;
  }

  return (
    <div className="earnings-container">
      <header className="earnings-header">
        <h1>TSLA Earnings Control Centre</h1>
        <div className="market-status">
          <span className={`status-dot ${currentMarketState.isRegularHours ? 'open' : 'closed'}`}></span>
          <span>{currentMarketState.state.replace('-', ' ').toUpperCase()}</span>
        </div>
      </header>

      <div className="earnings-grid">
        {/* Left Column: Price & Earnings Data */}
        <div className="earnings-left">
          <PriceDisplay quote={quote} marketState={currentMarketState} />
          <EarningsData data={earningsData} />
        </div>

        {/* Middle Column: Video & Transcript */}
        <div className="earnings-middle">
          <VideoEmbed url={CONFIG.youtubeUrl} />
          <TranscriptEmbed url={CONFIG.quartrUrl} />
        </div>

        {/* Right Column: News & Twitter */}
        <div className="earnings-right">
          <NewsFeed ticker={CONFIG.ticker} />
          <TwitterEmbed />
        </div>
      </div>
    </div>
  );
}
