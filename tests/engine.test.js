// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { Market } = require('../js/engine.js');

function setup() {
  const m = new Market({ startPrice: 100 });
  m.addAccount('maker', { cash: 100000, asset: 1000 });
  m.addAccount('me', { cash: 10000, asset: 0 });
  return m;
}

test('limit orders rest in the book without trading until they cross', () => {
  const m = setup();
  m.placeLimit('maker', 'sell', 101, 5);
  m.placeLimit('maker', 'buy', 99, 5);
  assert.equal(m.tradeCount, 0);
  assert.equal(m.bestAsk(), 101);
  assert.equal(m.bestBid(), 99);
  assert.equal(m.lastPrice, 100);
});

test('a market buy takes the cheapest asks first and raises the price', () => {
  const m = setup();
  m.placeLimit('maker', 'sell', 102, 5);
  m.placeLimit('maker', 'sell', 101, 5);
  const r = m.placeMarket('me', 'buy', 8);
  assert.equal(r.ok, true);
  assert.deepEqual(r.fills.map((f) => [f.price, f.qty]), [[101, 5], [102, 3]]);
  assert.equal(m.lastPrice, 102); // price is the last traded price
  assert.equal(m.account('me').asset, 8);
  assert.equal(m.account('me').cash, 10000 - 101 * 5 - 102 * 3);
});

test('a market sell takes the highest bids first and lowers the price', () => {
  const m = setup();
  m.placeLimit('maker', 'sell', 101, 10);
  m.placeLimit('maker', 'buy', 99, 5);
  m.placeLimit('maker', 'buy', 98, 5);
  m.placeMarket('me', 'buy', 10);
  assert.equal(m.lastPrice, 101);
  const r = m.placeMarket('me', 'sell', 8);
  assert.deepEqual(r.fills.map((f) => [f.price, f.qty]), [[99, 5], [98, 3]]);
  assert.equal(m.lastPrice, 98);
});

test('orders at the same price fill oldest first', () => {
  const m = setup();
  m.addAccount('maker2', { cash: 0, asset: 100 });
  m.placeLimit('maker', 'sell', 101, 2);
  m.placeLimit('maker2', 'sell', 101, 2);
  const r = m.placeMarket('me', 'buy', 3);
  assert.deepEqual(r.fills.map((f) => [f.seller, f.qty]), [['maker', 2], ['maker2', 1]]);
});

test('a crossing limit order trades at the resting price and rests the remainder', () => {
  const m = setup();
  m.placeLimit('maker', 'sell', 101, 2);
  const r = m.placeLimit('me', 'buy', 103, 5);
  assert.equal(r.filled, 2);
  assert.equal(r.fills[0].price, 101); // maker's price, not my limit
  assert.equal(r.order.remaining, 3);
  assert.equal(m.bestBid(), 103);
  assert.equal(m.availableCash('me'), 10000 - 101 * 2 - 103 * 3); // rest is reserved
});

test('no shorting and no buying beyond your cash', () => {
  const m = setup();
  m.placeLimit('maker', 'sell', 100, 500);
  assert.equal(m.placeMarket('me', 'sell', 1).ok, false);
  assert.equal(m.placeLimit('me', 'sell', 105, 1).ok, false);
  assert.equal(m.placeLimit('me', 'buy', 100, 101).ok, false); // costs 10100
  const r = m.placeMarket('me', 'buy', 500); // only 100 are affordable
  assert.equal(r.filled, 100);
  assert.equal(m.account('me').cash, 0);
  // Asset already offered in a resting sell cannot be sold twice.
  m.placeLimit('me', 'sell', 110, 100);
  assert.equal(m.placeLimit('me', 'sell', 111, 1).ok, false);
});

test('an account that can short may sell without buying first', () => {
  const m = setup();
  m.addAccount('fx', { cash: 10000, asset: 0, canShort: true });
  m.placeLimit('maker', 'sell', 100, 1);
  m.placeMarket('me', 'buy', 1); // sets the last price to 100
  m.placeLimit('maker', 'buy', 100, 500);

  // Sell 40 without holding any: the position goes negative, the cash comes in.
  assert.equal(m.placeMarket('fx', 'sell', 40).filled, 40);
  assert.equal(m.account('fx').asset, -40);
  assert.equal(m.account('fx').cash, 14000);
  assert.equal(m.equity('fx'), 10000);

  // The short can grow until it is worth the whole account (100 here), no further.
  assert.equal(m.sellable('fx'), 60);
  assert.equal(m.placeMarket('fx', 'sell', 61).ok, false);
  assert.equal(m.placeLimit('fx', 'sell', 101, 60).ok, true);
  assert.equal(m.placeLimit('fx', 'sell', 101, 1).ok, false); // resting sells count too
  m.cancelAll('fx');

  // Buying back closes the short.
  m.cancelAll('maker');
  m.placeLimit('maker', 'sell', 100, 500);
  m.placeMarket('fx', 'buy', 40);
  assert.equal(m.account('fx').asset, 0);
  assert.equal(m.account('fx').cash, 10000);
});

test('cancelling an order releases its reserved funds', () => {
  const m = setup();
  const r = m.placeLimit('me', 'buy', 90, 10);
  assert.equal(m.availableCash('me'), 10000 - 900);
  assert.equal(m.cancel(r.order.id), true);
  assert.equal(m.availableCash('me'), 10000);
  assert.equal(m.bestBid(), null);
  assert.equal(m.cancel(r.order.id), false);
});

test('trading moves cash and asset between accounts without creating any', () => {
  const m = setup();
  m.placeLimit('maker', 'sell', 100.5, 7);
  m.placeLimit('maker', 'buy', 99.5, 7);
  m.placeMarket('me', 'buy', 4.25);
  m.placeMarket('me', 'sell', 1.5);
  const total = (key) => m.account('me')[key] + m.account('maker')[key];
  assert.ok(Math.abs(total('cash') - 110000) < 1e-6);
  assert.ok(Math.abs(total('asset') - 1000) < 1e-6);
});

test('every timeframe groups the same trades into candles', () => {
  const m = setup();
  m.placeLimit('maker', 'sell', 100, 100);
  const buyAt = (time, price) => {
    while (m.time < time) m.tick();
    m.cancelAll('maker');
    m.placeLimit('maker', 'sell', price, 100);
    m.placeMarket('me', 'buy', 1);
  };
  buyAt(10, 101);  // minute 0
  buyAt(50, 99);   // minute 0
  buyAt(70, 104);  // minute 1
  buyAt(200, 98);  // minute 3 (minute 2 has no trades)
  buyAt(310, 102); // minute 5: second 5m candle

  const m1 = m.candles.get(60);
  assert.equal(m1.length, 6);
  assert.deepEqual(pick(m1[0]), { time: 0, open: 101, high: 101, low: 99, close: 99, volume: 2 });
  assert.deepEqual(pick(m1[2]), { time: 120, open: 104, high: 104, low: 104, close: 104, volume: 0 }); // flat

  const m5 = m.candles.get(300);
  assert.equal(m5.length, 2);
  assert.deepEqual(pick(m5[0]), { time: 0, open: 101, high: 104, low: 98, close: 98, volume: 4 });
  assert.deepEqual(pick(m5[1]), { time: 300, open: 102, high: 102, low: 102, close: 102, volume: 1 });

  const h1 = m.candles.get(3600);
  assert.equal(h1.length, 1);
  assert.deepEqual(pick(h1[0]), { time: 0, open: 101, high: 104, low: 98, close: 102, volume: 5 });
});

function pick(c) {
  return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}
