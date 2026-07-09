// Rightmove Plus — verdict cache in chrome.storage.local.
// Keyed by detector version so a regex change invalidates old verdicts by never reading them.

const RMP_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function rmpCacheKey(id) {
  return 'rmp:v' + RMP_DETECT_VERSION + ':' + id;
}

async function rmpCacheGetMany(ids) {
  const out = {};
  if (!ids.length) return out;
  try {
    const got = await chrome.storage.local.get(ids.map(rmpCacheKey));
    const now = Date.now();
    for (const id of ids) {
      const entry = got[rmpCacheKey(id)];
      if (entry && entry.v && now - entry.t < RMP_CACHE_TTL_MS) out[id] = entry.v;
    }
  } catch (e) { /* storage unavailable → treat as cache miss */ }
  return out;
}

function rmpCacheSet(id, verdict) {
  try {
    chrome.storage.local.set({ [rmpCacheKey(id)]: { v: verdict, t: Date.now() } });
  } catch (e) { /* best effort */ }
}
