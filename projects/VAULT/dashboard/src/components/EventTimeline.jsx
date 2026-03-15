import React from 'react';

function formatTs(ts) {
  if (!ts) return '';
  return ts.slice(0, 16).replace('T', ' ');
}

export default function EventTimeline({ events }) {
  if (!events || events.length === 0) {
    return (
      <div className="card">
        <div className="card-title">Events</div>
        <div className="empty">No events recorded</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-title">Events</div>
      <ul className="event-list" style={{ maxHeight: 'none', overflow: 'visible' }}>
        {events.slice(0, 6).map((e) => (
          <li key={e.id} className="event-item">
            <span className={`event-type ${e.event}`}>{e.event}</span>
            <span className="event-detail">{e.detail}</span>
            <span className="event-ts">{formatTs(e.ts)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
