export default function TranscriptEmbed({ url }) {
  return (
    <div className="transcript-embed">
      <div className="section-header">
        <h3>Live Transcript</h3>
        <a href={url} target="_blank" rel="noopener noreferrer" className="external-link">
          Open in Quartr
        </a>
      </div>
      <iframe
        src={url}
        title="Live Transcript - Quartr"
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    </div>
  );
}
