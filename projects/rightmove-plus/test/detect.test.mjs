// node --test projects/rightmove-plus/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rmpDetectListed } = require('../content/detect.js');

const cases = [
  // -- positives
  ['A stunning Grade II listed cottage in the heart of the village', 'listed', 'II'],
  ['GRADE II* LISTED FARMHOUSE', 'listed', 'II*'],
  ['This Grade 2 listed property retains many original features', 'listed', 'II'],
  ['A rare Grade One listed manor house', 'listed', 'I'],
  ['Grade II-listed townhouse', 'listed', 'II'],
  ['The property is listed, Grade II, and dates from 1740', 'listed', 'II'],
  ['This Grade II thatched cottage oozes charm', 'listed', 'II'], // roman grade, no "listed"
  ['A beautiful listed building in the conservation area', 'listed', null],
  ['Listed building consent has been granted for the extension', 'listed', null],
  ['Category B listed townhouse in Edinburgh New Town', 'listed', 'Cat B'],
  ['Grade B1 listed Victorian villa in Belfast', 'listed', 'B1'],
  ['The main house is Grade II listed; the annexe is not listed', 'listed', 'II'], // listed outranks unlisted
  ['Grade II listed barn conversion opposite the church', 'listed', 'II'],

  // -- explicit not-listed (the attractive ones)
  ['The property is neither listed nor situated within a conservation area.', 'unlisted', null],
  ['It is not a listed building', 'unlisted', null],
  ['Whilst not listed, the cottage retains a wealth of period features', 'unlisted', null],
  ['The house is not Grade II listed', 'unlisted', null],
  ['An unlisted Georgian townhouse', 'unlisted', null],
  ['This non-listed period property offers freedom to modernise', 'unlisted', null],
  ['Neither situated in a conservation area nor a listed building', 'unlisted', null],
  ['Free from listed building restrictions', 'unlisted', null],

  // -- nearby/contextual mentions only
  ['Situated opposite the Grade II listed parish church', 'mention', null],
  ['Within walking distance of the Grade II listed town hall', 'mention', null],
  ["A stone's throw from the Grade I listed cathedral", 'mention', null],
  ['Not far from the Grade II listed pub', 'mention', null], // proximity beats negation

  // -- clear (no signal at all)
  ['A modern three bedroom semi-detached house with garage', 'clear', null],
  ['EPC Grade C. Council tax band D', 'clear', null],
  ['Set in 4 acres of Grade 2 agricultural land', 'clear', null], // digit grade without "listed"
  ['Grade A office space on the ground floor', 'clear', null],
  ['Newly listed with Foxtons', 'clear', null],
  ['', 'clear', null],
];

for (const [text, status, grade] of cases) {
  test(JSON.stringify(text.slice(0, 60)) + ' → ' + status + (grade ? '/' + grade : ''), () => {
    const v = rmpDetectListed(text);
    assert.equal(v.status, status, 'status; got ' + JSON.stringify(v));
    assert.equal(v.grade, grade, 'grade; got ' + JSON.stringify(v));
  });
}

test('snippet covers the deciding match', () => {
  const v = rmpDetectListed('Lorem ipsum dolor sit amet. This wonderful Grade II listed cottage has oak beams throughout.');
  assert.equal(v.status, 'listed');
  assert.ok(v.snippet.includes('Grade II listed'), v.snippet);
});
