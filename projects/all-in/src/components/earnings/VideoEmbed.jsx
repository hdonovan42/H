export default function VideoEmbed({ url }) {
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

  // Convert watch URL to embed URL if needed
  let embedUrl = url;
  if (url.includes('watch?v=')) {
    const videoId = url.split('watch?v=')[1].split('&')[0];
    embedUrl = `https://www.youtube.com/embed/${videoId}`;
  } else if (url.includes('youtu.be/')) {
    const videoId = url.split('youtu.be/')[1].split('?')[0];
    embedUrl = `https://www.youtube.com/embed/${videoId}`;
  }

  return (
    <div className="video-embed">
      <iframe
        src={embedUrl}
        title="Tesla Earnings Call"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
}
