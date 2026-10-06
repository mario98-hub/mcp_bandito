import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RACCOON_MARK, RACCOON_BADGE_SVG, RACCOON_ICON_DATA_URI } from '../dist/core/brand.js';

test('brand: raccoon mark and badge are valid SVG in the dashboard palette', () => {
  assert.match(RACCOON_MARK, /^<svg[^>]*class="logo"/);
  assert.match(RACCOON_MARK, /<\/svg>$/);
  assert.match(RACCOON_BADGE_SVG, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(RACCOON_BADGE_SVG, /<\/svg>$/);
  for (const svg of [RACCOON_MARK, RACCOON_BADGE_SVG]) {
    assert.ok(svg.includes('#14213d'), 'navy band colour');
    assert.ok(svg.includes('#f5c84c'), 'accent (eyes) colour');
    assert.ok(svg.includes('#e9eae4'), 'paper (fur) colour');
  }
  // the badge carries the rounded navy backdrop; the header mark is transparent
  assert.ok(RACCOON_BADGE_SVG.includes('<rect'), 'badge has a backdrop');
  assert.ok(!RACCOON_MARK.includes('<rect'), 'header mark has no backdrop');
});

test('brand: icon data URI round-trips to the badge SVG', () => {
  const prefix = 'data:image/svg+xml,';
  assert.ok(RACCOON_ICON_DATA_URI.startsWith(prefix), 'svg+xml data URI');
  assert.equal(decodeURIComponent(RACCOON_ICON_DATA_URI.slice(prefix.length)), RACCOON_BADGE_SVG);
});
