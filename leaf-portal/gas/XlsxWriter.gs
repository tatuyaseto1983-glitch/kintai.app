/**
 * XlsxWriter.gs
 * ------------------------------------------------------------
 * 小さな .xlsx（Office Open XML）を作ります。Googleドライブに一時ファイルを作らず、XML を Utilities.zip でまとめるだけです
 * （ドライブの権限も不要。元の勤怠シートには一切書き込みません）。数式は入れず、値と書式だけを入れます。
 *
 *   buildXlsxBlob_(sheets, fileName) … ブックの Blob（MIME：XLSX_MIME_TYPE）
 *     sheets: [{ name, widths: [列幅...], rows: [[セル...], ...], merges: ['B2:C2', ...], rowHeights: [高さ...], landscape: true }]
 *     セル:   null（空）／{ v: 文字または数値, s: 書式名 }／{ s: 書式名 }（値なし・罫線だけ）
 *     時刻・時間は xlsxTimeValue_('08:23') の数値（1日＝1）で入れ、書式で hh:mm／[h]:mm と表示する
 */

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 書式名 → styles.xml の cellXfs の番号（styles.xml の並びと同じ） */
const XLSX_STYLE = {
  plain: 0,
  title: 1,        // 太字・大きめ
  label: 2,        // 太字（上部の項目名）
  header: 3,       // 見出し：薄い緑・太字・罫線・折り返し
  text: 4,         // 日別：文字・罫線
  time: 5,         // 日別：時刻 hh:mm・罫線
  textLeave: 6,    // 有給の日：文字・薄い黄色
  timeLeave: 7,    // 有給の日：時刻・薄い黄色
  undecided: 8,    // 未確定の列：薄いグレー・罫線
  totalText: 9,    // 合計行：文字・太字・罫線
  totalTime: 10,   // 合計行：時間 [h]:mm・太字・罫線
  undecidedHeader: 11, // 未確定の列の見出し：薄いグレー・太字・罫線
  note: 12,        // 注意書き（折り返し）
  value: 13,       // 上部の値・集計欄の文字（罫線）
  valueTime: 14,   // 集計欄の時間 [h]:mm（罫線）
};

/** 'HH:mm'（24時間を超える '138:00' も可）→ Excel の時間の数値（1日＝1）。空・読めない値は null */
function xlsxTimeValue_(text) {
  const m = String(text === null || text === undefined ? '' : text).trim().match(/^(\d{1,4}):(\d{2})$/);
  if (!m) return null;
  return (Number(m[1]) * 60 + Number(m[2])) / 1440;
}

