/*
 * The whole market without any screen: the order book, the bots and the
 * clock. The browser app and the headless run both use this.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'), require('./bots.js'), require('./calendar.js'), require('./config.js'));
  } else {
    root.Simulation = factory(root.MarketEngine, root.Bots, root.Calendar, root.Config);
  }
})(typeof self !== 'undefined' ? self : this, function (MarketEngine, Bots, Calendar, Config) {
  'use strict';

  function create({ startPrice, rng = Math.random }) {
    const market = new MarketEngine.Market({ startPrice, tickSize: Config.tickSize });
    const crowd = Bots.createBots(market, rng);

    return {
      market,
      crowd,

      // One second of market time: the clock moves, then every bot may act.
      // When the market closes for the weekend the clock jumps straight to
      // the next open, and nothing trades in between.
      step() {
        if (!Calendar.isOpen(market.time + 1)) {
          market.skipTo(Calendar.nextOpen(market.time + 1));
          return;
        }
        market.tick();
        crowd.step();
      },
    };
  }

  return { create };
});
