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

  // A "normal" order: 1.5% of a 10,000 balance. The whale multiplies this.
  const NORMAL_ORDER_VALUE = 150;

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
      this.gap = gap; // distance from the price, as a fraction of the price
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
      const gap = Math.max(0.01, price * this.gap);
      this.bid = market.placeLimit(this.id, 'buy', price - gap, (0.01 * acct.cash) / price).order;
      this.ask = market.placeLimit(this.id, 'sell', price + gap, 0.01 * acct.asset).order;
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
      let qty = (between(rng, 10, 50) * NORMAL_ORDER_VALUE) / market.lastPrice;
      if (side === 'sell') qty = Math.min(qty, market.availableAsset(this.id));
      market.placeMarket(this.id, side, qty);
    }
  }

  // Create the crowd and give each bot an account. Balances are set so
  // that, at the starting price, everyone holds half cash and half asset.
  function createBots(market, rng = Math.random) {
    const price = market.lastPrice;
    const bots = [];
    const add = (bot, cash) => {
      market.addAccount(bot.id, { cash, asset: cash / price });
      bots.push(bot);
    };
    for (let i = 1; i <= 30; i++) add(new RandomBot('random-' + i), 10000);
    add(new TrendBot('trend-1', 5, 20), 10000);
    add(new TrendBot('trend-2', 10, 30), 10000);
    add(new TrendBot('trend-3', 20, 60), 10000);
    add(new TrendBot('trend-4', 30, 120), 10000);
    add(new HftBot('hft-1', 0.0002), 50000);
    add(new HftBot('hft-2', 0.0004), 50000);
    add(new WhaleBot('whale'), 1000000);

    return {
      bots,
      // Let every bot act once. Call after each market tick.
      step() {
        const start = Math.floor(rng() * bots.length); // nobody always goes first
        for (let i = 0; i < bots.length; i++) bots[(start + i) % bots.length].act(market, rng);
      },
    };
  }

  return { createBots, RandomBot, TrendBot, HftBot, WhaleBot, NORMAL_ORDER_VALUE };
});
