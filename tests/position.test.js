const test = require('node:test');
const assert = require('node:assert/strict');
const { entryAfterFill, checkLevels, levelHit } = require('../js/position.js');

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

test('stop loss and take profit must sit on the right side of the price', () => {
  assert.equal(checkLevels(1, 100, 95, 110), null);          // long: stop below, target above
  assert.match(checkLevels(1, 100, 101, null), /Stop loss/);
  assert.match(checkLevels(1, 100, null, 99), /Take profit/);
  assert.equal(checkLevels(-1, 100, 105, 90), null);         // short: the other way round
  assert.match(checkLevels(-1, 100, 95, null), /Stop loss/);
  assert.match(checkLevels(-1, 100, null, 110), /Take profit/);
});

test('a level is hit when the traded range reaches it', () => {
  assert.equal(levelHit(5, 95, 110, 96, 104), null);   // long, price in between
  assert.equal(levelHit(5, 95, 110, 94.9, 100), 'sl');
  assert.equal(levelHit(5, 95, 110, 100, 110), 'tp');
  assert.equal(levelHit(-5, 105, 90, 96, 104), null);  // short, price in between
  assert.equal(levelHit(-5, 105, 90, 100, 105.2), 'sl');
  assert.equal(levelHit(-5, 105, 90, 89, 100), 'tp');
  assert.equal(levelHit(0, 95, 110, 0, 999), null);    // no position, nothing to close
  assert.equal(levelHit(5, null, null, 0, 999), null); // no levels set
});
