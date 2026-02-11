import React, { useRef, useEffect, useState } from 'react';

const PADDING = { top: 20, right: 20, bottom: 30, left: 60 };
const DEATH_LINE = 0;

export default function BalanceChart({ data }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    if (!data || data.length === 0) return;

    const canvas = canvasRef.current;
    const container = containerRef.current;
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Clear
    ctx.fillStyle = '#161616';
    ctx.fillRect(0, 0, w, h);

    const plotW = w - PADDING.left - PADDING.right;
    const plotH = h - PADDING.top - PADDING.bottom;

    // Data ranges
    const balances = data.map(d => d.balance);
    const maxBal = Math.max(...balances, 50) * 1.05;
    const minBal = Math.min(...balances, 0);

    const scaleX = (i) => PADDING.left + (i / (data.length - 1)) * plotW;
    const scaleY = (v) => PADDING.top + plotH - ((v - minBal) / (maxBal - minBal)) * plotH;

    // Grid lines — snap to round numbers
    ctx.strokeStyle = '#252525';
    ctx.lineWidth = 1;
    const range = maxBal - minBal;
    const rawStep = range / 6;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const nice = [1, 2, 2.5, 5, 10].find(n => n * magnitude >= rawStep) * magnitude;
    const gridStart = Math.floor(minBal / nice) * nice;
    const gridEnd = Math.ceil(maxBal / nice) * nice;
    for (let val = gridStart; val <= gridEnd; val += nice) {
      const y = scaleY(val);
      if (y < PADDING.top - 5 || y > h - PADDING.bottom + 5) continue;
      ctx.beginPath();
      ctx.moveTo(PADDING.left, y);
      ctx.lineTo(w - PADDING.right, y);
      ctx.stroke();

      ctx.fillStyle = '#777';
      ctx.font = '11px IBM Plex Mono';
      ctx.textAlign = 'right';
      ctx.fillText(`$${val.toFixed(0)}`, PADDING.left - 8, y + 4);
    }

    // Death line ($0)
    if (minBal <= 0) {
      const deathY = scaleY(DEATH_LINE);
      ctx.strokeStyle = '#ff0040';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(PADDING.left, deathY);
      ctx.lineTo(w - PADDING.right, deathY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ff0040';
      ctx.font = '10px IBM Plex Mono';
      ctx.textAlign = 'left';
      ctx.fillText('DEATH', w - PADDING.right - 40, deathY - 6);
    }

    // Balance line
    ctx.strokeStyle = '#00ff41';
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = scaleX(i);
      const y = scaleY(d.balance);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill under line
    const gradient = ctx.createLinearGradient(0, PADDING.top, 0, h - PADDING.bottom);
    gradient.addColorStop(0, 'rgba(0, 255, 65, 0.12)');
    gradient.addColorStop(1, 'rgba(0, 255, 65, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = scaleX(i);
      const y = scaleY(d.balance);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(scaleX(data.length - 1), h - PADDING.bottom);
    ctx.lineTo(PADDING.left, h - PADDING.bottom);
    ctx.closePath();
    ctx.fill();

    // X-axis: first and last timestamps
    ctx.fillStyle = '#777';
    ctx.font = '11px IBM Plex Mono';
    ctx.textAlign = 'left';
    const firstTs = data[0].ts.slice(0, 10);
    ctx.fillText(firstTs, PADDING.left, h - 6);
    ctx.textAlign = 'right';
    const lastTs = data[data.length - 1].ts.slice(0, 10);
    ctx.fillText(lastTs, w - PADDING.right, h - 6);

    // Hover crosshair
    if (hover !== null && hover >= 0 && hover < data.length) {
      const x = scaleX(hover);
      const y = scaleY(data[hover].balance);

      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(x, PADDING.top);
      ctx.lineTo(x, h - PADDING.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      // Dot
      ctx.fillStyle = '#00ff41';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();

      // Tooltip
      const d = data[hover];
      const tooltipText = `$${d.balance.toFixed(2)} | ${d.ts.slice(0, 16).replace('T', ' ')}`;
      ctx.fillStyle = '#f0f0f0';
      ctx.font = '12px IBM Plex Mono';
      const textW = ctx.measureText(tooltipText).width;
      const tx = Math.min(x - textW / 2, w - PADDING.right - textW);
      const txClamped = Math.max(tx, PADDING.left);
      ctx.fillText(tooltipText, txClamped, PADDING.top - 4);
    }
  }, [data, hover]);

  function handleMouseMove(e) {
    if (!data || data.length === 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const plotW = rect.width - PADDING.left - PADDING.right;
    const idx = Math.round(((x - PADDING.left) / plotW) * (data.length - 1));
    setHover(Math.max(0, Math.min(idx, data.length - 1)));
  }

  function handleMouseLeave() {
    setHover(null);
  }

  if (!data || data.length === 0) {
    return (
      <div className="card grid-full">
        <div className="card-title">Balance Lifeline</div>
        <div className="empty">No balance data yet</div>
      </div>
    );
  }

  return (
    <div className="card grid-full">
      <div className="card-title">Balance Lifeline</div>
      <div
        className="chart-container"
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