/** 1 → 'A'、27 → 'AA' */
function xlsxColumnName_(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** XML の文字（制御文字は除く） */
function xlsxEscape_(value) {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Excel のシート名にする（31文字まで・使えない文字 \ / ? * [ ] : は全角に・前後の ' を除く）。
 * used（小文字にした使用済みの名前）と重ならないよう、重なったら suffix（社員IDなど）を付ける。
 */
function xlsxSheetName_(name, suffix, used) {
  const clean = function (s) {
    return String(s || '').replace(/[\\\/?*\[\]:]/g, function (c) { return { '\\': '￥', '/': '／', '?': '？', '*': '＊', '[': '［', ']': '］', ':': '：' }[c]; })
      .replace(/[\u0000-\u001F]/g, '').trim().replace(/^'+|'+$/g, '');
  };
  const fit = function (base, tail) { return (base.slice(0, 31 - tail.length) + tail).trim(); };
  let result = fit(clean(name) || 'シート', '');
  if (used[result.toLowerCase()] && suffix) result = fit(clean(name) || 'シート', '（' + clean(suffix) + '）');
  for (let i = 2; used[result.toLowerCase()]; i++) result = fit(clean(name) || 'シート', '（' + (suffix ? clean(suffix) + '-' : '') + i + '）');
  used[result.toLowerCase()] = true;
  return result;
}

/** シート1枚の XML */
function xlsxSheetXml_(sheet) {
  const rows = sheet.rows || [];
  const widths = sheet.widths || [];
  const maxCol = rows.reduce(function (m, r) { return Math.max(m, r.length); }, widths.length || 1);
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
  out.push('<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
  out.push('<dimension ref="A1:' + xlsxColumnName_(maxCol) + Math.max(1, rows.length) + '"/>');
  out.push('<sheetViews><sheetView workbookViewId="0" zoomScale="90"/></sheetViews>');
  out.push('<sheetFormatPr defaultRowHeight="15"/>');
  if (widths.length) {
    out.push('<cols>' + widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols>');
  }
  out.push('<sheetData>');
  rows.forEach(function (row, ri) {
    const r = ri + 1;
    const cells = [];
    row.forEach(function (cell, ci) {
      if (!cell) return;
      const ref = xlsxColumnName_(ci + 1) + r;
      const s = XLSX_STYLE[cell.s] === undefined ? 0 : XLSX_STYLE[cell.s];
      const v = cell.v;
      if (v === null || v === undefined || v === '') {
        if (s) cells.push('<c r="' + ref + '" s="' + s + '"/>');
      } else if (typeof v === 'number' && isFinite(v)) {
        cells.push('<c r="' + ref + '" s="' + s + '"><v>' + v + '</v></c>');
      } else {
        cells.push('<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + xlsxEscape_(v) + '</t></is></c>');
      }
    });
    const height = sheet.rowHeights && sheet.rowHeights[ri] ? ' ht="' + sheet.rowHeights[ri] + '" customHeight="1"' : '';
    out.push('<row r="' + r + '"' + height + '>' + cells.join('') + '</row>');
  });
  out.push('</sheetData>');
  if (sheet.merges && sheet.merges.length) {
    out.push('<mergeCells count="' + sheet.merges.length + '">' + sheet.merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>');
  }
  out.push('<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>');
  out.push('<pageSetup paperSize="9" orientation="' + (sheet.landscape === false ? 'portrait' : 'landscape') + '" fitToWidth="1" fitToHeight="0"/>');
  out.push('</worksheet>');
  return out.join('');
}

/** 書式（styles.xml）。XLSX_STYLE の番号と同じ並び */
function xlsxStylesXml_() {
  const border = 'borderId="1" applyBorder="1"';
  const xf = function (attrs, inner) { return '<xf ' + attrs + (inner ? '>' + inner + '</xf>' : '/>'); };
  const center = '<alignment horizontal="center" vertical="center"/>';
  const wrapCenter = '<alignment horizontal="center" vertical="center" wrapText="1"/>';
  const wrapLeft = '<alignment vertical="top" wrapText="1"/>';
  const left = '<alignment vertical="center" wrapText="1"/>';
  const xfs = [
    xf('numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"'),                                                         // 0 plain
    xf('numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"'),                                         // 1 title
    xf('numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"'),                                         // 2 label
    xf('numFmtId="0" fontId="1" fillId="2" ' + border + ' xfId="0" applyFont="1" applyFill="1" applyAlignment="1"', wrapCenter), // 3 header
    xf('numFmtId="0" fontId="0" fillId="0" ' + border + ' xfId="0" applyAlignment="1"', left),                            // 4 text
    xf('numFmtId="164" fontId="0" fillId="0" ' + border + ' xfId="0" applyNumberFormat="1" applyAlignment="1"', center),   // 5 time
    xf('numFmtId="0" fontId="0" fillId="3" ' + border + ' xfId="0" applyFill="1" applyAlignment="1"', left),              // 6 textLeave
    xf('numFmtId="164" fontId="0" fillId="3" ' + border + ' xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"', center), // 7 timeLeave
    xf('numFmtId="0" fontId="0" fillId="4" ' + border + ' xfId="0" applyFill="1"'),                                       // 8 undecided
    xf('numFmtId="0" fontId="1" fillId="0" ' + border + ' xfId="0" applyFont="1" applyAlignment="1"', center),           // 9 totalText
    xf('numFmtId="165" fontId="1" fillId="0" ' + border + ' xfId="0" applyNumberFormat="1" applyFont="1" applyAlignment="1"', center), // 10 totalTime
    xf('numFmtId="0" fontId="1" fillId="4" ' + border + ' xfId="0" applyFont="1" applyFill="1" applyAlignment="1"', wrapCenter), // 11 undecidedHeader
    xf('numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"', wrapLeft),                         // 12 note
    xf('numFmtId="0" fontId="0" fillId="0" ' + border + ' xfId="0" applyAlignment="1"', left),                            // 13 value
    xf('numFmtId="165" fontId="0" fillId="0" ' + border + ' xfId="0" applyNumberFormat="1" applyAlignment="1"', center),  // 14 valueTime
  ];
  const fill = function (rgb) { return '<fill><patternFill patternType="solid"><fgColor rgb="FF' + rgb + '"/><bgColor indexed="64"/></patternFill></fill>'; };
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="hh:mm"/><numFmt numFmtId="165" formatCode="[h]:mm"/></numFmts>' +
    '<fonts count="3"><font><sz val="10"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font>' +
    '<font><b/><sz val="10"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font>' +
    '<font><b/><sz val="14"/><name val="Meiryo UI"/><family val="3"/><charset val="128"/></font></fonts>' +
    '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    fill('E2EFDA') + fill('FFF2CC') + fill('E7E6E6') + '</fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right>' +
    '<top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

/** ブック（.xlsx）の Blob を作る。sheets は1枚以上 */
function buildXlsxBlob_(sheets, fileName) {
  if (!sheets || !sheets.length) fail_('出力するシートがありません');
  const files = [];
  const add = function (path, xml) { files.push(Utilities.newBlob(xml, 'application/xml', path)); };
  add('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
    '</Types>');
  add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>');
  add('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView/></bookViews><sheets>' +
    sheets.map(function (s, i) { return '<sheet name="' + xlsxEscape_(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') +
    '</sheets></workbook>');
  add('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
    '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>');
  add('xl/styles.xml', xlsxStylesXml_());
  sheets.forEach(function (s, i) { add('xl/worksheets/sheet' + (i + 1) + '.xml', xlsxSheetXml_(s)); });
  const zip = Utilities.zip(files, fileName);
  zip.setContentType(XLSX_MIME_TYPE);
  return zip;
}
