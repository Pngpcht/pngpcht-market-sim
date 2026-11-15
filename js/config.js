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
