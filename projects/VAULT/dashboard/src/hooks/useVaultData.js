import { useState, useEffect, useCallback } from 'react';

const POLL_INTERVAL = 10_000; // 10 seconds

async function fetchJSON(url, creds) {
  const headers = {};
  if (creds) headers['Authorization'] = 'Basic ' + btoa(creds.user + ':' + creds.pass);
  const res = await fetch(url, { headers });
  if (res.status === 401) throw new Error('401 Unauthorised');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function useVaultData(creds) {
  const [status, setStatus] = useState(null);
  const [balanceHistory, setBalanceHistory] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [costs, setCosts] = useState(null);
  const [positions, setPositions] = useState(null);
  const [events, setEvents] = useState([]);
  const [memories, setMemories] = useState([]);
  const [predictions, setPredictions] = useState(null);
  const [calibration, setCalibration] = useState(null);
  const [smartMoney, setSmartMoney] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [s, bh, cy, co, po, ev, me, pr, ca, sm] = await Promise.all([
        fetchJSON('/api/v1/status', creds),
        fetchJSON('/api/v1/balance/history?limit=2000', creds),
        fetchJSON('/api/v1/cycles?limit=50', creds),
        fetchJSON('/api/v1/costs', creds),
        fetchJSON('/api/v1/positions', creds),
        fetchJSON('/api/v1/events?limit=50', creds),
        fetchJSON('/api/v1/memories?limit=30', creds),
        fetchJSON('/api/v1/predictions', creds),
        fetchJSON('/api/v1/calibration', creds).catch(() => null),
        fetchJSON('/api/v1/smart-money/summary', creds).catch(() => null),
      ]);
      setStatus(s);
      setBalanceHistory(bh);
      setCycles(cy);
      setCosts(co);
      setPositions(po);
      setEvents(ev);
      setMemories(me);
      setPredictions(pr);
      setCalibration(ca);
      setSmartMoney(sm);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [creds]);

  useEffect(() => {
    if (!creds) return;
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh, creds]);

  return { status, balanceHistory, cycles, costs, positions, events, memories, predictions, calibration, smartMoney, error, loading, refresh };
}
