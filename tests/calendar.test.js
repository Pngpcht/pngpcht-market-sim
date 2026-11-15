const test = require('node:test');
const assert = require('node:assert/strict');
const Calendar = require('../js/calendar.js');
const Simulation = require('../js/simulation.js');
const { Market } = require('../js/engine.js');

const { HOUR, DAY } = Calendar;
const at = (day, hour, minute = 0) => day * DAY + hour * HOUR + minute * 60; // day 0 is Monday

test('the market is open from Sunday 23:00 to Friday 22:00 GMT', () => {
  assert.equal(Calendar.isOpen(at(0, 0)), true);       // Monday 00:00
  assert.equal(Calendar.isOpen(at(4, 21, 59)), true);  // Friday 21:59
  assert.equal(Calendar.isOpen(at(4, 22)), false);     // Friday 22:00
  assert.equal(Calendar.isOpen(at(5, 12)), false);     // Saturday
  assert.equal(Calendar.isOpen(at(6, 22, 59)), false); // Sunday 22:59
  assert.equal(Calendar.isOpen(at(6, 23)), true);      // Sunday 23:00
  assert.equal(Calendar.isOpen(at(7 + 4, 22)), false); // the next Friday too
  assert.equal(Calendar.nextOpen(at(5, 12)), at(6, 23));
  assert.equal(Calendar.nextOpen(at(2, 9)), at(2, 9));
  assert.equal(Calendar.format(at(2, 13, 5)), 'Wed 13:05');
});

test('the simulation jumps over the weekend and nothing trades in it', () => {
  const sim = Simulation.create({ startPrice: 4000 });
  sim.market.skipTo(at(4, 21, 30)); // start half an hour before the Friday close
  const closedTrades = [];
  sim.market.onTrade = (t) => { if (!Calendar.isOpen(t.time)) closedTrades.push(t); };
  for (let i = 0; i < HOUR; i++) sim.step();

  assert.equal(closedTrades.length, 0);
  assert.equal(Calendar.format(sim.market.time).slice(0, 6), 'Sun 23'); // half an hour after the Sunday open
  assert.ok(sim.market.candles.get(60).every((c) => Calendar.isOpen(c.time)), 'no candles while closed');
});

test('bigger candles leave a gap for skipped time', () => {
  const m = new Market({ startPrice: 100 });
  for (let i = 0; i < 2 * HOUR; i++) m.tick();   // Monday 00:00 to 02:00
  m.skipTo(at(0, 9));                             // jump to 09:00
  for (let i = 0; i < HOUR; i++) m.tick();        // 09:00 to 10:00
  const times = m.candles.get(4 * HOUR).map((c) => c.time / HOUR);
  assert.deepEqual(times, [0, 8]); // the 04:00 candle does not exist
});
