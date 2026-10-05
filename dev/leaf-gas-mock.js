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

// Utilities.newBlob / Utilities.zip のまね（.xlsx の出力テスト用）。zip は本物の ZIP（deflate）を作る
class MockBlob {
  constructor(data, contentType, name) {
    this.bytes = Buffer.isBuffer(data) ? Buffer.from(data) : Array.isArray(data) ? Buffer.from(data.map((b) => b & 255)) : Buffer.from(String(data ?? ''), 'utf8');
    this.contentType = contentType || null;
    this.name = name || null;
  }
  getBytes() { return Buffer.from(this.bytes); }
  getDataAsString() { return this.bytes.toString('utf8'); }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getContentType() { return this.contentType; }
  setContentType(t) { this.contentType = t; return this; }
}
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function buildZip(blobs) {
  const zlib = require('node:zlib');
  const locals = [];
  const centrals = [];
  let offset = 0;
  blobs.forEach((blob) => {
    const name = Buffer.from(blob.getName(), 'utf8');
    const raw = blob.getBytes();
    const data = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(blobs.length, 8); end.writeUInt16LE(blobs.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end]));
}

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
    Utilities: {
      formatDate, parseDate, getUuid: () => crypto.randomUUID(),
      newBlob: (data, contentType, name) => new MockBlob(data, contentType, name),
      zip: (blobs, name) => new MockBlob(buildZip(blobs), 'application/zip', name || 'archive.zip'),
      base64Encode: (data) => Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64'),
    },
    Logger: { log: () => {} },
  };
  // HtmlService（doGet の画面表示用）。テンプレートは <?!= 式 ?> と <?= 式 ?> だけに対応
  const htmlOutput = (content) => {
    const out = {
      content, title: '', metaTags: {},
      getContent() { return this.content; },
      setTitle(t) { this.title = t; return this; },
      getTitle() { return this.title; },
      addMetaTag(name, value) { this.metaTags[name] = value; return this; },
      setXFrameOptionsMode() { return this; },
      setFaviconUrl(url) { this.faviconUrl = url; return this; },
    };
    return out;
  };
  const readHtml = (name) => {
    const file = path.join(GAS_DIR, name.endsWith('.html') ? name : name + '.html');
    if (!fs.existsSync(file)) throw new Error('HTML ファイルがありません: ' + name);
    return fs.readFileSync(file, 'utf8');
  };
  const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  context.HtmlService = {
    createHtmlOutputFromFile: (name) => htmlOutput(readHtml(name)),
    // テンプレート：<?= 式 ?>（エスケープ）・<?!= 式 ?>（そのまま）・<? 文 ?>（if など）に対応。
    // テンプレートに付けた値（template.initialView など）も、式の中で使えるようにする
    createTemplateFromFile: (name) => {
      const template = {
        evaluate: () => {
          const source = readHtml(name);
          let code = 'var __out = [];\n';
          let last = 0;
          source.replace(/<\?(!=|=)?([\s\S]*?)\?>/g, (m, kind, body, index) => {
            // 本物の Apps Script と同じく、中身が空の <?= ?> / <?!= ?> は構文エラーにする
            if (kind && !body.trim()) throw new SyntaxError("Unexpected token ';'（" + name + '.html の空のスクリプトレット）');
            code += '__out.push(' + JSON.stringify(source.slice(last, index)) + ');\n';
            if (kind === '=') code += '__out.push(__esc(' + body + '));\n';
            else if (kind === '!=') code += '__out.push(String(' + body + '));\n';
            else code += body + '\n';
            last = index + m.length;
            return m;
          });
          code += '__out.push(' + JSON.stringify(source.slice(last)) + ');\nreturn __out.join("");';
          const run = vm.runInContext('(function (__t, __esc) { with (__t) { ' + code + ' } })', context);
          return htmlOutput(run(template, escapeHtml));
        },
      };
      return template;
    },
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
