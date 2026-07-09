// Rightmove Plus — listed-building detection. Pure text logic, no DOM.
// Loaded as a content script AND require()d by the node tests (see export guard at the bottom).

const RMP_DETECT_VERSION = 1;

// England/Wales: Grade I, II*, II. Scotland: Category A/B/C. Northern Ireland: Grade A, B+, B1, B2.
const RMP_GRADE_MAP = {
  i: 'I', ii: 'II', iii: 'III',
  1: 'I', 2: 'II', 3: 'III',
  one: 'I', two: 'II', three: 'III',
  a: 'A', b: 'B', 'b+': 'B+', b1: 'B1', b2: 'B2', c: 'C',
};

const RMP_GRADE_SRC = '(i{1,3}\\s*\\*?|[123]\\s*\\*?|one|two|three|a|b\\+?[12]?|c)';

function rmpNormaliseGrade(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/\s+/g, '');
  const star = s.includes('*');
  const base = RMP_GRADE_MAP[s.replace(/\*/g, '')] || null;
  return base ? base + (star ? '*' : '') : null;
}

// Order matters: earlier patterns claim their text range; a later pattern whose match
// starts inside a claimed range is ignored. Explicit negations go first so
// "not Grade II listed" never feeds the positive patterns.
const RMP_PATTERNS = [
  // -- explicit "not listed" statements
  {
    kind: 'unlisted',
    re: new RegExp(
      "\\b(?:not|never|isn['’]?t|neither)\\s+(?:a\\s+|currently\\s+|statutorily\\s+|officially\\s+)?" +
      '(?:grade[\\s-]*' + RMP_GRADE_SRC + '\\s*)?listed\\b', 'gi'),
  },
  { kind: 'unlisted', re: /\b(?:un-?listed|non[\s-]?listed)\b/gi },
  { kind: 'unlisted', re: /\b(?:no|without|free\s+(?:of|from))\s+listed[\s-]+(?:building\s+)?(?:status|designation|restrictions?)\b/gi },
  // -- positive statements
  { kind: 'listed', graded: true, re: new RegExp('\\bgrade[\\s-]*' + RMP_GRADE_SRC + '[\\s-]*\\(?\\s*listed\\b', 'gi') },
  { kind: 'listed', graded: true, re: new RegExp('\\blisted\\b[\\s,;:(-]{0,4}grade[\\s-]*' + RMP_GRADE_SRC, 'gi') },
  // Roman-numeral grade with no "listed" ("this Grade II thatched cottage") still means listed;
  // digit/letter grades alone are too ambiguous (EPC Grade C, Grade 2 agricultural land).
  { kind: 'listed', graded: true, re: /\bgrade[\s-]*(i{1,3}\s*\*?)(?![a-z*])/gi },
  { kind: 'listed', re: /\blisted[\s-]+building\b/gi },
  { kind: 'listed', graded: true, catGrade: true, re: /\bcategor(?:y|ies)[\s-]*([abc])\b[\s-]*listed\b/gi },
];

// "…opposite the Grade II listed church" — the LISTED thing is nearby, not this property.
const RMP_PROXIMITY = new RegExp(
  "\\b(?:opposite|adjacent|next\\s+to|close\\s+to|near(?:by)?|overlook\\w*|views?\\s+(?:of|over|across|towards?)|" +
  "beside|backing|far\\s+from|moments\\s+from|yards\\s+from|met(?:re|er)s?\\s+from|miles?\\s+from|" +
  "min(?:ute)?s?\\s+(?:from|walk|of)|stone['’]?s\\s+throw|throw\\s+of|walking\\s+distance|short\\s+(?:walk|stroll|drive)|" +
  'surrounded\\s+by|amongst|among|proximity\\s+to|vicinity)\\b[^.,;:!?]{0,60}$', 'i');

// A positive match preceded by a negator in the same clause is really a "not listed" statement
// ("neither situated in a conservation area nor a listed building").
const RMP_NEGATION = /\b(?:not|no|never|isn['’]?t|neither|nor|without|non)\b[^.;:!?]{0,40}$/i;

function rmpSnippet(t, start, end) {
  const from = Math.max(0, start - 55);
  const to = Math.min(t.length, end + 55);
  return (from > 0 ? '…' : '') + t.slice(from, to).trim() + (to < t.length ? '…' : '');
}

// Verdict: { status: 'listed'|'unlisted'|'mention'|'clear', grade, snippet }
// Priority listed > unlisted > mention: a listing that says "the main house is Grade II listed;
// the annexe is not listed" must come out as listed.
function rmpDetectListed(text) {
  if (!text) return { status: 'clear', grade: null, snippet: null };
  const t = String(text).replace(/\s+/g, ' ');
  const accepted = [];

  for (const p of RMP_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(t)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (accepted.some((a) => start >= a.start && start < a.end)) continue;

      let kind = p.kind;
      let grade = null;
      if (p.kind === 'listed') {
        if (p.graded) grade = p.catGrade ? 'Cat ' + m[1].toUpperCase() : rmpNormaliseGrade(m[1]);
        const look = t.slice(Math.max(0, start - 70), start);
        if (RMP_PROXIMITY.test(look)) kind = 'mention';
        else if (RMP_NEGATION.test(look)) kind = 'unlisted';
      }
      accepted.push({ start, end, kind, grade });
    }
  }

  for (const status of ['listed', 'unlisted', 'mention']) {
    const hits = accepted.filter((a) => a.kind === status);
    if (!hits.length) continue;
    const graded = hits.find((a) => a.grade);
    const first = graded || hits[0];
    return { status, grade: status === 'listed' ? first.grade : null, snippet: rmpSnippet(t, first.start, first.end) };
  }
  return { status: 'clear', grade: null, snippet: null };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rmpDetectListed, rmpNormaliseGrade, RMP_DETECT_VERSION };
}
