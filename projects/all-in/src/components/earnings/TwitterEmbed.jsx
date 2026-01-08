import { useEffect, useRef } from 'react';

// Key Tesla accounts to follow during earnings
const TWITTER_LIST_URL = 'https://twitter.com/i/lists/1234567890'; // Replace with your list URL
const ACCOUNTS = ['elonmusk', 'SawyerMerritt', 'WholeMarsBlog', 'TeslaAIBot'];

export default function TwitterEmbed() {
  const containerRef = useRef(null);

  useEffect(() => {
    // Load Twitter widget script if not already loaded
    if (!window.twttr) {
      const script = document.createElement('script');
      script.src = 'https://platform.twitter.com/widgets.js';
      script.async = true;
      document.body.appendChild(script);
    } else {
      // If already loaded, render widgets
      window.twttr.widgets?.load(containerRef.current);
    }
  }, []);

  return (
    <div className="twitter-embed" ref={containerRef}>
      <div className="section-header">
        <h3>X / Twitter</h3>
        <div className="twitter-accounts">
          {ACCOUNTS.map(account => (
            <a
              key={account}
              href={`https://twitter.com/${account}`}
              target="_blank"
              rel="noopener noreferrer"
              className="twitter-account-link"
            >
              @{account}
            </a>
          ))}
        </div>
      </div>

      <div className="twitter-timeline-container">
        {/* Option 1: Embedded timeline for a Twitter List */}
        {/* Create a list with key accounts and embed it */}
        <a
          className="twitter-timeline"
          data-height="400"
          data-theme="dark"
          data-chrome="noheader nofooter noborders transparent"
          href="https://twitter.com/elonmusk"
        >
          Loading tweets...
        </a>

        {/* Fallback / placeholder */}
        <div className="twitter-placeholder">
          <p>Create a Twitter List with key accounts:</p>
          <ul>
            {ACCOUNTS.map(account => (
              <li key={account}>@{account}</li>
            ))}
          </ul>
          <p className="placeholder-hint">
            Then embed the list timeline here for best experience
          </p>
        </div>
      </div>
    </div>
  );
}
