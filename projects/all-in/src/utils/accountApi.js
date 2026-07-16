import { WORKER_URL } from './config';

// Magic-link account API for the compare page. The session token lives in
// localStorage (not a cookie) and is sent as a Bearer header; a 401 on any
// authed call clears it and flags the error so the UI can sign out gracefully.
const SESSION_KEY = 'compare_session_v1';

export const MAX_PORTFOLIOS = 20;

export const getStoredSession = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_KEY));
    return parsed?.token && parsed?.email ? parsed : null;
  } catch {
    return null;
  }
};

export const storeSession = (session) => {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* storage full */ }
};

export const clearSession = () => {
  localStorage.removeItem(SESSION_KEY);
};

const call = async (path, { method = 'GET', body, auth = true } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) {
    const session = getStoredSession();
    if (!session) {
      const err = new Error('Not signed in');
      err.sessionExpired = true;
      throw err;
    }
    headers['Authorization'] = `Bearer ${session.token}`;
  }
  const res = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    if (auth && res.status === 401) {
      clearSession();
      err.sessionExpired = true;
    }
    throw err;
  }
  return data;
};

export const requestLink = (email) =>
  call('/auth/request', { method: 'POST', auth: false, body: { email, origin: window.location.origin } });
export const verifyToken = (token) =>
  call('/auth/verify', { method: 'POST', auth: false, body: { token } });
export const getPortfolios = () => call('/portfolios');
export const savePortfolio = (name, data) =>
  call('/portfolios/save', { method: 'POST', body: { name, data } });
export const renamePortfolio = (from, to) =>
  call('/portfolios/rename', { method: 'POST', body: { from, to } });
export const deletePortfolio = (name) =>
  call('/portfolios/delete', { method: 'POST', body: { name } });
export const reorderPortfolios = (order) =>
  call('/portfolios/reorder', { method: 'POST', body: { order } });
