import { useState, useEffect } from 'react';
import { WORKER_URL } from '../../utils/config';

export default function TwitterEmbed() {
  const [tweets, setTweets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTweets = async () => {
      try {
        const res = await fetch(`${WORKER_URL}/nitter/SawyerMerritt`);
        if (res.ok) {
          const data = await res.json();
          setTweets(data);
        }
      } catch (error) {
        console.error('Error fetching tweets:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchTweets();
    const interval = setInterval(fetchTweets, 15000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const diffMins = Math.floor((Date.now() - date) / 60000);
    if (diffMins < 60) return `${diffMins}m`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h`;
    return date.toLocaleDateString();
  };

  return (
    <div className="twitter-embed">
      <div className="section-header">
        <h3>@SawyerMerritt</h3>
      </div>

      {loading && <div className="twitter-loading">Loading...</div>}

      {!loading && tweets.length === 0 && (
        <div className="twitter-empty">No tweets available</div>
      )}

      <div className="tweet-list">
        {tweets.map((tweet, i) => (
          <a key={i} href={tweet.url} target="_blank" rel="noopener noreferrer" className="tweet-item">
            <div className="tweet-text">{tweet.text}</div>
            <div className="tweet-time">{formatTime(tweet.date)}</div>
          </a>
        ))}
      </div>

      <a href="https://x.com/SawyerMerritt" target="_blank" rel="noopener noreferrer" className="twitter-fallback-link">
        View on X →
      </a>
    </div>
  );
}
