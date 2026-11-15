const test = require('node:test');
const assert = require('node:assert/strict');
const { entryAfterFill } = require('../js/position.js');

test('entry price follows the fills of a position', () => {
  let entry = entryAfterFill(0, 0, 'buy', 100, 2);      // open long 2 at 100
  assert.equal(entry, 100);
  entry = entryAfterFill(entry, 2, 'buy', 106, 1);      // add 1 at 106
  assert.equal(entry, 102);
  entry = entryAfterFill(entry, 3, 'sell', 110, 1);     // partly close: entry stays
  assert.equal(entry, 102);
  entry = entryAfterFill(entry, 2, 'sell', 108, 5);     // sell through zero: now short 3 at 108
  assert.equal(entry, 108);
  entry = entryAfterFill(entry, -3, 'buy', 105, 3);     // buy back: flat
  assert.equal(entry, 0);
});
