/**
 * SheetService.gs
 * ------------------------------------------------------------
 * スプレッドシートを「表（データベース）」として読み書きする共通処理です。
 *
 * ・列は番号ではなく「1行目の見出し名」で探します。
 *   → 列の順番を入れ替えたり、右側に独自の列を足したりしても動きます。
 * ・読み込みは getValues()、書き込みは setValues() でまとめて行います。
 * ・1回の実行の中では読み込んだ内容を覚えておき（キャッシュ）、何度もシートを読まないようにしています。
 * ・時刻や日付は「文字列（書式なしテキスト）」として保存します。
 *   → 「09:30」が勝手に日付や別の値に変換されるのを防ぐためです。
 */

var TABLE_CACHE_ = {};

/** 読み込んだ内容の記憶を消す（ロックを取った直後などに使う） */
function clearTableCache_() {
  TABLE_CACHE_ = {};
  SETTINGS_CACHE_ = null;
}

/** このスクリプトが紐づいているスプレッドシート */
function getSpreadsheet_() {
  const ss = APP_RUNTIME.spreadsheet || SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    fail_('スプレッドシートが見つかりません。このコードは、スプレッドシートの［拡張機能］→［Apps Script］から開いたプロジェクトに貼り付けてください');
  }
  return ss;
}

/** シートを名前で取得（なければ分かりやすいエラー） */
function getSheet_(sheetName) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) fail_('「' + sheetName + '」シートが見つかりません。Apps Script で setupSystem() を実行してください');
  return sheet;
}

/** Config.gs のシート定義を取得 */
function getSheetDefinition_(sheetName) {
  const def = SHEET_DEFINITIONS.filter(function (d) { return d.name === sheetName; })[0];
  if (!def) fail_('「' + sheetName + '」はこのシステムのシートとして定義されていません');
  return def;
}

/**
 * シート全体を1回で読み込み、1行を1つのオブジェクト（見出し名 → 値）にして返す。
 * 例：record['出勤'] → '09:30'
 * 戻り値：{ sheetName, sheet, headers, columnIndex, records }
 */
function readTable_(sheetName) {
  if (TABLE_CACHE_[sheetName]) return TABLE_CACHE_[sheetName];

  const sheet = getSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 1 || lastColumn < 1) {
    fail_('「' + sheetName + '」シートの1行目に見出しがありません。setupSystem() を実行してください');
  }
  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = values[0].map(function (h) { return String(h).trim(); });

  const columnIndex = {};
  headers.forEach(function (h, i) {
    if (h !== '' && columnIndex[h] === undefined) columnIndex[h] = i;
  });
  const missing = getSheetDefinition_(sheetName).headers.filter(function (h) { return columnIndex[h] === undefined; });
  if (missing.length) {
    fail_('「' + sheetName + '」シートに「' + missing.join('」「') + '」列がありません。setupSystem() を実行して列を追加してください');
  }

  const records = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i].every(isBlank_)) continue; // 空行は読み飛ばす
    records.push(makeRecord_(headers, values[i], i + 1));
  }

  const table = { sheetName: sheetName, sheet: sheet, headers: headers, columnIndex: columnIndex, records: records };
  TABLE_CACHE_[sheetName] = table;
  return table;
}

/** 1行分の値からオブジェクトを作る。行番号と元の値は見えない項目として持たせる */
function makeRecord_(headers, row, rowNumber) {
  const record = {};
  headers.forEach(function (h, i) {
    if (h !== '' && !Object.prototype.hasOwnProperty.call(record, h)) record[h] = row[i];
  });
  Object.defineProperty(record, '_rowNumber', { value: rowNumber, enumerable: false, writable: true });
  Object.defineProperty(record, '_raw', { value: row.slice(), enumerable: false, writable: true });
  return record;
}

/** セルに書き込む値にする（null や undefined は空欄、数値は文字列） */
function toCellValue_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value;
}

/**
 * 複数行をまとめて末尾に追加する（setValues 1回）。
 * objects の各要素は { 見出し名: 値 } の形。定義にない見出しの列は空欄になります。
 */
