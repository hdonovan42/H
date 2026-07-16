import { useState, useEffect, useCallback, useMemo } from 'react';
import { dayjs } from '../utils/marketState';
import { fetchYahooQuote } from '../utils/api';
import {
  getStoredSession, storeSession, clearSession,
  requestLink, verifyToken, getPortfolios,
  savePortfolio, renamePortfolio, deletePortfolio, MAX_PORTFOLIOS,
} from '../utils/accountApi';

const REF = 'TSLA'; // implicit first symbol of every saved portfolio

// Sign-in strip + saved-portfolio manager for the compare page.
// Signed out: email -> magic sign-in link. Signed in: save the working
// portfolio under a unique name (max 20), load/rename/delete saved ones.
export default function AccountPanel({ workingState, quotes, onLoadPortfolio }) {
  const [session, setSession] = useState(getStoredSession);
  const [portfolios, setPortfolios] = useState({});
  const [email, setEmail] = useState('');
  const [saveName, setSaveName] = useState('');
  const [renaming, setRenaming] = useState(null); // { from, to }
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [status, setStatus] = useState(null); // { kind: 'info' | 'error', text }
  const [busy, setBusy] = useState(false);
  const [extraQuotes, setExtraQuotes] = useState({}); // { SYM: price | null } for saved symbols outside the working set

  // A saved portfolio can hold symbols the page isn't currently tracking —
  // fetch their prices once so every row's value/weights can be computed
  useEffect(() => {
    const needed = new Set([REF]);
    Object.values(portfolios).forEach(p => (p.data?.symbols || []).forEach(s => needed.add(s)));
    const missing = [...needed].filter(s => quotes[s]?.price == null && !(s in extraQuotes));
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      const fetched = await Promise.all(missing.map(async s => [s, (await fetchYahooQuote(s))?.regularMarketPrice ?? null]));
      if (!cancelled) setExtraQuotes(prev => ({ ...prev, ...Object.fromEntries(fetched) }));
    })();
    return () => { cancelled = true; };
  }, [portfolios, quotes, extraQuotes]);

  // Per-portfolio summary: total value + "TICKER (weight%)" per priced holding.
  // null while a needed price is still loading.
  const summaries = useMemo(() => {
    const priceOf = (sym, overrides) => {
      const override = parseFloat(overrides?.[sym]);
      if (!isNaN(override)) return override;
      return quotes[sym]?.price ?? extraQuotes[sym] ?? null;
    };
    const out = {};
    for (const [name, { data }] of Object.entries(portfolios)) {
      const holdings = [];
      let total = 0;
      let pending = false;
      for (const sym of [REF, ...(data?.symbols || [])]) {
        const shareCount = parseFloat(data?.shares?.[sym]) || 0;
        if (shareCount <= 0) continue;
        const price = priceOf(sym, data?.priceOverrides);
        if (price == null) {
          pending = !(sym in extraQuotes); // null after a failed fetch = skip; undefined = still loading
          if (pending) break;
          continue;
        }
        const value = shareCount * price;
        total += value;
        holdings.push({ sym, value });
      }
      out[name] = pending ? null : {
        total,
        parts: holdings.map(h => `${h.sym} (${((h.value / total) * 100).toFixed(1)}%)`).join(', '),
      };
    }
    return out;
  }, [portfolios, quotes, extraQuotes]);

  const fmtTotal = (v) => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
    setPortfolios({});
    setRenaming(null);
    setConfirmDelete(null);
    setStatus(null);
  }, []);

  const handleApiError = useCallback((err) => {
    if (err.sessionExpired) {
      signOut();
      setStatus({ kind: 'error', text: 'Session expired — sign in again' });
    } else {
      setStatus({ kind: 'error', text: err.message });
    }
  }, [signOut]);

  // Arriving via a magic link: verify the token, then strip it from the URL/history
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('login');
    if (!token) return;
    params.delete('login');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    (async () => {
      setBusy(true);
      try {
        const { sessionToken, email: verifiedEmail } = await verifyToken(token);
        const next = { token: sessionToken, email: verifiedEmail };
        storeSession(next);
        setSession(next);
        setStatus({ kind: 'info', text: `Signed in as ${verifiedEmail}` });
      } catch (err) {
        setStatus({ kind: 'error', text: err.message });
      }
      setBusy(false);
    })();
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    getPortfolios()
      .then(r => { if (!cancelled) setPortfolios(r.portfolios); })
      .catch(err => { if (!cancelled) handleApiError(err); });
    return () => { cancelled = true; };
  }, [session, handleApiError]);

  const handleRequestLink = async (e) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setStatus(null);
    try {
      await requestLink(address);
      setStatus({ kind: 'info', text: 'Link sent — check your inbox (valid for 15 minutes)' });
    } catch (err) {
      setStatus({ kind: 'error', text: err.message });
    }
    setBusy(false);
  };

  const names = Object.keys(portfolios).sort((a, b) => a.localeCompare(b));
  const trimmedSaveName = saveName.trim();
  const nameExists = !!portfolios[trimmedSaveName];
  const atCap = !nameExists && names.length >= MAX_PORTFOLIOS;

  const handleSave = async (e) => {
    e.preventDefault();
    if (!trimmedSaveName || atCap) return;
    setBusy(true);
    setStatus(null);
    try {
      const r = await savePortfolio(trimmedSaveName, workingState);
      setPortfolios(r.portfolios);
      setStatus({ kind: 'info', text: `Saved “${trimmedSaveName}”` });
      setSaveName('');
    } catch (err) {
      handleApiError(err);
    }
    setBusy(false);
  };

  const handleLoad = (name) => {
    onLoadPortfolio(portfolios[name].data);
    setStatus({ kind: 'info', text: `Loaded “${name}”` });
    setConfirmDelete(null);
  };

  const submitRename = async (e) => {
    e.preventDefault();
    const to = renaming.to.trim();
    if (!to || to === renaming.from) { setRenaming(null); return; }
    setBusy(true);
    setStatus(null);
    try {
      const r = await renamePortfolio(renaming.from, to);
      setPortfolios(r.portfolios);
      setRenaming(null);
    } catch (err) {
      handleApiError(err); // 409 "That name is already taken" stays visible while editing
    }
    setBusy(false);
  };

  const handleDelete = async (name) => {
    if (confirmDelete !== name) {
      setConfirmDelete(name);
      return;
    }
    setBusy(true);
    setStatus(null);
    setConfirmDelete(null);
    try {
      const r = await deletePortfolio(name);
      setPortfolios(r.portfolios);
    } catch (err) {
      handleApiError(err);
    }
    setBusy(false);
  };

  if (!session) {
    return (
      <div className="box account-box">
        <form className="account-row" onSubmit={handleRequestLink}>
          <span className="account-label">Save portfolios</span>
          <input
            type="email"
            className="account-input"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@email.com"
            disabled={busy}
          />
          <button className="account-btn" type="submit" disabled={busy || !email.trim()}>
            Send sign-in link
          </button>
        </form>
        {status && <div className={`account-status ${status.kind}`}>{status.text}</div>}
      </div>
    );
  }

  return (
    <div className="box account-box">
      <div className="account-row account-header-row">
        <span className="account-label">Saved portfolios — {session.email}</span>
        <button className="account-btn" onClick={signOut}>Sign out</button>
      </div>

      {names.length > 0 && (
        <div className="portfolio-saved-list">
          {names.map(name => renaming?.from === name ? (
            <form key={name} className="portfolio-saved-row" onSubmit={submitRename}>
              <input
                autoFocus
                className="account-input"
                value={renaming.to}
                onChange={e => setRenaming({ ...renaming, to: e.target.value })}
                maxLength={40}
                disabled={busy}
              />
              <button className="account-btn" type="submit" disabled={busy}>Save</button>
              <button className="account-btn" type="button" onClick={() => setRenaming(null)}>Cancel</button>
            </form>
          ) : (
            <div key={name} className="portfolio-saved-row">
              <span className="portfolio-saved-name">{name}</span>
              <span className="portfolio-saved-summary">
                {summaries[name] === null
                  ? '…'
                  : summaries[name]?.total > 0
                    ? `${fmtTotal(summaries[name].total)} · ${summaries[name].parts}`
                    : '—'}
              </span>
              <span className="portfolio-saved-date">{dayjs(portfolios[name].updatedAt).format('D MMM')}</span>
              <button className="account-btn" onClick={() => handleLoad(name)} disabled={busy}>Load</button>
              <button className="account-btn" onClick={() => { setRenaming({ from: name, to: name }); setConfirmDelete(null); }} disabled={busy}>Rename</button>
              <button
                className={`account-btn ${confirmDelete === name ? 'danger' : ''}`}
                onClick={() => handleDelete(name)}
                disabled={busy}
              >
                {confirmDelete === name ? 'Confirm' : 'Delete'}
              </button>
            </div>
          ))}
        </div>
      )}

      <form className="account-row" onSubmit={handleSave}>
        <input
          className="account-input"
          value={saveName}
          onChange={e => setSaveName(e.target.value)}
          placeholder="Portfolio name"
          maxLength={40}
          disabled={busy}
        />
        <button className="account-btn" type="submit" disabled={busy || !trimmedSaveName || atCap}>
          {nameExists ? 'Overwrite' : 'Save current'}
        </button>
        {atCap && <span className="account-status error">Portfolio limit reached ({MAX_PORTFOLIOS})</span>}
      </form>

      {status && <div className={`account-status ${status.kind}`}>{status.text}</div>}
    </div>
  );
}
