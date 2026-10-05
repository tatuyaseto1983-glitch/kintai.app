/**
 * XlsxWriter.gs
 * ------------------------------------------------------------
 * 小さな .xlsx（Office Open XML）を作ります。Googleドライブに一時ファイルを作らず、XML を Utilities.zip でまとめるだけです
 * （ドライブの権限も不要。元の勤怠シートには一切書き込みません）。数式は入れず、値と書式だけを入れます。
 *
 *   buildXlsxBlob_(sheets, fileName) … ブックの Blob（MIME：XLSX_MIME_TYPE）
 *     sheets: [{ name, widths: [列幅...], rows: [[セル...], ...], merges: ['B2:C2', ...], rowHeights: [高さ...], landscape: true,
 *                fitToHeight: 1（1ページの高さに収める。省略時は幅だけ）, printTitleRows: '$1:$3'（印刷で毎ページ繰り返す行） }]
 *     セル:   null（空）／{ v: 文字または数値, s: 書式名 }／{ s: 書式名 }（値なし・罫線だけ）
 *     時刻・時間は xlsxTimeValue_('08:23') の数値（1日＝1）で入れ、書式で hh:mm／[h]:mm と表示する
 */

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 書式名 → styles.xml の cellXfs の番号（xlsxStylesXml_ の並びと同じ） */
const XLSX_STYLE = {
  plain: 0,
  title: 1,           // 太字・大きめ
  label: 2,           // 太字
  header: 3,          // 見出し：薄い緑・罫線・中央・折り返し（元のタイムカードの見出しと同じ色）
  text: 4,            // 日別：文字（左寄せ・折り返し）・罫線
  time: 5,            // 日別：時刻 hh:mm・罫線
  textLeave: 6,       // 有給の日：文字・薄い黄色
  timeLeave: 7,       // 有給の日：時刻・薄い黄色
  undecided: 8,       // 未確定の列：薄いグレー・罫線
  totalText: 9,       // 合計行：文字（中央）・太字・罫線
  totalTime: 10,      // 合計行：時間 [h]:mm・太字・罫線
  undecidedHeader: 11, // 未確定の列の見出し：薄いグレー・罫線
  note: 12,           // 注意書き（折り返し）
  value: 13,          // 集計欄の文字（罫線）
  valueTime: 14,      // 集計欄の時間 [h]:mm（罫線）
  date: 15,           // 日別：日付 m月d日・罫線・中央
  dateLeave: 16,      // 有給の日：日付・薄い黄色
  center: 17,         // 日別：文字（中央）・罫線
  centerLeave: 18,    // 有給の日：文字（中央）・薄い黄色
  subHeader: 19,      // 見出しの2段目：薄い緑・小さめの文字
  undecidedSub: 20,   // 未確定の列の見出しの2段目：薄いグレー・小さめの文字
  totalLeft: 21,      // 合計行：文字（左寄せ）・太字・罫線
  month: 22,          // 1行目：対象月（太字・下線の罫線・中央）
  name: 23,           // 1行目：氏名（太字・大きめ・下線の罫線）
  info: 24,           // 1行目：社員ID・対象期間（下線の罫線）
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
  out.push('<sheetFormatPr defaultRowHeight="13.5"/>');
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
  out.push('<printOptions horizontalCentered="1"/>');
  out.push('<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>');
  out.push('<pageSetup paperSize="9" orientation="' + (sheet.landscape === false ? 'portrait' : 'landscape') + '" fitToWidth="1" fitToHeight="' + (sheet.fitToHeight || 0) + '"/>');
  out.push('</worksheet>');
  return out.join('');
}

