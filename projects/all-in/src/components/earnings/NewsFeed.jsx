import { useState, useEffect } from 'react';
import { WORKER_URL } from '../../utils/config';

export default function NewsFeed({ ticker }) {
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchNews = async () => {
      try {
        const res = await fetch(`${WORKER_URL}/news/cnbc/${ticker}`);
        if (res.ok) {
          const data = await res.json();
          setNews(data.slice(0, 10)); // Show top 10 articles
        }
      } catch (error) {
        console.error('Error fetching news:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchNews();
    const interval = setInterval(fetchNews, 15000); // Refresh every 15s for earnings
    return () => clearInterval(interval);
  }, [ticker]);

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="news-feed">
      <div className="section-header">
        <h3>CNBC</h3>
      </div>

      {loading && <div className="news-loading">Loading news...</div>}

      {!loading && news.length === 0 && (
        <div className="news-empty">No recent news</div>
      )}

      <div className="news-list">
        {news.map((item, index) => (
          <a
            key={index}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="news-item"
          >
            <div className="news-source">{item.source}</div>
            <div className="news-title">{item.title}</div>
            <div className="news-time">{formatTime(item.publishedAt)}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
