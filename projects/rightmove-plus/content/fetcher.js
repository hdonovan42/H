// Rightmove Plus — throttled detail-page fetch queue.
// Same-origin fetches (the page the user would open by clicking the card), max 2 in flight,
// jittered gaps, verdicts cached so each property is fetched once per 30 days. If Rightmove
// starts refusing (403/429/503), the whole queue backs off rather than digging deeper.

const RMP_FETCH_CONCURRENCY = 2;
const RMP_FETCH_GAP_MS = 350;
const RMP_FETCH_JITTER_MS = 350;
const RMP_FETCH_TIMEOUT_MS = 15000;
const RMP_FETCH_BACKOFF_MS = 60000;
const RMP_FETCH_MAX_ATTEMPTS = 2;

const rmpFetchState = { queue: [], queued: new Set(), active: 0, pausedUntil: 0, resumeTimer: null };

function rmpEnqueueDetail(id, cb) {
  if (rmpFetchState.queued.has(id)) return;
  rmpFetchState.queued.add(id);
  rmpFetchState.queue.push({ id, cb, attempts: 0 });
  rmpFetchPump();
}

function rmpFetchPump() {
  const wait = rmpFetchState.pausedUntil - Date.now();
  if (wait > 0) {
    if (!rmpFetchState.resumeTimer) {
      rmpFetchState.resumeTimer = setTimeout(() => {
        rmpFetchState.resumeTimer = null;
        rmpFetchPump();
      }, wait);
    }
    return;
  }
  while (rmpFetchState.active < RMP_FETCH_CONCURRENCY && rmpFetchState.queue.length) {
    const job = rmpFetchState.queue.shift();
    rmpFetchState.active += 1;
    rmpRunDetailJob(job).finally(() => {
      setTimeout(() => {
        rmpFetchState.active -= 1;
        rmpFetchPump();
      }, RMP_FETCH_GAP_MS + Math.random() * RMP_FETCH_JITTER_MS);
    });
  }
}

async function rmpRunDetailJob(job) {
  job.attempts += 1;
  // 'unknown' is definitive for this session: don't refetch a page we failed to read.
  let verdict = { status: 'unknown', grade: null, snippet: null, definitive: true };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RMP_FETCH_TIMEOUT_MS);
    const res = await fetch('https://www.rightmove.co.uk/properties/' + job.id, {
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      // We're being told to slow down: pause everything, requeue this job once.
      rmpFetchState.pausedUntil = Date.now() + RMP_FETCH_BACKOFF_MS;
      if (job.attempts < RMP_FETCH_MAX_ATTEMPTS) {
        rmpFetchState.queue.unshift(job);
        return; // keep the id in `queued` — the job is still pending
      }
    } else if (res.ok) {
      const extracted = rmpExtractDetail(await res.text());
      if (extracted) {
        verdict = rmpDetectListed([extracted.desc].concat(extracted.features).join('. '));
        verdict.definitive = true;
      }
    }
  } catch (e) { /* network error / timeout → unknown */ }
  rmpFetchState.queued.delete(job.id);
  try {
    job.cb(job.id, verdict);
  } catch (e) { /* a callback error must never wedge the queue */ }
}