/** 書式（styles.xml）。XLSX_STYLE の番号と同じ並び。文字は元のタイムカードと同じ ＭＳ Ｐゴシック */
function xlsxStylesXml_() {
  const xf = function (numFmt, font, fill, border, align) {
    return '<xf numFmtId="' + numFmt + '" fontId="' + font + '" fillId="' + fill + '" borderId="' + border + '" xfId="0"' +
      (numFmt ? ' applyNumberFormat="1"' : '') + (font ? ' applyFont="1"' : '') + (fill ? ' applyFill="1"' : '') + (border ? ' applyBorder="1"' : '') +
      (align ? ' applyAlignment="1"><alignment ' + align + '/></xf>' : '/>');
  };
  const center = 'horizontal="center" vertical="center"';
  const wrapCenter = 'horizontal="center" vertical="center" wrapText="1"';
  const left = 'vertical="center" wrapText="1"';
  const leftOneLine = 'vertical="center"';
  // fonts: 0 標準11 / 1 太字11 / 2 太字14 / 3 標準9 / 4 標準10
  // fills: 2 薄い緑 / 3 薄い黄色 / 4 薄いグレー　borders: 1 四方 / 2 下だけ
  const xfs = [
    xf(0, 0, 0, 0),                 // 0 plain
    xf(0, 2, 0, 0),                 // 1 title
    xf(0, 1, 0, 0),                 // 2 label
    xf(0, 0, 2, 1, wrapCenter),     // 3 header
    xf(0, 4, 0, 1, left),           // 4 text
    xf(164, 0, 0, 1, center),       // 5 time
    xf(0, 4, 3, 1, left),           // 6 textLeave
    xf(164, 0, 3, 1, center),       // 7 timeLeave
    xf(0, 0, 4, 1, center),         // 8 undecided
    xf(0, 1, 0, 1, center),         // 9 totalText
    xf(165, 1, 0, 1, center),       // 10 totalTime
    xf(0, 0, 4, 1, wrapCenter),     // 11 undecidedHeader
    xf(0, 3, 0, 0, 'vertical="top" wrapText="1"'), // 12 note
    xf(0, 0, 0, 1, left),           // 13 value
    xf(165, 0, 0, 1, center),       // 14 valueTime
    xf(166, 0, 0, 1, center),       // 15 date
    xf(166, 0, 3, 1, center),       // 16 dateLeave
    xf(0, 0, 0, 1, center),         // 17 center
    xf(0, 0, 3, 1, center),         // 18 centerLeave
    xf(0, 3, 2, 1, wrapCenter),     // 19 subHeader
    xf(0, 3, 4, 1, wrapCenter),     // 20 undecidedSub
    xf(0, 1, 0, 1, left),           // 21 totalLeft
    xf(0, 1, 0, 2, center),         // 22 month
    xf(0, 2, 0, 2, leftOneLine),    // 23 name
    xf(0, 0, 0, 2, leftOneLine),    // 24 info
  ];
  const font = function (size, bold) {
    return '<font>' + (bold ? '<b/>' : '') + '<sz val="' + size + '"/><name val="ＭＳ Ｐゴシック"/><family val="3"/><charset val="128"/></font>';
  };
  const fill = function (rgb) { return '<fill><patternFill patternType="solid"><fgColor rgb="FF' + rgb + '"/><bgColor indexed="64"/></patternFill></fill>'; };
  const thin = '<color indexed="64"/>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="3"><numFmt numFmtId="164" formatCode="hh:mm"/><numFmt numFmtId="165" formatCode="[h]:mm"/>' +
    '<numFmt numFmtId="166" formatCode="m&quot;月&quot;d&quot;日&quot;"/></numFmts>' +
    '<fonts count="5">' + font(11) + font(11, true) + font(14, true) + font(9) + font(10) + '</fonts>' +
    '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    fill('CCFFCC') + fill('FFF2CC') + fill('E7E6E6') + '</fills>' +
    '<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left style="thin">' + thin + '</left><right style="thin">' + thin + '</right><top style="thin">' + thin + '</top><bottom style="thin">' + thin + '</bottom><diagonal/></border>' +
    '<border><left/><right/><top/><bottom style="thin">' + thin + '</bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

/** 印刷タイトル（各ページの上に繰り返す行。sheet.printTitleRows＝'$1:$3' など） */
function xlsxDefinedNamesXml_(sheets) {
  const names = sheets.map(function (s, i) {
    if (!s.printTitleRows) return '';
    return '<definedName name="_xlnm.Print_Titles" localSheetId="' + i + '">\'' + xlsxEscape_(String(s.name).replace(/'/g, "''")) + '\'!' + s.printTitleRows + '</definedName>';
  }).join('');
  return names ? '<definedNames>' + names + '</definedNames>' : '';
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
    '</sheets>' + xlsxDefinedNamesXml_(sheets) + '</workbook>');
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
