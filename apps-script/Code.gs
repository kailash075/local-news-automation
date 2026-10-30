/** @OnlyCurrentDoc */
// The line above limits this script to the one Sheet it is attached to (Google asks only for that Sheet).

/**
 * ErodeGlitz Sheet bridge.
 *
 * A small web app, bound to the "ErodeGlitz Newsroom" Google Sheet, that the GitHub Actions jobs call to read and
 * write rows. Every request is a POST with a JSON body {auth, op, ...}; `auth` must equal the Script property
 * BRIDGE_KEY. Writes run under the script lock, so "insert if absent", compare-and-set updates and publication
 * leases are atomic even when two workflows run at once.
 *
 * The bridge knows nothing about news. Table names and columns come from the repository (src/sheet/tables.ts) through
 * the `setup` operation, which the `migrate` workflow sends.
 *
 * Safety rules kept here, whatever the caller sends:
 *  - tables marked append-only (decisions, evidence, drafts, publish attempts, errors) refuse `update` and `upsert`;
 *  - nothing is ever deleted;
 *  - every written cell is plain text, and text that Sheets would read as a formula is stored literally;
 *  - secrets live in Script properties under the SECRET_ prefix and never in the Sheet.
 *
 * Setup: docs/SETUP_GUIDE.md, section "Google Sheet and Apps Script bridge". Only this file and the Script property
 * BRIDGE_KEY are needed; the project's appsscript.json can stay as Google created it.
 */

var MAX_CELL_CHARS = 45000;
var MAX_BATCH_OPS = 50;
var LOCK_WAIT_MS = 25000;
var FORMULA_START = /^[=+\-@']/;

// ---------------------------------------------------------------- entry points

function doGet() {
  return json_({ ok: false, error: 'POST only', retryable: false });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e && e.postData ? e.postData.contents : '');
  } catch (err) {
    return json_({ ok: false, error: 'body is not JSON', retryable: false });
  }
  if (!authorised_(body)) return json_({ ok: false, error: 'unauthorized', retryable: false });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return json_({ ok: false, error: 'busy', retryable: true });
  try {
    return json_(run_(body, true));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err), retryable: false });
  } finally {
    lock.releaseLock();
  }
}

/** Run once from the Apps Script editor. Creates BRIDGE_KEY in Script properties if it is missing; never prints it. */
function initBridge() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('BRIDGE_KEY')) {
    props.setProperty('BRIDGE_KEY', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  }
  Logger.log('BRIDGE_KEY is in Project Settings > Script properties. Copy it into the GitHub secret SHEET_BRIDGE_KEY.');
}

// ---------------------------------------------------------------- dispatch

function run_(body, topLevel) {
  switch (body.op) {
    case 'ping':
      return { ok: true, schemaVersion: props_().getProperty('SCHEMA_VERSION'), time: new Date().toISOString() };
    case 'setup':
      if (!topLevel) throw new Error('setup cannot run inside a batch');
      return setup_(body);
    case 'selfTest':
      if (!topLevel) throw new Error('selfTest cannot run inside a batch');
      return selfTest_(body);
    case 'select':
      return { ok: true, rows: select_(body) };
    case 'insert':
      return { ok: true, results: insert_(body) };
    case 'upsert':
      return { ok: true, inserted: upsert_(body) };
    case 'update':
      return { ok: true, rows: update_(body) };
    case 'secretGet':
      return { ok: true, value: props_().getProperty(secretName_(body.name)) };
    case 'secretPut':
      if (typeof body.value !== 'string' || body.value.length > 8000) throw new Error('secret value must be a string of at most 8000 characters');
      props_().setProperty(secretName_(body.name), body.value);
      return { ok: true };
    case 'batch':
      if (!topLevel) throw new Error('batch cannot be nested');
      if (!Array.isArray(body.ops) || body.ops.length > MAX_BATCH_OPS) throw new Error('batch needs at most ' + MAX_BATCH_OPS + ' ops');
      return { ok: true, results: body.ops.map(function (op) { return run_(op, false); }) };
    default:
      throw new Error('unknown op ' + body.op);
  }
}

// ---------------------------------------------------------------- schema

/** body: {schemaVersion, tables: [{name, columns, appendOnly}]}. Creates missing tabs, adds missing columns, keeps extra columns. */
function setup_(body) {
  if (typeof body.schemaVersion !== 'string' || !Array.isArray(body.tables)) throw new Error('setup needs schemaVersion and tables');
  var ss = spreadsheet_();
  var created = [];
  var extended = [];
  var appendOnly = [];
  body.tables.forEach(function (t) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(t.name)) throw new Error('bad table name ' + t.name);
    var sheet = ss.getSheetByName(t.name);
    if (!sheet) {
      sheet = ss.insertSheet(t.name);
      created.push(t.name);
    }
    var header = headerOf_(sheet);
    var missing = t.columns.filter(function (c) { return header.indexOf(c) < 0; });
    if (missing.length > 0) {
      var all = header.concat(missing);
      if (sheet.getMaxColumns() < all.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), all.length - sheet.getMaxColumns());
      var range = sheet.getRange(1, 1, 1, all.length);
      range.setNumberFormat('@');
      range.setValues([all]);
      range.setFontWeight('bold');
      sheet.setFrozenRows(1);
      if (header.length > 0) extended.push(t.name);
    }
    if (t.appendOnly) appendOnly.push(t.name);
  });
  props_().setProperty('APPEND_ONLY', JSON.stringify(appendOnly));
  props_().setProperty('SCHEMA_VERSION', body.schemaVersion);
  return { ok: true, created: created, extended: extended };
}

