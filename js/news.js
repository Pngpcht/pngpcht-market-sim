/*
 * Scheduled news: a few times a week, at 13:30 GMT on a weekday, something
 * is announced that pushes gold one way. The event itself moves nothing.
 * While it is on, the whale and the trend followers trade hard, and their
 * orders move the price.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./calendar.js'));
  else root.News = factory(root.Calendar);
})(typeof self !== 'undefined' ? self : this, function (Calendar) {
  'use strict';

  const { HOUR, DAY, WEEK } = Calendar;

  const PER_WEEK_MIN = 2;
  const PER_WEEK_MAX = 4;
  const RELEASE = 13.5 * HOUR;  // 13:30 GMT
  const DURATION = 2.5 * HOUR;  // how long the heavy trading lasts

  function create(rng = Math.random) {
    const events = []; // in time order: { time, end, direction }
    let weeks = 0;     // weeks scheduled so far
    let cursor = 0;    // first event that has not ended yet

    function scheduleWeek(week) {
      const days = [0, 1, 2, 3, 4]; // Monday to Friday
      const count = PER_WEEK_MIN + Math.floor(rng() * (PER_WEEK_MAX - PER_WEEK_MIN + 1));
      const picked = [];
      for (let i = 0; i < count; i++) picked.push(days.splice(Math.floor(rng() * days.length), 1)[0]);
      picked.sort((a, b) => a - b);
      for (const day of picked) {
        const time = week * WEEK + day * DAY + RELEASE;
        events.push({ time, end: time + DURATION, direction: rng() < 0.5 ? 1 : -1 });
      }
    }

    return {
      events,

      // The event that is on at market time `t`, or null. Call with rising times.
      at(t) {
        while (weeks <= Math.floor(t / WEEK)) scheduleWeek(weeks++);
        while (cursor < events.length && events[cursor].end <= t) cursor++;
        const event = events[cursor];
        return event && event.time <= t ? event : null;
      },
    };
  }

  return { create, DURATION };
});
