'use strict';
// 社労士提出用Excel（社員別シート・.xlsx）のテスト。出力した .xlsx を ZIP として開き、中の XML を直接確かめる。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const MITSUYAMA = 'hiroki@example.com'; // 役員・admin（勤怠集計 対象外）
const INOKURA = 'atsushi@example.com';  // 役員・staff（勤怠集計 対象外）
const OMORI = 'sachiko@example.com';    // フレックス
const MURATA = 'kiyoko@example.com';    // フレックス
const NAKATSUI = 'yuuki@example.com';   // 固定勤務
const KUBO = 'ayumi@example.com';       // 固定勤務
const NOW = '2026-10-15 20:00';

function office(extraStaff) {
  const gas = createLeafGas({ email: MITSUYAMA });
  gas.g.setupSystem();
  const base = { '在籍状況': '在籍', '雇用区分': '正社員', '有給申請対象': '対象', '休日出勤申請対象': '対象' };
  gas.g.appendRecords_('スタッフマスタ', [
    { ...base, '社員ID': 'E001', '氏名': '光山大樹', 'メールアドレス': MITSUYAMA, '権限': 'admin', '勤務区分': '固定勤務', '部署': '管理', '勤怠集計対象': '対象外', '有給申請対象': '対象外', '休日出勤申請対象': '対象外' },
    { ...base, '社員ID': 'E002', '氏名': '猪倉厚', 'メールアドレス': INOKURA, '権限': 'staff', '勤務区分': '固定勤務', '部署': '管理', '勤怠集計対象': '対象外', '有給申請対象': '対象外', '休日出勤申請対象': '対象外' },
    { ...base, '社員ID': 'E003', '氏名': '大森紗智子', 'メールアドレス': OMORI, '権限': 'staff', '勤務区分': 'フレックス', '部署': '一般' },
    { ...base, '社員ID': 'E004', '氏名': '村田清子', 'メールアドレス': MURATA, '権限': 'staff', '勤務区分': 'フレックス', '部署': '一般' },
    { ...base, '社員ID': 'E005', '氏名': '中津井祐貴', 'メールアドレス': NAKATSUI, '権限': 'staff', '勤務区分': '固定勤務', '部署': '一般' },
    { ...base, '社員ID': 'E006', '氏名': '久保亜弓', 'メールアドレス': KUBO, '権限': 'staff', '勤務区分': '固定勤務', '部署': '一般' },
  ].concat((extraStaff || []).map((s) => ({ ...base, '部署': '一般', '権限': 'staff', ...s }))));
  const settings = gas.main.getSheetByName('設定');
  settings.data.find((r) => r[0] === '自動休憩_適用開始')[1] = '06:00';
  settings.data.find((r) => r[0] === '日報_未提出判定開始日')[1] = '2026-01-01';
  gas.g.clearTableCache_();
  gas.setNow(NOW);
  return gas;
}
function run(gas, email, date, steps) {
  gas.loginAs(email);
  for (const [time, fn, arg] of steps) {
    gas.setNow(date + ' ' + time);
    const r = arg === undefined ? gas.g[fn]() : gas.g[fn](arg);
    assert.equal(r.success, true, date + ' ' + time + ' ' + fn + '：' + r.message);
  }
  gas.setNow(NOW);
}
const work = (gas, email, date, from, to) => run(gas, email, date, [[from, 'clockIn', '出社'], [to, 'clockOut']]);
const asAdmin = (gas) => { gas.loginAs(MITSUYAMA); gas.setNow(NOW); };
const snapshot = (gas) => JSON.stringify(gas.main.sheets.map((s) => [s.getName(), s.data]));

// ------------------------------------------------------------ .xlsx（ZIP）を開く

