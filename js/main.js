/*
 * Wires the engine, the chart and the panels together.
 */
(function () {
  'use strict';

  const { Market } = MarketEngine;
  const $ = (id) => document.getElementById(id);

  const ME = 'you';
  const START_PRICE = 100;
  const START_BALANCE = 10000;

  const WARMUP_TICKS = 2 * 86400; // market history built before you arrive: 2 days

  const market = new Market({ startPrice: START_PRICE });
  market.addAccount(ME, { cash: START_BALANCE, asset: 0 });
  const crowd = Bots.createBots(market);

  // One second of market time: the clock moves, then every bot may act.
  function step() {
    market.tick();
    crowd.step();
  }
  for (let i = 0; i < WARMUP_TICKS; i++) step();

  const chart = new CandleChart($('chart'));
  const SPEEDS = [1, 2, 5, 10, 30, 60, 120, 300, 600]; // slider stops
  let speed = 60;      // ticks (market seconds) per real second
  let paused = false;
  let timeframe = 60;  // candle size in seconds
  let mode = 'stock';  // 'stock': sell only what you own. 'forex': you may sell first (short).
  let entry = 0;       // average price I got into my position at
  const isOpen = (qty) => Math.abs(qty) > Position.FLAT;

  /* ---------------- formatting ---------------- */

  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const price = (p) => p.toFixed(2);
  const amount = (q) => q.toFixed(4);

  /* ---------------- my trades ---------------- */

  const myTrades = [];
  let tradesDirty = true;

  market.onTrade = (t) => {
    if (t.buyer !== ME && t.seller !== ME) return;
    const side = t.buyer === ME ? 'buy' : 'sell';
    const after = market.account(ME).asset;
    entry = Position.entryAfterFill(entry, after - (side === 'buy' ? t.qty : -t.qty), side, t.price, t.qty);
    myTrades.unshift({ time: t.time, side, price: t.price, qty: t.qty });
    if (myTrades.length > 200) myTrades.pop();
    tradesDirty = true;
  };

  /* ---------------- orders ---------------- */

  function say(text, isError) {
    const el = $('order-msg');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
  }

  function describeFills(side, result) {
    const cost = result.fills.reduce((sum, f) => sum + f.price * f.qty, 0);
    return (side === 'buy' ? 'Bought ' : 'Sold ') + amount(result.filled) + ' at ' + price(cost / result.filled) + ' average';
  }

  function submitMarket(side) {
    const qty = parseFloat($('market-qty').value);
    const result = market.placeMarket(ME, side, qty);
    if (!result.ok) return say(result.error, true);
    const short = result.filled < qty - 1e-9 ? ' (partly filled)' : '';
    say(describeFills(side, result) + short);
  }

  function submitLimit(side) {
    const result = market.placeLimit(ME, side, parseFloat($('limit-price').value), parseFloat($('limit-qty').value));
    if (!result.ok) return say(result.error, true);
    const parts = [];
    if (result.filled > 0) parts.push(describeFills(side, result));
    if (result.order) parts.push('Limit ' + side + ' waiting at ' + price(result.order.price));
    say(parts.join('. '));
  }

  // Close the whole position with a market order.
  function closePosition(reason) {
    const qty = market.account(ME).asset;
    if (!isOpen(qty)) return;
    const side = qty > 0 ? 'sell' : 'buy';
    // My waiting orders on that side would hold back what the close needs.
    for (const o of market.openOrders(ME)) if (o.side === side) market.cancel(o.id);
    const result = market.placeMarket(ME, side, Math.abs(qty));
    if (!result.ok) return say(reason + ', but closing failed: ' + result.error, true);
    say(reason + '. ' + describeFills(side, result));
  }

  $('close-position').addEventListener('click', () => closePosition('Position closed'));
  $('market-buy').addEventListener('click', () => submitMarket('buy'));
  $('market-sell').addEventListener('click', () => submitMarket('sell'));
  $('limit-buy').addEventListener('click', () => submitLimit('buy'));
  $('limit-sell').addEventListener('click', () => submitLimit('sell'));
  $('open-orders').addEventListener('click', (e) => {
    const id = e.target.dataset.cancel;
    if (id) market.cancel(Number(id));
  });
  $('limit-price').value = price(market.lastPrice);

  /* ---------------- left panel ---------------- */

  function setActive(container, button) {
    for (const b of container.querySelectorAll('.btn')) b.classList.toggle('active', b === button);
  }

  // Market: stock or forex
  const MODE_HINTS = {
    stock: 'Stock: you can only sell what you own.',
    forex: 'Forex: you can sell first and buy back later.',
  };
  function setMode(next) {
    const me = market.account(ME);
    const hint = $('mode-hint');
    if (next === 'stock' && me.asset - me.reservedAsset < -Position.FLAT) {
      hint.textContent = 'Close your short position and cancel its sell orders before going back to Stock.';
      hint.classList.add('error');
      return;
    }
    mode = next;
    me.canShort = mode === 'forex';
    chart.title = 'SIM/USD · ' + (mode === 'forex' ? 'Forex' : 'Stock');
    hint.textContent = MODE_HINTS[mode];
    hint.classList.remove('error');
    setActive($('modes'), $('modes').querySelector('[data-mode="' + mode + '"]'));
  }
  $('modes').addEventListener('click', (e) => {
    const button = e.target.closest('[data-mode]');
    if (button) setMode(button.dataset.mode);
  });
  setMode(mode);

  // Time speed
  $('speed').addEventListener('input', (e) => {
    speed = SPEEDS[e.target.value];
    $('speed-label').textContent = speed + '×';
  });
  $('pause-btn').addEventListener('click', () => {
    paused = !paused;
    $('pause-btn').textContent = paused ? 'Play' : 'Pause';
    $('pause-btn').classList.toggle('active', paused);
  });

  // Timeframe
  $('timeframes').addEventListener('click', (e) => {
    const button = e.target.closest('[data-tf]');
    if (!button) return;
    timeframe = Number(button.dataset.tf);
    setActive($('timeframes'), button);
  });

  // Drawing tools
  $('tools').addEventListener('click', (e) => {
    const button = e.target.closest('[data-tool]');
    if (button) chart.setTool(button.dataset.tool);
  });
  chart.onToolChange = (tool) => setActive($('tools'), $('tools').querySelector('[data-tool="' + tool + '"]'));
  $('undo-drawing').addEventListener('click', () => chart.undoDrawing());
  $('clear-drawings').addEventListener('click', () => chart.clearDrawings());

  // Indicators
  function readIndicators() {
    chart.indicators = ['sma', 'ema']
      .filter((type) => $(type + '-on').checked)
      .map((type) => ({ type, period: Math.max(2, Math.min(500, parseInt($(type + '-period').value, 10) || 2)) }));
  }
  for (const id of ['sma-on', 'sma-period', 'ema-on', 'ema-period']) $(id).addEventListener('input', readIndicators);
  readIndicators();

  /* ---------------- rendering the right panel ---------------- */

  const shown = {};
  function setText(id, text) {
    if (shown[id] === text) return;
    shown[id] = text;
    $(id).textContent = text;
  }

  function renderBalance() {
    const me = market.account(ME);
    setText('cash', usd.format(me.cash));
    setText('holdings', amount(me.asset) + ' SIM');
    setText('equity', 'Total ' + usd.format(me.cash + me.asset * market.lastPrice));
    const bid = market.bestBid(), ask = market.bestAsk();
    setText('bid', bid === null ? '–' : price(bid));
    setText('ask', ask === null ? '–' : price(ask));
  }

  function renderPosition() {
    const qty = market.account(ME).asset;
    const open = isOpen(qty);
    $('position-row').hidden = !open;
    $('close-position').hidden = !open;
    $('no-position').hidden = open;
    if (!open) return;
    const pnl = (market.lastPrice - entry) * qty;
    setText('pos-side', (qty > 0 ? 'Long ' : 'Short ') + amount(Math.abs(qty)));
    setText('pos-entry', 'at ' + price(entry));
    setText('pos-pnl', (pnl >= 0 ? '+' : '-') + usd.format(Math.abs(pnl)));
    $('pos-side').className = qty > 0 ? 'buy' : 'sell';
    $('pos-pnl').className = pnl >= 0 ? 'buy' : 'sell';
  }

  // Dashed lines on the chart: my waiting orders and my position.
  let orderLines = [];
  function renderChartLines() {
    const lines = orderLines.slice();
    if (isOpen(market.account(ME).asset)) lines.push({ price: entry, label: 'Entry', color: '#9aa7b8' });
    chart.orderLines = lines;
  }

  let ordersKey = null;
  function renderOpenOrders() {
    const orders = market.openOrders(ME).sort((a, b) => b.price - a.price);
    const key = orders.map((o) => o.id + ':' + o.remaining).join(',');
    if (key === ordersKey) return;
    ordersKey = key;
    orderLines = orders.map((o) => ({ price: o.price, side: o.side, label: (o.side === 'buy' ? 'Buy ' : 'Sell ') + amount(o.remaining) }));
    $('open-orders').innerHTML = orders.length
      ? orders.map((o) =>
          '<div class="tr"><span class="' + o.side + '">' + (o.side === 'buy' ? 'Buy' : 'Sell') + '</span>' +
          '<span>' + price(o.price) + '</span><span>' + amount(o.remaining) + '</span>' +
          '<button type="button" class="cancel" data-cancel="' + o.id + '" title="Cancel order" aria-label="Cancel order">✕</button></div>').join('')
      : '<p class="empty">No open orders</p>';
  }

  function renderTrades() {
    if (!tradesDirty) return;
    tradesDirty = false;
    $('trades').innerHTML = myTrades.length
      ? myTrades.map((t) =>
          '<div class="tr"><span>' + CandleChart.formatTime(t.time, true) + '</span>' +
          '<span class="' + t.side + '">' + (t.side === 'buy' ? 'Buy' : 'Sell') + '</span>' +
          '<span>' + price(t.price) + '</span><span>' + amount(t.qty) + '</span></div>').join('')
      : '<p class="empty">No trades yet</p>';
  }

  /* ---------------- main loop ---------------- */

  let lastFrame = performance.now();
  let pending = 0; // fractional ticks carried between frames

  function frame(now) {
    const dt = Math.min(1, (now - lastFrame) / 1000); // a slow frame still advances the market
    lastFrame = now;
    pending = paused ? 0 : pending + dt * speed;
    const ticks = Math.floor(pending);
    pending -= ticks;
    for (let i = 0; i < ticks; i++) step();

    chart.setData(market.candles.get(timeframe), timeframe);
    chart.render();
    renderBalance();
    renderPosition();
    renderOpenOrders();
    renderChartLines();
    renderTrades();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
