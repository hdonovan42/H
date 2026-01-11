import { useState, useEffect, useRef } from 'react';

export default function TwitterEmbed() {
  const [activeKey, setActiveKey] = useState(0);
  const [loadingKey, setLoadingKey] = useState(null);
  const loadingRef = useRef(null);

  useEffect(() => {
    // Refresh iframe every 15 seconds
    const interval = setInterval(() => {
      setLoadingKey(Date.now());
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  const handleLoad = () => {
    // New iframe loaded, swap it in
    if (loadingKey !== null) {
      setActiveKey(loadingKey);
      setLoadingKey(null);
    }
  };

  return (
    <div className="twitter-embed">
      <div className="section-header">
        <h3>@SawyerMerritt</h3>
      </div>
      <div className="nitter-wrapper">
        {/* Active iframe */}
        <iframe
          key={activeKey}
          src="https://nitter.net/SawyerMerritt"
          className="nitter-iframe"
          title="SawyerMerritt tweets"
          sandbox="allow-scripts allow-same-origin"
        />
        {/* Hidden loading iframe */}
        {loadingKey !== null && (
          <iframe
            key={loadingKey}
            ref={loadingRef}
            src="https://nitter.net/SawyerMerritt"
            className="nitter-iframe nitter-iframe-loading"
            title="SawyerMerritt tweets loading"
            sandbox="allow-scripts allow-same-origin"
            onLoad={handleLoad}
          />
        )}
      </div>
      <a
        href="https://x.com/SawyerMerritt"
        target="_blank"
        rel="noopener noreferrer"
        className="twitter-fallback-link"
      >
        View on X →
      </a>
    </div>
  );
}
