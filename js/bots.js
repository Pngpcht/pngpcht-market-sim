/*
 * The other traders. Every bot has its own account and places real orders
 * through the same order book as you, under the same rules (no shorting,
 * no buying beyond its cash). Nothing here touches the price directly:
 * how far the price moves in a day comes out of how often the bots trade,
 * how big their orders are and how much is waiting in the book.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./calendar.js'));
  else root.Bots = factory(root.Calendar);
})(typeof self !== 'undefined' ? self : this, function (Calendar) {
  'use strict';

  // Everything that was tuned to make the market behave like gold.
  const TUNING = {
    normalOrder: 10, // ounces (0.1 lot). The whale multiplies this.

    // How the day changes the bots (GMT).
    //   activity:   how often bots act, against London = 1
    //   size:       how big their orders are, against London = 1
    //   halfSpread: how far the high frequency trader quotes from the price, in dollars
    sessions: {
      asia:    { activity: 0.25, size: 0.6, halfSpread: 0.14 },
      london:  { activity: 1.0,  size: 1.0, halfSpread: 0.10 },
      overlap: { activity: 1.6,  size: 1.3, halfSpread: 0.08 },
      newyork: { activity: 0.9,  size: 1.0, halfSpread: 0.11 },
    },

    random: {
      count: 300,
      rate: 0.008,       // chance for each one to act each second, in London
      marketShare: 0.5,  // part of its orders that hit the market; the rest wait as limit orders
      minAway: 0.5,      // limit orders wait at least this far from the price, in dollars
      depth: 24,         // and on average this much further
      maxResting: 2,     // limit orders it keeps; older ones are cancelled
    },

    trend: {
      rate: 0.002,       // chance to act each second, in London
      newsBoost: 5,      // times more often during a news event
    },

    hft: {
      // Two of them. The first quotes at halfSpread and makes the spread;
      // the second quotes wider and bigger, so an ordinary order never
      // falls through into the thin part of the book.
      widths: [1, 1.8],
      ounces: [800, 2400], // what each holds; it quotes 1% of that on each side
      calmRange: 3.5,      // price range of the last 2 minutes, in dollars, up to which the spread stays normal
      maxWiden: 3,         // the spread grows to at most this many times normal when the price runs
    },

    whale: {
      rate: 1 / 2400,    // chance to act each second in London: about once every 40 minutes
      // During a news event it trades all one way: a burst in the first
      // ten minutes, one order every 100 seconds, then one every half hour
      // until the event is over.
      newsBurstSeconds: 600,
      newsBurstGap: 100,
      newsGap: 1800,
      ounces: 40000,     // what it holds, with the same value again in cash
    },
  };

  const between = (rng, lo, hi) => lo + rng() * (hi - lo);

  // Random: buys or sells at random, 1 to 2 percent of its balance each time
  // (of its cash for a buy, of its gold for a sell), scaled by the session.
  // Some orders hit the market, the rest wait as limit orders around the price.
  class RandomBot {
    constructor(id) {
      this.id = id;
      this.resting = []; // ids of its limit orders, oldest first
    }

    act(market, rng, now) {
      const T = TUNING.random;
      const acct = market.account(this.id);
      const price = market.lastPrice;
      const side = rng() < 0.5 ? 'buy' : 'sell';
      const share = between(rng, 0.01, 0.02) * now.session.size;
      const qty = side === 'buy' ? (share * acct.cash) / price : share * acct.asset;
      if (rng() < T.marketShare) {
        market.placeMarket(this.id, side, qty);
        return;
      }
      // Mostly close to the price, now and then far away: that is the depth
      // a big order has to chew through.
      const away = T.minAway + T.depth * -Math.log(1 - rng());
      const result = market.placeLimit(this.id, side, side === 'buy' ? price - away : price + away, qty);
      if (result.order) this.resting.push(result.order.id);
      while (this.resting.length > T.maxResting) market.cancel(this.resting.shift()); // drop stale orders
    }
  }

  // Trend follower: fast SMA above slow SMA means buy, below means sell.
  // The averages are taken over 1-minute closes. News makes it trade hard.
  class TrendBot {
    constructor(id, fast, slow) {
      this.id = id;
      this.fast = fast;
      this.slow = slow;
    }

    act(market, rng, now) {
      const T = TUNING.trend;
      if (rng() > T.rate * now.session.activity * (now.event ? T.newsBoost : 1)) return;
      const candles = market.candles.get(60);
      if (candles.length <= this.slow) return; // not enough history yet
      const fast = averageClose(candles, this.fast);
      const slow = averageClose(candles, this.slow);
      const acct = market.account(this.id);
      const share = between(rng, 0.01, 0.02) * now.session.size;
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
  // above it, and moves both as the price moves. The gap between them is the
  // market's spread. It quotes wider in quiet sessions and when the price
  // has been running.
  class HftBot {
    constructor(id, width) {
      this.id = id;
      this.width = width;
      this.quotedAt = null;
      this.half = null;
      this.bid = null;
      this.ask = null;
    }

    act(market, rng, now) {
      const price = market.lastPrice;
      const half = Math.max(market.tickSize, market.roundPrice(now.session.halfSpread * this.width * now.widen));
      const untouched = (o) => o && o.remaining === o.qty;
      if (price === this.quotedAt && half === this.half && untouched(this.bid) && untouched(this.ask)) return; // nothing to move
      market.cancelAll(this.id);
      const acct = market.account(this.id);
      this.bid = market.placeLimit(this.id, 'buy', price - half, (0.01 * acct.cash) / price).order;
      this.ask = market.placeLimit(this.id, 'sell', price + half, 0.01 * acct.asset).order;
      this.quotedAt = price;
      this.half = half;
    }
  }

  // How much wider than normal the high frequency traders quote right now:
  // 1 while the last two minutes stayed inside the calm range, more when
  // the price has been running.
  function spreadWidening(market) {
    const T = TUNING.hft;
    const candles = market.candles.get(60);
    let low = Infinity, high = -Infinity;
    for (let i = Math.max(0, candles.length - 2); i < candles.length; i++) {
      if (candles[i].low < low) low = candles[i].low;
      if (candles[i].high > high) high = candles[i].high;
    }
    return Math.min(T.maxWiden, Math.max(1, (high - low) / T.calmRange));
  }

  // Whale: almost always idle, then one huge market order, 10 to 50 times
  // the normal size. During a news event it keeps coming, all one way.
  class WhaleBot {
    constructor(id) {
      this.id = id;
      this.event = null;  // the news event it is trading
      this.nextAt = 0;    // when its next news order is due
    }

    act(market, rng, now) {
      const T = TUNING.whale;
      if (now.event) {
        if (this.event !== now.event) {
          this.event = now.event;
          this.nextAt = now.event.time;
        }
        if (market.time < this.nextAt) return;
        const burst = market.time - now.event.time < T.newsBurstSeconds;
        this.nextAt = market.time + (burst ? T.newsBurstGap : T.newsGap);
      } else if (rng() > T.rate * now.session.activity) {
        return;
      }
      const buy = now.event ? now.event.direction > 0 : rng() < 0.5;
      let qty = between(rng, 10, 50) * TUNING.normalOrder;
      if (!buy) qty = Math.min(qty, market.availableAsset(this.id));
      market.placeMarket(this.id, buy ? 'buy' : 'sell', qty);
    }
  }

  // What every bot can see at this second: the session, how wide the high
  // frequency traders quote, and the news event that is on (or null).
  function situation(market, news) {
    return {
      session: TUNING.sessions[Calendar.session(market.time)],
      widen: spreadWidening(market),
      event: news ? news.at(market.time) : null,
    };
  }

  // How many of `count` bots act this second when each has the chance `rate`.
  function howMany(rng, count, rate) {
    const limit = Math.exp(-count * rate);
    let n = 0;
    for (let p = rng(); p > limit; p *= rng()) n++;
    return n;
  }

  // Create the crowd and give each bot an account. Each bot holds the given
  // number of ounces and the same value again in cash, at the starting price.
  function createBots(market, rng = Math.random, news = null) {
    const price = market.lastPrice;
    const bots = [];
    const add = (bot, ounces) => {
      market.addAccount(bot.id, { cash: ounces * price, asset: ounces });
      bots.push(bot);
      return bot;
    };
    const normal = TUNING.normalOrder / 0.015; // holdings that make a typical order "normal"
    const randoms = [];
    for (let i = 1; i <= TUNING.random.count; i++) randoms.push(add(new RandomBot('random-' + i), normal));
    const slow = [
      add(new TrendBot('trend-1', 5, 20), normal),
      add(new TrendBot('trend-2', 10, 30), normal),
      add(new TrendBot('trend-3', 20, 60), normal),
      add(new TrendBot('trend-4', 30, 120), normal),
      add(new WhaleBot('whale'), TUNING.whale.ounces),
    ];
    const fast = TUNING.hft.widths.map((width, i) => add(new HftBot('hft-' + (i + 1), width), TUNING.hft.ounces[i]));

    // The high frequency traders are fast: their quotes are back in place
    // before the next order arrives, not once a second.
    function act(bot, now) {
      const traded = market.tradeCount;
      bot.act(market, rng, now);
      if (market.tradeCount !== traded) for (const hft of fast) hft.act(market, rng, now);
    }

    return {
      bots,
      // One second for the crowd. Call after each market tick.
      step() {
        const now = situation(market, news);
        // Only a few of the many random traders act in any one second.
        const acting = howMany(rng, randoms.length, TUNING.random.rate * now.session.activity);
        for (let i = 0; i < acting; i++) act(randoms[Math.floor(rng() * randoms.length)], now);
        for (const bot of slow) act(bot, now);
        for (const hft of fast) hft.act(market, rng, now);
      },
    };
  }

  return { createBots, situation, WhaleBot, TUNING };
});
