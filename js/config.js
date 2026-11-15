/*
 * The values that define the market. Change them here.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Config = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const Config = {
    symbol: 'XAU/USD',

    // Starting price in USD per troy ounce.
    // 'live' fetches the current XAU/USD price when the simulation starts.
    // Put a number here (for example 3900) to start from that price instead.
    startPrice: 'live',

    offlinePrice: 3900, // used only when the live price cannot be fetched
    priceUrl: 'https://api.gold-api.com/price/XAU',

    tickSize: 0.01,     // 1 pip = $0.01. Every price is rounded to it.
    startBalance: 10000,

    lotSize: 100,       // ounces in one standard lot, so a $1 move is $100 per lot
    minLot: 0.01,       // smallest order: 0.01 lot = 1 oz
    leverage: 1000,     // Forex mode: a position can be worth up to balance x leverage
    stopOut: 0.5,       // margin call when equity falls below this share of the required margin
  };

  // The price the simulation starts at, and where it came from.
  Config.resolveStartPrice = async function () {
    if (typeof Config.startPrice === 'number') return { price: Config.startPrice, source: 'config' };
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 5000);
      const response = await fetch(Config.priceUrl, { signal: abort.signal });
      const data = await response.json();
      clearTimeout(timer);
      if (data && data.price > 0) return { price: Math.round(data.price * 100) / 100, source: 'live' };
    } catch (error) {
      // offline or blocked: fall through
    }
    return { price: Config.offlinePrice, source: 'offline' };
  };

  return Config;
});
