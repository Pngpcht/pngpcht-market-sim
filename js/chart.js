/*
 * Candle chart drawn on a canvas.
 *
 * Drag to pan, scroll to zoom, double-click to jump back to the latest candle.
 * The chart only draws what it is given: candles come from the engine.
 */
(function (root) {
  'use strict';

  const C = {
    bg: '#0d1015',
    grid: '#181e27',
    axis: '#252d39',
    text: '#7b8696',
    bright: '#d5dce6',
    up: '#26a69a',
    down: '#ef5350',
    cross: '#56627a',
    label: '#2c3646',
  };
  const FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const AXIS_W = 62;   // price axis on the right
  const AXIS_H = 24;   // time axis at the bottom
  const PAD_TOP = 34;
  const PAD_BOTTOM = 12;
  const RIGHT_GAP = 4; // empty candle slots after the latest candle
  const TIME_STEPS = [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400, 172800, 345600, 604800];
  const TF_LABELS = { 60: '1m', 300: '5m', 900: '15m', 1800: '30m', 3600: '1h', 14400: '4h' };

  const pad2 = (n) => String(n).padStart(2, '0');

  // Market time (seconds since the start) as "D1 09:30" or "D1 09:30:15".
  function formatTime(t, withSeconds) {
    const day = Math.floor(t / 86400) + 1;
    const h = Math.floor((t % 86400) / 3600);
    const m = Math.floor((t % 3600) / 60);
    const base = 'D' + day + ' ' + pad2(h) + ':' + pad2(m);
    return withSeconds ? base + ':' + pad2(Math.floor(t % 60)) : base;
  }

  function niceStep(raw) {
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / pow;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  }

  class CandleChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.title = 'SIM/USD';
      this.candles = [];
      this.tf = 60;
      this.candleW = 8; // pixels per candle
      this.scroll = 0;  // candles the view is shifted back from the latest
      this.orderLines = []; // [{ price, side, label }]
      this.mouse = null;
      this.g = null;    // geometry of the last render
      this._pan = null;
      this._count = 0;
      this._bind();
      new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
      this._resize();
    }

    setData(candles, tf) {
      if (tf !== this.tf) {
        this.tf = tf;
        this.scroll = 0;
      } else if (this.scroll > 0 && candles.length > this._count) {
        // Looking at history: stay on the same candles as new ones arrive.
        this.scroll += candles.length - this._count;
      }
      this.candles = candles;
      this._count = candles.length;
    }

    resetView() {
      this.scroll = 0;
      this.candleW = 8;
    }

    /* ---- coordinates (valid after a render) ---- */

    xOfIndex(i) { const g = this.g; return g.plotW - (g.rightIdx - i + 0.5) * this.candleW; }
    indexOfX(x) { const g = this.g; return g.rightIdx + 0.5 - (g.plotW - x) / this.candleW; }
    yOfPrice(p) { const g = this.g; return PAD_TOP + ((g.max - p) / (g.max - g.min)) * g.innerH; }
    priceOfY(y) { const g = this.g; return g.max - ((y - PAD_TOP) / g.innerH) * (g.max - g.min); }
    // Candle i covers market time [i * tf, (i + 1) * tf) and is drawn at its middle.
    xOfTime(t) { return this.xOfIndex(t / this.tf - 0.5); }
    timeOfX(x) { return (this.indexOfX(x) + 0.5) * this.tf; }

    /* ---- input ---- */

    _bind() {
      const cv = this.canvas;
      const pos = (e) => {
        const r = cv.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };
      cv.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !this.g) return;
        const p = pos(e);
        cv.setPointerCapture(e.pointerId);
        this._onDown(p, e);
      });
      cv.addEventListener('pointermove', (e) => {
        if (!this.g) return;
        this.mouse = pos(e);
        this._onMove(this.mouse, e);
      });
      cv.addEventListener('pointerup', (e) => {
        if (!this.g) return;
        this._onUp(pos(e), e);
      });
      cv.addEventListener('pointerleave', () => { this.mouse = null; });
      cv.addEventListener('dblclick', () => this.resetView());
      cv.addEventListener('wheel', (e) => {
        if (!this.g) return;
        e.preventDefault();
        const x = Math.min(pos(e).x, this.g.plotW);
        const anchor = this.indexOfX(x);
        this.candleW = Math.max(1.5, Math.min(40, this.candleW * Math.exp(-e.deltaY * 0.0015)));
        if (this.scroll === 0) return; // following the latest candle: zoom from the right edge
        // Looking at history: keep the candle under the cursor where it is.
        const rightIdx = anchor - 0.5 + (this.g.plotW - x) / this.candleW;
        this.scroll = this.candles.length - 1 + RIGHT_GAP - rightIdx;
      }, { passive: false });
    }

    _onDown(p) {
      if (p.x < this.g.plotW) this._pan = { x: p.x, scroll: this.scroll };
    }

    _onMove(p) {
      if (this._pan) {
        this.scroll = this._pan.scroll + (p.x - this._pan.x) / this.candleW;
        if (Math.abs(this.scroll) < 0.5) this.scroll = 0; // snap back to following
      }
    }

    _onUp() {
      this._pan = null;
    }

    _resize() {
      const box = this.canvas.parentElement;
      const dpr = root.devicePixelRatio || 1;
      this.w = box.clientWidth;
      this.h = box.clientHeight;
      this.canvas.width = Math.max(1, Math.round(this.w * dpr));
      this.canvas.height = Math.max(1, Math.round(this.h * dpr));
      this.canvas.style.width = this.w + 'px';
      this.canvas.style.height = this.h + 'px';
      this.dpr = dpr;
      if (this.candles.length) this.render();
    }

    /* ---- drawing ---- */

    render() {
      const ctx = this.ctx;
      const n = this.candles.length;
      const w = this.w, h = this.h;
      if (!n || w < AXIS_W + 20 || h < AXIS_H + PAD_TOP + 20) return;
      const plotW = w - AXIS_W;
      const plotH = h - AXIS_H;
      const cw = this.candleW;

      // Keep at least a few candles in view.
      const maxBack = n - 1;
      const maxAhead = Math.max(0, Math.floor(plotW / cw) - RIGHT_GAP - 3);
      this.scroll = Math.max(-maxAhead, Math.min(maxBack, this.scroll));

      const rightIdx = n - 1 + RIGHT_GAP - this.scroll;
      const g = (this.g = { plotW, plotH, rightIdx, innerH: plotH - PAD_TOP - PAD_BOTTOM, min: 0, max: 1 });
      const first = Math.max(0, Math.floor(this.indexOfX(0)));
      const last = Math.min(n - 1, Math.ceil(this.indexOfX(plotW)));
      g.first = first;
      g.last = last;

      // Price range of the visible candles.
      let lo = Infinity, hi = -Infinity;
      for (let i = first; i <= last; i++) {
        const c = this.candles[i];
        if (c.low < lo) lo = c.low;
        if (c.high > hi) hi = c.high;
      }
      if (lo === Infinity) lo = hi = this.candles[n - 1].close;
      const margin = Math.max((hi - lo) * 0.1, hi * 0.002);
      g.min = lo - margin;
      g.max = hi + margin;

      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, w, h);
      ctx.font = FONT;
      ctx.textBaseline = 'middle';

      this._drawGrid(g);

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, plotW, plotH);
      ctx.clip();
      this._drawCandles(g);
      this._drawOrderLines(g);
      ctx.restore();

      this._drawLastPrice(g);
      this._drawCrosshair(g);
      this._drawHeader(g);
    }

    _drawGrid(g) {
      const ctx = this.ctx;
      const { plotW, plotH } = g;
      ctx.lineWidth = 1;

      // Price lines
      const step = niceStep((g.max - g.min) / Math.max(2, g.innerH / 56));
      ctx.textAlign = 'left';
      for (let p = Math.ceil(g.min / step) * step; p <= g.max; p += step) {
        const y = Math.round(this.yOfPrice(p)) + 0.5;
        ctx.strokeStyle = C.grid;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
        ctx.fillStyle = C.text;
        ctx.fillText(p.toFixed(2), plotW + 8, y);
      }

      // Time lines
      const wanted = (this.tf / this.candleW) * 90; // seconds per ~90px
      const tStep = TIME_STEPS.find((s) => s >= wanted && s >= this.tf) || TIME_STEPS[TIME_STEPS.length - 1];
      const t0 = Math.max(0, this.timeOfX(0));
      const t1 = this.timeOfX(plotW);
      ctx.textAlign = 'center';
      for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) {
        const x = Math.round(this.xOfIndex(t / this.tf)) + 0.5;
        if (x < 24 || x > plotW - 20) continue;
        ctx.strokeStyle = C.grid;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
        ctx.fillStyle = C.text;
        const label = t % 86400 === 0 ? 'Day ' + (t / 86400 + 1) : formatTime(t).split(' ')[1];
        ctx.fillText(label, x, plotH + AXIS_H / 2);
      }

      // Axis borders
      ctx.strokeStyle = C.axis;
      ctx.beginPath();
      ctx.moveTo(plotW + 0.5, 0); ctx.lineTo(plotW + 0.5, this.h);
      ctx.moveTo(0, plotH + 0.5); ctx.lineTo(this.w, plotH + 0.5);
      ctx.stroke();
    }

    _drawCandles(g) {
      const ctx = this.ctx;
      const bodyW = Math.max(1, Math.floor(this.candleW * 0.72));
      for (let i = g.first; i <= g.last; i++) {
        const c = this.candles[i];
        const x = Math.round(this.xOfIndex(i));
        const up = c.close >= c.open;
        const yO = this.yOfPrice(c.open), yC = this.yOfPrice(c.close);
        const top = Math.round(Math.min(yO, yC));
        const bodyH = Math.max(1, Math.round(Math.abs(yC - yO)));
        ctx.fillStyle = up ? C.up : C.down;
        const yH = Math.round(this.yOfPrice(c.high)), yL = Math.round(this.yOfPrice(c.low));
        ctx.fillRect(x, yH, 1, Math.max(1, yL - yH));
        ctx.fillRect(x - Math.floor(bodyW / 2), top, bodyW, bodyH);
      }
    }

    _drawOrderLines(g) {
      const ctx = this.ctx;
      ctx.setLineDash([2, 4]);
      ctx.textAlign = 'left';
      for (const o of this.orderLines) {
        if (o.price < g.min || o.price > g.max) continue;
        const y = Math.round(this.yOfPrice(o.price)) + 0.5;
        ctx.strokeStyle = ctx.fillStyle = o.side === 'buy' ? C.up : C.down;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(g.plotW, y); ctx.stroke();
        ctx.fillText(o.label, 8, y - 8);
      }
      ctx.setLineDash([]);
    }

    _axisLabel(y, text, fill, color) {
      const ctx = this.ctx;
      const plotW = this.g.plotW;
      ctx.fillStyle = fill;
      ctx.fillRect(plotW + 1, y - 9, AXIS_W - 1, 18);
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.fillText(text, plotW + 8, y);
    }

    _drawLastPrice(g) {
      const ctx = this.ctx;
      const c = this.candles[this.candles.length - 1];
      if (c.close < g.min || c.close > g.max) return;
      const color = c.close >= c.open ? C.up : C.down;
      const y = Math.round(this.yOfPrice(c.close)) + 0.5;
      ctx.strokeStyle = color;
      ctx.setLineDash([1, 3]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(g.plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      this._axisLabel(y, c.close.toFixed(2), color, '#fff');
    }

    _hoverIndex(g) {
      const m = this.mouse;
      if (!m || m.x >= g.plotW || m.y >= g.plotH) return -1;
      return Math.round(this.indexOfX(m.x));
    }

    _drawCrosshair(g) {
      const m = this.mouse;
      if (!m || m.x >= g.plotW || m.y >= g.plotH || this._pan) return;
      const ctx = this.ctx;
      const i = this._hoverIndex(g);
      const x = Math.round(this.xOfIndex(i)) + 0.5;
      const y = Math.round(m.y) + 0.5;
      ctx.strokeStyle = C.cross;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x, g.plotH);
      ctx.moveTo(0, y); ctx.lineTo(g.plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);

      this._axisLabel(y, this.priceOfY(m.y).toFixed(2), C.label, C.bright);

      if (i >= 0) {
        const text = formatTime(i * this.tf);
        const tw = ctx.measureText(text).width + 14;
        const tx = Math.max(0, Math.min(g.plotW - tw, x - tw / 2));
        ctx.fillStyle = C.label;
        ctx.fillRect(tx, g.plotH + 1, tw, AXIS_H - 2);
        ctx.fillStyle = C.bright;
        ctx.textAlign = 'center';
        ctx.fillText(text, tx + tw / 2, g.plotH + AXIS_H / 2);
      }
    }

    _drawHeader(g) {
      const ctx = this.ctx;
      const n = this.candles.length;
      const hover = this._hoverIndex(g);
      const c = this.candles[hover >= 0 && hover < n ? hover : n - 1];
      let x = 12;
      const y = 16;
      const put = (text, color) => {
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
        x += ctx.measureText(text).width + 8;
      };
      ctx.textAlign = 'left';
      ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      put(this.title + ' · ' + (TF_LABELS[this.tf] || this.tf + 's'), C.bright);
      ctx.font = FONT;
      if (g.plotW < 420) return; // not enough room for the numbers
      const color = c.close >= c.open ? C.up : C.down;
      for (const [k, v] of [['O', c.open], ['H', c.high], ['L', c.low], ['C', c.close]]) {
        put(k, C.text);
        x -= 4;
        put(v.toFixed(2), color);
      }
    }
  }

  CandleChart.formatTime = formatTime;
  root.CandleChart = CandleChart;
})(window);
