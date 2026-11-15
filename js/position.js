/*
 * Helpers for your position: the amount you hold (negative when short)
 * and the average price you got in at.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Position = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FLAT = 1e-6; // anything smaller counts as no position

  // Average entry price after a fill. `before` is the position before the
  // fill: positive for long, negative for short.
  function entryAfterFill(entry, before, side, price, qty) {
    const signed = side === 'buy' ? qty : -qty;
    const after = before + signed;
    if (Math.abs(after) < FLAT) return 0;                             // closed
    if (Math.abs(before) < FLAT || before * after < 0) return price;  // opened, or flipped to the other side
    if (before * signed > 0) {                                        // added to it
      return (entry * Math.abs(before) + price * qty) / Math.abs(after);
    }
    return entry;                                                     // partly closed
  }

  return { FLAT, entryAfterFill };
});