function appendRecords_(sheetName, objects) {
  if (!objects.length) return [];
  const table = readTable_(sheetName);
  const rows = objects.map(function (obj) {
    return table.headers.map(function (h) {
      return h !== '' && Object.prototype.hasOwnProperty.call(obj, h) ? toCellValue_(obj[h]) : '';
    });
  });
  const startRow = table.sheet.getLastRow() + 1;
  const range = table.sheet.getRange(startRow, 1, rows.length, table.headers.length);
  range.setNumberFormat('@'); // 書式なしテキストとして保存
  range.setValues(rows);

  const created = rows.map(function (row, i) { return makeRecord_(table.headers, row, startRow + i); });
  created.forEach(function (r) { table.records.push(r); });
  return created;
}

function appendRecord_(sheetName, obj) {
  return appendRecords_(sheetName, [obj])[0];
}

/**
 * 1行の一部の列を書き換える。
 * 変更する列が離れていても、間の列が文字列か空欄ならまとめて1回で書き込みます。
 * （間に日付や数値のセルがあるときは、その値を変えないよう分けて書き込みます）
 */
function updateRecord_(sheetName, record, changes) {
  const table = readTable_(sheetName);
  const names = Object.keys(changes);
  if (!names.length) return record;

  const raw = record._raw;
  const indexes = [];
  names.forEach(function (name) {
    const idx = table.columnIndex[name];
    if (idx === undefined) fail_('「' + sheetName + '」シートに「' + name + '」列がありません');
    const value = toCellValue_(changes[name]);
    record[name] = value;
    raw[idx] = value;
    if (indexes.indexOf(idx) === -1) indexes.push(idx);
  });
  indexes.sort(function (a, b) { return a - b; });

  const writeSpan = function (start, end) {
    const range = table.sheet.getRange(record._rowNumber, start + 1, 1, end - start + 1);
    range.setNumberFormat('@');
    range.setValues([raw.slice(start, end + 1)]);
  };
  let start = indexes[0];
  let end = indexes[0];
  for (let k = 1; k < indexes.length; k++) {
    let canBridge = true;
    for (let j = end + 1; j < indexes[k]; j++) {
      if (typeof raw[j] !== 'string') { canBridge = false; break; }
    }
    if (canBridge) {
      end = indexes[k];
    } else {
      writeSpan(start, end);
      start = indexes[k];
      end = indexes[k];
    }
  }
  writeSpan(start, end);
  return record;
}

/**
 * たくさんの行の、決まった列だけをまとめて書き込む（再計算など）。
 * 変更は updateRecordInMemory_ で先に反映しておき、最後にこの関数で1回だけ書き込みます。
 */
function writeColumnsInBulk_(sheetName, columnNames) {
  const table = readTable_(sheetName);
  if (!table.records.length) return;
  const indexes = columnNames.map(function (name) { return table.columnIndex[name]; });
  const minIdx = Math.min.apply(null, indexes);
  const maxIdx = Math.max.apply(null, indexes);
  const firstRow = table.records[0]._rowNumber;
  const lastRow = table.records[table.records.length - 1]._rowNumber;

  const byRow = {};
  table.records.forEach(function (r) { byRow[r._rowNumber] = r; });
  const values = [];
  for (let row = firstRow; row <= lastRow; row++) {
    const record = byRow[row];
    const line = [];
    for (let c = minIdx; c <= maxIdx; c++) line.push(record && record._raw[c] !== undefined ? record._raw[c] : '');
    values.push(line);
  }
  table.sheet.getRange(firstRow, minIdx + 1, values.length, maxIdx - minIdx + 1).setValues(values);
}

/** シートには書かずに、読み込んだ内容だけを書き換える（writeColumnsInBulk_ とセットで使う） */
function updateRecordInMemory_(sheetName, record, changes) {
  const table = readTable_(sheetName);
  Object.keys(changes).forEach(function (name) {
    const value = toCellValue_(changes[name]);
    record[name] = value;
    record._raw[table.columnIndex[name]] = value;
  });
}

/** 条件に合う行を探す */
function findRecords_(sheetName, predicate) {
  return readTable_(sheetName).records.filter(predicate);
}
