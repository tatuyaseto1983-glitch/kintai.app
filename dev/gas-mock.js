'use strict';
// Google Apps Script の各サービスを最小限まねたもの。gas/Code.gs を手元で動かし、テストするために使う。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const toBuf = (bytes) => Buffer.from(bytes.map((b) => (b + 256) % 256));

class Range {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.nc; c++) line.push(src[this.col - 1 + c] ?? '');
      out.push(line);
    }
    return out;
  }
  getDisplayValues() { return this.getValues().map((r) => r.map((v) => String(v))); }
  setValues(values) {
    values.forEach((line, r) => {
      const idx = this.row - 1 + r;
      while (this.sheet.data.length <= idx) this.sheet.data.push([]);
      line.forEach((v, c) => { this.sheet.data[idx][this.col - 1 + c] = v; });
    });
    this.sheet.book.dirty();
    return this;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
}

class Sheet {
  constructor(book, name, data = []) { Object.assign(this, { book, name, data }); }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) if ((this.data[i] || []).some((v) => v !== '' && v != null)) return i + 1;
    return 0;
  }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, (r || []).length), 0); }
  getRange(row, col, nr = 1, nc = 1) { return new Range(this, row, col, nr, nc); }
  deleteRow(row) { this.data.splice(row - 1, 1); this.book.dirty(); }
  setFrozenRows() {}
}

class Spreadsheet {
  constructor(id, sheets = {}, onChange = () => {}) {
    this.id = id;
    this.onChange = onChange;
    this.sheets = Object.entries(sheets).map(([n, d]) => new Sheet(this, n, d));
  }
  dirty() { this.onChange(); }
  getId() { return this.id; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(this, n); this.sheets.push(s); this.dirty(); return s; }
  toJSON() { return Object.fromEntries(this.sheets.map((s) => [s.name, s.data])); }
}

/**
 * Code.gs を読み込んだ実行環境を作る。
 * @param {object} opts
 * @param {string} [opts.file] 保存先のJSONファイル（省略時はメモリ上のみ）
 * @param {number} [opts.clockOffsetMs] 時計をずらす（テスト用）
 */
function createGas(opts = {}) {
  const file = opts.file;
  const saved = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  let saveTimer = null;
  const save = () => {
    if (!file) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fs.writeFileSync(file, JSON.stringify({ sheets: main.toJSON(), props, drive: [...drive.entries()].map(([k, v]) => [k, { ...v, bytes: v.bytes.toString('base64') }]) })), 50);
  };
  const main = new Spreadsheet('MAIN_SPREADSHEET_ID_0000000', saved.sheets || {}, save);
  const books = new Map([[main.id, main]]);
  const props = saved.props || {};
  const cache = new Map();
  const drive = new Map((saved.drive || []).map(([k, v]) => [k, { ...v, bytes: Buffer.from(v.bytes, 'base64') }]));

  const blob = (bytes, type, name) => ({ bytes: Buffer.isBuffer(bytes) ? bytes : toBuf(bytes), type, name,
    getBytes() { return toSigned(this.bytes); }, getContentType() { return this.type; }, getName() { return this.name; } });

  const context = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => main,
      openById: (id) => { const b = books.get(id); if (!b) throw new Error('not found'); return b; },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); save(); },
        deleteProperty: (k) => { delete props[k]; save(); },
        getProperties: () => ({ ...props }),
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => { const e = cache.get(k); return e && e.exp > Date.now() ? e.v : null; },
        put: (k, v, sec) => cache.set(k, { v, exp: Date.now() + sec * 1000 }),
        remove: (k) => cache.delete(k),
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (value, key) => toSigned(crypto.createHmac('sha256', key).update(value).digest()),
      base64Encode: (bytes) => (typeof bytes === 'string' ? Buffer.from(bytes) : toBuf(bytes)).toString('base64'),
      base64Decode: (s) => toSigned(Buffer.from(s, 'base64')),
      newBlob: blob,
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; }, getContent() { return this.content; } }),
    },
    DriveApp: {
      createFolder: (name) => ({ getId: () => 'folder_' + name }),
      getFolderById: () => ({
        createFile: (b) => { const id = 'file_' + crypto.randomBytes(6).toString('hex'); drive.set(id, { bytes: b.bytes, type: b.type, name: b.name }); save(); return { getId: () => id }; },
      }),
      getFileById: (id) => { const f = drive.get(id); if (!f) throw new Error('no file'); return { getBlob: () => blob(f.bytes, f.type, f.name) }; },
    },
    Logger: { log: () => {} },
  };
  if (opts.clockOffsetMs) {
    const RealDate = Date;
    const off = opts.clockOffsetMs;
    context.Date = class extends RealDate {
      constructor(...a) { super(...(a.length ? a : [RealDate.now() + off])); }
      static now() { return RealDate.now() + off; }
    };
  }
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8'), context, { filename: 'Code.gs' });
  context.setup();

  return {
    context,
    /** 画面からのリクエストと同じ形で呼ぶ */
    call(req) { return JSON.parse(context.doPost({ postData: { contents: JSON.stringify(req) } }).getContent()); },
    /** 取り込みテスト用に別のスプレッドシートを用意する */
    addSpreadsheet(id, sheets) { books.set(id, new Spreadsheet(id, sheets)); },
    main,
  };
}

module.exports = { createGas };
