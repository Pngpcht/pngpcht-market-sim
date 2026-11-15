/*
 * Candle chart drawn on a canvas.
 *
 * Drag to pan, scroll to zoom, double-click to jump back to the latest candle.
 * The chart only draws what it is given: candles come from the engine.
 *
 * Drawings (trendline, horizontal line, rectangle, fib) are anchored to
 * market time and price, so they stay put across pans, zooms and timeframes.
 * Drag to draw, or click once for each end. Click a drawing to select it,
 * Delete removes it, Escape cancels.
 */
(function (root) {
  'use strict';

  const Calendar = root.Calendar;

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
    draw: '#4c8dff',
    drawHi: '#9cc0ff',
    drawFill: 'rgba(76, 141, 255, 0.12)',
    sma: '#f5b83d',
    ema: '#b388ff',
  };
  const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const FIB_COLORS = ['#8a94a6', '#ef5350', '#f5b83d', '#26a69a', '#4c8dff', '#b388ff', '#8a94a6'];
  const HIT = 6; // pixels: how close a click must be to select a drawing
  const FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const AXIS_W = 62;   // price axis on the right
  const AXIS_H = 24;   // time axis at the bottom
  const PAD_TOP = 46;
  const PAD_BOTTOM = 12;
  const RIGHT_GAP = 4; // empty candle slots after the latest candle
  const TIME_STEPS = [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400, 172800, 345600, 604800];
  const TF_LABELS = { 60: '1m', 300: '5m', 900: '15m', 1800: '30m', 3600: '1h', 14400: '4h' };

  function niceStep(raw) {
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / pow;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  }

  class CandleChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.title = '';
      this.candles = [];
      this.tf = 60;
      this.candleW = 8; // pixels per candle
      this.scroll = 0;  // candles the view is shifted back from the latest
      this.orderLines = []; // [{ price, label, side or color }]
      this.markers = [];    // [{ time }] news events, drawn as a flag at their time
      this.indicators = []; // [{ type: 'sma' | 'ema', period }]
      this.drawings = [];   // [{ type, a: { t, p }, b: { t, p } }]
      this.tool = 'cursor';
      this.onToolChange = null;
      this._draft = null;   // drawing in progress
      this._selected = -1;
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

    setTool(tool) {
      this.tool = tool;
      this._draft = null;
      if (tool !== 'cursor') this._selected = -1;
      if (this.onToolChange) this.onToolChange(tool);
    }

    undoDrawing() {
      this.drawings.pop();
      this._selected = -1;
    }

    clearDrawings() {
      this.drawings = [];
      this._draft = null;
      this._selected = -1;
    }

    /* ---- coordinates (valid after a render) ---- */

    xOfIndex(i) { const g = this.g; return g.plotW - (g.rightIdx - i + 0.5) * this.candleW; }
    indexOfX(x) { const g = this.g; return g.rightIdx + 0.5 - (g.plotW - x) / this.candleW; }
    yOfPrice(p) { const g = this.g; return PAD_TOP + ((g.max - p) / (g.max - g.min)) * g.innerH; }
    priceOfY(y) { const g = this.g; return g.max - ((y - PAD_TOP) / g.innerH) * (g.max - g.min); }
    // Candles carry their own market time, and closed hours (weekends) have
    // no candles, so time is looked up rather than computed from the index.

    // Market time at the start of candle slot i. Slots before the first and
    // after the last candle continue at one candle per timeframe.
    timeOfIndex(i) {
      const c = this.candles, n = c.length;
      if (i < 0) return c[0].time + i * this.tf;
      if (i >= n) return c[n - 1].time + (i - n + 1) * this.tf;
      return c[i].time;
    }

    // Candle position of a market time, with a fraction for how far into the candle.
    indexOfTime(t) {
      const c = this.candles, n = c.length;
      if (t < c[0].time) return (t - c[0].time) / this.tf;
      if (t >= c[n - 1].time) return n - 1 + (t - c[n - 1].time) / this.tf;
      let lo = 0, hi = n - 1; // last candle that starts at or before t
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (c[mid].time <= t) lo = mid; else hi = mid - 1;
      }
      return lo + Math.min(1, (t - c[lo].time) / this.tf);
    }

    // A candle is drawn at the middle of its slot.
    xOfTime(t) { return this.xOfIndex(this.indexOfTime(t) - 0.5); }
    timeOfX(x) {
      const pos = this.indexOfX(x) + 0.5;
      const i = Math.floor(pos);
      return this.timeOfIndex(i) + (pos - i) * this.tf;
    }

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
      cv.addEventListener('dblclick', () => { if (this.tool === 'cursor') this.resetView(); });
      root.addEventListener('keydown', (e) => {
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        if (e.key === 'Escape') this.setTool('cursor');
        if ((e.key === 'Delete' || e.key === 'Backspace') && this._selected >= 0) {
          this.drawings.splice(this._selected, 1);
          this._selected = -1;
        }
      });
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

    _point(p) {
      return { t: this.timeOfX(p.x), p: this.priceOfY(p.y) };
    }

    _onDown(p) {
      if (p.x >= this.g.plotW || p.y >= this.g.plotH) return;
      if (this.tool === 'cursor') {
        this._selected = this._hit(p);
        this._pan = { x: p.x, scroll: this.scroll };
      } else if (this.tool === 'hline') {
        this._finish({ type: 'hline', a: this._point(p), b: this._point(p) });
      } else if (this._draft && this._draft.clicked) {
        // Second click of a click-click drawing.
        this._draft.b = this._point(p);
        this._finish(this._draft);
      } else {
        this._draft = { type: this.tool, a: this._point(p), b: this._point(p), downAt: p, clicked: false };
      }
    }

    _onMove(p) {
      if (this._draft) this._draft.b = this._point(p);
      if (this._pan) {
        this.scroll = this._pan.scroll + (p.x - this._pan.x) / this.candleW;
        if (Math.abs(this.scroll) < 0.5) this.scroll = 0; // snap back to following
      }
    }

    _onUp(p) {
      this._pan = null;
      const d = this._draft;
      if (!d || d.clicked) return;
      const dragged = Math.hypot(p.x - d.downAt.x, p.y - d.downAt.y) > 4;
      if (dragged) this._finish(d);
      else d.clicked = true; // a plain click: wait for the second click
    }

    _finish(d) {
      this.drawings.push({ type: d.type, a: d.a, b: d.b });
      this.setTool('cursor');
    }

    // Pixel box of a two-point drawing. Fib gets a minimum width so its labels fit.
    _box(d) {
      const ax = this.xOfTime(d.a.t), bx = this.xOfTime(d.b.t);
      const ay = this.yOfPrice(d.a.p), by = this.yOfPrice(d.b.p);
      const x0 = Math.min(ax, bx);
      let x1 = Math.max(ax, bx);
      if (d.type === 'fib') x1 = Math.max(x1, x0 + 110);
      return { ax, ay, bx, by, x0, x1, y0: Math.min(ay, by), y1: Math.max(ay, by) };
    }

    // Index of the drawing under a point, newest first, or -1.
    _hit(p) {
      for (let i = this.drawings.length - 1; i >= 0; i--) {
        const d = this.drawings[i];
        const b = this._box(d);
        if (d.type === 'hline') {
          if (Math.abs(p.y - b.ay) <= HIT) return i;
        } else if (d.type === 'trendline') {
          if (distToSegment(p.x, p.y, b.ax, b.ay, b.bx, b.by) <= HIT) return i;
        } else if (p.x >= b.x0 - HIT && p.x <= b.x1 + HIT && p.y >= b.y0 - HIT && p.y <= b.y1 + HIT) {
          return i;
        }
      }
      return -1;
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
      this._drawMarkers(g);
      this._drawCandles(g);
      this._drawIndicators(g);
      this._drawDrawings(g);
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
      const i0 = Math.max(0, Math.floor(this.indexOfX(0)));
      const i1 = Math.ceil(this.indexOfX(plotW));
      let lastX = -Infinity;
      ctx.textAlign = 'center';
      for (let i = i0; i <= i1; i++) {
        const t = this.timeOfIndex(i);
        if (t % tStep !== 0) continue;
        const x = Math.round(this.xOfIndex(i)) + 0.5;
        if (x < 24 || x > plotW - 20 || x - lastX < 50) continue; // labels crowd after a weekend gap
        lastX = x;
        ctx.strokeStyle = C.grid;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
        ctx.fillStyle = C.text;
        const [day, clock] = Calendar.format(t).split(' ');
        ctx.fillText(t % 86400 === 0 ? day : clock, x, plotH + AXIS_H / 2);
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

    _drawIndicators(g) {
      const ctx = this.ctx;
      g.legend = [];
      for (const ind of this.indicators) {
        // Only the visible part is computed, plus a warm-up before it.
        const warm = ind.type === 'ema' ? ind.period * 6 : ind.period;
        const start = Math.max(0, g.first - warm);
        const closes = [];
        for (let i = start; i <= g.last; i++) closes.push(this.candles[i].close);
        const values = root.Indicators[ind.type](closes, ind.period);
        const color = C[ind.type];
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false;
        for (let i = g.first; i <= g.last; i++) {
          const v = values[i - start];
          if (v === null) continue;
          const x = this.xOfIndex(i), y = this.yOfPrice(v);
          if (started) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          started = true;
        }
        ctx.stroke();
        const hover = this._hoverIndex(g);
        const at = hover >= start && hover <= g.last ? hover : g.last;
        g.legend.push({ text: ind.type.toUpperCase() + ' ' + ind.period, value: values[at - start], color });
      }
      ctx.lineWidth = 1;
    }

    _drawDrawings(g) {
      const ctx = this.ctx;
      const list = this._draft ? this.drawings.concat(this._draft) : this.drawings;
      const line = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
      list.forEach((d, i) => {
        const active = i === this._selected || d === this._draft;
        const b = this._box(d);
        ctx.lineWidth = active ? 2 : 1.25;
        ctx.strokeStyle = ctx.fillStyle = active ? C.drawHi : C.draw;
        if (d.type === 'hline') {
          const y = Math.round(b.ay) + 0.5;
          line(0, y, g.plotW, y);
          ctx.textAlign = 'right';
          ctx.fillText(d.a.p.toFixed(2), g.plotW - 6, y - 8);
        } else if (d.type === 'trendline') {
          line(b.ax, b.ay, b.bx, b.by);
          if (active) {
            for (const [x, y] of [[b.ax, b.ay], [b.bx, b.by]]) { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
          }
        } else if (d.type === 'rect') {
          ctx.fillStyle = C.drawFill;
          ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
          ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        } else if (d.type === 'fib') {
          // Level 0 at the end point, level 1 at the start point.
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = C.cross;
          line(b.ax, b.ay, b.bx, b.by);
          ctx.setLineDash([]);
          ctx.textAlign = 'left';
          FIB_LEVELS.forEach((level, k) => {
            const p = d.b.p + (d.a.p - d.b.p) * level;
            const y = Math.round(this.yOfPrice(p)) + 0.5;
            ctx.strokeStyle = ctx.fillStyle = FIB_COLORS[k];
            line(b.x0, y, b.x1, y);
            ctx.fillText(level + '  ' + p.toFixed(2), b.x0 + 4, y - 7);
          });
        }
      });
      ctx.lineWidth = 1;
    }

    // A dashed line and a "News" flag where each news event began.
    _drawMarkers(g) {
      const ctx = this.ctx;
      const now = this.candles[this.candles.length - 1].time + this.tf;
      ctx.textAlign = 'center';
      for (const m of this.markers) {
        if (m.time >= now) continue; // not released yet
        const x = Math.round(this.xOfTime(m.time)) + 0.5;
        if (x < 0 || x > g.plotW) continue;
        ctx.strokeStyle = 'rgba(245, 184, 61, 0.45)';
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(x, PAD_TOP - 6); ctx.lineTo(x, g.plotH); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.sma;
        ctx.fillRect(x - 17, g.plotH - 16, 34, 15);
        ctx.fillStyle = '#1a1300';
        ctx.fillText('News', x, g.plotH - 8);
      }
    }

    _drawOrderLines(g) {
      const ctx = this.ctx;
      ctx.setLineDash([2, 4]);
      ctx.textAlign = 'left';
      for (const o of this.orderLines) {
        if (o.price < g.min || o.price > g.max) continue;
        const y = Math.round(this.yOfPrice(o.price)) + 0.5;
        ctx.strokeStyle = ctx.fillStyle = o.color || (o.side === 'buy' ? C.up : C.down);
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
        const text = Calendar.format(this.timeOfIndex(i)) + ' GMT';
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
      if (g.plotW >= 420) { // enough room for the numbers
        const color = c.close >= c.open ? C.up : C.down;
        for (const [k, v] of [['O', c.open], ['H', c.high], ['L', c.low], ['C', c.close]]) {
          put(k, C.text);
          x -= 4;
          put(v.toFixed(2), color);
        }
      }
      x = 12;
      for (const item of g.legend || []) {
        ctx.fillStyle = item.color;
        ctx.fillText(item.text + (item.value == null ? '' : '  ' + item.value.toFixed(2)), x, 34);
        x += ctx.measureText(item.text + '  000.00').width + 14;
      }
    }
  }

  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  root.CandleChart = CandleChart;
})(window);
