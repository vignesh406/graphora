/* DataLens data layer: parsing, profiling, aggregation, prompt parsing.
   Pure functions with no DOM access, so it can run in the browser and in Node tests. */
(function (root) {
  'use strict';

  var LIMITS = {
    MAX_BYTES: 25 * 1024 * 1024,
    MAX_ROWS: 50000,
    MAX_COLS: 200,
    MAX_CATS: 200,
    MAX_SERIES: 12,
    PIE_SLICES: 12,
    SCATTER_MAX: 5000
  };

  function UserError(message) {
    this.name = 'UserError';
    this.message = message;
  }
  UserError.prototype = Object.create(Error.prototype);
  UserError.prototype.constructor = UserError;

  /* ---------- value helpers ---------- */

  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v == null) return NaN;
    var s = String(v).trim();
    if (!s) return NaN;
    var neg = /^\(.*\)$/.test(s);           // accounting negatives: (1,200)
    s = s.replace(/^\((.*)\)$/, '$1').replace(/[$€£,\s%]/g, '');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
    var n = Number(s);
    return neg ? -n : n;
  }

  var ISO_RE = /^\d{4}-\d{1,2}-\d{1,2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
  var US_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

  function isDateStr(v) {
    if (v instanceof Date) return !isNaN(v.getTime());
    if (typeof v !== 'string') return false;
    var s = v.trim();
    if (ISO_RE.test(s) || US_RE.test(s)) return !isNaN(Date.parse(s));
    return false;
  }

  function toTime(v) {
    if (v instanceof Date) return v.getTime();
    return Date.parse(String(v).trim());
  }

  function groupKey(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? '(blank)' : v.toISOString().slice(0, 10);
    if (v === '' || v == null) return '(blank)';
    return String(v);
  }

  // Cells can hold objects from JSON; store them as text so charts and tables stay simple.
  function cellValue(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    if (typeof v === 'number') return isFinite(v) ? v : '';
    return v;
  }

  /* ---------- profiling ---------- */

  function buildProfile(columns, rows) {
    var profile = {};
    columns.forEach(function (col) {
      var nonEmpty = 0, numeric = 0, dates = 0, distinct = Object.create(null), distinctCount = 0;
      for (var i = 0; i < rows.length; i++) {
        var v = rows[i][col];
        if (v === '' || v == null) continue;
        nonEmpty++;
        if (!isNaN(toNumber(v))) numeric++;
        if (isDateStr(v)) dates++;
        var k = groupKey(v);
        if (!distinct[k]) { distinct[k] = 1; distinctCount++; }
        if (distinctCount > LIMITS.MAX_CATS * 5) break;
      }
      var type = 'categorical';
      if (nonEmpty > 0 && numeric / nonEmpty >= 0.9) type = 'numeric';
      else if (nonEmpty > 0 && dates / nonEmpty >= 0.9) type = 'date';
      profile[col] = { type: type, distinct: distinctCount, nonEmpty: nonEmpty };
    });
    return profile;
  }

  function makeDataset(meta, columns, rows) {
    var ds = {
      name: meta.name || 'Untitled dataset',
      source: meta.source || 'unknown',
      size: meta.size || 0,
      sheet: meta.sheet || null,
      columns: columns,
      rows: rows,
      truncated: !!meta.truncated,
      warnings: meta.warnings || []
    };
    ds.profile = buildProfile(columns, rows);
    return ds;
  }

  // Build columns (in first-seen order) and normalized rows from an array of objects.
  function datasetFromObjects(objs, meta) {
    var warnings = (meta && meta.warnings) ? meta.warnings.slice() : [];
    var colSet = Object.create(null), columns = [];
    var rows = [];
    var limit = Math.min(objs.length, LIMITS.MAX_ROWS);
    if (objs.length > LIMITS.MAX_ROWS) {
      warnings.push('Only the first ' + LIMITS.MAX_ROWS.toLocaleString() + ' of ' + objs.length.toLocaleString() + ' rows were loaded.');
    }
    for (var i = 0; i < limit; i++) {
      var o = objs[i] || {};
      var out = {};
      Object.keys(o).forEach(function (k) {
        var name = String(k).trim() || 'Column';
        if (!colSet[name]) {
          if (columns.length >= LIMITS.MAX_COLS) return;
          colSet[name] = true; columns.push(name);
        }
        out[name] = cellValue(o[k]);
      });
      rows.push(out);
    }
    // Fill missing keys so every row has every column.
    rows.forEach(function (r) {
      columns.forEach(function (c) { if (!(c in r)) r[c] = ''; });
    });
    if (!rows.length) throw new UserError('The file has no data rows.');
    if (!columns.length) throw new UserError('The file has no column names.');
    return makeDataset({ name: meta.name, source: meta.source, size: meta.size, sheet: meta.sheet,
      truncated: objs.length > LIMITS.MAX_ROWS, warnings: warnings }, columns, rows);
  }

  /* ---------- CSV ---------- */

  function detectDelimiter(text) {
    var firstLine = text.split(/\r?\n/)[0] || '';
    var candidates = [',', ';', '\t', '|'];
    var best = ',', bestCount = -1;
    candidates.forEach(function (d) {
      var c = firstLine.split(d).length - 1;
      if (c > bestCount) { best = d; bestCount = c; }
    });
    return best;
  }

  // RFC 4180-style parser: quoted fields, doubled quotes, CRLF or LF line endings.
  function parseCSV(text, delim) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var rows = [], row = [], field = '', i = 0, inQuotes = false, line = 1, quoteLine = 1;
    var n = text.length;
    while (i < n) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        if (ch === '\n') line++;
        field += ch; i++; continue;
      }
      if (ch === '"' && field === '') { inQuotes = true; quoteLine = line; i++; continue; }
      if (ch === delim) { row.push(field); field = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
        if (ch === '\r' && text[i + 1] === '\n') i++;
        line++; i++; continue;
      }
      field += ch; i++;
    }
    if (inQuotes) {
      throw new UserError('CSV parse error: a quoted field starting on line ' + quoteLine + ' is never closed. Check for a missing closing quote (").');
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    // Drop fully blank lines.
    return rows.filter(function (r) {
      return r.some(function (c) { return String(c).trim() !== ''; });
    });
  }

  function datasetFromCSV(text, meta) {
    var delim = detectDelimiter(text);
    var table = parseCSV(text, delim);
    if (table.length < 2) throw new UserError('The CSV needs a header row and at least one data row.');
    var headers = table[0].map(function (h, idx) {
      var t = String(h).trim();
      return t || ('Column ' + (idx + 1));
    });
    // Make duplicate headers unique.
    var seen = Object.create(null);
    headers = headers.map(function (h) {
      var name = h, k = 2;
      while (seen[name]) name = h + ' (' + (k++) + ')';
      seen[name] = true;
      return name;
    });
    var objs = [];
    for (var r = 1; r < table.length; r++) {
      var o = {};
      for (var c = 0; c < headers.length; c++) o[headers[c]] = table[r][c] == null ? '' : table[r][c];
      objs.push(o);
    }
    var warnings = [];
    var ragged = table.slice(1).filter(function (rw) { return rw.length !== headers.length; }).length;
    if (ragged) warnings.push(ragged + ' row(s) had a different number of fields than the header and were padded or cut.');
    if (delim !== ',') warnings.push('Detected delimiter: ' + (delim === '\t' ? 'tab' : '"' + delim + '"') + '.');
    return datasetFromObjects(objs, { name: meta.name, source: 'csv', size: meta.size, warnings: warnings });
  }

  /* ---------- JSON ---------- */

  function datasetFromJSON(text, meta) {
    var data;
    try { data = JSON.parse(text); }
    catch (e) { throw new UserError('Invalid JSON: ' + e.message + '.'); }
    var list = null;
    if (Array.isArray(data)) list = data;
    else if (data && typeof data === 'object') {
      var key = Object.keys(data).filter(function (k) {
        return Array.isArray(data[k]) && data[k].length && typeof data[k][0] === 'object';
      })[0];
      if (key) list = data[key];
    }
    if (!list) throw new UserError('JSON must be an array of objects, or an object containing one such array.');
    var objs = list.filter(function (x) { return x && typeof x === 'object' && !Array.isArray(x); });
    if (!objs.length) throw new UserError('The JSON array contains no objects.');
    var warnings = [];
    if (objs.length !== list.length) warnings.push((list.length - objs.length) + ' non-object item(s) were skipped.');
    return datasetFromObjects(objs, { name: meta.name, source: 'json', size: meta.size, warnings: warnings });
  }

  /* ---------- Excel (rows come from SheetJS in app.js) ---------- */

  function datasetFromSheetRows(objs, meta) {
    if (!objs.length) throw new UserError('The selected sheet is empty.');
    return datasetFromObjects(objs, { name: meta.name, source: meta.source || 'xlsx', size: meta.size, sheet: meta.sheet });
  }

  /* ---------- sample data ---------- */

  function sampleDataset() {
    var seed = 20250101;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    var regions = ['North', 'South', 'East', 'West'];
    var products = ['Alpha', 'Beta', 'Gamma', 'Delta'];
    var rows = [];
    for (var m = 1; m <= 12; m++) {
      regions.forEach(function (reg, ri) {
        products.forEach(function (prod, pi) {
          var units = Math.round(20 + rnd() * 80 + pi * 12);
          var price = 40 + pi * 15 + ri * 3;
          rows.push({
            Month: '2025-' + (m < 10 ? '0' : '') + m + '-01',
            Region: reg,
            Product: prod,
            Units: units,
            Revenue: Math.round(units * price * 100) / 100,
            Rating: Math.round((3 + rnd() * 2) * 10) / 10
          });
        });
      });
    }
    return makeDataset({ name: 'Sample sales data', source: 'sample', size: 0 },
      ['Month', 'Region', 'Product', 'Units', 'Revenue', 'Rating'], rows);
  }

  /* ---------- CSV export ---------- */

  function csvEscape(v) {
    var s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSVText(columns, rows) {
    var lines = [columns.map(csvEscape).join(',')];
    rows.forEach(function (r) {
      lines.push(columns.map(function (c) { return csvEscape(r[c]); }).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  /* ---------- aggregation ---------- */

  function defaultsFor(ds) {
    var cols = ds.columns, p = ds.profile;
    var nums = cols.filter(function (c) { return p[c].type === 'numeric'; });
    var dates = cols.filter(function (c) { return p[c].type === 'date'; });
    var cats = cols.filter(function (c) { return p[c].type === 'categorical' && p[c].distinct <= 60; });
    var x = dates[0] || cats[0] || cols[0];
    var y = nums.filter(function (c) { return c !== x; })[0] || nums[0] || '';
    var type = (x && ds.profile[x].type === 'date') ? 'line' : 'bar';
    return { type: type, x: x, y: y, series: '', agg: y ? 'sum' : 'count' };
  }

  function sortKeys(keys, xType) {
    if (xType === 'date') {
      return keys.slice().sort(function (a, b) {
        var ta = Date.parse(a), tb = Date.parse(b);
        if (isNaN(ta) && isNaN(tb)) return a.localeCompare(b);
        if (isNaN(ta)) return 1; if (isNaN(tb)) return -1;
        return ta - tb;
      });
    }
    var allNum = keys.every(function (k) { return k === '(blank)' || !isNaN(toNumber(k)); });
    if (allNum) return keys.slice().sort(function (a, b) { return toNumber(a) - toNumber(b); });
    return keys.slice().sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
  }

  // Accumulate a value per (x, series) group.
  function accumulate(rows, cfg) {
    var acc = Object.create(null), xs = Object.create(null), ss = Object.create(null);
    rows.forEach(function (r) {
      var xk = groupKey(r[cfg.x]);
      var sk = cfg.series ? groupKey(r[cfg.series]) : '';
      var key = xk + '\u0001' + sk;
      if (!acc[key]) acc[key] = { sum: 0, count: 0, xk: xk, sk: sk };
      var a = acc[key];
      xs[xk] = true; ss[sk] = true;
      if (cfg.agg === 'count') { a.count++; return; }
      var v = toNumber(r[cfg.y]);
      if (!isNaN(v)) { a.sum += v; a.count++; }
    });
    return { acc: acc, xs: Object.keys(xs), ss: Object.keys(ss) };
  }

  function valueOf(a, agg) {
    if (agg === 'count') return a.count;
    if (agg === 'avg') return a.count ? a.sum / a.count : 0;
    return a.sum;
  }

  function buildCartesian(ds, rows, cfg, warnings) {
    var accum = accumulate(rows, cfg);
    var xKeys = accum.xs.slice();
    var xType = ds.profile[cfg.x].type;
    xKeys = sortKeys(xKeys, xType);
    if (xKeys.length > LIMITS.MAX_CATS) {
      // Keep the largest categories by total, in their natural order.
      var totals = {};
      xKeys.forEach(function (k) { totals[k] = 0; });
      Object.keys(accum.acc).forEach(function (key) {
        var a = accum.acc[key]; totals[a.xk] += Math.abs(valueOf(a, cfg.agg));
      });
      var keep = xKeys.slice().sort(function (a, b) { return totals[b] - totals[a]; }).slice(0, LIMITS.MAX_CATS);
      xKeys = xKeys.filter(function (k) { return keep.indexOf(k) !== -1; });
      warnings.push('Showing the ' + LIMITS.MAX_CATS + ' largest categories out of ' + accum.xs.length + '.');
    }
    var seriesKeys = cfg.series ? sortKeys(accum.ss, ds.profile[cfg.series].type) : [''];
    if (seriesKeys.length > LIMITS.MAX_SERIES) {
      warnings.push('Only the first ' + LIMITS.MAX_SERIES + ' series are drawn; ' + (seriesKeys.length - LIMITS.MAX_SERIES) + ' were left out.');
      seriesKeys = seriesKeys.slice(0, LIMITS.MAX_SERIES);
    }
    var datasets = seriesKeys.map(function (sk) {
      return {
        label: cfg.series ? sk : (cfg.agg === 'count' ? 'Count' : cfg.agg === 'avg' ? 'Average of ' + cfg.y : 'Total of ' + cfg.y),
        data: xKeys.map(function (xk) {
          var a = accum.acc[xk + '\u0001' + sk];
          return a ? valueOf(a, cfg.agg) : 0;
        })
      };
    });
    return { kind: 'cartesian', labels: xKeys, datasets: datasets, warnings: warnings };
  }

  function buildPie(ds, rows, cfg, warnings) {
    var cart = buildCartesian(ds, rows, Object.assign({}, cfg, { series: '' }), []);
    var ds0 = cart.datasets[0] ? cart.datasets[0].data : [];
    var pairs = cart.labels.map(function (l, i) { return { label: l, value: ds0[i] }; })
      .filter(function (p) { return p.value > 0; })
      .sort(function (a, b) { return b.value - a.value; });
    if (pairs.length > LIMITS.PIE_SLICES) {
      var top = pairs.slice(0, LIMITS.PIE_SLICES - 1);
      var rest = pairs.slice(LIMITS.PIE_SLICES - 1).reduce(function (s, p) { return s + p.value; }, 0);
      top.push({ label: 'Other', value: rest });
      pairs = top;
      warnings.push('Smaller categories were grouped into "Other".');
    }
    return { kind: 'pie', labels: pairs.map(function (p) { return p.label; }),
      datasets: [{ label: cfg.agg === 'count' ? 'Count' : 'Total of ' + cfg.y, data: pairs.map(function (p) { return p.value; }) }],
      warnings: warnings };
  }

  function pearson(xs, ys) {
    var n = xs.length;
    if (n < 3) return NaN;
    var mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var sxy = 0, sxx = 0, syy = 0;
    for (i = 0; i < n; i++) {
      var dx = xs[i] - mx, dy = ys[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    if (sxx === 0 || syy === 0) return NaN;
    return sxy / Math.sqrt(sxx * syy);
  }

  function buildScatter(ds, rows, cfg, warnings) {
    var pts = [];
    rows.forEach(function (r) {
      var x = toNumber(r[cfg.x]), y = toNumber(r[cfg.y]);
      if (!isNaN(x) && !isNaN(y)) pts.push({ x: x, y: y });
    });
    if (!pts.length) throw new UserError('Scatter plots need two numeric columns with values.');
    if (pts.length > LIMITS.SCATTER_MAX) {
      warnings.push('Showing ' + LIMITS.SCATTER_MAX + ' of ' + pts.length + ' points.');
      pts = pts.slice(0, LIMITS.SCATTER_MAX);
    }
    var all = rows.map(function (r) { return [toNumber(r[cfg.x]), toNumber(r[cfg.y])]; })
      .filter(function (p) { return !isNaN(p[0]) && !isNaN(p[1]); });
    var r = pearson(all.map(function (p) { return p[0]; }), all.map(function (p) { return p[1]; }));
    return { kind: 'scatter', points: pts, r: r, warnings: warnings,
      datasets: [{ label: cfg.y + ' vs ' + cfg.x, data: pts }] };
  }

  // Validate a chart config against the dataset and build chart-ready data.
  function produce(ds, cfg) {
    var warnings = [];
    var rows = ds.rows;
    if (!cfg.x || ds.columns.indexOf(cfg.x) === -1) throw new UserError('Choose an X column.');
    if (cfg.type === 'scatter') {
      if (!cfg.y || ds.profile[cfg.y].type !== 'numeric' || ds.profile[cfg.x].type !== 'numeric') {
        throw new UserError('Scatter plots need two numeric columns for X and Y.');
      }
      return buildScatter(ds, rows, cfg, warnings);
    }
    if (cfg.agg !== 'count') {
      if (!cfg.y || ds.columns.indexOf(cfg.y) === -1) throw new UserError('Choose a Y column, or use Count.');
      if (ds.profile[cfg.y].type !== 'numeric') throw new UserError('"' + cfg.y + '" is not numeric, so it cannot be summed or averaged. Use Count instead.');
    }
    if (cfg.series && ds.columns.indexOf(cfg.series) === -1) cfg = Object.assign({}, cfg, { series: '' });
    if (cfg.series === cfg.x) cfg = Object.assign({}, cfg, { series: '' });
    if (cfg.type === 'pie' || cfg.type === 'doughnut') return buildPie(ds, rows, cfg, warnings);
    return buildCartesian(ds, rows, cfg, warnings);
  }

  /* ---------- natural-language prompt (rule-based, not an LLM) ---------- */

  function parsePrompt(text, ds) {
    var t = ' ' + String(text || '').toLowerCase() + ' ';
    var notes = [];
    var base = defaultsFor(ds);
    var cfg = { type: base.type, x: base.x, y: base.y, series: '', agg: base.agg };

    if (/\bdoughnut\b|\bdonut\b/.test(t)) cfg.type = 'doughnut';
    else if (/\bpie\b/.test(t)) cfg.type = 'pie';
    else if (/\bscatter\b|\bcorrelat/.test(t)) cfg.type = 'scatter';
    else if (/\barea\b/.test(t)) cfg.type = 'area';
    else if (/\bline\b|\btrend|over time|\bmonthly\b|\bweekly\b|\bdaily\b/.test(t)) cfg.type = 'line';
    else if (/\bbar\b|\bcolumn\b|\bcompare\b|\bcomparison\b/.test(t)) cfg.type = 'bar';
    if (cfg.type !== base.type) notes.push('Chart type: ' + cfg.type + '.');

    if (/\baverage\b|\bmean\b|\bavg\b/.test(t)) cfg.agg = 'avg';
    else if (/\bcount\b|how many|number of/.test(t)) cfg.agg = 'count';
    else if (/\bsum\b|\btotal\b/.test(t)) cfg.agg = 'sum';

    // Find columns mentioned in the prompt, in the order they appear.
    var mentions = [];
    ds.columns.forEach(function (c) {
      var idx = t.indexOf(c.toLowerCase());
      if (idx !== -1) mentions.push({ col: c, idx: idx, len: c.length });
    });
    mentions.sort(function (a, b) { return a.idx - b.idx; });
    // Drop mentions nested inside a longer mention.
    mentions = mentions.filter(function (m, i) {
      return !mentions.some(function (o, j) { return j !== i && o.idx <= m.idx && o.idx + o.len >= m.idx + m.len && o.len > m.len; });
    });

    var seriesWord = /\b(across|per|by|each|every|split|for each)\b/;
    var numMentions = mentions.filter(function (m) { return ds.profile[m.col].type === 'numeric'; }).map(function (m) { return m.col; });
    var catMentions = mentions.filter(function (m) { return ds.profile[m.col].type !== 'numeric'; });
    // A categorical column after "across / per / by / each" is a series, unless it is the only category.
    var seriesCol = '', xCands = [];
    catMentions.forEach(function (m) {
      var before = t.slice(Math.max(0, m.idx - 14), m.idx);
      if (!seriesCol && cfg.type !== 'scatter' && catMentions.length > 1 && seriesWord.test(before)) seriesCol = m.col;
      else xCands.push(m.col);
    });
    if (cfg.type === 'scatter') {
      var nums = numMentions.length ? numMentions : mentions.map(function (m) { return m.col; });
      if (nums.length >= 2) { cfg.x = nums[0]; cfg.y = nums[1]; }
    } else {
      if (xCands.length) cfg.x = xCands[0];
      else if (numMentions.length) cfg.x = numMentions[0];
      var yCand = numMentions.filter(function (c) { return c !== cfg.x; })[0];
      if (yCand) cfg.y = yCand;
    }
    if (seriesCol && seriesCol !== cfg.x && cfg.type !== 'pie' && cfg.type !== 'doughnut') cfg.series = seriesCol;
    if (cfg.type === 'scatter') { cfg.agg = 'sum'; }
    if (cfg.agg !== 'count' && (!cfg.y || ds.profile[cfg.y].type !== 'numeric')) {
      notes.push('No numeric column found for Y, so counting rows instead.');
      cfg.agg = 'count';
    }
    if (cfg.agg === 'count' && cfg.type === 'scatter') cfg.type = 'bar';

    var warn = null;
    if (!mentions.length) notes.unshift('No column names matched, so defaults were used.');
    return { cfg: cfg, notes: notes, warn: warn };
  }

  var api = {
    LIMITS: LIMITS, UserError: UserError,
    toNumber: toNumber, isDateStr: isDateStr, toTime: toTime, groupKey: groupKey,
    buildProfile: buildProfile, parseCSV: parseCSV, detectDelimiter: detectDelimiter,
    datasetFromCSV: datasetFromCSV, datasetFromJSON: datasetFromJSON,
    datasetFromSheetRows: datasetFromSheetRows, sampleDataset: sampleDataset,
    toCSVText: toCSVText, defaultsFor: defaultsFor, produce: produce,
    pearson: pearson, parsePrompt: parsePrompt, sortKeys: sortKeys
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DataLens = api;
})(typeof window !== 'undefined' ? window : globalThis);
