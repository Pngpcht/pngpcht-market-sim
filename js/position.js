/*
 * Helpers for your position: the amount you hold (negative when short),
 * the average price you got in at, and its stop loss and take profit.
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

  // Are a stop loss and take profit on the right side of `price`?
  // `direction` is positive for a long position, negative for a short one.
  // A level that is not set is null. Returns what is wrong, or null.
  function checkLevels(direction, price, sl, tp) {
    if (direction > 0) {
      if (sl !== null && sl >= price) return 'Stop loss must be below the price when you are long';
      if (tp !== null && tp <= price) return 'Take profit must be above the price when you are long';
    } else {
      if (sl !== null && sl <= price) return 'Stop loss must be above the price when you are short';
      if (tp !== null && tp >= price) return 'Take profit must be below the price when you are short';
    }
    return null;
  }

  // Has the market reached the stop loss or take profit of a position?
  // `low` and `high` are the lowest and highest trade since the last check.
  // Returns 'sl', 'tp' or null.
  function levelHit(qty, sl, tp, low, high) {
    if (Math.abs(qty) < FLAT) return null;
    if (qty > 0) {
      if (sl !== null && low <= sl) return 'sl';
      if (tp !== null && high >= tp) return 'tp';
    } else {
      if (sl !== null && high >= sl) return 'sl';
      if (tp !== null && low <= tp) return 'tp';
    }
    return null;
  }

  return { FLAT, entryAfterFill, checkLevels, levelHit };
});