/** ZIP の中身：パス → 文字列（中央ディレクトリから読む。deflate と無圧縮に対応） */
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'ZIP の終端がある');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lp = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.slice(lp, lp + size);
    files[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** シートの XML → { cells: { 'A1': { v, s, t } }, rows: { 1: ['A1', ...] }, merges, xml } */
function parseSheet(xml) {
  const cells = {};
  const rows = {};
  for (const m of xml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = m[1] + m[2];
    const s = Number((m[3].match(/s="(\d+)"/) || [])[1] || 0);
    const t = (m[3].match(/t="(\w+)"/) || [])[1] || '';
    const inner = m[4] || '';
    let v = '';
    if (t === 'inlineStr') v = (inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    else if (/<v>/.test(inner)) v = Number(inner.match(/<v>([^<]*)<\/v>/)[1]);
    cells[ref] = { v, s, t };
    (rows[m[2]] = rows[m[2]] || []).push(ref);
  }
  const merges = [...xml.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((m) => m[1]);
  return { cells, rows, merges, xml };
}

function exportBook(gas, month) {
  asAdmin(gas);
  const res = gas.g.exportSharoushiTimecardXlsx(month || '2026-10');
  assert.equal(res.success, true, res.message);
  const buf = Buffer.from(res.data.base64, 'base64');
  const files = unzip(buf);
  const names = [...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)" sheetId="(\d+)"/g)].map((m) => m[1]);
  const sheets = {};
  names.forEach((n, i) => { sheets[n] = parseSheet(files['xl/worksheets/sheet' + (i + 1) + '.xml']); });
  return { res, buf, files, names, sheets };
}
const val = (sh, ref) => (sh.cells[ref] ? sh.cells[ref].v : undefined);
const rowValues = (sh, r) => (sh.rows[r] || []).map((ref) => sh.cells[ref].v);
/** 見出し行（5行目）の列名 → 列記号 */
const columns = (sh) => Object.fromEntries((sh.rows[5] || []).map((ref) => [sh.cells[ref].v, ref.replace(/\d+/, '')]));
const minutes = (v) => Math.round(v * 1440);
const HEADER_ROW = 5;
const FIRST_DAY_ROW = 6;
const TOTAL_ROW = FIRST_DAY_ROW + 31;
const STYLE = { header: 3, text: 4, time: 5, textLeave: 6, timeLeave: 7, undecided: 8, totalText: 9, totalTime: 10, undecidedHeader: 11 };

// ============================================================ 1〜7 シート・形式・期間・合計・対象者

test('Excel①⑦：勤怠集計対象の社員だけ1人1シート（役員など対象外は出さない）。シート名は氏名。本物の .xlsx（ZIP）', () => {
  const gas = office();
  const { res, buf, files, names } = exportBook(gas);
  assert.equal(res.data.fileName, '社労士提出用タイムカード_2026-10.xlsx');
  assert.equal(res.data.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(buf.slice(0, 2).toString('latin1'), 'PK', 'CSV ではなく ZIP（.xlsx）');
  assert.deepEqual(names, ['大森紗智子', '村田清子', '中津井祐貴', '久保亜弓']);
  assert.deepEqual(res.data.sheetNames, names);
  assert.ok(!names.some((n) => /光山|猪倉/.test(n)), '勤怠集計対象外は出さない');
  for (const p of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml']) assert.ok(files[p], p);
  assert.equal(Object.keys(files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).length, 4);
  assert.match(files['[Content_Types].xml'], /spreadsheetml\.sheet\.main\+xml/);
});

test('Excel②③：固定勤務は A形式（遅刻・早退・社内超過あり）、フレックスは B形式（遅刻・早退・社内超過なし、フレックスの月集計つき）', () => {
  const gas = office();
  const { sheets } = exportBook(gas);
  const a = sheets['中津井祐貴'];
  const b = sheets['大森紗智子'];
  assert.match(val(a, 'A1'), /A形式・固定勤務/);
  assert.equal(val(a, 'I2'), '固定勤務（A形式）');
  assert.deepEqual(rowValues(a, HEADER_ROW), ['日付', '曜日', '出勤時刻', '退勤時刻', '中断', '自動休憩', '実働', '会社時間', '在宅時間', '遅刻', '早退', '社内超過',
    '休日出勤', '休日出勤時間', '有給種別', '有給時間', '出張', '直行', '直帰', '勤務区間', '備考・要確認の理由', '法定時間外（未確定）', '深夜（未確定）', '法定休日（未確定）']);
  assert.match(val(b, 'A1'), /B形式・フレックス/);
  assert.equal(val(b, 'I2'), 'フレックス（B形式）');
  assert.deepEqual(rowValues(b, HEADER_ROW), ['日付', '曜日', '出勤時刻', '退勤時刻', '中断', '自動休憩', '会社時間', '在宅時間', '実働',
    '休日出勤', '休日出勤時間', '有給種別', '有給時間', '出張', '直行', '直帰', '勤務区間', '備考・要確認の理由', '法定時間外（未確定）', '深夜（未確定）', '法定休日（未確定）']);
  // B形式：合計行の下にフレックスの月集計（有給算入は「未確定」）
  const flexRow = Object.keys(b.rows).find((r) => val(b, 'A' + r) === '月所定');
  assert.ok(flexRow, 'フレックスの月集計がある');
  assert.deepEqual(rowValues(b, flexRow), ['月所定', '実働', '有給', '残り', '超過', '有給算入状態']);
  const next = String(Number(flexRow) + 1);
  assert.equal(minutes(val(b, 'A' + next)), 138 * 60, '月所定 138:00');
  assert.equal(val(b, 'F' + next), '未確定');
  assert.ok(!Object.values(a.cells).some((c) => c.v === '月所定'), 'A形式にはフレックスの月集計を出さない');
});

test('Excel④⑤⑥：対象期間は 21日〜翌20日（20日締め）。勤務のない日も全日1行・31行の枠・各シートに合計行', () => {
  const gas = office();
  work(gas, NAKATSUI, '2026-09-20', '09:30', '18:30'); // 9月分（入らない）
  work(gas, NAKATSUI, '2026-09-21', '09:30', '18:30');
  work(gas, NAKATSUI, '2026-10-20', '09:30', '18:30');
  work(gas, NAKATSUI, '2026-10-21', '09:30', '18:30'); // 11月分（入らない）
  const { sheets, names } = exportBook(gas);
  const a = sheets['中津井祐貴'];
  assert.deepEqual(rowValues(a, 2), ['社員ID', 'E005', '', '氏名', '中津井祐貴', '', '', '勤務区分', '固定勤務（A形式）', '', '', '']);
  assert.deepEqual(rowValues(a, 3).filter((v) => v !== ''), ['対象月', '2026年10月分', '対象期間', '2026/09/21～2026/10/20', '締め日', '20日締め']);
  assert.ok(a.merges.includes('B2:C2') && a.merges.includes('E3:G3'));
  const dates = [];
  for (let r = FIRST_DAY_ROW; r < FIRST_DAY_ROW + 31; r++) dates.push(val(a, 'A' + r));
  assert.equal(dates[0], '9/21');
  assert.equal(dates[29], '10/20');
  assert.equal(dates[30], '', '30日の期間の31行目は空欄の枠');
  assert.equal(a.cells['A' + (FIRST_DAY_ROW + 30)].s, STYLE.text, '空欄の行も罫線あり');
  assert.equal(dates.filter((d) => d).length, 30, '勤務のない日（土日・休み）も1行');
  assert.equal(val(a, 'B' + (FIRST_DAY_ROW + 5)), '土', '9/26（土）も出す');
  assert.equal(val(a, 'C' + FIRST_DAY_ROW) * 1440, 9 * 60 + 30, '9/21 の出勤 09:30（時刻の数値）');
  assert.equal(a.cells['C' + FIRST_DAY_ROW].s, STYLE.time);
  assert.ok(!dates.includes('9/20') && !dates.includes('10/21'));
  for (const n of names) {
    const sh = sheets[n];
    assert.equal(val(sh, 'A' + TOTAL_ROW), '合計', n + ' に合計行');
    assert.equal(sh.cells['A' + TOTAL_ROW].s, STYLE.totalText, '合計行は太字');
  }
  const col = columns(a);
  assert.equal(val(a, col['出勤時刻'] + TOTAL_ROW), '出勤2日');
  assert.equal(minutes(val(a, col['実働'] + TOTAL_ROW)), 16 * 60);
  assert.equal(a.cells[col['実働'] + TOTAL_ROW].s, STYLE.totalTime, '合計の時間は [h]:mm');
  assert.equal(val(a, col['備考・要確認の理由'] + TOTAL_ROW), '要確認 1日', '9/21 は日報未提出');
  assert.equal(val(a, col['備考・要確認の理由'] + FIRST_DAY_ROW), '日報未提出');
  // 2月分（1/21〜2/20）は31日 → 31行すべて日付
  const feb = exportBook(gas, '2027-02').sheets['中津井祐貴'];
  assert.equal(val(feb, 'A' + FIRST_DAY_ROW), '1/21');
  assert.equal(val(feb, 'A' + (FIRST_DAY_ROW + 30)), '2/20');
  assert.equal(val(feb, 'A' + TOTAL_ROW), '合計');
});

test('Excel⑦：勤務区分が固定勤務・フレックス以外（マスタにない区分）の人は出さず、メッセージで知らせる', () => {
  const gas = office([{ '社員ID': 'E007', '氏名': '区分なし太郎', 'メールアドレス': 'none@example.com', '勤務区分': 'パート' }]);
  const { res, names } = exportBook(gas);
  assert.ok(!names.includes('区分なし太郎'));
  assert.deepEqual(res.data.skipped, [{ employeeId: 'E007', name: '区分なし太郎', workType: 'パート' }]);
  assert.match(res.message, /出さなかった人：区分なし太郎/);
});

// ============================================================ 8〜11 中身

test('Excel⑧：複数の勤務区間はすべて残す（最初の2区間だけにしない）。有給の日は薄い黄色・休日出勤・備考', () => {
  const gas = office();
  // 会社 9:00〜10:00 → 中断 → 在宅 10:30〜12:00 → 退勤 → 在宅 13:00〜14:00 → 退勤 → 会社 15:00〜18:00
  run(gas, NAKATSUI, '2026-10-01', [['09:00', 'clockIn', '出社'], ['10:00', 'startBreak', ''], ['10:30', 'resumeWork', '在宅'], ['12:00', 'clockOut'],
    ['13:00', 'clockIn', '在宅'], ['14:00', 'clockOut'], ['15:00', 'clockIn', '出社'], ['18:00', 'clockOut']]);
  gas.loginAs(NAKATSUI); gas.setNow('2026-10-01 20:00');
  const pl = gas.g.submitPaidLeaveRequest({ date: '2026-10-07', leaveType: '1日有給', reason: '私用' }).data.requestId;
  asAdmin(gas);
  assert.equal(gas.g.approvePaidLeaveRequest(pl).success, true);
  const { sheets } = exportBook(gas);
  const a = sheets['中津井祐貴'];
  const col = columns(a);
  const r1 = FIRST_DAY_ROW + 10; // 10/1
  assert.equal(val(a, 'A' + r1), '10/1');
  assert.equal(val(a, col['勤務区間'] + r1), '会社 09:00〜10:00／在宅 10:30〜12:00／在宅 13:00〜14:00／会社 15:00〜18:00');
  assert.equal(minutes(val(a, col['中断'] + r1)), 30);
  const r7 = FIRST_DAY_ROW + 16; // 10/7
  assert.equal(val(a, 'A' + r7), '10/7');
  assert.equal(val(a, col['有給種別'] + r7), '1日有給');
  assert.equal(minutes(val(a, col['有給時間'] + r7)), 8 * 60);
  assert.equal(a.cells['A' + r7].s, STYLE.textLeave, '有給の日は薄い黄色');
  assert.equal(a.cells[col['有給時間'] + r7].s, STYLE.timeLeave);
  assert.equal(val(a, col['有給種別'] + TOTAL_ROW), '1日', '合計行の有給種別の列＝有給日数');
  assert.match(a.xml, /<c r="[A-Z]+\d+" s="7"/, '薄い黄色の時刻の書式');
  assert.match(sheets['中津井祐貴'].xml, /orientation="landscape" fitToWidth="1" fitToHeight="0"/, 'A4横・1ページ幅');
});

test('Excel⑨⑩：法定時間外・深夜・法定休日（未確定）は全行空欄。社内超過は社内超過の列だけで、法定時間外には入れない', () => {
  const gas = office();
  run(gas, NAKATSUI, '2026-10-01', [['09:00', 'clockIn', '出社'], ['12:00', 'startBreak', ''], ['12:30', 'resumeWork', '在宅'], ['23:00', 'clockOut']]);
  run(gas, OMORI, '2026-10-02', [['08:00', 'clockIn', '出社'], ['23:30', 'clockOut']]);
  const { sheets, names } = exportBook(gas);
  const a = sheets['中津井祐貴'];
  const col = columns(a);
  const r1 = FIRST_DAY_ROW + 10;
  assert.equal(minutes(val(a, col['社内超過'] + r1)), 4 * 60 + 30, '社内超過 18:30〜23:00');
  assert.equal(minutes(val(a, col['実働'] + r1)), 12 * 60 + 30);
  for (const n of names) {
    const sh = sheets[n];
    const c = columns(sh);
    for (const h of ['法定時間外（未確定）', '深夜（未確定）', '法定休日（未確定）']) {
      assert.equal(sh.cells[c[h] + HEADER_ROW].s, STYLE.undecidedHeader, '未確定の見出しは薄いグレー');
      for (let r = FIRST_DAY_ROW; r <= TOTAL_ROW; r++) {
        const cell = sh.cells[c[h] + r];
        assert.deepEqual([cell.v, cell.s], ['', STYLE.undecided], n + ' ' + h + ' ' + r + '行目は空欄（薄いグレー）');
      }
    }
  }
  assert.ok(!/<f>/.test(Object.values(sheets).map((s) => s.xml).join('')), '数式は入れない');
});

test('Excel⑪：給与の項目（基本給・等級手当・残業単価・残業手当・深夜手当・休日出勤手当・通勤手当・給与合計額）は出さない', () => {
  const gas = office();
  work(gas, NAKATSUI, '2026-10-01', '09:30', '20:00');
  const { files } = exportBook(gas);
  const all = Object.values(files).join('');
  for (const word of ['基本給', '等級手当', '残業単価', '残業手当', '深夜手当', '休日出勤手当', '通勤手当', '給与合計', '手当', '単価', '時給', '金額', '円']) {
    assert.ok(!all.includes(word), word + ' を含まない');
  }
  assert.ok(!/交通費|業務走行距離|メールアドレス|@example\.com/.test(all), '不要な個人情報・交通費は出さない');
});

// ============================================================ 12〜15 権限・読み取りだけ・後片付け・CSV

test('Excel⑫：一般スタッフは実行できない（管理者だけ）。スタッフ画面の関数一覧にもない', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const r = gas.g.exportSharoushiTimecardXlsx('2026-10');
  assert.deepEqual([r.success, /管理者権限がありません/.test(r.message), r.data], [false, true, null]);
  const src = fs.readFileSync(path.join(__dirname, '../leaf-portal/gas/AdminMonthlyService.gs'), 'utf8');
  const start = src.indexOf('function exportSharoushiTimecardXlsx(');
  assert.match(src.slice(start, src.indexOf('\n}\n', start)), /requireAdmin\(\)/);
  const html = gas.g.doGet({ parameter: {} }).getContent();
  const staffList = JSON.parse(html.match(/HW_FUNCTIONS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  assert.ok(!staffList.includes('exportSharoushiTimecardXlsx'));
  const adminList = JSON.parse(html.match(/ADMIN_FUNCTIONS = (\[[\s\S]*?\])/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  assert.ok(adminList.includes('exportSharoushiTimecardXlsx'));
});

test('Excel⑬⑭：元のシートは1文字も変わらず、一時ファイル（スプレッドシート・ドライブ）も作らない', () => {
  const gas = office();
  work(gas, NAKATSUI, '2026-10-01', '09:30', '19:30');
  asAdmin(gas);
  const before = snapshot(gas);
  const books = gas.books.size;
  exportBook(gas);
  exportBook(gas, '2026-09');
  assert.equal(snapshot(gas), before, 'シートは変わらない');
  assert.equal(gas.books.size, books, 'スプレッドシートを新しく作らない');
  const src = ['XlsxWriter.gs', 'AdminMonthlyService.gs'].map((f) => fs.readFileSync(path.join(__dirname, '../leaf-portal/gas', f), 'utf8')).join('\n');
  assert.ok(!/DriveApp|SpreadsheetApp\.create|Drive\.Files/.test(src), 'ドライブに一時ファイルを作るコードがない');
});

test('Excel⑮：既存の社労士確認用の詳細表（CSV）はそのまま使える', () => {
  const gas = office();
  work(gas, NAKATSUI, '2026-10-01', '09:30', '18:30');
  asAdmin(gas);
  const res = gas.g.exportSharoushiDetailCsv('2026-10');
  assert.equal(res.success, true, res.message);
  assert.equal(res.data.fileName, 'sharoushi_check_2026-10.csv');
  const lines = res.data.csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines.length, 1 + 4 * (30 + 1));
  assert.match(lines[0], /^社員ID,氏名,勤務区分,日付,/);
});

// ============================================================ シート名・書式

test('シート名：同じ氏名は社員IDを付けて区別。使えない文字は全角に、31文字まで、重ならない', () => {
  const gas = office([
    { '社員ID': 'E008', '氏名': '中津井祐貴', 'メールアドレス': 'yuuki2@example.com', '勤務区分': '固定勤務' },
    { '社員ID': 'E009', '氏名': 'A/B:C*D?[E]', 'メールアドレス': 'sym@example.com', '勤務区分': 'フレックス' },
  ]);
  const { names } = exportBook(gas);
  assert.ok(names.includes('中津井祐貴') && names.includes('中津井祐貴（E008）'));
  assert.ok(names.includes('A／B：C＊D？［E］'));
  const used = {};
  const long = 'あ'.repeat(40);
  const n1 = gas.g.xlsxSheetName_(long, 'E100', used);
  const n2 = gas.g.xlsxSheetName_(long, 'E101', used);
  const n3 = gas.g.xlsxSheetName_('', '', used);
  const n4 = gas.g.xlsxSheetName_('', '', used);
  assert.deepEqual([n1.length, n2.length], [31, 31]);
  assert.ok(n2.endsWith('（E101）'));
  assert.deepEqual([n3, n4], ['シート', 'シート（2）']);
  assert.equal(gas.g.xlsxSheetName_('abc', 'X', { abc: true }), 'abc（X）', '大文字小文字だけ違う名前も重なりとみなす');
});

test('書式：見出しは薄い緑・時刻 hh:mm・合計 [h]:mm・どのシートも同じ列は同じ幅', () => {
  const gas = office();
  const { files, sheets } = exportBook(gas);
  const styles = files['xl/styles.xml'];
  assert.match(styles, /<numFmt numFmtId="164" formatCode="hh:mm"\/><numFmt numFmtId="165" formatCode="\[h\]:mm"\/>/);
  assert.match(styles, /FFE2EFDA/, '見出しの薄い緑');
  assert.match(styles, /FFFFF2CC/, '有給の薄い黄色');
  assert.match(styles, /FFE7E6E6/, '未確定の薄いグレー');
  const a = sheets['中津井祐貴'];
  assert.equal(a.cells['A' + HEADER_ROW].s, STYLE.header);
  const widths = (sh) => [...sh.xml.matchAll(/<col min="\d+" max="\d+" width="([\d.]+)"/g)].map((m) => m[1]).join(',');
  assert.equal(widths(sheets['中津井祐貴']), widths(sheets['久保亜弓']));
  assert.equal(widths(sheets['大森紗智子']), widths(sheets['村田清子']));
  assert.match(a.xml, /paperSize="9"/, 'A4');
});
