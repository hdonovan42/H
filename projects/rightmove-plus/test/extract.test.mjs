// Extraction tests against real Rightmove pages. Fixtures are gitignored (copyrighted content);
// refresh them with test/fetch-fixtures.sh — tests skip politely when absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { rmpExtractDetail, rmpExtractDetailFromModel, rmpNextDataToMap } = require('../content/extract.js');

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const propertyPage = join(fixtures, 'property.html');
const searchPage = join(fixtures, 'search.html');

test('detail page: description + key features via __PAGE_MODEL', { skip: !existsSync(propertyPage) }, () => {
  const html = readFileSync(propertyPage, 'utf8');
  const ex = rmpExtractDetailFromModel(html);
  assert.ok(ex, 'model extraction returned null');
  assert.equal(ex.source, 'model');
  assert.ok(ex.desc.length > 100, 'description too short: ' + ex.desc.length);
  assert.ok(ex.features.length > 0, 'no key features');
});

test('detail page: markup fallback also finds the description', { skip: !existsSync(propertyPage) }, () => {
  const html = readFileSync(propertyPage, 'utf8');
  const model = rmpExtractDetailFromModel(html);
  const crippled = html.replace(/__PAGE_MODEL/g, '__NOPE');
  const ex = rmpExtractDetail(crippled);
  assert.ok(ex, 'fallback extraction returned null');
  assert.equal(ex.source, 'markup');
  // both paths should agree on the opening of the description
  assert.equal(ex.desc.slice(0, 60), model.desc.slice(0, 60));
});

test('search page: __NEXT_DATA__ → id-keyed text map', { skip: !existsSync(searchPage) }, () => {
  const html = readFileSync(searchPage, 'utf8');
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  assert.ok(m, 'no __NEXT_DATA__ on search page');
  const map = rmpNextDataToMap(JSON.parse(m[1]));
  assert.ok(map.size >= 20, 'expected a page of results, got ' + map.size);
  for (const [id, text] of map) {
    assert.match(id, /^\d+$/);
    assert.equal(typeof text, 'string');
  }
});
