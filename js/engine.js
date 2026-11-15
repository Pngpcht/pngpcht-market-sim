/*
 * Market engine: a limit order book with price-time priority.
 *
 * No DOM and no dependencies. Loads as a plain <script> in the browser
 * (window.MarketEngine) and with require() in Node for the tests.
 *
 * - Makers rest limit orders in the book. Takers hit them.
 * - A trade always happens at the resting (maker) order's price.
 * - The market price is the price of the last trade.
 * - No fees. You can only buy what you can pay for, and resting orders
 *   reserve the funds they need.
 * - By default there is no shorting: you can only sell what you hold.
 *   An account with `canShort` may sell without holding (its asset goes
 *   negative) until the short is worth as much as the whole account.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarketEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9;
  const BASE_TF = 60; // candles are stored per minute; 1 tick = 1 second

  const roundPrice = (p) => Math.round(p * 100) / 100; // 1 cent price steps
  const floorQty = (q) => Math.floor(q * 1e4 + 1e-6) / 1e4; // 4 decimals
  const clean = (x) => (Math.abs(x) < 1e-7 ? 0 : x);

  /* ---------------------------------------------------------------- */
  /* Candles                                                          */
  /* ---------------------------------------------------------------- */

  // Groups trades into 1-minute candles. Bigger timeframes are built by
  // merging those same candles, so every timeframe shows the same trades.
  class CandleStore {
    constructor(startPrice) {
      this.base = [];
      this.lastClose = startPrice;
      this._cache = new Map(); // timeframe -> merged candles
    }

    // Make sure a candle exists for the minute containing `time`.
    // Minutes without trades become flat candles at the last price.
    advanceTo(time) {
      const bucket = Math.floor(time / BASE_TF) * BASE_TF;
      const last = this.base[this.base.length - 1];
      let next = last ? last.time + BASE_TF : 0;
      while (next <= bucket) {
        const p = this.lastClose;
        this.base.push({ time: next, open: p, high: p, low: p, close: p, volume: 0, trades: 0 });
        next += BASE_TF;
      }
    }

    addTrade(time, price, qty) {
      this.advanceTo(time);
      const c = this.base[this.base.length - 1];
      if (c.trades === 0) {
        c.open = c.high = c.low = price;
      } else {
        if (price > c.high) c.high = price;
        if (price < c.low) c.low = price;
      }
      c.close = price;
      c.volume += qty;
      c.trades += 1;
      this.lastClose = price;
    }

    // Candles for a timeframe given in seconds (a multiple of 60).
    get(tf) {
      if (tf === BASE_TF) return this.base;
      const m = Math.round(tf / BASE_TF);
      let out = this._cache.get(tf);
      if (!out) this._cache.set(tf, (out = []));
      // The last merged candle may still be growing: rebuild from there.
      const from = Math.max(0, out.length - 1);
      out.length = from;
      for (let k = from; k * m < this.base.length; k++) {
        out.push(mergeCandles(this.base, k * m, Math.min((k + 1) * m, this.base.length)));
      }
      return out;
    }
  }

  function mergeCandles(base, start, end) {
    const first = base[start];
    const c = { time: first.time, open: first.open, high: first.high, low: first.low, close: first.close, volume: 0, trades: 0 };
    for (let i = start; i < end; i++) {
      const b = base[i];
      if (b.trades > 0) {
        if (c.trades === 0) {
          c.open = b.open; c.high = b.high; c.low = b.low;
        } else {
          if (b.high > c.high) c.high = b.high;
          if (b.low < c.low) c.low = b.low;
        }
        c.trades += b.trades;
        c.volume += b.volume;
      }
      c.close = b.close;
    }
    return c;
  }

  /* ---------------------------------------------------------------- */
  /* Market                                                           */
  /* ---------------------------------------------------------------- */

  class Market {
    constructor({ startPrice = 100 } = {}) {
      this.time = 0; // seconds of market time
      this.lastPrice = startPrice;
      this.accounts = new Map();
      this.orders = new Map(); // open orders by id
      // Both sides are sorted so the best order is LAST (cheap to pop):
      // bids ascending by price, asks descending by price. Among equal
      // prices the older order sits closer to the end.
      this.bids = [];
      this.asks = [];
      this.candles = new CandleStore(startPrice);
      this.tradeCount = 0;
      this.onTrade = null; // optional callback(trade)
      this._nextOrderId = 1;
      this.candles.advanceTo(0);
    }

    /* ---- accounts ---- */

    addAccount(id, { cash = 0, asset = 0, canShort = false } = {}) {
      const account = { id, cash, asset, canShort, reservedCash: 0, reservedAsset: 0, open: new Set() };
      this.accounts.set(id, account);
      return account;
    }

    account(id) { return this.accounts.get(id); }

    availableCash(id) {
      const a = this.accounts.get(id);
      return Math.max(0, a.cash - a.reservedCash);
    }

    availableAsset(id) {
      const a = this.accounts.get(id);
      return Math.max(0, a.asset - a.reservedAsset);
    }

    // What the account is worth right now: cash plus its position at the last price.
    equity(id) {
      const a = this.accounts.get(id);
      return a.cash + a.asset * this.lastPrice;
    }

    // How much the account may sell right now. Without shorting that is what
    // it holds. With shorting it may go on until the short position is worth
    // as much as the account itself.
    sellable(id) {
      const a = this.accounts.get(id);
      const free = a.asset - a.reservedAsset;
      if (!a.canShort) return Math.max(0, free);
      return Math.max(0, floorQty(free + this.equity(id) / this.lastPrice));
    }

    /* ---- book ---- */

    bestBid() { return this.bids.length ? this.bids[this.bids.length - 1].price : null; }
    bestAsk() { return this.asks.length ? this.asks[this.asks.length - 1].price : null; }

    openOrders(accountId) { return Array.from(this.accounts.get(accountId).open); }

    // Advance market time by one tick (1 second).
    tick() {
      this.time += 1;
      this.candles.advanceTo(this.time);
    }

    /* ---- orders ---- */

    // Limit order: trades against anything it crosses, the rest waits in the book.
    placeLimit(accountId, side, price, qty) {
      const acct = this.accounts.get(accountId);
      price = roundPrice(price);
      qty = floorQty(qty);
      if (!acct) return fail('Unknown account');
      if (side !== 'buy' && side !== 'sell') return fail('Side must be buy or sell');
      if (!(price > 0)) return fail('Price must be above zero');
      if (!(qty > 0)) return fail('Amount must be above zero');
      if (side === 'buy' && price * qty > this.availableCash(accountId) + EPS) return fail('Not enough cash');
      if (side === 'sell' && qty > this.sellable(accountId) + EPS) return fail(sellError(acct));

      const fills = this._match(acct, side, qty, price);
      const filled = sumQty(fills);
      const remaining = floorQty(qty - filled);
      let order = null;
      if (remaining > 0) {
        order = { id: this._nextOrderId++, accountId, side, price, qty, remaining, time: this.time };
        this._rest(order, acct);
      }
      return { ok: true, order, fills, filled };
    }

    // Market order: trades against the best resting orders until it is
    // filled, the book is empty, or (for buys) the cash runs out.
    placeMarket(accountId, side, qty) {
      const acct = this.accounts.get(accountId);
      qty = floorQty(qty);
      if (!acct) return fail('Unknown account');
      if (side !== 'buy' && side !== 'sell') return fail('Side must be buy or sell');
      if (!(qty > 0)) return fail('Amount must be above zero');
      if (side === 'sell' && qty > this.sellable(accountId) + EPS) return fail(sellError(acct));
      const book = side === 'buy' ? this.asks : this.bids;
      if (!book.length) return fail('No orders to trade against');

      const fills = this._match(acct, side, qty, null);
      if (!fills.length) return fail(side === 'buy' ? 'Not enough cash' : 'No orders to trade against');
      return { ok: true, order: null, fills, filled: sumQty(fills) };
    }

    cancel(orderId) {
      const order = this.orders.get(orderId);
      if (!order) return false;
      this._remove(order);
      return true;
    }

    cancelAll(accountId) {
      for (const order of this.openOrders(accountId)) this._remove(order);
    }

    /* ---- internals ---- */

    _match(taker, side, qty, limit) {
      const book = side === 'buy' ? this.asks : this.bids;
      const fills = [];
      let remaining = qty;
      while (remaining > EPS && book.length) {
        const maker = book[book.length - 1];
        if (limit !== null && (side === 'buy' ? maker.price > limit : maker.price < limit)) break;
        if (maker.accountId === taker.id) {
          // Never trade with yourself: the older resting order is cancelled.
          this._remove(maker);
          continue;
        }
        let q = Math.min(remaining, maker.remaining);
        if (side === 'buy') {
          q = Math.min(q, floorQty((taker.cash - taker.reservedCash) / maker.price));
          if (q <= EPS) break; // out of cash
        }
        fills.push(this._trade(taker, maker, side, q));
        remaining = floorQty(remaining - q);
      }
      return fills;
    }

    _trade(taker, maker, takerSide, qty) {
      const makerAcct = this.accounts.get(maker.accountId);
      const price = maker.price;
      const cost = price * qty;
      if (takerSide === 'buy') {
        taker.cash = clean(taker.cash - cost);
        taker.asset += qty;
        makerAcct.cash += cost;
        makerAcct.asset = clean(makerAcct.asset - qty);
        makerAcct.reservedAsset = clean(makerAcct.reservedAsset - qty);
      } else {
        taker.asset = clean(taker.asset - qty);
        taker.cash += cost;
        makerAcct.asset += qty;
        makerAcct.cash = clean(makerAcct.cash - cost);
        makerAcct.reservedCash = clean(makerAcct.reservedCash - cost);
      }
      maker.remaining = floorQty(maker.remaining - qty);
      if (maker.remaining <= EPS) this._remove(maker);

      this.lastPrice = price;
      this.tradeCount += 1;
      this.candles.addTrade(this.time, price, qty);
      const trade = {
        id: this.tradeCount,
        time: this.time,
        price,
        qty,
        takerSide,
        buyer: takerSide === 'buy' ? taker.id : maker.accountId,
        seller: takerSide === 'sell' ? taker.id : maker.accountId,
      };
      if (this.onTrade) this.onTrade(trade);
      return trade;
    }

    _rest(order, acct) {
      const book = order.side === 'buy' ? this.bids : this.asks;
      // First index whose price is at or past the new price, so the new
      // order lands in front of (further from the end than) older equals.
      let lo = 0, hi = book.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const before = order.side === 'buy' ? book[mid].price < order.price : book[mid].price > order.price;
        if (before) lo = mid + 1; else hi = mid;
      }
      book.splice(lo, 0, order);
      this.orders.set(order.id, order);
      acct.open.add(order);
      if (order.side === 'buy') acct.reservedCash += order.price * order.remaining;
      else acct.reservedAsset += order.remaining;
    }

    _remove(order) {
      const book = order.side === 'buy' ? this.bids : this.asks;
      const i = book.lastIndexOf(order);
      if (i >= 0) book.splice(i, 1);
      this.orders.delete(order.id);
      const acct = this.accounts.get(order.accountId);
      acct.open.delete(order);
      if (order.side === 'buy') acct.reservedCash = clean(acct.reservedCash - order.price * order.remaining);
      else acct.reservedAsset = clean(acct.reservedAsset - order.remaining);
      if (acct.open.size === 0) { acct.reservedCash = 0; acct.reservedAsset = 0; } // drop rounding drift
      order.remaining = 0;
    }
  }

  function sellError(acct) {
    return acct.canShort ? 'Short would be bigger than your account' : 'Not enough to sell (no shorting)';
  }

  function fail(error) { return { ok: false, error, order: null, fills: [], filled: 0 }; }

  function sumQty(fills) {
    let total = 0;
    for (const f of fills) total += f.qty;
    return floorQty(total);
  }

  return { Market };
});
