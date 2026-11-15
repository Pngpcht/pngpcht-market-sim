const test = require('node:test');
const assert = require('node:assert/strict');
const { Market } = require('../js/engine.js');
const { createBots, WhaleBot, NORMAL_ORDER_VALUE } = require('../js/bots.js');

// Small seeded random generator so the runs are repeatable.
function seeded(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function totals(market) {
  let cash = 0, asset = 0;
  for (const a of market.accounts.values()) { cash += a.cash; asset += a.asset; }
  return { cash, asset };
}

test('bots make a market on their own, through the order book', () => {
  const market = new Market({ startPrice: 100 });
  const crowd = createBots(market, seeded(7));
  const before = totals(market);
  for (let i = 0; i < 6 * 3600; i++) { market.tick(); crowd.step(); }

  assert.ok(market.tradeCount > 1000, 'bots trade with each other');
  assert.ok(market.bestBid() < market.bestAsk(), 'the book is never crossed');
  assert.ok(market.lastPrice > 50 && market.lastPrice < 200, 'price stays in a sane range');

  // Trading only moves cash and asset around: nothing is created, nobody goes short.
  const after = totals(market);
  assert.ok(Math.abs(after.cash - before.cash) < 1e-3);
  assert.ok(Math.abs(after.asset - before.asset) < 1e-3);
  for (const a of market.accounts.values()) {
    assert.ok(a.cash >= 0 && a.asset >= 0, a.id + ' has no negative balance');
  }
});

test('a whale order is 10 to 50 times the normal size and moves the price', () => {
  const market = new Market({ startPrice: 100 });
  const crowd = createBots(market, seeded(3));
  for (let i = 0; i < 1800; i++) { market.tick(); crowd.step(); }

  // Force the rare order: the first roll says "act now", the second says "buy".
  const rolls = [0, 0, 0.5];
  const whale = new WhaleBot('whale');
  const before = market.lastPrice;
  const held = market.account('whale').asset;
  whale.act(market, () => rolls.shift());
  const bought = market.account('whale').asset - held;

  const normal = NORMAL_ORDER_VALUE / before;
  assert.ok(bought >= 10 * normal - 1e-3 && bought <= 50 * normal + 1e-3);
  assert.ok(market.lastPrice > before, 'a huge buy raises the price');
});
