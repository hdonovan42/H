import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';

// Extract video ID from various YouTube URL formats
const getVideoId = (url) => {
  if (!url) return null;
  if (url.includes('watch?v=')) {
    return url.split('watch?v=')[1].split('&')[0];
  } else if (url.includes('youtu.be/')) {
    return url.split('youtu.be/')[1].split('?')[0];
  } else if (url.includes('/embed/')) {
    return url.split('/embed/')[1].split('?')[0];
  }
  // Assume it's already a video ID
  return url;
};

const VideoEmbed = forwardRef(({ url }, ref) => {
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  const videoId = getVideoId(url);

  // Expose seekTo method to parent
  useImperativeHandle(ref, () => ({
    seekTo: (seconds) => {
      if (playerRef.current && playerRef.current.seekTo) {
        playerRef.current.seekTo(seconds, true);
      }
    },
    getCurrentTime: () => {
      if (playerRef.current && playerRef.current.getCurrentTime) {
        return playerRef.current.getCurrentTime();
      }
      return 0;
    }
  }));

  useEffect(() => {
    if (!videoId) return;

    // Load YouTube IFrame API if not already loaded
    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
    }

    const initPlayer = () => {
      if (playerRef.current) {
        playerRef.current.destroy();
      }

      playerRef.current = new window.YT.Player(containerRef.current, {
        videoId: videoId,
        playerVars: {
          autoplay: 0,
          cc_load_policy: 1,  // Enable captions by default
          cc_lang_pref: 'en', // Prefer English captions
          modestbranding: 1,
          rel: 0,
          enablejsapi: 1
        },
        events: {
          onReady: (event) => {
            console.log('YouTube player ready');
          }
        }
      });
    };

    // Initialize when API is ready
    if (window.YT && window.YT.Player) {
      initPlayer();
    } else {
      window.onYouTubeIframeAPIReady = initPlayer;
    }

    return () => {
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
  }, [videoId]);

  if (!url) {
    return (
      <div className="video-embed video-placeholder">
        <div className="placeholder-content">
          <h3>Earnings Call Video</h3>
          <p>YouTube URL not configured</p>
          <p className="placeholder-hint">Update CONFIG.youtubeUrl in EarningsControlCentre.jsx before earnings</p>
        </div>
      </div>
    );
  }

  return (
    <div className="video-embed">
      <div ref={containerRef} className="youtube-player"></div>
    </div>
  );
});

VideoEmbed.displayName = 'VideoEmbed';

export default VideoEmbed;
