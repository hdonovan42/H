import { useState, useMemo } from 'react';

// Format seconds to MM:SS
const formatTime = (seconds) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const TRANSCRIPT_SUMMARY = [
  {
    heading: 'Mission & Vision',
    text: 'Tesla updated its mission to "amazing abundance." Musk outlined a future of universal high income driven by AI and robotics, with Tesla making major investments across batteries, solar, AI chips, and autonomous vehicles.'
  },
  {
    heading: 'Model S/X End of Life',
    text: 'Model S and X production will wind down next quarter. The Fremont factory space will be converted into an Optimus robot production line targeting 1 million units per year.'
  },
  {
    heading: 'FSD & Robotaxi',
    text: 'Tesla completed its first unsupervised paid robotaxi rides in Austin with no safety monitor and no chase car. The fleet exceeds 500 vehicles across Austin and the Bay Area, doubling roughly monthly. Tesla expects fully autonomous vehicles in 25-50% of US cities by year-end, pending regulatory approval.'
  },
  {
    heading: 'CyberCab',
    text: 'Production begins in April. Designed as a dedicated 2-seater with no steering wheel or pedals, optimized for minimum cost-per-mile and a 50-60 hour/week duty cycle. Expected to eventually outnumber all other Tesla vehicles combined.'
  },
  {
    heading: 'Fleet Owner Program',
    text: 'Existing Tesla owners will be able to add or remove their cars from the autonomous fleet, similar to Airbnb. Owners could potentially earn more from fleet lending than their lease cost.'
  },
  {
    heading: 'Q4 Financials',
    text: 'Auto margins (ex-credits) improved from 15.4% to 17.9%. Total gross margin exceeded 20.1% for the first time in two years. Energy revenue hit $12.8B (+26.6% YoY). FSD adoption reached ~1.1M paid customers. Free cash flow was $1.4B.'
  },
  {
    heading: 'FSD Subscription Transition',
    text: 'Tesla is transitioning fully to a subscription-based model for FSD. Near-term, this will shift new additions away from upfront purchases and impact auto margins.'
  },
  {
    heading: '2026 CapEx',
    text: 'Expecting $20B+ in capital expenditure across six factories (lithium refinery, LFP, CyberCab, Semi, mega factory, Optimus), AI compute infrastructure, and fleet expansion. Does not include potential solar cell manufacturing investments.'
  },
  {
    heading: 'Optimus',
    text: 'Optimus Gen 3 unveil expected in a few months. Designed to look human and learn tasks by observation, verbal instruction, or video. Three hardest challenges: hand dexterity, real-world AI, and production scaling. Still in R&D phase with meaningful production volume expected by end of year.'
  },
  {
    heading: 'AI Chips',
    text: 'Musk is spending significant personal time on AI5 chip design (every Saturday + Tuesdays). AI6 to follow in under a year. Tesla claims 10x+ memory efficiency versus other large AI models. Chip production identified as the key limiting factor for growth beyond 3 years.'
  },
  {
    heading: 'Energy & Supply Chain',
    text: 'Targeting 100 GW/year solar cell production. Building the most advanced lithium refinery in the world (Corpus Christi) and a cathode refinery in Austin. Battery pack supply remains the biggest global production constraint.'
  },
  {
    heading: 'Competition & Risk',
    text: 'China acknowledged as the toughest competitor for humanoid robots, with strong AI and manufacturing capabilities. Tesla is securing domestic supply chains to mitigate geopolitical risk, emphasizing self-reliance in batteries, chips, and refining.'
  },
  {
    heading: 'Other',
    text: 'Next-gen Roadster debut targeted for April. Cybertruck is the best-selling electric truck in its segment, with its production line designed for future autonomous vehicle conversion. No layoff plans at Fremont; headcount expected to increase.'
  }
];

export default function TranscriptEmbed({ transcript, onSeek, liveUrl }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [speakerFilter, setSpeakerFilter] = useState('all');
  const [showSummary, setShowSummary] = useState(false);

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
        <div className="transcript-header-right">
          {transcript.metadata && (
            <span className="transcript-meta">
              {transcript.metadata.quarter} • {transcript.metadata.source}
            </span>
          )}
          <button
            className={`transcript-summary-btn ${showSummary ? 'active' : ''}`}
            onClick={() => setShowSummary(s => !s)}
          >
            Summary
          </button>
        </div>
      </div>

      {showSummary ? (
        <div className="transcript-summary">
          {TRANSCRIPT_SUMMARY.map((item, i) => (
            <div key={i} className="summary-item">
              <div className="summary-heading">{item.heading}</div>
              <div className="summary-text">{item.text}</div>
            </div>
          ))}
        </div>
      ) : (
        <>
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
              className={`transcript-segment ${segment.start !== null ? 'clickable' : ''}`}
              onClick={() => segment.start !== null && onSeek && onSeek(segment.start)}
            >
              <div className="segment-header">
                {segment.start !== null && (
                  <span className="segment-time">{formatTime(segment.start)}</span>
                )}
                <span className="segment-speaker">
                  {segment.speaker}{segment.role ? ` - ${segment.role}` : ''}
                </span>
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
        </>
      )}
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
