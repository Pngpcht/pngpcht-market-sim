/*
 * Moving averages. Each function returns an array the same length as
 * `values`, with null where there is not enough data yet.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Indicators = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Simple moving average: the mean of the last `period` values.
  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  // Exponential moving average, started from the SMA of the first `period` values.
  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let sum = 0;
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      if (i < period) {
        sum += values[i];
        if (i === period - 1) prev = out[i] = sum / period;
      } else {
        prev = out[i] = values[i] * k + prev * (1 - k);
      }
    }
    return out;
  }

  return { sma, ema };
});
