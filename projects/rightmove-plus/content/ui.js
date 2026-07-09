// Rightmove Plus — orchestration: card discovery, badges, filter pill, SPA-nav handling.
//
// Rightmove is a React (Next.js) app: it REUSES card DOM nodes across pagination and can
// re-render any of them at will. Two hard rules keep us compatible:
//   1. Never insert children into React-managed nodes. Badges are ::after pseudo-elements
//      driven by data attributes — React leaves attributes it didn't render alone, and there
//      is no extra DOM for its reconciler to trip over.
//   2. Every scan is idempotent and re-derives everything from the DOM. A reused node is
//      recognised by its property id changing; all our attributes are recomputed each pass,
//      so stale hidden/badge state can never leak from one page of results to the next.
// All DOM writes are guarded (write only on real change) so our own MutationObserver never
// feeds back into another scan.
//
// Verdict lifecycle per property id:
//   tier 1 (free): card text + __NEXT_DATA__ summary/keyFeatures → 'listed' is definitive
//     (an explicit claim on the card is enough); anything else stays provisional because a
//     truncated summary can hide a "Grade II listed" further down the full description.
//   tier 2 (mode ≠ off): throttled fetch of the property page → definitive verdict, cached 30 days.

(() => {
  if (window.top !== window) return;

  const RMP_MODES = [
    ['off', 'Off', 'Badges only — no filtering, no background checks'],
    ['hide', 'Hide', 'Hide listed buildings'],
    ['only', 'Only', 'Show only listed buildings'],
    ['unlisted', 'Not listed', 'Show only properties explicitly described as not listed'],
  ];

  const verdicts = new Map();
  let mode = 'off';
  let showHidden = false;
  let pill = null;
  let countText = null;
  let showBtn = null;
  const modeButtons = new Map();

  const nextDataMap = (() => {
    try {
      const el = document.getElementById('__NEXT_DATA__');
      return el ? rmpNextDataToMap(JSON.parse(el.textContent)) : new Map();
    } catch (e) {
      return new Map();
    }
  })();

  // ---- guarded DOM writes ------------------------------------------------

  function setFlag(el, cls, on) {
    if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
  }

  function setData(el, key, value) {
    if (value == null || value === '') {
      if (el.dataset[key] !== undefined) delete el.dataset[key];
    } else if (el.dataset[key] !== value) {
      el.dataset[key] = value;
    }
  }

  function setText(el, s) {
    if (el.textContent !== s) el.textContent = s;
  }

  // ---- card discovery ----------------------------------------------------

  function rmpDebounce(fn, ms) {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  function cardId(card) {
    const anchor = card.querySelector('a[id^="prop"]');
    if (anchor && /^prop\d+$/.test(anchor.id)) return anchor.id.slice(4);
    const link = card.querySelector('a[href*="/properties/"]');
    const m = link && (link.getAttribute('href') || '').match(/\/properties\/(\d+)/);
    return m ? m[1] : null;
  }

  function allCards() {
    return document.querySelectorAll('div[data-testid^="propertyCard-"]');
  }

  // Strip everything of ours off a node (fresh node, or one React reused for another property).
  function resetCard(card) {
    setData(card, 'rmpLabel', null);
    setData(card, 'rmpStatus', null);
    setFlag(card, 'rmp-host', false);
    setFlag(card, 'rmp-hidden', false);
    setFlag(card, 'rmp-ghost', false);
    if (card.dataset.rmpTitled) {
      card.removeAttribute('title');
      delete card.dataset.rmpTitled;
    }
  }

  let scanning = false;
  let rescanWanted = false;

  async function scan() {
    if (scanning) {
      rescanWanted = true;
      return;
    }
    scanning = true;
    try {
      const found = [];
      for (const card of allCards()) {
        const id = cardId(card);
        if (!id) continue;
        if (card.dataset.rmpId !== id) {
          resetCard(card);
          setData(card, 'rmpId', id);
        }
        found.push({ card, id });
      }
      if (found.length && !pill) mountPill();

      const missing = found.filter((f) => !verdicts.has(f.id));
      if (missing.length) {
        const cached = await rmpCacheGetMany([...new Set(missing.map((f) => f.id))]);
        for (const id of Object.keys(cached)) verdicts.set(id, cached[id]);
        for (const { card, id } of missing) {
          if (verdicts.has(id)) continue;
          const text = (nextDataMap.get(id) || '') + '. ' + (card.textContent || '');
          const v = rmpDetectListed(text);
          v.definitive = v.status === 'listed';
          verdicts.set(id, v);
          if (v.definitive) rmpCacheSet(id, v);
        }
      }
      refresh();
    } finally {
      scanning = false;
      if (rescanWanted) {
        rescanWanted = false;
        scan();
      }
    }
  }

  function onVerdict(id, v) {
    verdicts.set(id, v);
    if (v.definitive && v.status !== 'unknown') rmpCacheSet(id, v);
    refresh();
  }

  // ---- painting ----------------------------------------------------------

  function shouldHide(v) {
    if (!v.definitive) return false; // never hide while still checking
    if (v.status === 'unknown') return false; // never hide what we couldn't read
    if (mode === 'hide') return v.status === 'listed';
    if (mode === 'only') return v.status === 'clear' || v.status === 'unlisted';
    if (mode === 'unlisted') return v.status !== 'unlisted';
    return false;
  }

  function chipLabel(v) {
    if (v.status === 'listed') {
      if (!v.grade) return 'LISTED';
      if (v.grade.indexOf('Cat ') === 0) return 'CATEGORY ' + v.grade.slice(4) + ' LISTED';
      return 'GRADE ' + v.grade + ' LISTED';
    }
    if (v.status === 'unlisted') return v.definitive ? 'NOT LISTED' : 'NOT LISTED?';
    if (v.status === 'mention') return 'LISTED NEARBY?';
    if (v.status === 'unknown') return 'UNKNOWN';
    if (mode !== 'off' && !v.definitive) return 'CHECKING…';
    return null; // definitive clear, or provisional clear while Off
  }

  function paint(card, v) {
    const label = chipLabel(v);
    setData(card, 'rmpLabel', label);
    setData(card, 'rmpStatus', label ? v.status : null);
    setFlag(card, 'rmp-host', !!label);
    const tip = label && v.snippet ? '“' + v.snippet + '”' : null;
    if (tip) {
      if (card.getAttribute('title') !== tip) card.setAttribute('title', tip);
      setData(card, 'rmpTitled', '1');
    } else if (card.dataset.rmpTitled) {
      card.removeAttribute('title');
      delete card.dataset.rmpTitled;
    }
  }

  function refresh() {
    let hidden = 0;
    let checking = 0;
    for (const card of allCards()) {
      const id = card.dataset.rmpId;
      if (!id) continue;
      const v = verdicts.get(id) || { status: 'clear', grade: null, snippet: null, definitive: false };
      if (mode !== 'off' && !v.definitive) {
        rmpEnqueueDetail(id, onVerdict);
        checking += 1;
      }
      paint(card, v);
      const hide = shouldHide(v);
      setFlag(card, 'rmp-hidden', hide && !showHidden);
      setFlag(card, 'rmp-ghost', hide && showHidden);
      if (hide) hidden += 1;
    }
    updatePill(hidden, checking);
  }

  // ---- pill --------------------------------------------------------------

  function setMode(next) {
    mode = next;
    try {
      chrome.storage.sync.set({ rmpMode: next });
    } catch (e) { /* still works for this tab */ }
    syncPill();
    refresh();
  }

  function syncPill() {
    for (const [value, btn] of modeButtons) setFlag(btn, 'rmp-active', value === mode);
  }

  function updatePill(hidden, checking) {
    if (!pill) return;
    const bits = [];
    if (checking) bits.push(checking + ' checking');
    if (hidden) bits.push(hidden + ' hidden');
    setText(countText, bits.join(' · '));
    const display = hidden ? '' : 'none';
    if (showBtn.style.display !== display) showBtn.style.display = display;
  }

  function mountPill() {
    pill = document.createElement('div');
    pill.className = 'rmp-pill';

    const label = document.createElement('span');
    label.className = 'rmp-pill-label';
    label.textContent = 'Listed:';
    pill.appendChild(label);

    for (const [value, text, title] of RMP_MODES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.title = title;
      btn.addEventListener('click', () => setMode(value));
      modeButtons.set(value, btn);
      pill.appendChild(btn);
    }

    countText = document.createElement('span');
    countText.className = 'rmp-count';
    pill.appendChild(countText);

    showBtn = document.createElement('button');
    showBtn.type = 'button';
    showBtn.className = 'rmp-showlink';
    showBtn.textContent = 'show';
    showBtn.title = 'Reveal hidden cards (dimmed) instead of removing them';
    showBtn.style.display = 'none';
    showBtn.addEventListener('click', () => {
      showHidden = !showHidden;
      showBtn.textContent = showHidden ? 'mask' : 'show';
      refresh();
    });
    pill.appendChild(showBtn);

    // document.body is outside React's root, so appending here is safe.
    document.body.appendChild(pill);
    syncPill();
  }

  // ---- init --------------------------------------------------------------

  (async () => {
    try {
      const got = await chrome.storage.sync.get({ rmpMode: 'off' });
      if (RMP_MODES.some(([value]) => value === got.rmpMode)) mode = got.rmpMode;
    } catch (e) { /* default to off */ }
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.rmpMode && changes.rmpMode.newValue !== mode) {
          mode = changes.rmpMode.newValue;
          syncPill();
          refresh();
        }
      });
    } catch (e) { /* no cross-tab sync */ }

    // Rightmove renders results client-side and repaints on pagination; watch for new cards.
    const debouncedScan = rmpDebounce(scan, 250);
    new MutationObserver(debouncedScan).observe(document.documentElement, { childList: true, subtree: true });
    scan();
  })();
})();
