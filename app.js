/* DataLens app: wires the landing page and workspace to data.js and Chart.js / SheetJS. */
(function () {
  'use strict';

  var DL = window.DataLens;
  var LIM = DL.LIMITS;
  var ACCENT = '#4648d4';
  var PALETTE = ['#4648d4', '#8455ef', '#00885d', '#6063ee', '#767586', '#6ffbbe', '#293040', '#6b38d4', '#ba1a1a', '#006c49', '#c7c4d7', '#d3daef'];
  var LIB_MSG = 'The chart library did not load. Check your internet connection and reload the page. Tables and exports still work.';
  var PAGE = 25;

  function $(id) { return document.getElementById(id); }
  function must(id) {
    var el = $(id);
    if (!el) throw new Error('Missing element #' + id);
    return el;
  }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  function fmt(n) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  function isUserErr(e) { return e && (e instanceof DL.UserError || e.name === 'UserError'); }
  function hexA(hex, a) {
    var h = hex.replace('#', '');
    var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function palette(accent) {
    return [accent].concat(PALETTE.filter(function (c) { return c.toLowerCase() !== accent.toLowerCase(); }));
  }
  function setHidden(el, hidden) { if (el) el.hidden = hidden; }
  function setText(id, text) { var el = $(id); if (el) el.textContent = text; }
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function downloadPNG(canvas, name) {
    var out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    var g = out.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, out.width, out.height);
    g.drawImage(canvas, 0, 0);
    out.toBlob(function (b) { download(b, name + '.png'); }, 'image/png');
  }
  function slug(s) { return String(s || 'chart').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'chart'; }

  /* ---------- messages & status ---------- */

  function showMsg(msgEl, text) {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.hidden = false;
  }
  function hideMsg(msgEl) { if (msgEl) msgEl.hidden = true; }

  function setStatus(kind, text) {
    var box = $('wsStatus');
    if (!box) return;
    box.setAttribute('data-state', kind);
    setText('wsStatusText', text);
  }

  /* ---------- chart configuration ---------- */

  function chartConfig(res, cfg, o) {
    o = o || {};
    var accent = o.accent || ACCENT;
    var pal = palette(accent);
    var type = cfg.type || 'bar';
    var isScatter = res.kind === 'scatter';
    var isPie = res.kind === 'pie';
    var ct = isPie ? type : isScatter ? 'scatter' : (type === 'line' || type === 'area') ? 'line' : 'bar';
    var datasets, data;

    if (isScatter) {
      datasets = [{ label: res.datasets[0].label, data: res.points, backgroundColor: hexA(accent, 0.65), borderColor: accent, pointRadius: 4 }];
      data = { datasets: datasets };
    } else if (isPie) {
      datasets = [{ label: res.datasets[0].label, data: res.datasets[0].data, backgroundColor: pal.slice(0, res.labels.length), borderColor: '#ffffff', borderWidth: 2 }];
      data = { labels: res.labels, datasets: datasets };
    } else {
      datasets = res.datasets.map(function (d, i) {
        var c = pal[i % pal.length];
        if (ct === 'bar') return { label: d.label, data: d.data, backgroundColor: c, borderRadius: 6, maxBarThickness: 48 };
        return {
          label: d.label, data: d.data, borderColor: c, borderWidth: 2.5, tension: 0.35,
          backgroundColor: type === 'area' ? hexA(c, 0.18) : 'transparent',
          fill: type === 'area', pointRadius: res.labels.length > 40 ? 0 : 3
        };
      });
      data = { labels: res.labels, datasets: datasets };
    }

    var horizontal = !!o.horizontal && ct === 'bar';
    var showLegend = isPie || res.datasets.length > 1;
    var tickColor = '#464554';
    var grid = { color: '#e1e8fd' };
    var scales = {};
    if (!isPie) {
      scales.x = { title: { display: !!o.xLabel, text: o.xLabel || '', color: tickColor }, grid: grid, ticks: { color: tickColor } };
      scales.y = { title: { display: !!o.yLabel, text: o.yLabel || '', color: tickColor }, grid: grid, ticks: { color: tickColor, callback: function (v) { return fmt(v); } }, beginAtZero: !isScatter };
    }
    return {
      type: ct,
      data: data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        indexAxis: horizontal ? 'y' : 'x',
        plugins: {
          legend: { display: showLegend, position: 'bottom', labels: { color: tickColor, boxWidth: 10 } },
          title: { display: !!o.title, text: o.title || '', color: '#191b24', font: { weight: '600', size: 14 } },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                if (isScatter) return ctx.dataset.label + ': (' + fmt(ctx.parsed.x) + ', ' + fmt(ctx.parsed.y) + ')';
                var v = isPie ? ctx.parsed : (horizontal ? ctx.parsed.x : ctx.parsed.y);
                return ctx.dataset.label + ': ' + fmt(v);
              }
            }
          }
        },
        scales: scales
      }
    };
  }

  // Render a chart into a canvas; returns the Chart instance (or null if the library is missing).
  function renderInto(canvas, res, cfg, o) {
    if (!window.Chart) return null;
    return new window.Chart(canvas, chartConfig(res, cfg, o));
  }

  function chartCSV(res, cfg) {
    if (res.kind === 'scatter') {
      return DL.toCSVText([cfg.x, cfg.y], res.points.map(function (p) { return { [cfg.x]: p.x, [cfg.y]: p.y }; }));
    }
    var cols = [cfg.x || 'Category'].concat(res.datasets.map(function (d) { return d.label; }));
    var rows = res.labels.map(function (l, i) {
      var r = {}; r[cols[0]] = l;
      res.datasets.forEach(function (d, j) { r[cols[j + 1]] = d.data[i]; });
      return r;
    });
    return DL.toCSVText(cols, rows);
  }

  function autoTitle(cfg) {
    if (cfg.type === 'scatter') return cfg.y + ' vs ' + cfg.x;
    var what = cfg.agg === 'count' ? 'Count' : (cfg.agg === 'avg' ? 'Average' : 'Total') + (cfg.y ? ' of ' + cfg.y : '');
    return what + ' by ' + cfg.x;
  }

  /* ---------- Panel: a chart with controls bound by element id ---------- */

  function Panel(o) {
    this.o = o;
    this.chart = null;
    this.ds = null;
    this.res = null;
    this.cfg = null;
    this.color = ACCENT;
    var self = this;
    var ids = o.ids;
    ['type', 'x', 'y', 'series', 'agg'].forEach(function (k) {
      on($(ids[k]), 'change', function () { self.refresh(); });
    });
    ['title', 'xLabel', 'yLabel'].forEach(function (k) {
      on($(ids[k]), 'input', function () { self.refresh(); });
    });
    on($(ids.color), 'input', function (e) { self.color = e.target.value; self.refresh(); });
    Array.prototype.forEach.call($(ids.swatches).querySelectorAll('[data-accent]'), function (b) {
      b.addEventListener('click', function () {
        self.color = b.getAttribute('data-accent');
        if ($(ids.color)) $(ids.color).value = self.color;
        Array.prototype.forEach.call($(ids.swatches).querySelectorAll('[data-accent]'), function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        self.refresh();
      });
    });
    on($(ids.png), 'click', function () { if (self.chart) downloadPNG($(ids.canvas), slug(self.title) || 'chart'); });
    on($(ids.csv), 'click', function () {
      if (!self.res) return;
      download(new Blob([chartCSV(self.res, self.cfg)], { type: 'text/csv' }), slug(self.title) + '-data.csv');
    });
  }

  Panel.prototype.fill = function (ds) {
    var ids = this.o.ids;
    var cols = ds ? ds.columns : [];
    var nums = cols.filter(function (c) { return ds && ds.profile[c].type === 'numeric'; });
    var cats = cols.filter(function (c) { return ds && ds.profile[c].type !== 'numeric' && ds.profile[c].distinct <= 60; });
    function fillSel(sel, list, blank) {
      sel.innerHTML = '';
      if (blank !== null) sel.appendChild(new Option(blank, ''));
      list.forEach(function (c) { sel.appendChild(new Option(c, c)); });
    }
    var x = $(ids.x), y = $(ids.y), series = $(ids.series), agg = $(ids.agg);
    fillSel(x, cols, null);
    fillSel(y, nums, '— none (count rows) —');
    fillSel(series, cats, 'None');
    if (ds) {
      var defs = DL.defaultsFor(ds);
      $(ids.type).value = defs.type;
      x.value = defs.x;
      y.value = defs.y;
      series.value = '';
      agg.value = defs.agg;
    }
  };

  Panel.prototype.read = function () {
    var ids = this.o.ids;
    function v(k) { return $(ids[k]) ? $(ids[k]).value : ''; }
    return { type: v('type') || 'bar', x: v('x'), y: v('y'), series: v('series'), agg: v('agg') || 'sum' };
  };

  Panel.prototype.clear = function (text) {
    if (this.chart) { this.chart.destroy(); this.chart = null; }
    this.res = null;
    showMsg($(this.o.ids.msg), text);
  };

  Panel.prototype.refresh = function () {
    var ids = this.o.ids;
    var ds = this.o.ds();
    if (ds !== this.ds) { this.ds = ds; this.fill(ds); }
    if (!ds) { this.clear(this.o.emptyText || 'Load a dataset to see a chart.'); return; }
    var cfg = this.read();
    this.cfg = cfg;
    var rows = this.o.rows();
    if (!rows.length) { this.clear('No rows match the current filters.'); return; }
    var res;
    try {
      res = DL.produce(Object.assign({}, ds, { rows: rows }), cfg);
    } catch (e) {
      if (isUserErr(e)) { this.clear(e.message); return; }
      throw e;
    }
    this.res = res;
    var title = ($(ids.title) && $(ids.title).value.trim()) || autoTitle(cfg);
    this.title = title;
    var xl = $(ids.xLabel) ? $(ids.xLabel).value.trim() : '';
    var yl = $(ids.yLabel) ? $(ids.yLabel).value.trim() : '';
    if (!window.Chart) { this.clear(LIB_MSG); return; }
    hideMsg($(ids.msg));
    if (this.chart) this.chart.destroy();
    var canvas = $(ids.canvas);
    this.chart = renderInto(canvas, res, cfg, { accent: this.color, title: title, xLabel: xl || cfg.x, yLabel: yl || (cfg.agg === 'count' ? 'Count' : cfg.y) });
    if (this.o.onRender) this.o.onRender(res, cfg, this);
    if (this.o.noteId) setText(this.o.noteId, res.warnings.join(' '));
  };

  /* ---------- sample-driven sections ---------- */

  var sampleCache = null;
  function sample() { if (!sampleCache) sampleCache = DL.sampleDataset(); return sampleCache; }
  function activeDs() { return state.ds || sample(); }

  function cartesian(ds, cfg) { return DL.produce(ds, cfg); }

  function renderHero() {
    var t0 = performance.now();
    var ds = sample();
    var line = cartesian(ds, { type: 'line', x: 'Month', y: 'Revenue', series: '', agg: 'sum' });
    var heroCanvas = $('heroChart');
    if (heroCanvas && window.Chart) {
      renderInto(heroCanvas, line, { type: 'line' }, { accent: ACCENT, xLabel: '', yLabel: '' });
    }
    // Category bars (revenue by region).
    var reg = cartesian(ds, { type: 'bar', x: 'Region', y: 'Revenue', series: '', agg: 'sum' });
    var regRows = reg.labels.map(function (l, i) { return { l: l, v: reg.datasets[0].data[i] }; }).sort(function (a, b) { return b.v - a.v; });
    var max = regRows[0].v || 1;
    var cats = $('heroCats');
    cats.innerHTML = '';
    regRows.forEach(function (r, i) {
      var row = document.createElement('div');
      row.className = 'bar-row';
      var head = document.createElement('div'); head.className = 'r1';
      var s = document.createElement('span'); s.textContent = r.l;
      var b = document.createElement('b'); b.textContent = '$' + (r.v / 1000).toFixed(1) + 'k';
      head.appendChild(s); head.appendChild(b);
      var track = document.createElement('div'); track.className = 'track';
      var fill = document.createElement('i');
      fill.style.width = Math.round((r.v / max) * 100) + '%';
      if (i === 1) fill.style.background = 'var(--primary-2)';
      if (i === 2) fill.style.background = 'var(--primary-3)';
      track.appendChild(fill);
      row.appendChild(head); row.appendChild(track);
      cats.appendChild(row);
    });

    // Donut: units by product.
    var prod = cartesian(ds, { type: 'doughnut', x: 'Product', y: 'Units', series: '', agg: 'sum' });
    var donutCols = ['#4648d4', '#8455ef', '#00885d', '#6063ee'];
    var donutTotal = prod.datasets[0].data.reduce(function (s, v) { return s + v; }, 0) || 1;
    if ($('heroDonut') && window.Chart) {
      renderInto($('heroDonut'), prod, { type: 'doughnut' }, { accent: ACCENT });
    }
    var legend = $('heroDonutLegend');
    legend.innerHTML = '';
    prod.labels.forEach(function (l, i) {
      var row = document.createElement('div');
      var dot = document.createElement('i'); dot.className = 'dot'; dot.style.background = donutCols[i % 4];
      var sp = document.createElement('span'); sp.style.color = 'var(--ink)';
      sp.textContent = l + ' (' + Math.round(prod.datasets[0].data[i] / donutTotal * 100) + '%)';
      row.appendChild(dot); row.appendChild(sp); legend.appendChild(row);
    });

    // KPIs and sparklines computed from the sample.
    var rev = line.datasets[0].data;
    var units = cartesian(ds, { type: 'line', x: 'Month', y: 'Units', series: '', agg: 'sum' }).datasets[0].data;
    var rating = cartesian(ds, { type: 'line', x: 'Month', y: 'Rating', series: '', agg: 'avg' }).datasets[0].data;
    var totalRev = rev.reduce(function (s, v) { return s + v; }, 0);
    var totalUnits = units.reduce(function (s, v) { return s + v; }, 0);
    var avgRating = ds.rows.reduce(function (s, r) { return s + DL.toNumber(r.Rating); }, 0) / ds.rows.length;
    setKpi(1, '$' + Math.round(totalRev).toLocaleString(), pctChange(rev), rev);
    setKpi(2, Math.round(totalUnits).toLocaleString(), pctChange(units), units);
    setKpi(3, avgRating.toFixed(2), diffChange(rating), rating);

    // Insight line computed from the sample.
    var last = rev.length - 1;
    var top = regRows[0];
    var shareTop = Math.round(top.v / reg.datasets[0].data.reduce(function (s, v) { return s + v; }, 0) * 100);
    var dir = rev[last] >= rev[last - 1] ? 'higher' : 'lower';
    setText('heroInsight', 'Revenue in ' + monthName(line.labels[last]) + ' was ' +
      Math.abs(Math.round(pctChange(rev) || 0)) + '% ' + dir + ' than the month before. ' +
      top.l + ' leads with ' + shareTop + '% of total revenue.');

    var ms = Math.max(1, Math.round(performance.now() - t0));
    setText('heroLatency', 'Sample rendered in ' + ms + ' ms');
    setText('heroAcc', ds.rows.length + ' of ' + ds.rows.length + ' rows parsed');
  }

  function pctChange(arr) {
    var n = arr.length;
    if (n < 2 || !arr[n - 2]) return 0;
    return (arr[n - 1] - arr[n - 2]) / arr[n - 2] * 100;
  }
  function diffChange(arr) {
    var n = arr.length;
    return n < 2 ? 0 : arr[n - 1] - arr[n - 2];
  }
  function monthName(label) {
    var t = Date.parse(label);
    return isNaN(t) ? label : new Date(t).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  }
  function setKpi(i, valueText, change, series) {
    setText('heroK' + i, valueText);
    var d = $('heroD' + i);
    if (d) {
      var up = change >= 0;
      d.lastChild.textContent = (up ? '+' : '') + (i === 3 ? change.toFixed(2) : change.toFixed(1) + '%');
      d.style.color = up ? '' : 'var(--red, #ba1a1a)';
    }
    var line = $('heroS' + i);
    if (line && series.length) {
      var min = Math.min.apply(null, series), max = Math.max.apply(null, series);
      var span = (max - min) || 1;
      var pts = series.map(function (v, k) {
        var x = 2 + k * (60 / (series.length - 1 || 1));
        var y = 22 - ((v - min) / span) * 20;
        return x.toFixed(1) + ',' + y.toFixed(1);
      });
      line.setAttribute('points', pts.join(' '));
    }
  }

  function renderGallery() {
    var ds = sample();
    var specs = [
      ['galBar', { type: 'bar', x: 'Region', y: 'Revenue', series: '', agg: 'sum' }, { horizontal: false }],
      ['galLine', { type: 'line', x: 'Month', y: 'Revenue', series: '', agg: 'sum' }, {}],
      ['galDonut', { type: 'doughnut', x: 'Product', y: 'Units', series: '', agg: 'sum' }, {}],
      ['galScatter', { type: 'scatter', x: 'Units', y: 'Revenue', series: '', agg: 'sum' }, {}],
      ['galArea', { type: 'area', x: 'Month', y: 'Units', series: '', agg: 'sum' }, {}],
      ['galHBar', { type: 'bar', x: 'Product', y: 'Revenue', series: '', agg: 'sum' }, { horizontal: true }]
    ];
    specs.forEach(function (s) {
      var canvas = $(s[0]);
      if (!canvas) return;
      var res = DL.produce(ds, s[1]);
      if (!window.Chart) { showMsg($(s[0] + 'Msg'), LIB_MSG); return; }
      renderInto(canvas, res, s[1], { accent: ACCENT, horizontal: s[2].horizontal });
    });
  }

  /* ---------- natural-language prompt ---------- */

  var aiState = { cfg: null, text: '' };

  function runPrompt(text) {
    var ds = activeDs();
    aiState.text = text;
    if (!text.trim()) { showMsg($('aiMsg'), 'Type a question about your data first.'); return; }
    var parsed = DL.parsePrompt(text, ds);
    aiState.cfg = parsed.cfg;
    applyAiConfig(parsed.cfg, parsed.notes);
  }

  function applyAiConfig(cfg, notes) {
    var canvas = $('aiChart');
    var msg = $('aiMsg');
    var res;
    try { res = DL.produce(activeDs(), cfg); }
    catch (e) {
      if (isUserErr(e)) { showMsg(msg, e.message); return; }
      throw e;
    }
    hideMsg(msg);
    if (!window.Chart) { showMsg(msg, LIB_MSG); return; }
    if (aiPanel.chart) aiPanel.chart.destroy();
    aiPanel.chart = renderInto(canvas, res, cfg, { accent: ACCENT, title: autoTitle(cfg), xLabel: cfg.x, yLabel: cfg.agg === 'count' ? 'Count' : cfg.y });
    aiPanel.res = res;
    aiPanel.cfg = cfg;
    var lines = ['Interpreted as: ' + cfg.type + ' chart of ' + (cfg.agg === 'count' ? 'row counts' : cfg.agg + ' of ' + cfg.y) + ' by ' + cfg.x + (cfg.series ? ', split by ' + cfg.series : '') + '.'];
    (notes || []).concat(res.warnings).forEach(function (n) { lines.push(n); });
    setText('aiNotes', lines.join(' '));
    setText('aiDataset', (activeDs().name || 'Dataset') + ' · ' + activeDs().rows.length.toLocaleString() + ' rows');
    var segs = document.querySelectorAll('[data-ai-type]');
    Array.prototype.forEach.call(segs, function (b) {
      b.classList.toggle('on', b.getAttribute('data-ai-type') === cfg.type);
    });
  }

  function bindAI() {
    on($('aiGo'), 'click', function () { runPrompt($('aiPrompt').value); });
    on($('aiPrompt'), 'keydown', function (e) { if (e.key === 'Enter') runPrompt($('aiPrompt').value); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-prompt]'), function (b) {
      b.addEventListener('click', function () { $('aiPrompt').value = b.getAttribute('data-prompt'); runPrompt(b.getAttribute('data-prompt')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-ai-type]'), function (b) {
      b.addEventListener('click', function () {
        if (!aiState.cfg) runPrompt($('aiPrompt').value || 'show revenue by region');
        if (!aiState.cfg) return;
        aiState.cfg = Object.assign({}, aiState.cfg, { type: b.getAttribute('data-ai-type') });
        applyAiConfig(aiState.cfg, []);
      });
    });
    on($('aiPng'), 'click', function () { if (aiPanel.chart) downloadPNG($('aiChart'), 'ai-chart'); });
  }

  /* ---------- workspace: loading ---------- */

  var state = {
    ds: null,
    wb: null,
    pending: null,
    ws: { filter: { col: '', val: '', q: '' }, sort: { col: '', dir: 1 }, page: 0 }
  };

  // A failed load keeps whatever dataset was already on screen.
  function fail(message) {
    setStatus('error', message + (state.ds ? ' The previous data is still shown.' : ''));
    refreshAll();
  }

  function applyDataset(ds, okText) {
    state.ds = ds;
    state.ws.filter = { col: '', val: '', q: '' };
    state.ws.sort = { col: '', dir: 1 };
    state.ws.page = 0;
    var warn = ds.warnings.length ? ' ' + ds.warnings.join(' ') : '';
    setStatus('success', (okText || 'Loaded') + ' ' + ds.rows.length.toLocaleString() + ' rows × ' + ds.columns.length + ' columns from ' + ds.name + '.' + warn);
    refreshAll();
  }

  function parseSheet(name) {
    var ws = state.wb.Sheets[name];
    var objs = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
    var p = state.pending;
    return DL.datasetFromSheetRows(objs, { name: p.name, size: p.size, sheet: name, source: 'xlsx' });
  }

  function loadFile(file) {
    setStatus('loading', 'Reading ' + file.name + '…');
    if (file.size > LIM.MAX_BYTES) return fail('This file is larger than 25 MB. Split it into smaller files and try again.');
    if (!file.size) return fail('The file is empty.');
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var kind = (ext === 'csv' || ext === 'tsv' || ext === 'txt') ? 'csv'
      : ext === 'json' ? 'json'
      : (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'ods') ? 'xlsx' : null;
    if (!kind) return fail('Unsupported file type ".' + ext + '". Upload a CSV, Excel (.xlsx/.xls) or JSON file.');
    state.pending = { name: file.name, size: file.size };
    var reader = new FileReader();
    reader.onerror = function () { fail('The browser could not read this file.'); };
    reader.onload = function () {
      try {
        var meta = { name: file.name, size: file.size };
        if (kind === 'csv') applyDataset(DL.datasetFromCSV(String(reader.result), meta), 'Parsed');
        else if (kind === 'json') applyDataset(DL.datasetFromJSON(String(reader.result), meta), 'Parsed');
        else loadWorkbook(reader.result);
      } catch (e) {
        if (isUserErr(e)) fail(e.message);
        else fail('Unexpected error while reading the file: ' + e.message);
      }
    };
    if (kind === 'xlsx') reader.readAsArrayBuffer(file); else reader.readAsText(file, 'utf-8');
  }

  function loadWorkbook(buf) {
    if (!window.XLSX) throw new DL.UserError('Excel support could not load (SheetJS is missing). Upload a CSV or JSON file instead.');
    state.wb = XLSX.read(buf, { type: 'array', cellDates: true });
    var names = state.wb.SheetNames;
    if (!names.length) throw new DL.UserError('The workbook has no sheets.');
    var sel = $('wsSheet');
    sel.innerHTML = '';
    names.forEach(function (n) { sel.appendChild(new Option(n, n)); });
    setHidden($('wsSheetWrap'), names.length < 2);
    applyDataset(parseSheet(names[0]), 'Parsed');
  }

  function loadSample() {
    var ds = DL.sampleDataset();
    state.pending = { name: ds.name, size: 0 };
    applyDataset(ds, 'Loaded the built-in sample:');
  }

  function clearData() {
    state.ds = null; state.wb = null;
    setHidden($('wsSheetWrap'), true);
    $('fileInput').value = '';
    setStatus('idle', 'No file loaded yet. Upload a file or try the built-in sample.');
    refreshAll();
  }

  /* ---------- workspace: table, filters, summary ---------- */

  function viewRows() {
    var ds = state.ds;
    if (!ds) return [];
    var f = state.ws.filter;
    var q = f.q.trim().toLowerCase();
    return ds.rows.filter(function (r) {
      if (f.col && f.val !== '' && DL.groupKey(r[f.col]) !== f.val) return false;
      if (q && !ds.columns.some(function (c) { return String(r[c]).toLowerCase().indexOf(q) !== -1; })) return false;
      return true;
    });
  }

  function sortedRows() {
    var rows = viewRows().slice();
    var s = state.ws.sort;
    if (!s.col) return rows;
    rows.sort(function (a, b) {
      var x = a[s.col], y = b[s.col];
      var nx = DL.toNumber(x), ny = DL.toNumber(y);
      if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * s.dir;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * s.dir;
    });
    return rows;
  }

  function renderSummary() {
    var ds = state.ds;
    var box = $('wsSummary');
    box.innerHTML = '';
    if (!ds) return;
    var counts = { numeric: 0, date: 0, categorical: 0 };
    ds.columns.forEach(function (c) { counts[ds.profile[c].type]++; });
    setText('wsName', ds.name + (ds.sheet ? ' · ' + ds.sheet : ''));
    setText('wsSize', ds.size ? (ds.size / 1024).toFixed(1) + ' KB' : 'Sample');
    var chips = [
      ds.rows.length.toLocaleString() + ' rows',
      ds.columns.length + ' columns',
      counts.numeric + ' numeric',
      counts.date + ' date',
      counts.categorical + ' categorical'
    ];
    chips.forEach(function (t) {
      var s = document.createElement('span'); s.className = 'ws-chip'; s.textContent = t; box.appendChild(s);
    });
  }

  function renderFilters() {
    var ds = state.ds;
    var colSel = $('wsFCol'), valSel = $('wsFVal');
    colSel.innerHTML = '';
    colSel.appendChild(new Option('All columns', ''));
    valSel.innerHTML = '';
    valSel.appendChild(new Option('Any value', ''));
    if (!ds) { colSel.disabled = true; valSel.disabled = true; return; }
    colSel.disabled = false; valSel.disabled = false;
    ds.columns.forEach(function (c) {
      if (ds.profile[c].type !== 'numeric' && ds.profile[c].distinct <= 200) colSel.appendChild(new Option(c, c));
    });
    if (state.ws.filter.col && colSel.querySelector('option[value="' + state.ws.filter.col.replace(/"/g, '') + '"]')) {
      colSel.value = state.ws.filter.col;
    } else { state.ws.filter.col = ''; }
    fillValues();
    $('wsSearch').value = state.ws.filter.q;
  }

  function fillValues() {
    var ds = state.ds, valSel = $('wsFVal'), col = state.ws.filter.col;
    valSel.innerHTML = '';
    valSel.appendChild(new Option('Any value', ''));
    if (ds && col) {
      var seen = {}, vals = [];
      ds.rows.forEach(function (r) { var k = DL.groupKey(r[col]); if (!seen[k]) { seen[k] = 1; vals.push(k); } });
      DL.sortKeys(vals, ds.profile[col].type).forEach(function (v) { valSel.appendChild(new Option(v, v)); });
      valSel.value = state.ws.filter.val;
      if (valSel.value !== state.ws.filter.val) state.ws.filter.val = '';
    } else {
      state.ws.filter.val = '';
    }
  }

  function renderTable() {
    var ds = state.ds;
    var head = $('wsHead'), body = $('wsBody');
    head.innerHTML = ''; body.innerHTML = '';
    var emptyRow = $('wsEmpty');
    if (!ds) {
      setHidden(emptyRow, false);
      $('wsRowCount').textContent = '';
      $('wsPageInfo').textContent = 'Page 0 of 0';
      $('wsPrev').disabled = true; $('wsNext').disabled = true;
      $('wsCsv').disabled = true;
      return;
    }
    setHidden(emptyRow, true);
    $('wsCsv').disabled = false;
    var tr = document.createElement('tr');
    ds.columns.forEach(function (c) {
      var th = document.createElement('th');
      th.scope = 'col';
      var b = document.createElement('button');
      b.type = 'button';
      var s = state.ws.sort;
      b.textContent = c + (s.col === c ? (s.dir > 0 ? ' ▲' : ' ▼') : '');
      b.addEventListener('click', function () {
        if (state.ws.sort.col === c) state.ws.sort.dir = -state.ws.sort.dir;
        else state.ws.sort = { col: c, dir: 1 };
        renderTable();
      });
      th.setAttribute('aria-sort', s.col === c ? (s.dir > 0 ? 'ascending' : 'descending') : 'none');
      th.appendChild(b);
      tr.appendChild(th);
    });
    head.appendChild(tr);

    var rows = sortedRows();
    var pages = Math.max(1, Math.ceil(rows.length / PAGE));
    state.ws.page = Math.min(Math.max(0, state.ws.page), pages - 1);
    var slice = rows.slice(state.ws.page * PAGE, state.ws.page * PAGE + PAGE);
    slice.forEach(function (r) {
      var row = document.createElement('tr');
      ds.columns.forEach(function (c) {
        var td = document.createElement('td');
        td.textContent = r[c];
        if (ds.profile[c].type === 'numeric' && r[c] !== '') td.className = 'num';
        row.appendChild(td);
      });
      body.appendChild(row);
    });
    if (!slice.length) {
      var empty = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = ds.columns.length; td.className = 'ws-nomatch';
      td.textContent = 'No rows match the current search or filter.';
      empty.appendChild(td); body.appendChild(empty);
    }
    $('wsRowCount').textContent = rows.length.toLocaleString() + ' of ' + ds.rows.length.toLocaleString() + ' rows';
    $('wsPageInfo').textContent = 'Page ' + (state.ws.page + 1) + ' of ' + pages;
    $('wsPrev').disabled = state.ws.page === 0;
    $('wsNext').disabled = state.ws.page >= pages - 1;
  }

  function bindWorkspaceControls() {
    var drop = $('wsDrop');
    var input = $('fileInput');
    on($('wsPick'), 'click', function () { input.click(); });
    on(input, 'change', function (e) { if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]); });
    on($('wsSample'), 'click', loadSample);
    on($('wsClear'), 'click', clearData);
    on($('wsSheet'), 'change', function (e) {
      try { applyDataset(parseSheet(e.target.value), 'Parsed'); }
      catch (err) { fail(isUserErr(err) ? err.message : 'Could not read that sheet: ' + err.message); }
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      on(drop, ev, function (e) { e.preventDefault(); drop.classList.add('is-drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      on(drop, ev, function (e) { e.preventDefault(); drop.classList.remove('is-drag'); });
    });
    on(drop, 'drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
    on($('wsSearch'), 'input', function (e) { state.ws.filter.q = e.target.value; state.ws.page = 0; renderTable(); wsPanel.refresh(); });
    on($('wsFCol'), 'change', function (e) { state.ws.filter.col = e.target.value; state.ws.filter.val = ''; state.ws.page = 0; fillValues(); renderTable(); wsPanel.refresh(); });
    on($('wsFVal'), 'change', function (e) { state.ws.filter.val = e.target.value; state.ws.page = 0; renderTable(); wsPanel.refresh(); });
    on($('wsFClear'), 'click', function () {
      state.ws.filter = { col: '', val: '', q: '' }; state.ws.page = 0;
      renderFilters(); renderTable(); wsPanel.refresh();
    });
    on($('wsPrev'), 'click', function () { state.ws.page--; renderTable(); });
    on($('wsNext'), 'click', function () { state.ws.page++; renderTable(); });
    on($('wsCsv'), 'click', function () {
      if (!state.ds) return;
      var rows = sortedRows();
      download(new Blob([DL.toCSVText(state.ds.columns, rows)], { type: 'text/csv' }), slug(state.ds.name) + '-filtered.csv');
    });
  }

  /* ---------- workspace chart panel ---------- */

  var wsPanel = null;

  function refreshAll() {
    renderSummary();
    renderFilters();
    renderTable();
    wsPanel.refresh();
    exPanel.refresh();
    runPrompt(aiState.text || 'revenue by region as a bar chart');
  }

  var exPanel = null;
  var aiPanel = null;

  /* ---------- init ---------- */

  function init() {
    if (!DL) throw new Error('data.js did not load');
    aiPanel = { chart: null, res: null, cfg: null };
    wsPanel = new Panel({
      ids: { type: 'wsType', x: 'wsX', y: 'wsY', series: 'wsSeries', agg: 'wsAgg', title: 'wsTitle', xLabel: 'wsXLabel', yLabel: 'wsYLabel', color: 'wsColor', swatches: 'wsSwatches', canvas: 'wsCanvas', msg: 'wsMsg', png: 'wsPng', csv: 'wsChartCsv' },
      ds: function () { return state.ds; },
      rows: function () { return viewRows(); },
      emptyText: 'Upload a file or load the sample to chart your data.',
      noteId: 'wsNotes'
    });
    exPanel = new Panel({
      ids: { type: 'edType', x: 'edX', y: 'edY', series: 'edSeries', agg: 'edAgg', title: 'edTitle', xLabel: 'edXLabel', yLabel: 'edYLabel', color: 'edColor', swatches: 'edSwatches', canvas: 'edCanvas', msg: 'edMsg', png: 'edPng', csv: 'edCsv' },
      ds: activeDs,
      rows: function () { return activeDs().rows; }
    });
    bindWorkspaceControls();
    bindAI();
    renderHero();
    renderGallery();
    refreshAll();
  }

  window.DataLensApp = { state: state, loadSample: loadSample, loadFile: loadFile };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