/** Writes the given values to a scratch tab, reads them back and removes the tab, so the caller can see what Sheets keeps. */
function selfTest_(body) {
  var ss = spreadsheet_();
  var old = ss.getSheetByName('_selftest');
  if (old) ss.deleteSheet(old);
  var sheet = ss.insertSheet('_selftest');
  try {
    var values = body.values.map(function (v) { return [cell_(v)]; });
    var range = sheet.getRange(1, 1, values.length, 1);
    range.setNumberFormat('@');
    range.setValues(values);
    SpreadsheetApp.flush();
    var back = sheet.getRange(1, 1, values.length, 1).getValues().map(function (r) { return text_(r[0]); });
    return { ok: true, values: back };
  } finally {
    ss.deleteSheet(sheet);
  }
}

// ---------------------------------------------------------------- data operations

function select_(body) {
  var t = table_(body.table);
  var cols = body.columns || t.header;
  cols.forEach(function (c) { column_(t, c); });
  return t.rows
    .filter(function (r) { return matches_(t, r.values, body.where); })
    .map(function (r) {
      var o = {};
      cols.forEach(function (c) { o[c] = r.values[c]; });
      return o;
    });
}

/** body: {table, rows, unique?: [columns], refuseIf?: {name, where}}. Returns one result per row, in order. */
function insert_(body) {
  var t = table_(body.table);
  if (!Array.isArray(body.rows) || body.rows.length === 0) throw new Error('insert needs rows');
  var unique = body.unique || [];
  unique.forEach(function (c) { column_(t, c); });
  if (body.refuseIf && body.rows.length !== 1) throw new Error('refuseIf needs exactly one row');
  var pending = [];
  var results = body.rows.map(function (row) {
    var values = rowValues_(t, row);
    if (unique.length > 0) {
      var same = function (other) { return unique.every(function (c) { return other[c] === values[c]; }); };
      var existing = t.rows.filter(function (r) { return same(r.values); })[0];
      if (existing) return { inserted: false, existing: existing.values };
      var earlier = pending.filter(same)[0];
      if (earlier) return { inserted: false, existing: earlier };
    }
    // Checked after the unique key, so a retried request finds its own row instead of a conflict.
    if (body.refuseIf && t.rows.some(function (r) { return matches_(t, r.values, body.refuseIf.where); })) {
      throw new Error('conflict: ' + body.refuseIf.name);
    }
    pending.push(values);
    return { inserted: true };
  });
  appendRows_(t, pending);
  return results;
}

/** body: {table, match: [columns], row}. Updates the given columns of the matching row, or appends the row. */
function upsert_(body) {
  var t = table_(body.table);
  refuseAppendOnly_(t);
  var values = rowValues_(t, body.row);
  var cols = body.match || [];
  if (cols.length === 0) throw new Error('upsert needs match columns');
  var match = t.rows.filter(function (r) { return cols.every(function (c) { return r.values[column_(t, c)] === values[c]; }); })[0];
  if (!match) {
    appendRows_(t, [values]);
    return true;
  }
  Object.keys(body.row).forEach(function (c) { match.values[c] = values[c]; });
  writeRow_(t, match);
  return false;
}

/** body: {table, where, set, orderBy?, limit?}. Compare-and-set: only rows matching `where` change. Returns the changed rows. */
function update_(body) {
  var t = table_(body.table);
  refuseAppendOnly_(t);
  if (!body.where || Object.keys(body.where).length === 0) throw new Error('update needs a where clause');
  var setValues = rowValues_(t, body.set);
  var setCols = Object.keys(body.set);
  var hits = t.rows.filter(function (r) { return matches_(t, r.values, body.where); });
  if (body.orderBy) {
    var order = body.orderBy.map(function (c) { return column_(t, c); });
    hits.sort(function (a, b) {
      for (var i = 0; i < order.length; i++) {
        if (a.values[order[i]] < b.values[order[i]]) return -1;
        if (a.values[order[i]] > b.values[order[i]]) return 1;
      }
      return 0;
    });
  }
  if (typeof body.limit === 'number') hits = hits.slice(0, body.limit);
  hits.forEach(function (r) {
    setCols.forEach(function (c) { r.values[c] = setValues[c]; });
    writeRow_(t, r);
  });
  return hits.map(function (r) { return r.values; });
}

