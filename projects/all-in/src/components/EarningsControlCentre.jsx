import { useState, useEffect, useRef } from 'react';
import { getMarketState, getTodayEST, MarketState, dayjs } from '../utils/marketState';
import { fetchPriceData, fetchMarketClock } from '../utils/api';
import { WORKER_URL, EST } from '../utils/config';
import VideoEmbed from './earnings/VideoEmbed';
import TranscriptEmbed from './earnings/TranscriptEmbed';
import PriceDisplay from './earnings/PriceDisplay';
import EarningsData from './earnings/EarningsData';
import NewsFeed from './earnings/NewsFeed';
import TwitterEmbed from './earnings/TwitterEmbed';
import '../styles/earnings.css';

// Configuration - update these before each earnings call
const CONFIG = {
  youtubeUrl: 'https://www.youtube.com/watch?v=GQ9S7xbkGAY&t=80s', // e.g., 'https://www.youtube.com/watch?v=VIDEO_ID'
  quartrUrl: 'https://quartr.com/companies/tesla-inc_3706',
  ticker: 'TSLA',
  // Set to null during live call, populate after call ends
  transcriptUrl: null // e.g., '/transcripts/tsla-q4-2025.json'
};

// Sample transcript structure (for testing - remove in production)
// In production, this would be fetched from CONFIG.transcriptUrl or a worker endpoint
const SAMPLE_TRANSCRIPT = null; // Set to null to show "live mode"
/* Example transcript structure:
{
  segments: [
    { start: 0, end: 45, speaker: "Operator", text: "Good day, and thank you for standing by..." },
    { start: 45, end: 120, speaker: "Elon Musk", text: "Thanks for joining us today..." },
  ],
  metadata: {
    ticker: "TSLA",
    quarter: "Q4 2025",
    date: "2026-01-28",
    source: "fool.com"
  }
}
*/

export default function EarningsControlCentre() {
  const [quote, setQuote] = useState(null);
  const [currentMarketState, setCurrentMarketState] = useState(getMarketState());
  const [clockData, setClockData] = useState(null);
  const [earningsData, setEarningsData] = useState(null);
  const [postMarketData, setPostMarketData] = useState([]);
  const [transcript, setTranscript] = useState(SAMPLE_TRANSCRIPT);
  const [loading, setLoading] = useState(true);

  const clockDataRef = useRef(null);
  const videoRef = useRef(null);

  // Handle seek from transcript click
  const handleTranscriptSeek = (seconds) => {
    if (videoRef.current) {
      videoRef.current.seekTo(seconds);
    }
  };

  // Fetch transcript if URL is configured
  useEffect(() => {
    if (!CONFIG.transcriptUrl) return;

    const fetchTranscript = async () => {
      try {
        const res = await fetch(CONFIG.transcriptUrl);
        if (res.ok) {
          const data = await res.json();
          setTranscript(data);
        }
      } catch (error) {
        console.error('Error fetching transcript:', error);
      }
    };
    fetchTranscript();
  }, []);

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

  // Fetch earnings data from Finnhub
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

  // Fetch post-market chart data (1-minute bars for earnings night)
  useEffect(() => {
    const fetchPostMarket = async () => {
      try {
        const res = await fetch(`${WORKER_URL}/yahoo/${CONFIG.ticker}?range=1d&interval=1m&includePrePost=true`);
        if (res.ok) {
          const data = await res.json();
          if (data?.chart?.result?.[0]) {
            const result = data.chart.result[0];
            const timestamps = result.timestamp || [];
            const quote = result.indicators.quote[0];

            const bars = timestamps.map((t, i) => ({
              date: dayjs.unix(t).tz(EST).toISOString(),
              open: quote.open[i],
              high: quote.high[i],
              low: quote.low[i],
              close: quote.close[i],
              volume: quote.volume[i] || 0
            })).filter(b => b.close !== null);

            setPostMarketData(bars);
          }
        }
      } catch (error) {
        console.error('Error fetching post-market data:', error);
      }
    };

    fetchPostMarket();
    const interval = setInterval(fetchPostMarket, 10000); // Refresh every 10s for earnings night
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <div className="earnings-loading">Loading...</div>;
  }

  return (
    <div className="earnings-container">
      <header className="earnings-header">
        <h1>TSLA Earnings</h1>
        <div className="market-status">
          <span className={`status-dot ${currentMarketState.isRegularHours ? 'open' : 'closed'}`}></span>
          <span>{currentMarketState.state.replace('-', ' ').toUpperCase()}</span>
        </div>
      </header>

      <div className="earnings-grid">
        {/* Left Column: Price & Earnings Data */}
        <div className="earnings-left">
          <PriceDisplay quote={quote} marketState={currentMarketState} postMarketData={postMarketData} />
          <EarningsData data={earningsData} />
        </div>

        {/* Middle Column: Video & Transcript */}
        <div className="earnings-middle">
          <VideoEmbed ref={videoRef} url={CONFIG.youtubeUrl} />
          <TranscriptEmbed
            transcript={transcript}
            onSeek={handleTranscriptSeek}
            liveUrl={CONFIG.quartrUrl}
          />
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
