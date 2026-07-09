// Rightmove Plus — pure extraction helpers for Rightmove payloads. No DOM APIs, node-testable.

function rmpStripHtml(s) {
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Slice one balanced JSON object starting at `from` (the script block carries further
// statements after it, so we can't just cut at </script>).
function rmpSliceJsonObject(s, from) {
  let depth = 0;
  let inString = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(from, i + 1);
    }
  }
  return null;
}

// Detail pages ship `window.__PAGE_MODEL = {"data": "<json>"}` where <json> is an array and
// every object value is an index into that same array. We only need two spots:
// propertyData.text.description and propertyData.keyFeatures.
function rmpExtractDetailFromModel(html) {
  const i = html.indexOf('__PAGE_MODEL');
  if (i === -1) return null;
  const j = html.indexOf('{', i);
  if (j === -1) return null;
  const raw = rmpSliceJsonObject(html, j);
  if (!raw) return null;
  try {
    const arr = JSON.parse(JSON.parse(raw).data);
    if (!Array.isArray(arr)) return null;
    const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    const textObj = arr.find((x) => isObj(x) && 'description' in x && 'shareDescription' in x);
    const desc = textObj && typeof arr[textObj.description] === 'string' ? arr[textObj.description] : null;
    const pd = arr.find((x) => isObj(x) && 'keyFeatures' in x && 'text' in x);
    let features = [];
    if (pd && Array.isArray(arr[pd.keyFeatures])) {
      features = arr[pd.keyFeatures].map((n) => arr[n]).filter((s) => typeof s === 'string');
    }
    if (!desc && !features.length) return null;
    return { desc: rmpStripHtml(desc || ''), features, source: 'model' };
  } catch (e) {
    return null;
  }
}

// Fallback if the model format changes: the description is server-rendered after an
// <h2>Description</h2> heading.
function rmpExtractDetailFromMarkup(html) {
  const m = html.match(/>\s*Description\s*<\/h2>([\s\S]{0,20000}?)(?:<h2|<\/section|<\/main)/i);
  return m ? { desc: rmpStripHtml(m[1]), features: [], source: 'markup' } : null;
}

function rmpExtractDetail(html) {
  return rmpExtractDetailFromModel(html) || rmpExtractDetailFromMarkup(html);
}

// Search page __NEXT_DATA__ → Map(propertyId -> searchable text from summary + key features).
// Ids are globally unique, so a stale map (SPA pagination) can only miss ids, never mislabel.
function rmpNextDataToMap(nd) {
  const map = new Map();
  const props = nd && nd.props && nd.props.pageProps && nd.props.pageProps.searchResults
    && nd.props.pageProps.searchResults.properties;
  if (!Array.isArray(props)) return map;
  for (const p of props) {
    if (!p || p.id == null) continue;
    const bits = [p.summary || '', p.propertyTypeFullDescription || ''];
    if (Array.isArray(p.keyFeatures)) {
      for (const f of p.keyFeatures) bits.push(typeof f === 'string' ? f : (f && f.description) || '');
    }
    map.set(String(p.id), bits.filter(Boolean).join('. '));
  }
  return map;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rmpStripHtml, rmpExtractDetail, rmpExtractDetailFromModel, rmpExtractDetailFromMarkup, rmpNextDataToMap };
}
