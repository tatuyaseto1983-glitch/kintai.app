'use strict';
// leaf-portal/gas/*.gs（株式会社リーフ 社内ポータル用の勤怠バックエンド）を Node.js 上で動かすための、
// Google Apps Script の最小限のまね。テスト（test/leaf-portal.test.js）で使う。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const GAS_DIR = path.join(__dirname, '..', 'leaf-portal', 'gas');
const DEFAULT_MAX_ROWS = 1000;
const DEFAULT_MAX_COLUMNS = 26;

class Range {
  constructor(sheet, row, col, nr, nc) {
    if (row < 1 || col < 1 || nr < 1 || nc < 1) throw new Error(`範囲が正しくありません (${row},${col},${nr},${nc})`);
    if (row + nr - 1 > sheet.maxRows) throw new Error('行がシートの範囲外です');
    if (col + nc - 1 > sheet.maxColumns) throw new Error('列がシートの範囲外です');
    Object.assign(this, { sheet, row, col, nr, nc });
  }
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
  setValues(values) {
    if (values.length !== this.nr || values.some((line) => line.length !== this.nc)) {
      throw new Error(`データの行数・列数が範囲と一致しません（範囲 ${this.nr}x${this.nc}）`);
    }
    values.forEach((line, r) => {
      const idx = this.row - 1 + r;
      while (this.sheet.data.length <= idx) this.sheet.data.push([]);
      line.forEach((v, c) => { this.sheet.data[idx][this.col - 1 + c] = v; });
    });
    this.sheet.book.writeCount += 1;
    return this;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setDataValidation() { return this; }
}

class Sheet {
  constructor(book, name, data = []) {
    Object.assign(this, { book, name, data, maxRows: DEFAULT_MAX_ROWS, maxColumns: DEFAULT_MAX_COLUMNS });
  }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) if ((this.data[i] || []).some((v) => v !== '' && v != null)) return i + 1;
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.data.forEach((row) => (row || []).forEach((v, i) => { if (v !== '' && v != null) max = Math.max(max, i + 1); }));
    return max;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxColumns; }
  insertColumnsAfter(after, count) { this.maxColumns += count; }
  getRange(row, col, nr = 1, nc = 1) { return new Range(this, row, col, nr, nc); }
  setFrozenRows() {}
}

class Spreadsheet {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.sheets = [new Sheet(this, 'シート1')];
    this.timeZone = 'America/Los_Angeles';
    this.writeCount = 0;
  }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) {
    if (this.getSheetByName(n)) throw new Error(`「${n}」という名前のシートはすでに存在します`);
    const s = new Sheet(this, n);
    this.sheets.push(s);
    return s;
  }
  deleteSheet(sheet) {
    if (this.sheets.length === 1) throw new Error('最後のシートは削除できません');
    this.sheets = this.sheets.filter((s) => s !== sheet);
  }
  getSpreadsheetTimeZone() { return this.timeZone; }
  setSpreadsheetTimeZone(tz) { this.timeZone = tz; }
  toast() {}
  /** テスト用：シートの中身を見出しつきのオブジェクトで取り出す */
  rows(sheetName) {
    const sheet = this.getSheetByName(sheetName);
    const [head, ...body] = sheet.data;
    return body.filter((r) => r && r.some((v) => v !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
  }
}

// Asia/Tokyo だけに対応した日付の書式化（日本は夏時間がないので +9 時間で計算できる）
const JST_OFFSET_MS = 9 * 3600 * 1000;
function formatDate(date, tz, pattern) {
  if (tz !== 'Asia/Tokyo') throw new Error('モックは Asia/Tokyo のみ対応: ' + tz);
  const d = new Date(date.getTime() + JST_OFFSET_MS);
  const p2 = (n) => String(n).padStart(2, '0');
  const parts = {
    yyyy: String(d.getUTCFullYear()), MM: p2(d.getUTCMonth() + 1), dd: p2(d.getUTCDate()),
    HH: p2(d.getUTCHours()), mm: p2(d.getUTCMinutes()), ss: p2(d.getUTCSeconds()),
  };
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, (t) => parts[t]);
}
function parseDate(text, tz, pattern) {
  if (tz !== 'Asia/Tokyo') throw new Error('モックは Asia/Tokyo のみ対応: ' + tz);
  const m = String(text).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m || !/^yyyy-MM-dd HH:mm(:ss)?$/.test(pattern)) throw new Error('モックが対応していない日付です: ' + text);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - JST_OFFSET_MS);
}

/**
 * leaf-portal の GAS を読み込んだ実行環境を作る。
 * @param {object} [opts]
 * @param {string} [opts.email] ログイン中のメールアドレス
 * @param {boolean} [opts.reverseOrder] ファイルを逆順に読み込む
 */
function createLeafGas(opts = {}) {
  const books = new Map();
  const newBook = (name) => {
    const book = new Spreadsheet('SS_' + crypto.randomBytes(6).toString('hex'), name);
    books.set(book.id, book);
    return book;
  };
  const main = newBook('本番');
  const props = {};
  const state = { email: opts.email || 'owner@example.com' };

  const validationBuilder = () => {
    const b = { requireValueInList() { return b; }, setAllowInvalid() { return b; }, build() { return {}; } };
    return b;
  };

  const context = {
    console: { log: () => {}, error: () => {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => main,
      create: (name) => newBook(name),
      openById: (id) => { const b = books.get(id); if (!b) throw new Error('not found'); return b; },
      flush: () => {},
      newDataValidation: validationBuilder,
      getUi: () => { throw new Error('この環境では UI を使えません'); },
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => state.email }),
      getEffectiveUser: () => ({ getEmail: () => state.email }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate, parseDate, getUuid: () => crypto.randomUUID() },
    Logger: { log: () => {} },
  };
  vm.createContext(context);

  const files = fs.readdirSync(GAS_DIR).filter((f) => f.endsWith('.gs'))
    .sort((a, b) => (a === 'Config.gs' ? -1 : b === 'Config.gs' ? 1 : a.localeCompare(b)));
  if (opts.reverseOrder) files.reverse(); // Apps Script のファイルの並び順が違っても動くかの確認用
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(GAS_DIR, f), 'utf8'), context, { filename: f }));

  return {
    g: context,
    main,
    books,
    /** ログイン中のアカウントを変える */
    loginAs(email) { state.email = email; },
    /** 「今」の時刻を変える（'2026-06-01 09:30'。null で本当の時刻に戻す） */
    setNow(text) {
      vm.runInContext(text ? `APP_RUNTIME.now = Utilities.parseDate(${JSON.stringify(text)}, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')` : 'APP_RUNTIME.now = null', context);
    },
    /** GAS 側の式を評価する（const で定義された定数を見るとき用） */
    eval(code) { return vm.runInContext(code, context); },
  };
}

module.exports = { createLeafGas };
