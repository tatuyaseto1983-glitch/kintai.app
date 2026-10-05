'use strict';
// 社労士提出用Excel（社員別シート・.xlsx）のテスト。出力した .xlsx を ZIP として開き、中の XML を直接確かめる。
// 列構成は元の「【改定版】タイムカード」の A形式（固定勤務）／B形式（フレックス）に合わせ、直行・直帰・勤務区間・備考・要確認の理由を足したもの。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
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
const HEADER_ROW = 2;
const SUB_ROW = 3;
const FIRST_DAY_ROW = 4;
const TOTAL_ROW = FIRST_DAY_ROW + 31;
/** 見出し行（2行目）の列名 → 列記号 */
const columns = (sh) => Object.fromEntries((sh.rows[HEADER_ROW] || []).map((ref) => [sh.cells[ref].v, ref.replace(/\d+/, '')]));
const minutes = (v) => Math.round(v * 1440);
const excelDate = (key) => { const [y, m, d] = key.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; };
/** その日付の行番号（10月分：9/21 が4行目） */
const rowOf = (sh, key) => Number(Object.keys(sh.cells).find((ref) => /^A\d+$/.test(ref) && sh.cells[ref].v === excelDate(key)).slice(1));
const STYLE = { header: 3, text: 4, time: 5, textLeave: 6, timeLeave: 7, undecided: 8, totalText: 9, totalTime: 10, undecidedHeader: 11,
  date: 15, dateLeave: 16, center: 17, subHeader: 19, undecidedSub: 20 };
const A_COLUMNS = ['日付', '曜日', '出勤', '退勤', '休憩', '労働時間', '法定時間外', '深夜', '法定内', '休日', '法定休日', '直行', '直帰', '勤務区間', '備考・要確認の理由'];
const B_COLUMNS = ['日付', '曜日', '出勤', '退勤', '在宅開始', '在宅終了', '休憩', '労働1', '労働2', '労働時間', '深夜', '法定時間外', '休日', '出張',
  '直行', '直帰', '勤務区間', '備考・要確認の理由'];
/** 社内管理用で、社労士提出用には出さない項目 */
const INTERNAL_ONLY = ['会社時間', '在宅時間', '遅刻', '早退', '社内超過', '有給種別', '有給時間'];

// ============================================================ ファイル・シート・対象者

