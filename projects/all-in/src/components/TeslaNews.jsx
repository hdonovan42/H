import { useState, useEffect, useCallback } from 'react';
import { WORKER_URL } from '../utils/config';
import '../styles/news.css';

const getRelativeTime = (dateString) => {
  const now = new Date();
  const date = new Date(dateString);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
};

const getSourceStyle = (source) => {
  const s = (source || '').toLowerCase();
  if (s === 'sec') return { background: '#1a4b8c', color: '#fff' };
  if (s === 'x') return { background: '#000', color: '#fff' };
  return { background: '#2d5a3d', color: '#fff' };
};

export default function TeslaNews() {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');
  const [tweetUrl, setTweetUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [updating, setUpdating] = useState(false);

  const fetchNews = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch(`${WORKER_URL}/news/TSLA?limit=500`);
      if (!response.ok) throw new Error('Failed to fetch news');
      const data = await response.json();
      setArticles(data.news || data.articles || []);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const triggerUpdate = async () => {
    setUpdating(true);
    try {
      const response = await fetch(`${WORKER_URL}/news/update`);
      const data = await response.json();
      console.log('Update result:', data);
      await fetchNews();
    } catch (err) {
      console.error('Update failed:', err);
    } finally {
      setUpdating(false);
    }
  };

  const handleAddTweet = async (e) => {
    e.preventDefault();
    if (!tweetUrl.trim()) return;

    if (!tweetUrl.includes('x.com') && !tweetUrl.includes('twitter.com')) {
      setSubmitError('Please enter a valid X/Twitter URL');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const response = await fetch(`${WORKER_URL}/news/tweet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: tweetUrl, note: '' })
      });

      if (!response.ok) throw new Error('Failed to add tweet');

      setTweetUrl('');
      await fetchNews();
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    fetchNews();
    const interval = setInterval(fetchNews, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchNews]);

  const filteredArticles = articles.filter(article => {
    const src = (article.source || '').toUpperCase();
    if (activeFilter === 'all') return true;
    if (activeFilter === 'SEC') return src === 'SEC' || src.includes('SEC') || src.includes('EDGAR');
    if (activeFilter === 'news') return !src.includes('SEC') && !src.includes('EDGAR') && src !== 'X';
    if (activeFilter === 'X') return src === 'X';
    return true;
  });

  const filters = [
    { key: 'all', label: 'All' },
    { key: 'SEC', label: 'SEC' },
    { key: 'news', label: 'News' },
    { key: 'X', label: 'X' }
  ];

  return (
    <div className="page-wrapper">
      <div className="container">
        <header className="header">
          <div className="header-left">
            <div className="title">TSLA News</div>
            <span className="summary-badge">{articles.length} articles</span>
          </div>
          <a href="index.html" className="back-link">← Stock Tracker</a>
        </header>

        <div className="controls">
          <div className="filters">
            {filters.map(f => (
              <button
                key={f.key}
                className={`filter-btn ${activeFilter === f.key ? 'active' : ''}`}
                onClick={() => setActiveFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            className="update-btn"
            onClick={triggerUpdate}
            disabled={updating}
          >
            {updating ? 'Updating...' : 'Refresh News'}
          </button>
        </div>

        <div className="box">
          {loading ? (
            <div className="loading-state">Loading news...</div>
          ) : error ? (
            <div className="error-state">
              <div>Error: {error}</div>
              <button className="retry-btn" onClick={fetchNews}>Retry</button>
            </div>
          ) : filteredArticles.length === 0 ? (
            <div className="empty-state">
              {articles.length === 0
                ? 'No news yet. Click "Refresh News" to fetch articles.'
                : 'No articles match this filter.'}
            </div>
          ) : (
            <div className="news-list">
              {filteredArticles.map((article, index) => (
                <div key={article.id || index} className="news-item">
                  <span
                    className="source-badge"
                    style={getSourceStyle(article.source)}
                  >
                    {article.source}
                  </span>
                  <div className="news-content">
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="news-title"
                    >
                      {article.title}
                    </a>
                    <div className="news-meta">
                      <span>{getRelativeTime(article.publishedAt)}</span>
                      {article.sourceDisplay && article.sourceDisplay !== article.source && (
                        <span className="news-source-detail">{article.sourceDisplay}</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <form className="tweet-form" onSubmit={handleAddTweet}>
            <input
              type="text"
              className="tweet-input"
              placeholder="Paste X/Twitter URL to add manually..."
              value={tweetUrl}
              onChange={(e) => setTweetUrl(e.target.value)}
              disabled={submitting}
            />
            <button
              type="submit"
              className="tweet-btn"
              disabled={submitting || !tweetUrl.trim()}
            >
              {submitting ? '...' : 'Add'}
            </button>
            {submitError && <span className="error-inline">{submitError}</span>}
          </form>
        </div>

        {lastUpdated && (
          <div className="timestamp">
            Last refreshed: {lastUpdated.toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  );
}
