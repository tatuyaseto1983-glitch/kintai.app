'use strict';
// leaf-portal/gas（株式会社リーフ 社内ポータル用 勤怠バックエンド）のテスト
const test = require('node:test');
const assert = require('node:assert');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const ADMIN = 'admin@example.com';
const FIXED = 'fixed@example.com';
const FLEX = 'flex@example.com';

/** セットアップ済みで、管理者・固定・フレックスの3名が登録された環境 */
function ready() {
  const gas = createLeafGas({ email: ADMIN });
  gas.g.setupSystem();
  gas.g.appendRecords_('スタッフマスタ', [
    { '社員ID': 'E001', '氏名': '山田', 'メールアドレス': ADMIN, '権限': 'admin', '勤務区分': '固定勤務', '在籍状況': '在籍' },
    { '社員ID': 'E002', '氏名': '佐藤', 'メールアドレス': FIXED, '権限': 'staff', '勤務区分': '固定勤務', '在籍状況': '在籍' },
    { '社員ID': 'E003', '氏名': '鈴木', 'メールアドレス': FLEX, '権限': 'staff', '勤務区分': 'フレックス', '在籍状況': '在籍' },
  ]);
  return gas;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

test('setupSystem：7シートを作り、2回目以降は何も壊さない', () => {
  const gas = createLeafGas();
  gas.g.setupSystem();
  const names = gas.main.getSheets().map((s) => s.getName());
  for (const n of ['スタッフマスタ', '勤怠記録', '中断履歴', '打刻修正申請', '残業申請', '日報', '設定']) assert.ok(names.includes(n), n);
  assert.ok(names.includes('シート1'), '最初からあるシートも削除しない');
  assert.equal(gas.main.rows('設定').length, 13);
  assert.equal(gas.main.getSpreadsheetTimeZone(), 'Asia/Tokyo');

  // 利用者が設定値を変更し、データも入れた後にもう一度実行
  const settings = gas.main.getSheetByName('設定');
  settings.data[1][1] = '10:00';
  gas.main.getSheetByName('スタッフマスタ').data.push(['E001', '山田', 'a@example.com']);
  const before = JSON.stringify(gas.main.sheets.map((s) => s.data));
  gas.g.setupSystem();
  assert.equal(JSON.stringify(gas.main.sheets.map((s) => s.data)), before, '2回目は何も変わらない');
  assert.equal(gas.main.rows('設定')[0]['値'], '10:00');
});

test('setupSystem：既存シートの足りない見出しだけを右端に足し、データは動かさない', () => {
  const gas = createLeafGas();
  const sheet = gas.main.insertSheet('スタッフマスタ');
  sheet.data = [['社員ID', '氏名', 'メールアドレス', '自分で足した列'], ['E009', '既存', 'x@example.com', 'メモ']];
  const empty = gas.main.insertSheet('中断履歴'); // 同名の空シート
  const noHeader = gas.main.insertSheet('日報');
  noHeader.data = [[], ['データだけある行']]; // 1行目が空でデータあり → 触らない
  const settings = gas.main.insertSheet('設定');
  settings.data = [['項目', '値', '説明'], ['自動休憩', '00:45', '会社で変更済み']];

  const log = gas.g.setupSystem();
  assert.deepEqual(sheet.data[1], ['E009', '既存', 'x@example.com', 'メモ']);
  assert.deepEqual(sheet.data[0].slice(0, 4), ['社員ID', '氏名', 'メールアドレス', '自分で足した列']);
  assert.deepEqual(sheet.data[0].slice(4), ['権限', '雇用区分', '勤務区分', '標準出勤', '標準退勤', '1日所定時間', '週所定時間', '月所定時間', '在籍状況', '入社日', '部署', '備考']);
  assert.ok(sheet.maxColumns >= 16, '列が足りなければシートの列を増やす');
  assert.equal(empty.data[0][0], '中断ID');
  assert.deepEqual(noHeader.data, [[], ['データだけある行']]);
  assert.match(log, /日報：⚠ 1行目（見出し）が空/);
  const rows = gas.main.rows('設定');
  assert.equal(rows.find((r) => r['項目'] === '自動休憩')['値'], '00:45', '既存の設定値は上書きしない');
  assert.equal(rows.length, 13, '無い項目だけ追加');
});

test('Apps Script のファイルの並び順が違っても動く', () => {
  const gas = createLeafGas({ reverseOrder: true });
  gas.g.setupSystem();
  assert.equal(gas.g.runAllScenarioTests().failed, 0);
});

test('シートがない・見出しが足りないときは分かりやすいエラー', () => {
  const gas = createLeafGas({ email: FIXED });
  let r = gas.g.clockIn('出社');
  assert.equal(r.success, false);
  assert.match(r.message, /「スタッフマスタ」シートが見つかりません。.*setupSystem/);

  gas.g.setupSystem();
  gas.main.getSheetByName('勤怠記録').data[0][6] = '出勤時刻';
  gas.g.appendRecords_('スタッフマスタ', [{ '社員ID': 'E002', '氏名': '佐藤', 'メールアドレス': FIXED, '権限': 'staff', '勤務区分': '固定勤務', '在籍状況': '在籍' }]);
  r = gas.g.clockIn('出社');
  assert.match(r.message, /「勤怠記録」シートに「出勤」列がありません/);
});

test('勤務時間の計算（純粋な計算）', () => {
  const { g } = createLeafGas();
  const base = { isFixed: true, standardStartMinutes: 570, standardEndMinutes: 1110, autoBreakMinutes: 60, autoBreakThresholdMinutes: 0, overtimeFreeLimitMinutes: 30, overtimeUnitMinutes: 1, interruptionMinutes: 0 };
  const calc = (inT, outT, extra = {}) => plain(g.calculateWorkTime_({ ...base, clockInMinutes: g.toMinutes_(inT), clockOutMinutes: g.toMinutes_(outT), ...extra }));

  let r = calc('09:30', '19:00', { interruptionMinutes: 20 });
  assert.equal(r.netMinutes, 490); // 8:10
  assert.equal(r.internalExcessMinutes, 30);
  assert.equal(r.requiresPreApproval, true);
  assert.equal(calc('09:30', '18:42').internalExcessMinutes, 12);
  assert.equal(calc('09:30', '19:12').internalExcessMinutes, 42);
  assert.equal(calc('09:30', '18:59').requiresPreApproval, false);
  assert.equal(calc('09:30', '10:00').netMinutes, 0, '実働はマイナスにしない');
  r = calc('22:00', '01:00');
  assert.equal(r.grossMinutes, 180, '日付をまたぐ勤務');
  assert.equal(r.internalExcessMinutes, 180);
  assert.equal(calc('09:30', '19:12', { overtimeUnitMinutes: 15 }).internalExcessMinutes, 30, '記録単位で切り捨て');
  r = calc('10:00', '19:00', { isFixed: false });
  assert.equal(r.lateMinutes, 0);
  assert.equal(r.internalExcessMinutes, 0);
  assert.equal(calc('09:30', '13:00', { autoBreakThresholdMinutes: 360 }).autoBreakMinutes, 0, '適用開始より短い日は自動休憩なし');

  assert.deepEqual(plain(g.calculateFlexBalance_(8280, 6195)), { scheduledMinutes: 8280, workedMinutes: 6195, remainingMinutes: 2085, excessMinutes: 0 });
  assert.deepEqual(plain(g.calculateFlexBalance_(8280, 8540)), { scheduledMinutes: 8280, workedMinutes: 8540, remainingMinutes: 0, excessMinutes: 260 });
});

test('日付・時刻の変換（Date や数値のセルにも対応）', () => {
  const { g } = createLeafGas();
  assert.equal(g.formatMinutes_(8280), '138:00');
  assert.equal(g.formatMinutes_(12), '00:12');
  assert.equal(g.toMinutes_('9:30'), 570);
  assert.equal(g.toMinutes_('138:00'), 8280);
  assert.equal(g.toMinutes_(0.5), 720);
  assert.equal(g.toMinutes_('abc'), null);
  assert.equal(g.toMinutes_(g.Utilities.parseDate('1899-12-30 09:30', 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')), 570, '時刻形式のセル');
  assert.equal(g.toMinutes_(g.Utilities.parseDate('1900-01-04 18:00', 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')), 8280, '経過時間形式のセル（138:00）');
  assert.equal(g.toDateKey_('2026/9/1'), '2026-09-01');
  assert.equal(g.toDateKey_(g.Utilities.parseDate('2026-09-01 00:00', 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')), '2026-09-01');
  assert.equal(g.toDateKey_('2026-02-30'), '');
  assert.equal(g.isSameDate_('2026-09-01', g.Utilities.parseDate('2026-09-01 23:59', 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')), true);
  assert.equal(g.isSameDate_('', ''), false);
  assert.deepEqual(plain(g.getMonthRange_('2026-02', 0)), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(plain(g.getMonthRange_('2026-01', 20)), { from: '2025-12-21', to: '2026-01-20' });
  assert.equal(g.getMonthKeyForDate_('2026-12-25', 20), '2027-01');
  assert.deepEqual(plain(g.getWeekRange_('2026-06-03', 1)), { from: '2026-06-01', to: '2026-06-07' });
  assert.deepEqual(plain(g.getWeekRange_('2026-06-03', 0)), { from: '2026-05-31', to: '2026-06-06' });
});

test('自動テスト（runAllScenarioTests）は別ファイルで動き、本番シートに書き込まない', () => {
  const gas = ready();
  const before = JSON.stringify(gas.main.sheets.map((s) => s.data));
  const result = gas.g.runAllScenarioTests();
  const failed = result.results.filter((r) => !r.ok).map((r) => r.title + ' ' + r.detail);
  assert.deepEqual(failed, []);
  assert.ok(result.passed >= 30);
  assert.equal(JSON.stringify(gas.main.sheets.map((s) => s.data)), before);
  assert.equal(gas.books.size, 2);
  // 2回目はテスト用ファイルを使い回す
  assert.equal(gas.g.runAllScenarioTests().failed, 0);
  assert.equal(gas.books.size, 2);
  assert.equal(gas.eval('APP_RUNTIME.spreadsheet'), null, 'テスト後は元に戻る');
});

test('ユーザー判定：未登録・重複・退職・休職', () => {
  const gas = ready();
  gas.loginAs('FIXED@Example.com'); // 大文字小文字は区別しない
  assert.equal(gas.g.getCurrentUser().data.employeeId, 'E002');
  gas.loginAs('nobody@example.com');
  assert.match(gas.g.getCurrentUser().message, /登録されていないアカウント/);
  gas.loginAs('');
  assert.match(gas.g.getCurrentUser().message, /メールアドレスを取得できませんでした/);

  const staff = gas.main.getSheetByName('スタッフマスタ');
  staff.data[2][11] = '休職';
  gas.loginAs(FIXED);
  assert.equal(gas.g.getCurrentUser().success, true);
  assert.match(gas.g.clockIn('出社').message, /在籍状況が「休職」のため打刻できません/);
  staff.data[2][11] = '退職';
  assert.match(gas.g.getCurrentUser().message, /退職済み/);

  gas.g.appendRecords_('スタッフマスタ', [{ '社員ID': 'E010', '氏名': '重複', 'メールアドレス': FLEX }]);
  gas.loginAs(FLEX);
  assert.match(gas.g.getCurrentUser().message, /複数登録/);
});

test('日付をまたぐ勤務：前日の勤務中の記録に退勤できる', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 22:00');
  gas.g.clockIn('出社');
  gas.setNow('2026-06-02 01:00');
  const r = gas.g.clockOut();
  assert.equal(r.success, true, r.message);
  assert.equal(r.data.date, '2026-06-01');
  assert.equal(r.data.workTime, '02:00');
  // 翌日の出勤はできる
  gas.setNow('2026-06-02 09:30');
  assert.equal(gas.g.clockIn('出社').success, true);
});

test('退勤し忘れのまま翌日に出勤すると注意が出る', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 09:30');
  gas.g.clockIn('出社');
  gas.setNow('2026-06-03 09:30');
  const r = gas.g.clockIn('出社');
  assert.equal(r.success, true);
  assert.match(r.message, /2026-06-01 の退勤が記録されていません/);
});

test('設定シートの値を変えると計算に反映される／不正な値は分かりやすいエラー', () => {
  const gas = ready();
  const settings = gas.main.getSheetByName('設定');
  const row = settings.data.findIndex((r) => r[0] === '固定勤務_標準退勤');
  settings.data[row][1] = '18:00';
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 09:30');
  gas.g.clockIn('出社');
  gas.setNow('2026-06-01 18:42');
  const r = gas.g.clockOut();
  assert.equal(r.data.internalExcess, '00:42');
  assert.equal(r.data.needsCheck, '要確認');

  settings.data[row][1] = '夕方';
  assert.match(gas.g.clockIn('出社').message, /「設定」シートの「固定勤務_標準退勤」の値「夕方」が正しくありません/);
});

test('スタッフマスタの個別の標準時刻が設定より優先される', () => {
  const gas = ready();
  const staff = gas.main.getSheetByName('スタッフマスタ');
  staff.data[2][6] = '10:00'; // 佐藤の標準出勤
  staff.data[2][7] = '19:00';
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 10:05');
  assert.equal(gas.g.clockIn('出社').data.late, '00:05');
  gas.setNow('2026-06-01 19:10');
  const r = gas.g.clockOut();
  assert.equal(r.data.scheduledEnd, '19:00');
  assert.equal(r.data.internalExcess, '00:10');
});

test('打刻修正：出勤の打刻忘れ・中断の追加・再開の押し忘れ・却下', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-02 09:00');
  let r = gas.g.submitCorrectionRequest({ targetDate: '2026-06-01', item: '退勤', after: '18:30', reason: '打刻忘れ' });
  assert.match(r.message, /出勤記録がありません/);
  const ids = [];
  for (const req of [
    { item: '出勤', after: '09:30' }, { item: '退勤', after: '18:30' }, { item: '中断', after: '15:00' },
    { item: '再開', after: '15:30' }, { item: '勤務形態', after: '在宅' },
  ]) {
    r = gas.g.submitCorrectionRequest({ targetDate: '2026-06-01', reason: '打刻忘れ', ...req });
    assert.equal(r.success, true, r.message);
    ids.push(r.data.requestId);
  }
  assert.equal(gas.g.submitCorrectionRequest({ targetDate: '2026-06-03', item: '出勤', after: '09:30', reason: 'x' }).message, '未来の日付は修正申請できません');
  assert.match(gas.g.approveCorrectionRequest(ids[0]).message, /管理者のみ/);

  gas.loginAs(ADMIN);
  for (const id of ids) assert.equal(gas.g.approveCorrectionRequest(id).success, true);
  assert.match(gas.g.approveCorrectionRequest(ids[0]).message, /すでに処理済み/);
  const rec = gas.main.rows('勤怠記録').find((x) => x['社員ID'] === 'E002');
  assert.equal(rec['出勤'], '09:30');
  assert.equal(rec['退勤'], '18:30');
  assert.equal(rec['中断合計'], '00:30');
  assert.equal(rec['実働時間'], '07:30');
  assert.equal(rec['勤務形態'], '在宅');
  assert.equal(rec['状態'], '退勤済み');
  assert.equal(rec['打刻修正状況'], '修正済み');
  assert.equal(gas.main.rows('中断履歴')[0]['中断時間'], '00:30');

  // 既存の中断の開始時刻を直す → 却下
  gas.loginAs(FIXED);
  r = gas.g.submitCorrectionRequest({ targetDate: '2026-06-01', item: '中断', before: '15:10', after: '15:05', reason: 'x' });
  assert.match(r.message, /一致する中断の記録が見つかりません/);
  r = gas.g.submitCorrectionRequest({ targetDate: '2026-06-01', item: '中断', before: '15:00', after: '15:10', reason: '時刻違い' });
  assert.equal(r.success, true);
  assert.equal(gas.main.rows('勤怠記録')[0]['打刻修正状況'], '申請中');
  gas.loginAs(ADMIN);
  assert.match(gas.g.rejectCorrectionRequest(r.data.requestId, '').message, /却下理由を入力/);
  assert.equal(gas.g.rejectCorrectionRequest(r.data.requestId, '記録どおりです').success, true);
  assert.equal(gas.main.rows('勤怠記録')[0]['打刻修正状況'], '修正済み');
  assert.equal(gas.main.rows('中断履歴')[0]['中断開始'], '15:00', '却下なので変わらない');
});

test('残業申請：過去日・重複はエラー、承認前に退勤→承認で要確認が消える', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 10:00');
  assert.match(gas.g.submitOvertimeRequest({ targetDate: '2026-05-31', plannedStart: '18:30', plannedEnd: '20:00', reason: 'x' }).message, /過去の日付/);
  assert.match(gas.g.submitOvertimeRequest({ targetDate: '2026-06-01', plannedStart: '18:30', plannedEnd: '25:00', reason: 'x' }).message, /予定終了/);
  const req = gas.g.submitOvertimeRequest({ targetDate: '2026-06-01', plannedStart: '18:30', plannedEnd: '20:00', reason: '現場対応' });
  assert.equal(req.success, true);
  assert.match(gas.g.submitOvertimeRequest({ targetDate: '2026-06-01', plannedStart: '18:30', plannedEnd: '20:00', reason: 'x' }).message, /すでに提出されています/);

  gas.setNow('2026-06-01 09:30');
  gas.g.clockIn('出社');
  gas.setNow('2026-06-01 20:00');
  let r = gas.g.clockOut();
  assert.equal(r.data.preOvertimeRequest, '承認待ち');
  assert.equal(r.data.needsCheck, '要確認');
  assert.equal(gas.main.rows('残業申請')[0]['実績残業'], '01:30');

  gas.loginAs(ADMIN);
  r = gas.g.approveOvertimeRequest(req.data.requestId);
  assert.equal(r.success, true);
  const rec = gas.main.rows('勤怠記録')[0];
  assert.equal(rec['事前残業申請'], '承認済み');
  assert.equal(rec['要確認'], '');
  assert.equal(rec['退勤'], '20:00', '打刻は変えない');
});

test('管理者機能：日別・月別・承認待ち・CSV・再計算', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 09:30');
  gas.g.clockIn('出社');
  gas.setNow('2026-06-01 19:12');
  gas.g.clockOut();
  gas.g.submitCorrectionRequest({ targetDate: '2026-06-01', item: '退勤', after: '18:30', reason: 'x' });

  gas.loginAs(ADMIN);
  gas.setNow('2026-06-02 09:00');
  const daily = gas.g.getDailyAttendance('2026-06-01');
  assert.deepEqual(daily.data.records.map((r) => r.name + ':' + r.status), ['山田:未出勤', '佐藤:退勤済み', '鈴木:未出勤']);
  const monthly = gas.g.getMonthlyAttendance('2026-06');
  const sato = monthly.data.summaries.find((s) => s.employeeId === 'E002');
  assert.equal(sato.workTime, '08:42');
  assert.equal(sato.needsCheckCount, 1);
  assert.equal(monthly.data.summaries.find((s) => s.employeeId === 'E003').flexRemaining, '138:00');
  assert.equal(gas.g.getPendingRequests().data.corrections.length, 1);
  const csv = gas.g.exportAttendanceCsv('2026-06');
  assert.ok(csv.data.csv.startsWith('﻿勤怠ID,日付,社員ID'));
  assert.equal(csv.data.csv.split('\r\n').length, 2);

  // シートを直接直して再計算
  const sheet = gas.main.getSheetByName('勤怠記録');
  const outCol = sheet.data[0].indexOf('退勤');
  sheet.data[1][outCol] = '18:40';
  gas.setNow('2026-06-20 09:00');
  const r = gas.g.recalculateThisMonth();
  assert.equal(r.success, true, r.message);
  const rec = gas.main.rows('勤怠記録')[0];
  assert.equal(rec['社内超過時間'], '00:10');
  assert.equal(rec['要確認'], '');
  assert.equal(rec['打刻修正状況'], '申請中', '計算列以外は変えない');

  gas.loginAs(FIXED);
  for (const fn of ['getDailyAttendance', 'getMonthlyAttendance', 'getPendingRequests', 'exportAttendanceCsv', 'checkWeeklyRestDays', 'recalculateThisMonth']) {
    assert.match(gas.g[fn]().message, /管理者のみ/, fn);
  }
  assert.match(gas.g.getFlexSummary('E003').message, /管理者のみ/);
  gas.loginAs(ADMIN);
  assert.equal(gas.g.getFlexSummary('E003').success, true);
});

test('日報：下書き→提出→確認済み後は変更不可', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 17:00');
  let r = gas.g.saveDailyReport({ workContent: '下書き', status: '下書き' });
  assert.equal(r.data.status, '下書き');
  assert.equal(r.data.submittedAt, '');
  r = gas.g.saveDailyReport({ workContent: '現場確認', issues: '資材の納期' });
  assert.equal(r.data.status, '提出済み');
  assert.equal(gas.main.rows('日報').length, 1, '同じ日は上書き');
  assert.match(gas.g.saveDailyReport({ workContent: 'x', status: '確認済み' }).message, /ステータス/);

  gas.loginAs(ADMIN);
  assert.equal(gas.g.confirmDailyReport(r.data.reportId).success, true);
  gas.loginAs(FIXED);
  assert.match(gas.g.saveDailyReport({ workContent: '変更' }).message, /確認済みの日報は変更できません/);
  assert.equal(gas.g.getMyDailyReports('2026-06').data.reports.length, 1);
});

test('戻り値はすべて { success, message, data } の形で、画面に渡せる値だけ', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 09:30');
  for (const r of [gas.g.clockIn('出社'), gas.g.clockIn('出社'), gas.g.getMyAttendance(), gas.g.getTodayStaffStatus()]) {
    assert.deepEqual(Object.keys(r).sort(), ['data', 'message', 'success']);
    assert.equal(typeof r.message, 'string');
    assert.doesNotThrow(() => JSON.stringify(r));
  }
});
