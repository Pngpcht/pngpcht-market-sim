/*
 * The market's clock. Market time is counted in seconds, and second 0 is a
 * Monday at 00:00 GMT.
 *
 * Gold trades from Sunday 23:00 to Friday 22:00 GMT and is closed in between.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Calendar = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HOUR = 3600;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const WEEK_CLOSE = 4 * DAY + 22 * HOUR; // Friday 22:00
  const WEEK_OPEN = 6 * DAY + 23 * HOUR;  // Sunday 23:00

  function isOpen(t) {
    const inWeek = t % WEEK;
    return inWeek < WEEK_CLOSE || inWeek >= WEEK_OPEN;
  }

  // The next second the market is open: `t` itself if it is open now.
  function nextOpen(t) {
    return isOpen(t) ? t : t - (t % WEEK) + WEEK_OPEN;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function dayName(t) {
    return DAY_NAMES[Math.floor(t / DAY) % 7];
  }

  // "Wed 13:05" or "Wed 13:05:22", GMT.
  function format(t, withSeconds) {
    const text = dayName(t) + ' ' + pad2(Math.floor((t % DAY) / HOUR)) + ':' + pad2(Math.floor((t % HOUR) / 60));
    return withSeconds ? text + ':' + pad2(Math.floor(t % 60)) : text;
  }

  return { HOUR, DAY, WEEK, WEEK_CLOSE, WEEK_OPEN, isOpen, nextOpen, dayName, format };
});
