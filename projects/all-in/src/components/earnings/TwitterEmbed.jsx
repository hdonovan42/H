import { useState, useEffect, useCallback } from 'react';
import { WORKER_URL } from '../../utils/config';

const USERNAME = 'SawyerMerritt';

function formatTime(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatCount(n) {
  if (n == null || n === 0) return '';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function parseTweetText(text) {
  if (!text) return null;
  // Split on mentions, hashtags, and URLs while keeping delimiters
  const parts = text.split(/(@\w+|#\w+|https?:\/\/\S+)/g);
  return parts.map((part, i) => {
    if (part.startsWith('@')) {
      const handle = part.slice(1);
      return (
        <a key={i} href={`https://x.com/${handle}`} className="tweet-link" target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
          {part}
        </a>
      );
    }
    if (part.startsWith('#')) {
      const tag = part.slice(1);
      return (
        <a key={i} href={`https://x.com/hashtag/${tag}`} className="tweet-link" target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
          {part}
        </a>
      );
    }
    if (part.startsWith('http')) {
      return (
        <a key={i} href={part} className="tweet-link" target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
          {part.replace(/^https?:\/\//, '').slice(0, 30)}...
        </a>
      );
    }
    // Preserve line breaks
    return part.split('\n').map((line, j) => (
      <span key={`${i}-${j}`}>{j > 0 && <br />}{line}</span>
    ));
  });
}

const ReplyIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
    <path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.25-.893 4.306-2.394 5.82l-2.382 2.404a1 1 0 0 1-1.421.003l-2.382-2.392C12.154 14.42 11.17 13 9.756 13H6.75a3 3 0 0 0-3 3v2.5a1 1 0 1 1-2 0V13c0-1.636.787-3.089 2.003-4H3.756c-1.107 0-2.005-.896-2.005-2v-1.5a1 1 0 0 1 2 0V7c0 .553.448 1 1.002 1H9.756c2.04 0 3.888.88 5.17 2.28l1.555 1.57 1.562-1.576c1.06-1.07 1.712-2.52 1.712-4.144C19.756 2.988 17.57.8 14.871.8H9.756C5.673.8.751 4.658.751 10z" />
  </svg>
);

const RetweetIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
    <path d="M4.75 3.79l4.603 4.3-1.706 1.82L6 8.38v7.37c0 .97.784 1.75 1.75 1.75H13V19.5H7.75c-1.8 0-3.25-1.46-3.25-3.25V8.38L2.853 9.91 1.147 8.09l3.603-4.3zm11.5 16.42l-4.603-4.3 1.706-1.82L15 15.62V8.25c0-.97-.784-1.75-1.75-1.75H8V4.5h5.25c1.8 0 3.25 1.46 3.25 3.25v7.37l1.647-1.53 1.706 1.82-3.603 4.3z" />
  </svg>
);

const HeartIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
    <path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91z" />
  </svg>
);

export default function TwitterEmbed() {
  const [tweets, setTweets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchTweets = useCallback(async () => {
    try {
      const res = await fetch(`${WORKER_URL}/tweets/${USERNAME}`, { cache: 'no-store' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        setTweets(data);
        setError(null);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTweets();
    const interval = setInterval(fetchTweets, 30000);
    return () => clearInterval(interval);
  }, [fetchTweets]);

  return (
    <div className="twitter-embed">
      <div className="section-header">
        <h3>X</h3>
        <a
          href={`https://x.com/${USERNAME}`}
          target="_blank"
          rel="noopener noreferrer"
          className="tweet-header-link"
        >
          @{USERNAME}
        </a>
      </div>

      <div className="tweet-feed">
        {loading && <div className="tweet-loading">Loading tweets...</div>}
        {error && <div className="tweet-error">{error}</div>}
        {tweets.map(tweet => (
          <a
            key={tweet.id}
            href={tweet.url}
            target="_blank"
            rel="noopener noreferrer"
            className="tweet-card"
          >
            <div className="tweet-card-header">
              <span className="tweet-author">{tweet.author?.name}</span>
              <span className="tweet-handle">@{tweet.author?.handle}</span>
              <span className="tweet-dot">·</span>
              <span className="tweet-time">{formatTime(tweet.date)}</span>
            </div>

            <div className="tweet-text">{parseTweetText(tweet.text)}</div>

            {tweet.media?.length > 0 && (
              <div className="tweet-media">
                {tweet.media.map((m, i) => (
                  <div key={i} className="tweet-media-item">
                    <img src={m.url} alt="" loading="lazy" />
                    {m.type === 'video' && <div className="tweet-media-play">▶</div>}
                  </div>
                ))}
              </div>
            )}

            <div className="tweet-metrics">
              <span className="tweet-metric tweet-metric--reply">
                <ReplyIcon />
                {formatCount(tweet.metrics?.replies)}
              </span>
              <span className="tweet-metric tweet-metric--rt">
                <RetweetIcon />
                {formatCount(tweet.metrics?.retweets)}
              </span>
              <span className="tweet-metric tweet-metric--like">
                <HeartIcon />
                {formatCount(tweet.metrics?.likes)}
              </span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
