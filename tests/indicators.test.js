const test = require('node:test');
const assert = require('node:assert/strict');
const { sma, ema } = require('../js/indicators.js');

test('sma is the mean of the last N values', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('ema starts at the sma and then leans toward recent values', () => {
  // period 3 -> k = 0.5
  assert.deepEqual(ema([1, 2, 3, 5, 9], 3), [null, null, 2, 3.5, 6.25]);
});