// ---------------------------------------------------------------- conditions

/**
 * A condition per column: a string (equal), null (empty), an array (one of), or an object with any of
 * gt / gte / lt / lte (string comparison; timestamps are UTC ISO strings of one fixed length) and notIn (array).
 * An object never matches an empty cell unless it has orEmpty: true; {} alone therefore means "not empty".
 */
function matches_(t, values, where) {
  if (!where) return true;
  return Object.keys(where).every(function (c) {
    var v = values[column_(t, c)];
    var cond = where[c];
    if (cond === null) return v === '';
    if (typeof cond === 'string') return v === cond;
    if (Array.isArray(cond)) return cond.indexOf(v) >= 0;
    if (v === '') return cond.orEmpty === true;
    if (cond.gt !== undefined && !(v > cond.gt)) return false;
    if (cond.gte !== undefined && !(v >= cond.gte)) return false;
    if (cond.lt !== undefined && !(v < cond.lt)) return false;
    if (cond.lte !== undefined && !(v <= cond.lte)) return false;
    if (cond.notIn !== undefined && cond.notIn.indexOf(v) >= 0) return false;
    return true;
  });
}

// ---------------------------------------------------------------- sheet access

function props_() { return PropertiesService.getScriptProperties(); }

function spreadsheet_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function authorised_(body) {
  var key = props_().getProperty('BRIDGE_KEY');
  if (!key || !body || typeof body.auth !== 'string' || body.auth.length !== key.length) return false;
  var diff = 0;
  for (var i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ body.auth.charCodeAt(i);
  return diff === 0;
}

function secretName_(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/.test(name)) throw new Error('bad secret name');
  return 'SECRET_' + name;
}

function headerOf_(sheet) {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(text_).filter(function (h) { return h !== ''; });
}

function table_(name) {
  if (typeof name !== 'string') throw new Error('table name missing');
  var sheet = spreadsheet_().getSheetByName(name);
  if (!sheet || name.charAt(0) === '_') throw new Error('unknown table ' + name + '; run the migrate workflow');
  var header = headerOf_(sheet);
  if (header.length === 0) throw new Error('table ' + name + ' has no header; run the migrate workflow');
  var last = sheet.getLastRow();
  var data = last > 1 ? sheet.getRange(2, 1, last - 1, header.length).getValues() : [];
  var rows = data.map(function (cells, i) {
    var values = {};
    header.forEach(function (h, j) { values[h] = text_(cells[j]); });
    return { rowNumber: i + 2, values: values };
  });
  return { name: name, sheet: sheet, header: header, rows: rows };
}

function column_(t, c) {
  if (t.header.indexOf(c) < 0) throw new Error('unknown column ' + c + ' in ' + t.name);
  return c;
}

function refuseAppendOnly_(t) {
  var list = JSON.parse(props_().getProperty('APPEND_ONLY') || '[]');
  if (list.indexOf(t.name) >= 0) throw new Error(t.name + ' is append-only');
}

/** Every value must be a string and every key a known column. Missing columns become empty. */
function rowValues_(t, row) {
  if (!row || typeof row !== 'object') throw new Error('row must be an object');
  var out = {};
  t.header.forEach(function (h) { out[h] = ''; });
  Object.keys(row).forEach(function (c) {
    column_(t, c);
    if (typeof row[c] !== 'string') throw new Error('value of ' + c + ' must be a string');
    if (row[c].length > MAX_CELL_CHARS) throw new Error('value of ' + c + ' is too long');
    out[c] = row[c];
  });
  return out;
}

function appendRows_(t, rows) {
  if (rows.length === 0) return;
  var start = t.sheet.getLastRow() + 1;
  var need = start + rows.length - 1;
  if (t.sheet.getMaxRows() < need) t.sheet.insertRowsAfter(t.sheet.getMaxRows(), need - t.sheet.getMaxRows() + 100);
  var range = t.sheet.getRange(start, 1, rows.length, t.header.length);
  range.setNumberFormat('@');
  range.setValues(rows.map(function (v) { return t.header.map(function (h) { return cell_(v[h]); }); }));
  rows.forEach(function (v, i) { t.rows.push({ rowNumber: start + i, values: v }); });
}

function writeRow_(t, r) {
  var range = t.sheet.getRange(r.rowNumber, 1, 1, t.header.length);
  range.setNumberFormat('@');
  range.setValues([t.header.map(function (h) { return cell_(r.values[h]); })]);
}

/** Text that Sheets would treat as a formula, or whose leading apostrophe it would hide, gets an apostrophe prefix. */
function cell_(v) {
  var s = v === undefined || v === null ? '' : String(v);
  return FORMULA_START.test(s) ? "'" + s : s;
}

/** Cells are read back as text. A Date or number only appears if someone typed into the Sheet by hand. */
function text_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  return String(v);
}
