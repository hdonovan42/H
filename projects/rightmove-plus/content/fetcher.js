// Rightmove Plus — throttled detail-page fetch queue.
// Same-origin fetches (the page the user would open by clicking the card), max 2 in flight,
// 300ms gap between jobs, verdicts cached so each property is fetched once per 30 days.

const RMP_FETCH_CONCURRENCY = 2;
const RMP_FETCH_GAP_MS = 300;
const RMP_FETCH_TIMEOUT_MS = 15000;

const rmpFetchState = { queue: [], queued: new Set(), active: 0 };

function rmpEnqueueDetail(id, cb) {
  if (rmpFetchState.queued.has(id)) return;
  rmpFetchState.queued.add(id);
  rmpFetchState.queue.push({ id, cb });
  rmpFetchPump();
}

function rmpFetchPump() {
  while (rmpFetchState.active < RMP_FETCH_CONCURRENCY && rmpFetchState.queue.length) {
    const job = rmpFetchState.queue.shift();
    rmpFetchState.active += 1;
    rmpRunDetailJob(job).finally(() => {
      setTimeout(() => {
        rmpFetchState.active -= 1;
        rmpFetchState.queued.delete(job.id);
        rmpFetchPump();
      }, RMP_FETCH_GAP_MS);
    });
  }
}

async function rmpRunDetailJob(job) {
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
    if (res.ok) {
      const extracted = rmpExtractDetail(await res.text());
      if (extracted) {
        verdict = rmpDetectListed([extracted.desc].concat(extracted.features).join('. '));
        verdict.definitive = true;
      }
    }
  } catch (e) { /* network error / timeout → unknown */ }
  try {
    job.cb(job.id, verdict);
  } catch (e) { /* a callback error must never wedge the queue */ }
}
