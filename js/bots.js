/*
 * The other traders. Every bot has its own account and places real orders
 * through the same order book as you, under the same rules (no shorting,
 * no buying beyond its cash). Nothing here touches the price directly.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Bots = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A "normal" order in ounces (0.1 lot): 1.5% of what a random bot holds.
  // The whale multiplies this.
  const NORMAL_ORDER_OZ = 10;

  const between = (rng, lo, hi) => lo + rng() * (hi - lo);

  // Random: buys or sells at random, 1 to 2 percent of its balance each time.
  // Some orders hit the market, the rest wait as limit orders near the price.
  class RandomBot {
    constructor(id) {
      this.id = id;
      this.resting = []; // ids of its limit orders, oldest first
    }

    act(market, rng) {
      if (rng() > 0.08) return;
      const acct = market.account(this.id);
      const price = market.lastPrice;
      const side = rng() < 0.5 ? 'buy' : 'sell';
      const share = between(rng, 0.01, 0.02);
      const qty = side === 'buy' ? (share * acct.cash) / price : share * acct.asset;
      if (rng() < 0.5) {
        market.placeMarket(this.id, side, qty);
        return;
      }
      // Mostly close to the price, now and then far away: that is the depth
      // a big order has to chew through.
      const away = price * 0.006 * -Math.log(1 - rng());
      const result = market.placeLimit(this.id, side, side === 'buy' ? price - away : price + away, qty);
      if (result.order) this.resting.push(result.order.id);
      while (this.resting.length > 8) market.cancel(this.resting.shift()); // drop stale orders
    }
  }

  // Trend follower: fast SMA above slow SMA means buy, below means sell.
  // The averages are taken over 1-minute closes.
  class TrendBot {
    constructor(id, fast, slow) {
      this.id = id;
      this.fast = fast;
      this.slow = slow;
    }

    act(market, rng) {
      if (rng() > 0.002) return;
      const candles = market.candles.get(60);
      if (candles.length <= this.slow) return; // not enough history yet
      const fast = averageClose(candles, this.fast);
      const slow = averageClose(candles, this.slow);
      const acct = market.account(this.id);
      const share = between(rng, 0.01, 0.02);
      if (fast > slow) market.placeMarket(this.id, 'buy', (share * acct.cash) / market.lastPrice);
      else if (fast < slow) market.placeMarket(this.id, 'sell', share * acct.asset);
    }
  }

  function averageClose(candles, n) {
    let sum = 0;
    for (let i = candles.length - n; i < candles.length; i++) sum += candles[i].close;
    return sum / n;
  }

  // High frequency trader: keeps a buy just below the price and a sell just
  // above it, and moves both every tick as the price moves.
  class HftBot {
    constructor(id, gap) {
      this.id = id;
      this.gap = gap; // distance from the price, in dollars
      this.quotedAt = null;
      this.bid = null;
      this.ask = null;
    }

    act(market) {
      const price = market.lastPrice;
      const untouched = (o) => o && o.remaining === o.qty;
      if (price === this.quotedAt && untouched(this.bid) && untouched(this.ask)) return; // nothing to move
      market.cancelAll(this.id);
      const acct = market.account(this.id);
      this.bid = market.placeLimit(this.id, 'buy', price - this.gap, (0.01 * acct.cash) / price).order;
      this.ask = market.placeLimit(this.id, 'sell', price + this.gap, 0.01 * acct.asset).order;
      this.quotedAt = price;
    }
  }

  // Whale: almost always idle, then one huge market order,
  // 10 to 50 times the normal size.
  class WhaleBot {
    constructor(id) {
      this.id = id;
    }

    act(market, rng) {
      if (rng() > 1 / 2400) return; // about once every 40 minutes of market time
      const side = rng() < 0.5 ? 'buy' : 'sell';
      let qty = between(rng, 10, 50) * NORMAL_ORDER_OZ;
      if (side === 'sell') qty = Math.min(qty, market.availableAsset(this.id));
      market.placeMarket(this.id, side, qty);
    }
  }

  // Create the crowd and give each bot an account. Each bot holds the given
  // number of ounces and the same value again in cash, at the starting price.
  function createBots(market, rng = Math.random) {
    const price = market.lastPrice;
    const bots = [];
    const add = (bot, ounces) => {
      market.addAccount(bot.id, { cash: ounces * price, asset: ounces });
      bots.push(bot);
    };
    const normal = NORMAL_ORDER_OZ / 0.015; // holdings that make a typical order "normal"
    for (let i = 1; i <= 30; i++) add(new RandomBot('random-' + i), normal);
    add(new TrendBot('trend-1', 5, 20), normal);
    add(new TrendBot('trend-2', 10, 30), normal);
    add(new TrendBot('trend-3', 20, 60), normal);
    add(new TrendBot('trend-4', 30, 120), normal);
    add(new HftBot('hft-1', 0.08), normal);
    add(new HftBot('hft-2', 0.15), normal);
    add(new WhaleBot('whale'), 100 * normal);

    return {
      bots,
      // Let every bot act once. Call after each market tick.
      step() {
        const start = Math.floor(rng() * bots.length); // nobody always goes first
        for (let i = 0; i < bots.length; i++) bots[(start + i) % bots.length].act(market, rng);
      },
    };
  }

  return { createBots, WhaleBot, NORMAL_ORDER_OZ };
});