test('Excel：1つの .xlsx に勤怠集計対象の社員だけ1人1シート（役員など対象外は出さない）。シート名は氏名。本物の .xlsx（ZIP）', () => {
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

test('Excel：勤務区分が固定勤務・フレックス以外（マスタにない区分）の人は出さず、メッセージで知らせる', () => {
  const gas = office([{ '社員ID': 'E007', '氏名': '区分なし太郎', 'メールアドレス': 'none@example.com', '勤務区分': 'パート' }]);
  const { res, names } = exportBook(gas);
  assert.ok(!names.includes('区分なし太郎'));
  assert.deepEqual(res.data.skipped, [{ employeeId: 'E007', name: '区分なし太郎', workType: 'パート' }]);
  assert.match(res.message, /出さなかった人：区分なし太郎/);
});

// ============================================================ 列構成

test('Excel：固定勤務＝A形式の列（元のタイムカードの基本列＋直行・直帰・勤務区間・備考・要確認の理由）。2段目は未確定・承認済み', () => {
  const gas = office();
  const a = exportBook(gas).sheets['中津井祐貴'];
  assert.deepEqual(rowValues(a, HEADER_ROW), A_COLUMNS);
  const c = columns(a);
  assert.deepEqual(['法定時間外', '深夜', '法定内', '法定休日'].map((h) => val(a, c[h] + SUB_ROW)), ['未確定', '未確定', '未確定', '未確定']);
  assert.equal(val(a, c['休日'] + SUB_ROW), '承認済み');
  assert.ok(a.merges.includes('A2:A3') && a.merges.includes('F2:F3'), '2段目のない列は縦に結合');
  assert.match(val(a, 'H1'), /A形式（固定勤務）/);
  assert.ok(!Object.values(a.cells).some((x) => x.v === '月所定'), 'A形式にはフレックスの月集計を出さない');
});

test('Excel：フレックス＝B形式の列（出勤・退勤・在宅開始・在宅終了・休憩・労働1・労働2…）。下にフレックスの月集計（有給算入＝未確定）', () => {
  const gas = office();
  const b = exportBook(gas).sheets['大森紗智子'];
  assert.deepEqual(rowValues(b, HEADER_ROW), B_COLUMNS);
  const c = columns(b);
  assert.deepEqual([val(b, c['労働1'] + SUB_ROW), val(b, c['労働2'] + SUB_ROW), val(b, c['深夜'] + SUB_ROW), val(b, c['法定時間外'] + SUB_ROW)], ['会社等', '在宅', '未確定', '未確定']);
  assert.match(val(b, 'H1'), /B形式（フレックス）/);
  const flexRow = Object.keys(b.rows).find((r) => val(b, 'A' + r) === '月所定');
  assert.ok(Number(flexRow) > TOTAL_ROW, 'フレックスの月集計は合計行の下');
  assert.deepEqual(rowValues(b, flexRow), ['月所定', '実働', '有給', '残り', '超過', '有給算入状態']);
  const next = String(Number(flexRow) + 1);
  assert.equal(minutes(val(b, 'A' + next)), 138 * 60, '月所定 138:00');
  assert.equal(val(b, 'F' + next), '未確定');
});

test('Excel：社内管理用の項目（会社時間・在宅時間・遅刻・早退・社内超過・有給種別・有給時間）はどのシートにも出さない。社内詳細月次・CSVには残る', () => {
  const gas = office();
  work(gas, NAKATSUI, '2026-10-01', '10:00', '20:00'); // 遅刻・社内超過のある日
  const { sheets, files } = exportBook(gas);
  const all = Object.keys(files).filter((p) => /worksheets/.test(p)).map((p) => files[p]).join('');
  for (const word of INTERNAL_ONLY) {
    assert.ok(!all.includes('>' + word + '<'), word + ' の列はない');
  }
  for (const sh of Object.values(sheets)) {
    const heads = rowValues(sh, HEADER_ROW).concat(rowValues(sh, SUB_ROW));
    assert.ok(!INTERNAL_ONLY.some((w) => heads.includes(w)));
  }
  // 社内用の画面・CSVはそのまま
  const csv = gas.g.exportSharoushiDetailCsv('2026-10');
  assert.match(csv.data.csv, /会社時間,在宅時間/);
  const detail = gas.g.exportAdminEmployeeMonthCsv('E005', '2026-10');
  assert.match(detail.data.csv, /会社時間,在宅時間,遅刻,早退,社内超過,休日出勤,休日出勤時間,有給種別,有給時間/);
  const m = gas.g.getAdminEmployeeMonth('E005', '2026-10').data.days.find((d) => d.date === '2026-10-01');
  assert.deepEqual([m.late, m.internalExcess, m.officeTime], ['00:30', '01:30', '10:00']);
});

// ============================================================ 期間・全日・合計

test('Excel：20日締め（10月分＝9/21〜10/20）。勤務のない日・休日も全日1行（日付は m月d日）、31行の枠、最下部に合計行', () => {
  const gas = office();
  work(gas, NAKATSUI, '2026-09-20', '09:30', '18:30'); // 9月分（入らない）
  work(gas, NAKATSUI, '2026-09-21', '09:30', '18:30');
  work(gas, NAKATSUI, '2026-10-20', '09:30', '18:30');
  work(gas, NAKATSUI, '2026-10-21', '09:30', '18:30'); // 11月分（入らない）
  const { sheets, names, files } = exportBook(gas);
  const a = sheets['中津井祐貴'];
  assert.deepEqual([val(a, 'A1'), val(a, 'C1'), val(a, 'F1')], ['2026年10月分', '中津井祐貴', '社員ID：E005']);
  assert.match(val(a, 'H1'), /対象期間：2026\/09\/21～2026\/10\/20（20日締め）/);
  const dates = [];
  for (let r = FIRST_DAY_ROW; r < FIRST_DAY_ROW + 31; r++) dates.push(val(a, 'A' + r));
  assert.equal(dates[0], excelDate('2026-09-21'));
  assert.equal(dates[29], excelDate('2026-10-20'));
  assert.equal(dates[30], '', '30日の期間の31行目は空欄の枠');
  assert.equal(a.cells['A' + (FIRST_DAY_ROW + 30)].s, STYLE.date, '空欄の行も罫線あり');
  assert.equal(dates.filter((d) => d !== '').length, 30, '勤務のない日（土日・休み）も1行');
  assert.ok(!dates.includes(excelDate('2026-09-20')) && !dates.includes(excelDate('2026-10-21')));
  assert.equal(a.cells['A' + FIRST_DAY_ROW].s, STYLE.date);
  assert.match(files['xl/styles.xml'], /formatCode="m&quot;月&quot;d&quot;日&quot;"/, '日付は m月d日（元のタイムカードと同じ）');
  assert.equal(val(a, 'B' + (FIRST_DAY_ROW + 5)), '土', '9/26（土）も出す');
  const c = columns(a);
  assert.equal(minutes(val(a, c['出勤'] + FIRST_DAY_ROW)), 9 * 60 + 30);
  assert.equal(a.cells[c['出勤'] + FIRST_DAY_ROW].s, STYLE.time, '時刻は hh:mm');
  for (const n of names) {
    assert.equal(val(sheets[n], 'A' + TOTAL_ROW), '合計', n + ' に合計行');
    assert.ok(sheets[n].merges.includes('A' + TOTAL_ROW + ':B' + TOTAL_ROW));
  }
  assert.equal(val(a, c['出勤'] + TOTAL_ROW), '2日', '出勤日数');
  assert.equal(minutes(val(a, c['労働時間'] + TOTAL_ROW)), 16 * 60);
  assert.equal(minutes(val(a, c['休憩'] + TOTAL_ROW)), 2 * 60);
  assert.equal(a.cells[c['労働時間'] + TOTAL_ROW].s, STYLE.totalTime, '合計の時間は [h]:mm');
  // 2月分（1/21〜2/20）は31日 → 31行すべて日付
  const feb = exportBook(gas, '2027-02').sheets['中津井祐貴'];
  assert.equal(val(feb, 'A' + FIRST_DAY_ROW), excelDate('2027-01-21'));
  assert.equal(val(feb, 'A' + (FIRST_DAY_ROW + 30)), excelDate('2027-02-20'));
  assert.equal(val(feb, 'A' + TOTAL_ROW), '合計');
});

// ============================================================ 中身

test('Excel：A形式の1日（休憩＝退勤−出勤−労働時間。内訳と要確認は備考へ。複数区間はすべて勤務区間へ）', () => {
  const gas = office();
  // 会社 9:00〜12:00 → 中断 → 在宅 12:30〜15:00 → 退勤 → 在宅 19:00〜21:00
  run(gas, NAKATSUI, '2026-10-01', [['09:00', 'clockIn', '出社'], ['12:00', 'startBreak', '通院'], ['12:30', 'resumeWork', '在宅'], ['15:00', 'clockOut'],
    ['19:00', 'clockIn', '在宅'], ['21:00', 'clockOut']]);
  run(gas, NAKATSUI, '2026-10-02', [['09:30', 'clockIn', '出社']]); // 退勤なし
  const a = exportBook(gas).sheets['中津井祐貴'];
  const c = columns(a);
  const r = rowOf(a, '2026-10-01');
  assert.deepEqual(['出勤', '退勤', '休憩', '労働時間'].map((h) => minutes(val(a, c[h] + r))), [9 * 60, 21 * 60, 5 * 60 + 30, 6 * 60 + 30]);
  assert.equal(val(a, c['勤務区間'] + r), '会社 09:00〜12:00／在宅 12:30〜15:00／在宅 19:00〜21:00', '3区間すべて');
  assert.match(val(a, c['備考・要確認の理由'] + r), /休憩の内訳：自動休憩 01:00＋中断（私用の中抜け） 00:30＋退勤〜再出勤の間 04:00/);
  // 残業の事前申請なしは社内ルールの確認事項として書く（法定時間外の判定と混同しない）。社内用の CSV は元の文言のまま
  const note = val(a, c['備考・要確認の理由'] + r);
  assert.match(note, /社内確認：30分以上の社内超過に対する承認済み事前申請なし/);
  assert.doesNotMatch(note, /残業：30分以上で承認済みの事前申請なし/);
  assert.match(gas.g.exportSharoushiDetailCsv('2026-10').data.csv, /残業：30分以上で承認済みの事前申請なし/);
  const r2 = rowOf(a, '2026-10-02');
  assert.match(val(a, c['備考・要確認の理由'] + r2), /退勤/, '打刻漏れは備考・要確認の理由へ');
  assert.doesNotMatch(val(a, c['備考・要確認の理由'] + r2), /日報/, '日報の未提出は社内用なので入れない');
  assert.equal(val(a, c['休憩'] + r2), '', '退勤がない日は休憩・労働時間を出さない');
  assert.match(a.xml, new RegExp('<row r="' + r + '" ht="[\\d.]+" customHeight="1"'), '長い備考の行は高さを指定');
});

test('Excel：B形式の1日（出勤・退勤＝会社等、在宅開始・在宅終了、労働1＝会社等、労働2＝在宅、休憩＝労働1＋労働2−労働時間）', () => {
  const gas = office();
  run(gas, OMORI, '2026-10-01', [['09:00', 'clockIn', '出社'], ['12:00', 'startBreak', ''], ['12:30', 'resumeWork', '在宅'], ['19:00', 'clockOut']]);
  const b = exportBook(gas).sheets['大森紗智子'];
  const c = columns(b);
  const r = rowOf(b, '2026-10-01');
  assert.deepEqual(['出勤', '退勤', '在宅開始', '在宅終了', '休憩', '労働1', '労働2', '労働時間'].map((h) => minutes(val(b, c[h] + r))),
    [9 * 60, 12 * 60, 12 * 60 + 30, 19 * 60, 60, 3 * 60, 6 * 60 + 30, 8 * 60 + 30]);
  assert.equal(val(b, c['勤務区間'] + r), '会社 09:00〜12:00／在宅 12:30〜19:00');
  assert.equal(minutes(val(b, c['労働1'] + TOTAL_ROW)), 3 * 60);
  assert.equal(minutes(val(b, c['労働2'] + TOTAL_ROW)), 6 * 60 + 30);
});

test('Excel：直行・直帰・出張は ○、勤務区間に現場、備考に日備考・有給・休日出勤（有給の日は薄い黄色）。合計に日数', () => {
  const gas = office();
  gas.loginAs(NAKATSUI); gas.setNow('2026-10-01 09:00');
  const hw = gas.g.submitHolidayWorkRequest({ workDate: '2026-10-04', plannedStart: '09:00', plannedEnd: '17:00', reason: '立ち会い', content: '検査',
    compDayType: '未定', compDayDate: '', note: '', site: '' }).data.requestId;
  const pl = gas.g.submitPaidLeaveRequest({ date: '2026-10-07', leaveType: '1日有給', reason: '私用' }).data.requestId;
  asAdmin(gas);
  assert.equal(gas.g.approvePaidLeaveRequest(pl).success, true);
  assert.equal(gas.g.approveHolidayWorkRequest(hw).success, true);
  work(gas, NAKATSUI, '2026-10-04', '10:00', '16:00');
  run(gas, NAKATSUI, '2026-10-09', [['09:30', 'clockIn', '出社'], ['18:30', 'clockOut']]);
  gas.loginAs(NAKATSUI); gas.setNow('2026-10-10 09:00');
  assert.equal(gas.g.saveMyDayDetail({ date: '2026-10-09', businessTrip: true, dayNote: '熊本出張', segments: [{ number: 1, direct: true, directReturn: true, site: '堺市○○様邸', note: '' }] }).success, true);
  // フレックスの人も同じ日に出張
  run(gas, OMORI, '2026-10-09', [['09:00', 'clockIn', '出社'], ['18:00', 'clockOut']]);
  gas.loginAs(OMORI); gas.setNow('2026-10-10 09:00');
  assert.equal(gas.g.saveMyDayDetail({ date: '2026-10-09', businessTrip: true, dayNote: '', segments: [{ number: 1, direct: true, directReturn: false, site: '', note: '' }] }).success, true);
  const { sheets } = exportBook(gas);
  const a = sheets['中津井祐貴'];
  const c = columns(a);
  const r9 = rowOf(a, '2026-10-09');
  assert.deepEqual([val(a, c['直行'] + r9), val(a, c['直帰'] + r9)], ['○', '○']);
  assert.match(val(a, c['勤務区間'] + r9), /会社 09:30〜18:30（直行・直帰・現場：堺市○○様邸）/);
  assert.match(val(a, c['備考・要確認の理由'] + r9), /出張・備考：熊本出張/, 'A形式は出張の列がないので備考へ');
  const r4 = rowOf(a, '2026-10-04');
  assert.equal(minutes(val(a, c['休日'] + r4)), 6 * 60, '承認済みの休日出勤の労働時間');
  assert.match(val(a, c['備考・要確認の理由'] + r4), /休日出勤（承認済み）/);
  const r7 = rowOf(a, '2026-10-07');
  assert.equal(val(a, c['備考・要確認の理由'] + r7), '有給：1日有給（08:00）');
  assert.equal(a.cells['A' + r7].s, STYLE.dateLeave, '有給の日は薄い黄色');
  assert.deepEqual([val(a, c['直行'] + TOTAL_ROW), val(a, c['直帰'] + TOTAL_ROW)], ['1日', '1日']);
  assert.match(val(a, c['備考・要確認の理由'] + TOTAL_ROW), /休日出勤 1日/);
  const b = sheets['大森紗智子'];
  const cb = columns(b);
  const rb = rowOf(b, '2026-10-09');
  assert.deepEqual([val(b, cb['出張'] + rb), val(b, cb['直行'] + rb), val(b, cb['直帰'] + rb)], ['○', '○', '']);
  assert.equal(val(b, cb['出張'] + TOTAL_ROW), '1日');
});

test('Excel：法定時間外・深夜・法定休日（A形式は法定内も）は全行空欄。22時以降・社内超過があっても法定時間外・深夜に入れない', () => {
  const gas = office();
  run(gas, NAKATSUI, '2026-10-01', [['09:00', 'clockIn', '出社'], ['23:00', 'clockOut']]);
  run(gas, OMORI, '2026-10-02', [['08:00', 'clockIn', '出社'], ['23:30', 'clockOut']]);
  const { sheets, names } = exportBook(gas);
  for (const n of names) {
    const sh = sheets[n];
    const c = columns(sh);
    const undecided = ['法定時間外', '深夜', '法定内', '法定休日'].filter((h) => c[h]);
    assert.ok(undecided.length >= 2);
    for (const h of undecided) {
      assert.equal(sh.cells[c[h] + HEADER_ROW].s, STYLE.undecidedHeader, '未確定の見出しは薄いグレー');
      for (let r = FIRST_DAY_ROW; r <= TOTAL_ROW; r++) {
        const cell = sh.cells[c[h] + r];
        assert.deepEqual([cell.v, cell.s], ['', STYLE.undecided], n + ' ' + h + ' ' + r + '行目は空欄');
      }
    }
  }
  assert.ok(!/<f>/.test(Object.values(sheets).map((s) => s.xml).join('')), '数式は入れない');
});

test('Excel：給与の項目（基本給・等級手当・残業単価・残業手当・深夜手当・休日出勤手当・通勤手当・給与合計額）・交通費・メールアドレスは出さない', () => {
  const gas = office();
  work(gas, NAKATSUI, '2026-10-01', '09:30', '20:00');
  const { files } = exportBook(gas);
  const all = Object.values(files).join('');
  for (const word of ['基本給', '等級手当', '残業単価', '残業手当', '深夜手当', '休日出勤手当', '通勤手当', '給与合計', '手当', '単価', '時給', '金額', '円']) {
    assert.ok(!all.includes(word), word + ' を含まない');
  }
  assert.ok(!/交通費|業務走行距離|メールアドレス|@example\.com/.test(all));
});

// ============================================================ 権限・読み取りだけ・後片付け・CSV

test('Excel：一般スタッフは実行できない（管理者だけ）。スタッフ画面の関数一覧にもない', () => {
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

test('Excel：元のシートは1文字も変わらず、一時ファイル（スプレッドシート・ドライブ）も作らない', () => {
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

test('Excel：既存の社労士確認用の詳細表（CSV）はそのまま使える', () => {
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

// ============================================================ シート名・書式・印刷・開けること

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

test('書式・印刷：見出しは元のタイムカードと同じ薄い緑・ＭＳ Ｐゴシック・行の高さ19.95・A4横で1ページ・見出し行を印刷タイトルに。同じ形式は同じ列幅', () => {
  const gas = office();
  const { files, sheets } = exportBook(gas);
  const styles = files['xl/styles.xml'];
  assert.match(styles, /<numFmt numFmtId="164" formatCode="hh:mm"\/><numFmt numFmtId="165" formatCode="\[h\]:mm"\/>/);
  assert.match(styles, /FFCCFFCC/, '見出しの薄い緑（元のタイムカードと同じ色）');
  assert.match(styles, /ＭＳ Ｐゴシック/);
  const a = sheets['中津井祐貴'];
  assert.equal(a.cells['A' + HEADER_ROW].s, STYLE.header);
  assert.match(a.xml, /<row r="4" ht="19.95" customHeight="1">/);
  assert.match(a.xml, /<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="1"\/>/, 'A4横・1ページ');
  assert.match(a.xml, /<pageSetUpPr fitToPage="1"\/>/);
  assert.match(files['xl/workbook.xml'], /<definedName name="_xlnm.Print_Titles" localSheetId="2">'中津井祐貴'!\$1:\$3<\/definedName>/);
  const widths = (sh) => [...sh.xml.matchAll(/<col min="\d+" max="\d+" width="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(widths(sheets['中津井祐貴']), widths(sheets['久保亜弓']));
  assert.deepEqual(widths(sheets['大森紗智子']), widths(sheets['村田清子']));
  // 横に広がりすぎない（列幅の合計。A4横1ページに収まる目安）
  assert.ok(widths(a).reduce((t, w) => t + w, 0) <= 160, 'A形式の列幅の合計');
  assert.ok(widths(sheets['大森紗智子']).reduce((t, w) => t + w, 0) <= 185, 'B形式の列幅の合計');
});

const python = (() => {
  try { execFileSync('python3', ['-c', 'import openpyxl'], { stdio: 'ignore' }); return 'python3'; } catch (e) { return null; }
})();
test('xlsx として正常に開ける（openpyxl で読み込み、シート・見出し・値・結合・印刷設定を確認）', { skip: !python && 'python3 と openpyxl がないため省略' }, () => {
  const gas = office();
  run(gas, NAKATSUI, '2026-10-01', [['09:00', 'clockIn', '出社'], ['12:00', 'startBreak', ''], ['12:30', 'resumeWork', '在宅'], ['19:00', 'clockOut']]);
  const { buf } = exportBook(gas);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-xlsx-')), 'book.xlsx');
  fs.writeFileSync(file, buf);
  try {
    const out = execFileSync(python, ['-c', `
import json, sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
res = {}
for ws in wb.worksheets:
    res[ws.title] = {
        'header': [c.value for c in ws[2]],
        'a4': ws['A4'].value.strftime('%Y-%m-%d'), 'a4fmt': ws['A4'].number_format,
        'total': ws['A35'].value, 'orientation': ws.page_setup.orientation,
        'merged': len(ws.merged_cells.ranges),
    }
ws = wb['中津井祐貴']
res['row'] = [str(ws.cell(14, c).value) for c in range(1, 7)]
print(json.dumps(res, ensure_ascii=False))
`, file]).toString();
    const r = JSON.parse(out);
    assert.deepEqual(Object.keys(r).filter((k) => k !== 'row'), ['大森紗智子', '村田清子', '中津井祐貴', '久保亜弓']);
    assert.deepEqual(r['中津井祐貴'].header, A_COLUMNS);
    assert.deepEqual(r['大森紗智子'].header, B_COLUMNS);
    assert.deepEqual([r['中津井祐貴'].a4, r['中津井祐貴'].a4fmt, r['中津井祐貴'].total, r['中津井祐貴'].orientation], ['2026-09-21', 'm"月"d"日"', '合計', 'landscape']);
    assert.deepEqual(r.row, ['2026-10-01 00:00:00', '木', '09:00:00', '19:00:00', '01:30:00', '08:30:00']);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
