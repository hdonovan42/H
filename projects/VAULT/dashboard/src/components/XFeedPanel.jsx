import React from 'react';

export default function XFeedPanel({ tweets }) {
  if (!tweets || tweets.length === 0) {
    return (
      <div className="card">
        <div className="card-title">X/Twitter Feed</div>
        <div className="empty">No tweets collected yet</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-title">X/Twitter Feed ({tweets.length})</div>
      <div className="tweet-list">
        {tweets.map((t, i) => (
          <div key={t.tweet_id || i} className="tweet-item">
            <div className="tweet-author">
              @{t.author}
              {t.retweeted_by && <span className="tweet-rt-by"> (RT by @{t.retweeted_by})</span>}
            </div>
            <div className="tweet-text">{t.text}</div>
            <div className="tweet-meta">
              {t.likes > 0 && <span>{t.likes.toLocaleString()} likes</span>}
              {t.retweets > 0 && <span>{t.retweets.toLocaleString()} RT</span>}
              {t.created_at && <span>{t.created_at.slice(0, 16).replace('T', ' ')}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
