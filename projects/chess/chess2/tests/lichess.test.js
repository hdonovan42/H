// js/lichess.js against lichess.org's own server analysis of 12 real games
// (lichess-games.json: /game/export/{id}?evals=true&accuracy=true, 2026-09-23).
// Each ply is { cp | mate, best?, judgement? } from White's point of view.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accuracy, judge, INITIAL } from '../js/lichess.js';

const games = JSON.parse(readFileSync(new URL('lichess-games.json', import.meta.url)));
const evalOf = ({ cp, mate }) => (mate !== undefined ? { mate } : { cp });

test('accuracy matches lichess.org exactly, both colours, every game', () => {
  for (const g of games) {
    const a = accuracy(g.plies.map(evalOf));
    assert.deepEqual({ white: Math.round(a.white), black: Math.round(a.black) }, g.accuracy, g.id);
  }
});

// lila stores `best` only on judged plies, so an unjudged ply can't tell us
// whether the best move was played. Judged plies must match exactly; every
// other ply must either get no judgement or be one lila skipped for playing best.
test('judgements match lichess.org on every judged ply', () => {
  let judged = 0, silent = 0;
  for (const g of games) {
    g.plies.forEach((p, i) => {
      const got = judge(i ? evalOf(g.plies[i - 1]) : INITIAL, evalOf(p), i % 2 === 0);
      if (p.judgement) { assert.equal(got, p.judgement, `${g.id} ply ${i + 1}`); judged++; }
      else if (got) silent++;
    });
  }
  assert.equal(judged, 115);
  // Unjudged plies that our rule would flag: only possible if lila skipped them
  // as best moves. Reported so a change here is noticed.
  console.log(`  ${judged} judged plies match; ${silent} unjudged plies would be flagged unless the best move was played`);
});

test('mate sequences follow lila', () => {
  assert.equal(judge({ cp: 50 }, { mate: -3 }, true), 'blunder');       // walked into mate
  assert.equal(judge({ cp: -800 }, { mate: -3 }, true), 'mistake');
  assert.equal(judge({ cp: -1200 }, { mate: -3 }, true), 'inaccuracy');
  assert.equal(judge({ mate: 2 }, { cp: 1200 }, true), 'inaccuracy');    // let mate slip, still winning
  assert.equal(judge({ mate: 2 }, { mate: -5 }, true), 'blunder');
  assert.equal(judge({ mate: -2 }, { cp: -300 }, false), 'blunder');     // same, for Black
  assert.equal(judge({ mate: 4 }, { mate: 3 }, true), null);
});
