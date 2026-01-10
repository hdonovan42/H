import { useEffect, useRef } from 'react';

export default function TwitterEmbed() {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!window.twttr) {
      const script = document.createElement('script');
      script.src = 'https://platform.twitter.com/widgets.js';
      script.async = true;
      document.body.appendChild(script);
    } else {
      window.twttr.widgets?.load(containerRef.current);
    }
  }, []);

  return (
    <div className="twitter-embed" ref={containerRef}>
      <div className="section-header">
        <h3>@SawyerMerritt</h3>
      </div>
      <a
        className="twitter-timeline"
        data-height="400"
        data-theme="dark"
        data-chrome="noheader nofooter noborders transparent"
        href="https://x.com/SawyerMerritt"
        target="_blank"
        rel="noopener noreferrer"
      >
        View @SawyerMerritt on X →
      </a>
    </div>
  );
}
