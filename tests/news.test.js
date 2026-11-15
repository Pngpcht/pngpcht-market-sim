const test = require('node:test');
const assert = require('node:assert/strict');
const News = require('../js/news.js');
const Calendar = require('../js/calendar.js');

test('news comes a few times a week, on weekdays at 13:30 GMT', () => {
  let seed = 11;
  const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const news = News.create(rng);
  news.at(8 * Calendar.WEEK - 1); // schedule eight weeks
  for (let week = 0; week < 8; week++) {
    const inWeek = news.events.filter((e) => Math.floor(e.time / Calendar.WEEK) === week);
    assert.ok(inWeek.length >= 2 && inWeek.length <= 4);
  }
  for (const e of news.events) {
    assert.equal(Calendar.format(e.time).slice(4), '13:30');
    assert.ok(!['Sat', 'Sun'].includes(Calendar.dayName(e.time)));
    assert.ok(Calendar.isOpen(e.time) && Calendar.isOpen(e.end));
    assert.ok(e.direction === 1 || e.direction === -1);
  }
});

test('an event is on from its release until it ends', () => {
  const news = News.create(() => 0.5);
  const first = (news.at(0), news.events[0]);
  const fresh = News.create(() => 0.5);
  assert.equal(fresh.at(first.time - 1), null);
  assert.equal(fresh.at(first.time).time, first.time);
  assert.equal(fresh.at(first.end - 1).time, first.time);
  assert.equal(fresh.at(first.end), null);
});
