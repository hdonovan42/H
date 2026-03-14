import { useState, useEffect, useCallback } from 'react';

const POLL_INTERVAL = 10_000; // 10 seconds

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function useVaultData() {
  const [status, setStatus] = useState(null);
  const [balanceHistory, setBalanceHistory] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [costs, setCosts] = useState(null);
  const [positions, setPositions] = useState(null);
  const [events, setEvents] = useState([]);
  const [predictions, setPredictions] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [s, bh, cy, co, po, ev, pr] = await Promise.all([
        fetchJSON('/api/v1/status'),
        fetchJSON('/api/v1/balance/history?limit=2000'),
        fetchJSON('/api/v1/cycles?limit=50'),
        fetchJSON('/api/v1/costs'),
        fetchJSON('/api/v1/positions'),
        fetchJSON('/api/v1/events?limit=50'),
        fetchJSON('/api/v1/predictions'),
      ]);
      setStatus(s);
      setBalanceHistory(bh);
      setCycles(cy);
      setCosts(co);
      setPositions(po);
      setEvents(ev);
      setPredictions(pr);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  return { status, balanceHistory, cycles, costs, positions, events, predictions, error, loading, refresh };
}
