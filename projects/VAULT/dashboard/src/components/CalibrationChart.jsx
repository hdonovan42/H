import React, { useRef, useEffect } from 'react';

export default function CalibrationChart({ data }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data?.calibration_curve?.length) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;

    const pad = { top: 20, right: 20, bottom: 30, left: 40 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Clear
    ctx.fillStyle = '#161616';
    ctx.fillRect(0, 0, w, h);

    // Perfect calibration line (diagonal)
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + plotH);
    ctx.lineTo(pad.left + plotW, pad.top);
    ctx.stroke();
    ctx.setLineDash([]);

    // Axes
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.stroke();

    // Labels
    ctx.fillStyle = '#777';
    ctx.font = '10px IBM Plex Mono';
    ctx.textAlign = 'center';
    ctx.fillText('Estimated', pad.left + plotW / 2, h - 4);
    ctx.save();
    ctx.translate(10, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Actual', 0, 0);
    ctx.restore();

    // Tick labels
    for (let i = 0; i <= 10; i += 2) {
      const x = pad.left + (i / 10) * plotW;
      const y = pad.top + plotH - (i / 10) * plotH;
      ctx.fillStyle = '#555';
      ctx.textAlign = 'center';
      ctx.fillText(`${i * 10}%`, x, pad.top + plotH + 14);
      ctx.textAlign = 'right';
      ctx.fillText(`${i * 10}%`, pad.left - 4, y + 4);
    }

    // Plot calibration points
    const curve = data.calibration_curve;
    if (curve.length > 1) {
      ctx.strokeStyle = '#4ecdc4';
      ctx.lineWidth = 2;
      ctx.beginPath();
      curve.forEach((pt, i) => {
        const x = pad.left + pt.estimated * plotW;
        const y = pad.top + plotH - pt.actual_rate * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Dots
    curve.forEach((pt) => {
      const x = pad.left + pt.estimated * plotW;
      const y = pad.top + plotH - pt.actual_rate * plotH;
      ctx.fillStyle = '#4ecdc4';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      // Count label
      ctx.fillStyle = '#999';
      ctx.font = '9px IBM Plex Mono';
      ctx.textAlign = 'center';
      ctx.fillText(`n=${pt.count}`, x, y - 8);
    });
  }, [data]);

  if (!data?.calibration_curve?.length) {
    return (
      <div className="card">
        <div className="card-title">Calibration</div>
        <div className="empty">Not enough resolved markets for calibration</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-title">Calibration ({data.records?.length || 0} resolved)</div>
      <div className="chart-container" style={{ height: '220px' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
