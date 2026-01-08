import { useState, useMemo } from 'react';

// Format seconds to MM:SS
const formatTime = (seconds) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export default function TranscriptEmbed({ transcript, onSeek, liveUrl }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [speakerFilter, setSpeakerFilter] = useState('all');

  // Extract unique speakers from transcript
  const speakers = useMemo(() => {
    if (!transcript?.segments) return [];
    const unique = [...new Set(transcript.segments.map(s => s.speaker))];
    return unique.filter(Boolean);
  }, [transcript]);

  // Filter segments based on search and speaker
  const filteredSegments = useMemo(() => {
    if (!transcript?.segments) return [];
    return transcript.segments.filter(segment => {
      const matchesSearch = !searchQuery ||
        segment.text.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesSpeaker = speakerFilter === 'all' ||
        segment.speaker === speakerFilter;
      return matchesSearch && matchesSpeaker;
    });
  }, [transcript, searchQuery, speakerFilter]);

  // If no transcript available, show live mode
  if (!transcript || !transcript.segments || transcript.segments.length === 0) {
    return (
      <div className="transcript-embed transcript-live">
        <div className="section-header">
          <h3>Transcript</h3>
        </div>
        <div className="transcript-live-content">
          <p>Live transcript will be available after the earnings call.</p>
          <p className="transcript-hint">During the call, use YouTube captions (CC button).</p>
          {liveUrl && (
            <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="transcript-link">
              View on Quartr
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="transcript-embed transcript-available">
      <div className="section-header">
        <h3>Transcript</h3>
        {transcript.metadata && (
          <span className="transcript-meta">
            {transcript.metadata.quarter} • {transcript.metadata.source}
          </span>
        )}
      </div>

      {/* Search and Filter Controls */}
      <div className="transcript-controls">
        <input
          type="text"
          placeholder="Search transcript..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="transcript-search"
        />
        <select
          value={speakerFilter}
          onChange={(e) => setSpeakerFilter(e.target.value)}
          className="transcript-speaker-filter"
        >
          <option value="all">All Speakers</option>
          {speakers.map(speaker => (
            <option key={speaker} value={speaker}>{speaker}</option>
          ))}
        </select>
      </div>

      {/* Results count */}
      {searchQuery && (
        <div className="transcript-results">
          {filteredSegments.length} result{filteredSegments.length !== 1 ? 's' : ''}
        </div>
      )}

      {/* Transcript Segments */}
      <div className="transcript-segments">
        {filteredSegments.map((segment, index) => (
          <div
            key={index}
            className="transcript-segment"
            onClick={() => onSeek && onSeek(segment.start)}
          >
            <div className="segment-header">
              <span className="segment-time">{formatTime(segment.start)}</span>
              <span className="segment-speaker">{segment.speaker}</span>
            </div>
            <div className="segment-text">
              {searchQuery ? (
                <HighlightedText text={segment.text} query={searchQuery} />
              ) : (
                segment.text
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Highlight matching text
function HighlightedText({ text, query }) {
  if (!query) return text;

  const parts = text.split(new RegExp(`(${query})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i}>{part}</mark>
        ) : (
          part
        )
      )}
    </>
  );
}
