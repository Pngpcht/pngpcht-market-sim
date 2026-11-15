/*
 * Wires the engine, the chart and the panels together.
 */
(async function () {
  'use strict';

  const { Market } = MarketEngine;
  const $ = (id) => document.getElementById(id);

  const ME = 'you';
  const WARMUP_TICKS = 2 * 86400; // market history built before you arrive: 2 days

  const start = await Config.resolveStartPrice();
  const market = new Market({ startPrice: start.price, tickSize: Config.tickSize });
  market.addAccount(ME, { cash: Config.startBalance, asset: 0 });
  const crowd = Bots.createBots(market);

  for (let i = 0; i < WARMUP_TICKS; i++) {
    market.tick();
    crowd.step();
  }

  const chart = new CandleChart($('chart'));
  const SPEEDS = [1, 2, 5, 10, 30, 60, 120, 300, 600]; // slider stops
  let speed = 60;      // ticks (market seconds) per real second
  let paused = false;
  let timeframe = 60;  // candle size in seconds
  let mode = 'stock';  // 'stock': sell only what you own. 'forex': you may sell first (short).
  let entry = 0;       // average price I got into my position at
  const isOpen = (qty) => Math.abs(qty) > Position.FLAT;
  let levels = { sl: null, tp: null }; // stop loss and take profit of my position
  let low = market.lastPrice;          // lowest and highest trade since the levels were last checked
  let high = market.lastPrice;

  /* ---------------- formatting ---------------- */

  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const price = (p) => p.toFixed(2);
  const amount = (q) => q.toFixed(4);

  /* ---------------- my trades ---------------- */

  const myTrades = [];
  let tradesDirty = true;

  market.onTrade = (t) => {
    if (t.price < low) low = t.price;
    if (t.price > high) high = t.price;
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

  /* ---------------- stop loss / take profit ---------------- */

  // The two inputs as prices, null when left empty.
  function readLevels() {
    const read = (id) => {
      const text = $(id).value.trim();
      if (text === '') return null;
      const value = Math.round(parseFloat(text) * 100) / 100;
      return value > 0 ? value : NaN;
    };
    const typed = { sl: read('sl'), tp: read('tp') };
    if (Number.isNaN(typed.sl) || Number.isNaN(typed.tp)) return { error: 'Stop loss and take profit must be prices above zero' };
    return typed;
  }

  function showLevels() {
    $('sl').value = levels.sl === null ? '' : price(levels.sl);
    $('tp').value = levels.tp === null ? '' : price(levels.tp);
  }

  // The typed levels, checked against the position this order would leave me with.
  function levelsForOrder(side, refPrice, qty) {
    const typed = readLevels();
    if (typed.error) return typed;
    const after = market.account(ME).asset + (side === 'buy' ? qty : -qty);
    if (isOpen(after)) {
      const error = Position.checkLevels(after, refPrice, typed.sl, typed.tp);
      if (error) return { error };
    }
    return typed;
  }

  // Editing the inputs while a position is open moves its levels.
  function updateLevels() {
    const qty = market.account(ME).asset;
    if (!isOpen(qty)) return; // read when the next order is placed
    const typed = readLevels();
    const error = typed.error || Position.checkLevels(qty, market.lastPrice, typed.sl, typed.tp);
    if (error) {
      showLevels(); // back to the levels that are active
      return say(error, true);
    }
    levels = typed;
    showLevels();
    say('Stop loss and take profit updated');
  }
  $('sl').addEventListener('change', updateLevels);
  $('tp').addEventListener('change', updateLevels);

  // Runs after every tick: close the position if the market reached a level.
  function protect() {
    const qty = market.account(ME).asset;
    if (isOpen(qty)) {
      const hit = Position.levelHit(qty, levels.sl, levels.tp, low, high);
      if (hit) closePosition(hit === 'sl' ? 'Stop loss hit' : 'Take profit hit');
      // A short that has eaten almost the whole account is closed before it can go below zero.
      else if (qty < 0 && market.equity(ME) < -qty * market.lastPrice * 0.05) closePosition('Margin call, short closed');
    }
    low = high = market.lastPrice;
  }

  /* ---------------- placing orders ---------------- */

  function submitMarket(side) {
    const qty = parseFloat($('market-qty').value);
    const typed = levelsForOrder(side, market.lastPrice, qty);
    if (typed.error) return say(typed.error, true);
    const previous = levels;
    levels = typed;
    const result = market.placeMarket(ME, side, qty);
    if (!result.ok) {
      levels = previous;
      return say(result.error, true);
    }
    const short = result.filled < qty - 1e-9 ? ' (partly filled)' : '';
    say(describeFills(side, result) + short);
  }

  function submitLimit(side) {
    const limit = parseFloat($('limit-price').value);
    const qty = parseFloat($('limit-qty').value);
    const typed = levelsForOrder(side, limit, qty);
    if (typed.error) return say(typed.error, true);
    const previous = levels;
    levels = typed;
    const result = market.placeLimit(ME, side, limit, qty);
    if (!result.ok) {
      levels = previous;
      return say(result.error, true);
    }
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
    chart.title = Config.symbol + ' · ' + (mode === 'forex' ? 'Forex' : 'Stock');
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

  let wasOpen = false;
  function renderPosition() {
    const qty = market.account(ME).asset;
    const open = isOpen(qty);
    if (wasOpen && !open) {
      // The position is gone, and its stop loss and take profit go with it.
      levels = { sl: null, tp: null };
      showLevels();
    }
    wasOpen = open;
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
    const open = isOpen(market.account(ME).asset);
    if (open) lines.push({ price: entry, label: 'Entry', color: '#9aa7b8' });
    if (open || orderLines.length) {
      if (levels.sl !== null) lines.push({ price: levels.sl, label: 'Stop loss', side: 'sell' });
      if (levels.tp !== null) lines.push({ price: levels.tp, label: 'Take profit', side: 'buy' });
    }
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
    for (let i = 0; i < ticks; i++) {
      // One second of market time: the clock moves, every bot may act,
      // then my stop loss and take profit are checked.
      market.tick();
      crowd.step();
      protect();
    }

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
