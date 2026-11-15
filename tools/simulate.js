/*
 * Headless run: the same market as the app, with no screen.
 * Simulates a number of days and prints how gold-like the result is.
 *
 *   node tools/simulate.js                     30 days from the live price
 *   node tools/simulate.js --days 10 --seed 7  another length or random seed
 *   node tools/simulate.js --price 3900        start from a fixed price
 */
const Config = require('../js/config.js');
const Calendar = require('../js/calendar.js');
const News = require('../js/news.js');
const Simulation = require('../js/simulation.js');

const { HOUR, DAY } = Calendar;
const SESSIONS = ['asia', 'london', 'overlap', 'newyork'];
const NEWS_WINDOW = 3 * HOUR; // "within a few hours" of an event

function option(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}

// Small seeded random generator so a run can be repeated.
function seeded(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const usd = (x) => '$' + x.toFixed(2);
const verdict = (ok) => (ok ? 'ok  ' : 'MISS');

async function main() {
  const days = option('days', 30);
  const seed = option('seed', 1);
  const fixed = option('price', null);
  const start = fixed ? { price: fixed, source: 'command line' } : await Config.resolveStartPrice();

  const sim = Simulation.create({ startPrice: start.price, rng: seeded(seed) });
  const market = sim.market;

  // Spread, sampled every open second, by session and inside or outside news.
  const spread = {};
  for (const s of SESSIONS) spread[s] = { sum: 0, n: 0, normal: 0, ounces: 0 };
  // The volatile time is the quarter of an hour after a news release. News
  // comes out in the overlap session, so compare inside that session.
  const newsSpread = { sum: 0, n: 0 };
  const calmSpread = { sum: 0, n: 0 };

  let closedTrades = 0;
  let weekendsSkipped = 0;
  market.onTrade = (t) => {
    if (!Calendar.isOpen(t.time)) closedTrades++;
    spread[Calendar.session(t.time)].ounces += t.qty;
  };

  const began = Date.now();
  const end = days * DAY;
  while (market.time < end) {
    const before = market.time;
    sim.step();
    if (market.time - before > 1) { weekendsSkipped++; continue; }
    const bid = market.bestBid(), ask = market.bestAsk();
    if (bid === null || ask === null) continue;
    const width = ask - bid;
    const session = Calendar.session(market.time);
    const s = spread[session];
    s.sum += width; s.n++;
    if (width >= 0.095 && width <= 0.305) s.normal++;
    if (session === 'overlap') {
      const event = sim.news.at(market.time);
      const bucket = !event ? calmSpread : market.time - event.time < 900 ? newsSpread : null;
      if (bucket) { bucket.sum += width; bucket.n++; }
    }
  }
  const seconds = (Date.now() - began) / 1000;

  // Daily range, on trading days that run from 22:00 to 22:00 GMT.
  const candles = market.candles.get(60);
  const daily = new Map();
  for (const c of candles) {
    if (!c.trades) continue;
    const key = Math.floor((c.time + 2 * HOUR) / DAY);
    const d = daily.get(key) || { low: Infinity, high: -Infinity, close: 0, minutes: 0 };
    d.low = Math.min(d.low, c.low); d.high = Math.max(d.high, c.high); d.close = c.close; d.minutes++;
    daily.set(key, d);
  }
  for (const [key, d] of daily) if (d.minutes < 600) daily.delete(key); // a day the run only caught part of
  const ranges = [...daily.values()].map((d) => ({ dollars: d.high - d.low, percent: (100 * (d.high - d.low)) / d.close }));
  const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  const rangeDollars = mean(ranges.map((r) => r.dollars));
  const rangePercent = mean(ranges.map((r) => r.percent));

  // News: the furthest the price got from where it was when the event began.
  const spikes = [];
  for (const event of sim.news.events) {
    if (event.time + NEWS_WINDOW > end) continue;
    let from = null, far = 0;
    for (const c of candles) {
      if (c.time < event.time - 60) continue;
      if (c.time >= event.time + NEWS_WINDOW) break;
      if (from === null) { from = c.close; continue; }
      far = Math.max(far, Math.abs(c.high - from), Math.abs(c.low - from));
    }
    spikes.push({ time: event.time, direction: event.direction, move: far });
  }
  const closedCandles = candles.filter((c) => !Calendar.isOpen(c.time)).length;
  const weeks = days / 7;

  console.log('XAU/USD headless run: ' + days + ' days, seed ' + seed + ', ' + seconds.toFixed(1) + 's');
  console.log('Start price ' + usd(start.price) + ' (' + start.source + '), last price ' + usd(market.lastPrice) + ', ' + market.tradeCount + ' trades');
  console.log('');

  console.log('Daily range (' + ranges.length + ' trading days), target 2 to 3 percent');
  console.log('  ' + verdict(rangePercent >= 2 && rangePercent <= 3) + ' average ' + usd(rangeDollars) + ' = ' + rangePercent.toFixed(2) + '%');
  console.log('       smallest ' + usd(Math.min(...ranges.map((r) => r.dollars))) + ', biggest ' + usd(Math.max(...ranges.map((r) => r.dollars))));
  console.log('');

  console.log('Average spread by session, target 0.10 to 0.30 in normal conditions, wider when quiet or volatile');
  const perHour = (name) => (spread[name].ounces / spread[name].n) * HOUR;
  for (const name of SESSIONS) {
    const s = spread[name];
    const avg = s.sum / s.n;
    console.log('  ' + verdict(avg >= 0.1 && avg <= 0.3) + ' ' + name.padEnd(8) + usd(avg) + '   inside 0.10 to 0.30 for ' + ((100 * s.normal) / s.n).toFixed(0) + '% of the time,  ' + Math.round(perHour(name)) + ' oz traded per hour');
  }
  console.log('  ' + verdict(perHour('asia') < perHour('london') && perHour('london') < perHour('overlap')) + ' volume: asia thinnest, london more, overlap the busiest');
  const quietWider = spread.asia.sum / spread.asia.n > spread.overlap.sum / spread.overlap.n;
  const newsWider = newsSpread.n > 0 && newsSpread.sum / newsSpread.n > 1.2 * (calmSpread.sum / calmSpread.n);
  console.log('  ' + verdict(quietWider) + ' quiet hours (asia) wider than the busy overlap');
  console.log('  ' + verdict(newsWider) + ' volatile: ' + usd(newsSpread.sum / Math.max(1, newsSpread.n)) + ' in the 15 minutes after news, against ' + usd(calmSpread.sum / calmSpread.n) + ' in the same session without news');
  console.log('');

  console.log('News spikes, target a few per week, each moving 40 to 100 dollars within ' + NEWS_WINDOW / HOUR + ' hours');
  console.log('  ' + verdict(spikes.length / weeks >= 2 && spikes.length / weeks <= 4.5) + ' ' + spikes.length + ' events = ' + (spikes.length / weeks).toFixed(1) + ' per week');
  const inTarget = spikes.filter((s) => s.move >= 40 && s.move <= 100).length;
  console.log('  ' + verdict(inTarget >= spikes.length * 0.7) + ' ' + inTarget + ' of ' + spikes.length + ' moved 40 to 100 dollars, average ' + usd(mean(spikes.map((s) => s.move))));
  for (const s of spikes) {
    const week = Math.floor(s.time / Calendar.WEEK) + 1;
    console.log('       week ' + week + ' ' + Calendar.format(s.time) + '  ' + (s.direction > 0 ? 'up  ' : 'down') + '  ' + usd(s.move));
  }
  console.log('');

  console.log('Weekend, target closed Friday 22:00 to Sunday 23:00 GMT');
  console.log('  ' + verdict(closedTrades === 0 && closedCandles === 0 && weekendsSkipped > 0) + ' ' + weekendsSkipped + ' weekends skipped, ' + closedTrades + ' trades and ' + closedCandles + ' candles while closed');
}

main();
