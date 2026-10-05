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
  assert.equal(gas.main.rows('設定').length, 19, '段階3の5項目と段階5の日報_未提出判定開始日を含む');
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
  assert.deepEqual(sheet.data[1].slice(0, 4), ['E009', '既存', 'x@example.com', 'メモ'], '既存のデータは動かさない');
  assert.equal(sheet.data[1][sheet.data[0].indexOf('休日出勤申請対象')], '対象', '新しく作った「休日出勤申請対象」列にだけ初期値が入る');
  assert.deepEqual(sheet.data[0].slice(0, 4), ['社員ID', '氏名', 'メールアドレス', '自分で足した列']);
  assert.deepEqual(sheet.data[0].slice(4), ['権限', '雇用区分', '勤務区分', '標準出勤', '標準退勤', '1日所定時間', '週所定時間', '月所定時間', '在籍状況', '入社日', '部署', '備考', '勤怠集計対象', '休日出勤申請対象', '有給申請対象', '日報提出対象', '日報確認対象']);
  assert.ok(sheet.maxColumns >= 17, '列が足りなければシートの列を増やす');
  assert.equal(empty.data[0][0], '中断ID');
  assert.deepEqual(noHeader.data, [[], ['データだけある行']]);
  assert.match(log, /日報：⚠ 1行目（見出し）が空/);
  const rows = gas.main.rows('設定');
  assert.equal(rows.find((r) => r['項目'] === '自動休憩')['値'], '00:45', '既存の設定値は上書きしない');
  assert.equal(rows.length, 19, '無い項目だけ追加');
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

test('日報（以前の saveDailyReport）：下書き→提出→提出後も本人は修正できる（バージョンが上がる）', () => {
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
  assert.equal(gas.g.confirmDailyReport(r.data.reportId).success, true, '以前の関数名でも「確認しました」になる');
  gas.loginAs(FIXED);
  assert.equal(gas.g.saveDailyReport({ workContent: '変更' }).success, true, '提出後も本人は修正できる');
  assert.match(gas.g.saveDailyReport({ workContent: '変更', status: '下書き' }).message, /下書きに戻せません/);
  const row = gas.main.rows('日報')[0];
  assert.deepEqual([row['日報ステータス'], row['バージョン'], row['本日の業務内容']], ['submitted', '2', '変更']);
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

test('メールアドレスが取得できないときは、所有者などで代用せず明確なエラーで止まる', () => {
  const gas = ready();
  gas.loginAs(''); // 個人Gmail同士のWebアプリ「自分として実行」などで起きる状態
  gas.g.Session.getEffectiveUser = () => ({ getEmail: () => ADMIN }); // 実行権限の持ち主は登録済みの管理者
  gas.setNow('2026-06-01 09:30');
  for (const r of [gas.g.getCurrentUser(), gas.g.clockIn('出社'), gas.g.getTodayStaffStatus(), gas.g.getAllAttendance('2026-06-01', '2026-06-30')]) {
    assert.equal(r.success, false);
    assert.match(r.message, /メールアドレスを取得できませんでした。打刻などの処理は行っていません/);
  }
  assert.equal(gas.main.rows('勤怠記録').length, 0, '何も記録されない');

  gas.g.Session.getActiveUser = () => { throw new Error('権限がありません'); };
  assert.match(gas.g.clockIn('出社').message, /メールアドレスを取得できませんでした/);
  gas.g.Session.getActiveUser = () => ({ getEmail: () => 'not-an-email' });
  assert.match(gas.g.clockIn('出社').message, /形式が正しくありません/);
});

test('自動休憩_適用開始：設定シートの値を変えるだけで短時間勤務の自動休憩を引かなくなる', () => {
  const gas = ready();
  const { g } = gas;
  const base = { isFixed: false, standardStartMinutes: 570, standardEndMinutes: 1110, autoBreakMinutes: 60, overtimeFreeLimitMinutes: 30, overtimeUnitMinutes: 1 };
  const auto = (hours, interruption, threshold) => g.calculateWorkTime_({ ...base, clockInMinutes: 540, clockOutMinutes: 540 + hours * 60, interruptionMinutes: interruption, autoBreakThresholdMinutes: threshold }).autoBreakMinutes;
  assert.equal(auto(3, 0, 0), 60, '00:00 は常に引く');
  assert.equal(auto(6, 0, 360), 0, '6時間ちょうどは引かない');
  assert.equal(auto(6.5, 0, 360), 60);
  assert.equal(auto(7, 90, 360), 0, '中断を除いて6時間以下なら引かない');

  const settings = gas.main.getSheetByName('設定');
  settings.data[settings.data.findIndex((r) => r[0] === '自動休憩_適用開始')][1] = '06:00';
  gas.loginAs(FLEX);
  gas.setNow('2026-06-01 10:00');
  gas.g.clockIn('在宅');
  gas.setNow('2026-06-01 14:00');
  const r = gas.g.clockOut();
  assert.equal(r.data.autoBreak, '00:00');
  assert.equal(r.data.workTime, '04:00');
});

test('clasp push 前の確認：設定の間違いを止める', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { checkClaspProject, REQUIRED_FILES } = require('../leaf-portal/tools/check-clasp');
  const real = checkClaspProject(path.join(__dirname, '..', 'leaf-portal'));
  assert.deepEqual(real.files, [...REQUIRED_FILES].sort(), 'gas/ のファイルがそろっている');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clasp-'));
  fs.cpSync(path.join(__dirname, '..', 'leaf-portal', 'gas'), path.join(dir, 'gas'), { recursive: true });
  const write = (obj) => fs.writeFileSync(path.join(dir, '.clasp.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
  assert.match(checkClaspProject(dir).errors[0], /\.clasp\.json がありません/);
  write('{ "scriptId": "abc", }');
  assert.match(checkClaspProject(dir).errors[0], /書き方が正しくありません/);
  write({ scriptId: 'AKfycbxDEPLOY', rootDir: 'gas' });
  assert.match(checkClaspProject(dir).errors[0], /デプロイID/);
  write({ scriptId: '1' + 'a'.repeat(56), rootDir: '.' });
  assert.match(checkClaspProject(dir).errors[0], /rootDir は "gas"/);
  write({ scriptId: '1' + 'a'.repeat(56), rootDir: 'gas' });
  assert.equal(checkClaspProject(dir).ok, true);
  fs.rmSync(path.join(dir, 'gas', 'Config.gs'));
  assert.match(checkClaspProject(dir).errors[0], /Config\.gs/);
});

test('テスト環境への反映：.clasp.test.json を使い、本番と同じスクリプトIDなら止める', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { checkClaspProject } = require('../leaf-portal/tools/check-clasp');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clasp-test-'));
  fs.cpSync(path.join(__dirname, '..', 'leaf-portal', 'gas'), path.join(dir, 'gas'), { recursive: true });
  const prodId = '1' + 'p'.repeat(56);
  const testId = '1' + 't'.repeat(56);
  const write = (name, id) => fs.writeFileSync(path.join(dir, name), JSON.stringify({ scriptId: id, rootDir: 'gas' }));
  write('.clasp.json', prodId);
  assert.match(checkClaspProject(dir, { test: true }).errors[0], /\.clasp\.test\.json がありません/, 'テスト用の設定がなければ止める（本番の設定は使わない）');
  write('.clasp.test.json', prodId);
  assert.match(checkClaspProject(dir, { test: true }).errors[0], /スクリプトIDが同じです/, '本番と同じIDならテストへの反映を止める');
  assert.match(checkClaspProject(dir).errors[0], /スクリプトIDが同じです/, '本番への反映も止める');
  write('.clasp.test.json', testId);
  const r = checkClaspProject(dir, { test: true });
  assert.deepEqual([r.ok, r.scriptId, r.configName], [true, testId, '.clasp.test.json']);
  assert.equal(checkClaspProject(dir).scriptId, prodId, '本番の設定はそのまま');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'leaf-portal', 'package.json'), 'utf8'));
  assert.match(pkg.scripts['push:test'], /--test && clasp -P \.clasp\.test\.json push$/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'leaf-portal', '.gitignore'), 'utf8'), /^\.clasp\.test\.json$/m);
});

test('テスト用スプレッドシート（名前に「テスト」）では画面に「テスト環境」と出る。setupSystem は対象のシート名を記録', () => {
  const gas = createLeafGas();
  gas.main.name = 'リーフ勤怠管理';
  gas.g.setupSystem();
  let out = gas.g.doGet();
  assert.doesNotMatch(out.getContent(), /id="envBadge"/);
  assert.doesNotMatch(out.getTitle(), /テスト/);
  gas.main.name = '【テスト】リーフ勤怠管理';
  out = gas.g.doGet();
  assert.match(out.getContent(), /<span class="env-badge" id="envBadge">テスト環境<\/span>/);
  assert.match(out.getTitle(), /^【テスト環境】/);
  assert.match(gas.g.setupSystem(), /対象のスプレッドシート：「【テスト】リーフ勤怠管理」 https:/);
});

test('画面の一番下に「版」が出る（npm run check の表示と同じ値。push・デプロイ更新の確認用）', () => {
  const path = require('node:path');
  const { readAppBuild } = require('../leaf-portal/tools/check-clasp');
  const build = readAppBuild(path.join(__dirname, '..', 'leaf-portal'));
  assert.match(build, /^\d{4}\.\d{2}\.\d{2}-\d+$/);
  const gas = createLeafGas();
  gas.g.setupSystem();
  assert.match(gas.g.doGet().getContent(), new RegExp('<span class="app-build" id="appBuild">版 ' + build.replace(/\./g, '\\.') + '</span>'));
});

test('会社名：正式表記「Leaf Co.,Ltd.」は WebApp.gs の APP_BRAND_NAME 1か所だけに書き、画面のロゴ横・フッター・タイトル・ロゴの代替文字はそこから出す', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const gas = createLeafGas();
  assert.equal(gas.eval('APP_BRAND_NAME'), 'Leaf Co.,Ltd.');
  assert.equal(gas.eval('WEB_APP_TITLE'), 'Leaf Co.,Ltd.｜勤怠管理');
  const html = gas.g.doGet().getContent();
  assert.ok(html.includes('alt="Leaf Co.,Ltd. ロゴ"'));
  assert.ok(!/Co\.,\s*Ltd(?!\.)/.test(html), '末尾のピリオドがない表記は画面に出ない');
  // コード（.gs・.html）に社名を直接書いているのは APP_BRAND_NAME の定義だけ
  const dir = path.join(__dirname, '..', 'leaf-portal', 'gas');
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.(gs|html)$/.test(x))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (/Co\.\s*,\s*Ltd/i.test(line)) hits.push(f + ':' + (i + 1) + ' ' + line.trim());
    });
  }
  assert.deepEqual(hits, ["WebApp.gs:21 const APP_BRAND_NAME = 'Leaf Co.,Ltd.';"]);
});

test('スタッフ画面：doGet() が画面を返し、Styles・Scripts が読み込まれる', () => {
  const gas = createLeafGas();
  const out = gas.g.doGet();
  const html = out.getContent();
  assert.equal(out.getTitle(), 'Leaf Co.,Ltd.｜勤怠管理');
  // ヘッダー：会社ロゴ（Logo.html の data URI）と「Leaf Co.,Ltd.」「勤怠管理」
  const logo = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'leaf-portal', 'gas', 'Logo.html'), 'utf8').trim();
  assert.ok(html.includes('<img class="brand-logo" src="' + logo + '"'), 'ロゴは Logo.html の内容をそのまま使う');
  assert.match(html, /<span class="brand-name">Leaf Co\.,Ltd\.<\/span>/);
  assert.match(html, /<span class="brand-sub" id="brandSub">勤怠管理<\/span>/);
  assert.match(html, /<footer class="site-footer">Leaf Co\.,Ltd\.<span class="app-build" id="appBuild">版 [^<]+<\/span><\/footer>/);
  assert.doesNotMatch(html, /リーフ 社内ポータル|brand-mark/, '古い表記・葉っぱアイコンは残っていない');
  assert.equal(out.faviconUrl, undefined, 'favicon のURLが未設定なら設定しない');
  assert.equal(out.metaTags.viewport, 'width=device-width, initial-scale=1');
  assert.ok(html.includes('<style>') && html.includes('function callGas'));
  assert.doesNotMatch(html, /<\?/, 'テンプレートの記号が残っていない');
  // 画面から呼ぶ関数はすべてサーバーに存在し、管理者用の関数は許可リストに入っていない
  const allowed = JSON.parse(html.match(/ALLOWED_FUNCTIONS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  for (const fn of allowed) assert.equal(typeof gas.g[fn], 'function', fn);
  for (const fn of ['requireAdmin', 'getAllAttendance', 'getDailyAttendance', 'getMonthlyAttendance', 'approveCorrectionRequest', 'approveOvertimeRequest', 'exportAttendanceCsv', 'setupSystem']) {
    assert.ok(!allowed.includes(fn), fn);
  }
});

test('スタッフ画面：getStaffDashboard() は本人の情報だけをまとめて返す', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 09:30');
  let r = gas.g.getStaffDashboard();
  assert.equal(r.success, true);
  assert.deepEqual(Object.keys(r.data).sort(), ['flex', 'month', 'overtime', 'overtimeRule', 'staffStatus', 'today', 'transport', 'user']);
  assert.deepEqual(plain(r.data.overtimeRule.data), { freeLimitMinutes: 30, freeLimitLabel: '30分' }, '設定シートの 00:30');
  assert.deepEqual(r.data.overtime.data, [], '固定勤務は自分の残業申請（まだ0件）');
  assert.equal(r.data.user.data.employeeId, 'E002');
  assert.equal(r.data.today.data.record, null, '未出勤');
  assert.equal(r.data.flex.data, null, '固定勤務はフレックス集計なし');
  gas.g.clockIn('出社');
  r = gas.g.getStaffDashboard(['today', 'staffStatus']);
  assert.deepEqual(Object.keys(r.data).sort(), ['staffStatus', 'today']);
  assert.equal(r.data.today.data.record.status, '勤務中');
  for (const s of r.data.staffStatus.data.staff) assert.deepEqual(Object.keys(s).sort(), ['isSelf', 'label', 'name', 'status', 'workStyle']);
  assert.deepEqual(r.data.staffStatus.data.staff.filter((s) => s.isSelf).map((s) => s.name), ['佐藤'], '自分の行だけ isSelf');

  // 同姓同名がいても、「自分」は社員IDで判定されるので1人だけ
  gas.g.appendRecords_('スタッフマスタ', [{ '社員ID': 'E099', '氏名': '佐藤', 'メールアドレス': 'sato2@example.com', '権限': 'staff', '勤務区分': '固定勤務', '在籍状況': '在籍' }]);
  const same = gas.g.getTodayStaffStatus().data.staff.filter((s) => s.name === '佐藤');
  assert.deepEqual(same.map((s) => s.isSelf), [true, false]);

  // 画面から社員IDを渡しても無視され、他人の情報は取れない
  gas.loginAs(FLEX);
  r = gas.g.getStaffDashboard('E002');
  assert.equal(r.data.user.data.employeeId, 'E003');
  assert.equal(r.data.today.data.record, null);
  assert.equal(r.data.flex.data.employeeId, 'E003');
  assert.equal(r.data.month.data.records.length, 0);
  r = gas.g.getStaffDashboard(['requireAdmin', 'today']);
  assert.deepEqual(Object.keys(r.data).sort(), ['today'], '決められた名前以外は無視');

  // ログインユーザーを確認できないときは、各項目が失敗として返る（画面全体は落ちない）
  gas.loginAs('');
  r = gas.g.getStaffDashboard();
  assert.equal(r.success, true);
  for (const k of ['user', 'today', 'month', 'staffStatus']) assert.equal(r.data[k].success, false, k);
  assert.match(r.data.user.message, /メールアドレスを取得できませんでした/);
  assert.equal(gas.main.rows('勤怠記録').length, 1, '読み取りだけで何も書き込まない');
});

test('setupSystem などはWebアプリ経由（操作者≠所有者）では実行できない', () => {
  const gas = ready();
  gas.g.Session.getEffectiveUser = () => ({ getEmail: () => ADMIN }); // 「自分として実行」＝所有者
  gas.loginAs(FIXED); // ブラウザで操作しているスタッフ
  for (const fn of ['setupSystem', 'addSampleStaff', 'runAllScenarioTests']) {
    assert.throws(() => gas.g[fn](), /Webアプリからは実行できません/, fn);
  }
  gas.loginAs('');
  assert.throws(() => gas.g.setupSystem(), /Webアプリからは実行できません/);
  gas.loginAs(ADMIN); // エディタで所有者が実行
  assert.doesNotThrow(() => gas.g.setupSystem());
  assert.equal(gas.g.runAllScenarioTests().failed, 0);
});

test('自動テスト（runAllScenarioTests）は Google 実機と同じ 43件', () => {
  const gas = createLeafGas();
  const r = gas.g.runAllScenarioTests();
  assert.equal(r.results.length, 43);
  assert.equal(r.failed, 0);
});

// ============================================================ 管理者画面

/** 管理者画面のテスト用：6/1(月) に固定・フレックスが勤務、固定は残業・申請あり */
/** 日報_未提出判定開始日を入れる（段階5の修正：空欄の間は日報の未提出を判定しない） */
function setReportMissingFrom(gas, value) {
  gas.main.getSheetByName('設定').data.find((r) => r[0] === '日報_未提出判定開始日')[1] = value;
  gas.g.clearTableCache_();
}

function adminReady() {
  const gas = ready();
  setReportMissingFrom(gas, '2026-01-01');
  gas.g.appendRecords_('スタッフマスタ', [{ '社員ID': 'E004', '氏名': '田中', 'メールアドレス': 'tanaka@example.com', '権限': 'staff', '勤務区分': '固定勤務', '在籍状況': '在籍', '部署': '営業部' }]);
  const staff = gas.main.getSheetByName('スタッフマスタ');
  staff.data[2][13] = '設計部'; // 佐藤の部署
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 09:40');
  gas.g.clockIn('出社');
  gas.setNow('2026-06-01 19:12');
  gas.g.clockOut();
  gas.loginAs(FLEX);
  gas.setNow('2026-06-01 10:00');
  gas.g.clockIn('在宅');
  gas.setNow('2026-06-01 12:00');
  gas.g.startBreak('');
  return gas;
}

test('管理者画面 1・2：一般スタッフは管理者データを取得できず、adminは取得できる', () => {
  const gas = adminReady();
  gas.setNow('2026-06-01 20:00');
  for (const who of [FIXED, FLEX, 'nobody@example.com', '']) {
    gas.loginAs(who);
    for (const [fn, args] of [
      ['getAdminDashboard', [{}]], ['exportAdminAttendanceCsv', [{ type: 'monthly' }]], ['approveCorrectionRequest', ['x']],
      ['rejectCorrectionRequest', ['x', 'y']], ['approveOvertimeRequest', ['x']], ['rejectOvertimeRequest', ['x', 'y']],
      ['recalculateThisMonth', []], ['exportAttendanceCsv', []],
    ]) {
      const r = gas.g[fn](...args);
      assert.equal(r.success, false, who + ' ' + fn);
      assert.equal(r.data, null, '管理者データを一切返さない：' + fn);
      if (who === FIXED || who === FLEX) assert.match(r.message, /管理者権限がありません/, fn);
    }
  }
  gas.loginAs(ADMIN);
  const r = gas.g.getAdminDashboard({ date: '2026-06-01' });
  assert.equal(r.success, true, r.message);
  assert.deepEqual(Object.keys(r.data).sort(), ['admin', 'corrections', 'daily', 'date', 'flex', 'holidayWork', 'month', 'monthly', 'overtime', 'paidLeave', 'reports', 'restDays', 'shiftEnabled', 'summary', 'today']);
  assert.equal(r.data.admin.name, '山田');
  // 取得したい情報だけ返す（不要な大量データを返さない）
  const part = gas.g.getAdminDashboard({ date: '2026-06-01', parts: ['summary', 'setupSystem'] });
  assert.deepEqual(Object.keys(part.data).sort(), ['date', 'month', 'shiftEnabled', 'summary', 'today']);
});

test('管理者画面 3：日別一覧とサマリー（本日出勤・在宅・中断中・打刻漏れ・残業要確認）', () => {
  const gas = adminReady();
  gas.loginAs(ADMIN);
  gas.setNow('2026-06-01 20:00');
  const r = gas.g.getAdminDashboard({ date: '2026-06-01' });
  const s = r.data.summary;
  assert.deepEqual([s.present, s.remote, s.working, s.onBreak, s.finished, s.notStarted], [2, 1, 0, 1, 1, 2]);
  assert.equal(s.overtimeNeedsCheck, 1);
  assert.equal(s.missingPunchStaff, 0, '今日の中断中は打刻漏れではない');
  const rows = r.data.daily.rows;
  assert.deepEqual(rows.map((x) => x.name + ':' + x.status), ['山田:未出勤', '佐藤:退勤済み', '鈴木:中断中', '田中:未出勤']);
  const sato = rows.find((x) => x.name === '佐藤');
  assert.equal(sato.department, '設計部');
  assert.equal(sato.late, '00:10');
  assert.equal(sato.internalExcess, '00:42');
  assert.equal(sato.workTime, '08:32', '勤務時間は丸めない');
  assert.equal(sato.needsCheck, '要確認');
  assert.equal(sato.preOvertimeRequest, 'なし');
  assert.equal(rows.find((x) => x.name === '鈴木').late, '', 'フレックスは遅刻判定なし');

  // 翌日になると、退勤していない・再開していない記録は打刻漏れになる
  gas.setNow('2026-06-03 09:00');
  const next = gas.g.getAdminDashboard({ date: '2026-06-01' });
  assert.deepEqual(next.data.daily.rows.find((x) => x.name === '鈴木').issues, ['退勤なし', '再開なし']);
  assert.equal(next.data.summary.missingPunchStaff, 1);
  // 状態と記録の矛盾
  const sheet = gas.main.getSheetByName('勤怠記録');
  sheet.data[1][sheet.data[0].indexOf('状態')] = '勤務中';
  assert.deepEqual(gas.g.getAdminDashboard({ date: '2026-06-01' }).data.daily.rows.find((x) => x.name === '佐藤').issues, ['状態と記録が不一致']);
});

test('管理者画面 4：月別一覧（固定の合計・フレックスの残り）', () => {
  const gas = adminReady();
  gas.loginAs(FLEX);
  gas.setNow('2026-06-01 12:30');
  gas.g.resumeWork();
  gas.setNow('2026-06-01 19:30');
  gas.g.clockOut();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-02 09:00');
  gas.g.submitCorrectionRequest({ targetDate: '2026-06-01', item: '退勤', after: '18:30', reason: 'x' });
  gas.loginAs(ADMIN);
  const m = gas.g.getAdminDashboard({ month: '2026-06', parts: ['monthly'] }).data.monthly;
  assert.equal(m.from, '2026-05-21', '20日締め：6月分＝5/21〜6/20');
  assert.equal(m.to, '2026-06-20');
  assert.equal(m.periodText, '2026年6月分 対象期間：2026/05/21〜2026/06/20');
  const sato = m.rows.find((x) => x.name === '佐藤');
  assert.deepEqual([sato.workDays, sato.workTime, sato.lateTotal, sato.lateCount, sato.internalExcessTotal, sato.needsCheckCount, sato.correctionCount, sato.flex],
    [1, '08:32', '00:10', 1, '00:42', 1, 1, null]);
  const suzuki = m.rows.find((x) => x.name === '鈴木');
  assert.deepEqual(suzuki.flex, { scheduled: '138:00', worked: '08:00', remaining: '130:00', excess: '00:00', paidLeave: '00:00', paidLeaveMode: '未確定' });
  assert.equal(suzuki.internalExcessTotal, '00:00');
});

test('管理者画面 5・6：打刻修正申請の承認（再計算）と却下（理由・承認者・日時）', () => {
  const gas = adminReady();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-02 09:00');
  const a = gas.g.submitCorrectionRequest({ targetDate: '2026-06-01', item: '出勤', after: '09:30', reason: '打刻が遅れた' }).data.requestId;
  const b = gas.g.submitCorrectionRequest({ targetDate: '2026-06-01', item: '退勤', after: '18:40', reason: '押し間違い' }).data.requestId;
  gas.loginAs(ADMIN);
  let d = gas.g.getAdminDashboard({ parts: ['corrections'] }).data.corrections;
  assert.equal(d.pendingCount, 2);
  assert.equal(d.pending[0].department, '設計部');

  assert.equal(gas.g.approveCorrectionRequest(a).success, true);
  const row = gas.g.getAdminDashboard({ date: '2026-06-01', parts: ['daily'] }).data.daily.rows.find((x) => x.name === '佐藤');
  assert.deepEqual([row.clockIn, row.late, row.workTime, row.correctionStatus], ['09:30', '', '08:42', '申請中']);

  assert.match(gas.g.rejectCorrectionRequest(b, '').message, /却下理由/);
  assert.equal(gas.g.rejectCorrectionRequest(b, '記録どおりです').success, true);
  const rec = gas.main.rows('打刻修正申請').find((x) => x['申請ID'] === b);
  assert.equal(rec['ステータス'], '却下');
  assert.equal(rec['却下理由'], '記録どおりです');
  assert.equal(rec['承認者'], '山田');
  assert.match(rec['承認日時'], /^2026-06-02 09:00/);
  d = gas.g.getAdminDashboard({ parts: ['corrections'] }).data.corrections;
  assert.equal(d.pendingCount, 0);
  assert.equal(d.processed.length, 2);
  assert.equal(gas.g.approveCorrectionRequest(a).success, false, '二重に承認できない');
});

test('管理者画面 7・8：残業申請の承認で要確認が消え、却下では残る', () => {
  const gas = adminReady();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-02 08:00');
  const ok = gas.g.submitOvertimeRequest({ targetDate: '2026-06-02', plannedStart: '18:30', plannedEnd: '19:30', reason: '図面' }).data.requestId;
  const ng = gas.g.submitOvertimeRequest({ targetDate: '2026-06-03', plannedStart: '18:30', plannedEnd: '19:30', reason: '図面' }).data.requestId;
  for (const day of ['2026-06-02', '2026-06-03']) {
    gas.setNow(day + ' 09:30'); gas.g.clockIn('出社');
    gas.setNow(day + ' 19:12'); gas.g.clockOut();
  }
  gas.loginAs(ADMIN);
  gas.setNow('2026-06-04 09:00');
  assert.equal(gas.g.getAdminDashboard({ parts: ['overtime'] }).data.overtime.pendingCount, 2);
  assert.equal(gas.g.approveOvertimeRequest(ok).success, true);
  assert.equal(gas.g.rejectOvertimeRequest(ng, '業務上不要').success, true);
  const daily = (date) => gas.g.getAdminDashboard({ date, parts: ['daily'] }).data.daily.rows.find((x) => x.name === '佐藤');
  assert.deepEqual([daily('2026-06-02').preOvertimeRequest, daily('2026-06-02').needsCheck, daily('2026-06-02').internalExcess], ['承認済み', '', '00:42']);
  assert.deepEqual([daily('2026-06-03').preOvertimeRequest, daily('2026-06-03').needsCheck], ['却下', '要確認']);
  const list = gas.g.getAdminDashboard({ parts: ['overtime'] }).data.overtime;
  assert.equal(list.processed.find((x) => x.requestId === ok).actualOvertime, '00:42');
  assert.match(list.processed.find((x) => x.requestId === ng).note, /業務上不要/);
});

test('管理者画面 9：今月の勤怠を再計算', () => {
  const gas = adminReady();
  const sheet = gas.main.getSheetByName('勤怠記録');
  sheet.data[1][sheet.data[0].indexOf('退勤')] = '18:40';
  gas.loginAs(ADMIN);
  gas.setNow('2026-06-05 09:00');
  const r = gas.g.recalculateThisMonth();
  assert.equal(r.success, true, r.message);
  const row = gas.g.getAdminDashboard({ date: '2026-06-01', parts: ['daily'] }).data.daily.rows.find((x) => x.name === '佐藤');
  assert.deepEqual([row.clockOut, row.internalExcess, row.needsCheck], ['18:40', '00:10', '']);
});

test('管理者画面 10：CSV（日別・月別。部署入り・BOM付き・式にならない）', () => {
  const gas = adminReady();
  gas.main.getSheetByName('スタッフマスタ').data[2][13] = '=HYPERLINK("x")';
  gas.loginAs(ADMIN);
  gas.setNow('2026-06-05 09:00');
  let r = gas.g.exportAdminAttendanceCsv({ type: 'monthly', month: '2026-06' });
  assert.equal(r.success, true);
  assert.equal(r.data.fileName, 'kintai_monthly_2026-06.csv');
  const lines = r.data.csv.split('\r\n');
  assert.ok(lines[0].startsWith('﻿日付,社員ID,氏名,部署,勤務区分,勤務形態,出勤,退勤,自動休憩,中断合計,実働,遅刻,早退,社内超過,事前残業申請,要確認,打刻漏れ,打刻修正状況,状態,勤務場所,勤務区間数,出社時間,在宅時間,日備考,出張,直行,直帰,現場,業務走行距離,交通費合計,日の区分,有給種別,有給時間,要確認（申請）,休日出勤時間,日報,要確認の理由'));
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^2026-06-01,E002,佐藤,"'=HYPERLINK\(""x""\)",固定勤務,出社,09:40,19:12,01:00,00:00,08:32,00:10,,00:42,なし,要確認,,,退勤済み,会社,1,09:32,00:00,,,,,,,,,,,,,未提出,残業：30分以上で承認済みの事前申請なし・日報未提出$/, '勤務区間・付帯情報・交通費の列は右端に足す（勤務場所は会社と表示）。段階5：休日出勤時間・日報・要確認の理由');
  r = gas.g.exportAdminAttendanceCsv({ type: 'daily', date: '2026-06-02' });
  assert.equal(r.data.csv.split('\r\n').length, 1, 'その日の記録がなければ見出しだけ');
});

test('管理者画面 11：週1日完全休日の警告（問題のある人だけ）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  for (let d = 21; d <= 27; d++) {
    const date = '2026-09-' + d;
    gas.setNow(date + ' 09:30'); gas.g.clockIn('出社');
    gas.setNow(date + ' 18:30'); gas.g.clockOut();
  }
  gas.loginAs(ADMIN);
  gas.setNow('2026-09-29 09:00');
  const r = gas.g.getAdminDashboard({ date: '2026-09-23', parts: ['restDays'] }).data.restDays;
  assert.deepEqual([r.from, r.to], ['2026-09-21', '2026-09-27']);
  assert.deepEqual(r.rows.map((x) => x.name + ':' + x.status + ':' + x.restDays), ['佐藤:不足:0'], '休みを取れた人は出さない');
  gas.setNow('2026-09-28 09:00'); // 週の初日（月曜）：まだ誰も今週の完全休日が確定していない
  const now = gas.g.getAdminDashboard({ date: '2026-09-28', parts: ['restDays'] }).data.restDays;
  assert.deepEqual(now.rows, [], '今週の途中は「不足」の警告にしない');
  assert.deepEqual(now.pending.map((x) => x.name).sort(), ['佐藤', '山田', '鈴木'].sort(), '未確定は別枠');
  assert.deepEqual([now.previous.from, now.previous.to], ['2026-09-21', '2026-09-27']);
  assert.deepEqual(now.previous.rows.map((x) => x.name + ':' + x.status), ['佐藤:不足'], '前の週の確定した不足は警告に出す');
});

test('管理者画面 12：日報の提出状況（出勤ありで日報なし＝未提出、下書きだけ＝未提出（下書きあり）・内容は返さない、出勤なし＝対象外）', () => {
  const gas = adminReady();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 19:20');
  const id = gas.g.saveDailyReport({ workContent: '現場確認', issues: '資材の遅れ' }).data.reportId;
  gas.loginAs(FLEX);
  gas.g.saveDailyReport({ workContent: '下書きの秘密メモ', status: '下書き' });
  gas.loginAs(ADMIN);
  let rep = gas.g.getAdminDashboard({ date: '2026-06-01', parts: ['reports'] }).data.reports;
  assert.deepEqual(rep.rows.map((x) => x.name + ':' + x.status), ['山田:対象外', '佐藤:提出済み', '鈴木:未提出（下書きあり）', '田中:対象外']);
  assert.deepEqual([rep.submittedCount, rep.notSubmittedCount, rep.draftOnlyCount, rep.noneCount], [1, 1, 1, 2]);
  assert.doesNotMatch(JSON.stringify(rep), /下書きの秘密メモ|資材の遅れ/, '管理者画面の一覧に本文は返さない（下書きは特に）');
  assert.equal(rep.rows.find((x) => x.name === '鈴木').workStyle, '在宅');
  const sato = rep.rows.find((x) => x.name === '佐藤');
  assert.deepEqual([sato.reportId, sato.confirmedCount, sato.targetCount], [id, 0, 3]);
  assert.equal(gas.g.confirmDailyReport(id).success, true);
  rep = gas.g.getAdminDashboard({ date: '2026-06-01', parts: ['reports'] }).data.reports;
  assert.equal(rep.rows.find((x) => x.name === '佐藤').confirmedCount, 1);
});

test('管理者画面：フレックス管理（週・月）と画面の許可リスト', () => {
  const gas = adminReady();
  gas.loginAs(ADMIN);
  gas.setNow('2026-06-01 20:00');
  const f = gas.g.getAdminDashboard({ date: '2026-06-01', parts: ['flex'] }).data.flex;
  assert.deepEqual(f.rows.map((x) => x.name), ['鈴木']);
  assert.deepEqual([f.rows[0].week.scheduled, f.rows[0].month.scheduled], ['32:00', '138:00']);
  // 画面の管理者用の許可リストはすべて requireAdmin を通る関数
  const html = gas.g.doGet({ parameter: { view: 'admin' } }).getContent();
  assert.match(html, /data-initial-view="admin"/);
  assert.match(gas.g.doGet({ parameter: { view: '<script>' } }).getContent(), /data-initial-view="staff"/);
  const list = JSON.parse(html.match(/ADMIN_FUNCTIONS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  gas.loginAs(FIXED);
  for (const fn of list) {
    const r = gas.g[fn]({}, 'x');
    assert.equal(r.success, false, fn);
    assert.match(r.message, /管理者権限がありません/, fn);
  }
});

// ============================================================ 残業申請フォーム（スタッフ画面）

test('残業申請 1〜9：申請できる条件とエラー', () => {
  const gas = ready();
  gas.setNow('2026-06-01 10:00');
  const req = (over) => ({ targetDate: '2026-06-01', plannedStart: '18:30', plannedEnd: '19:15', reason: '図面の修正', ...over });

  gas.loginAs(FIXED);
  // 1. 固定勤務は申請できる（社員ID・氏名はサーバー側でログインユーザーから入る）
  let r = gas.g.submitOvertimeRequest(req({ employeeId: 'E003', name: 'なりすまし' }));
  assert.equal(r.success, true, r.message);
  assert.equal(r.data.plannedOvertime, '00:45');
  const row = gas.main.rows('残業申請')[0];
  assert.deepEqual([row['社員ID'], row['氏名'], row['ステータス'], row['予定開始'], row['予定終了'], row['予定残業時間']], ['E002', '佐藤', '承認待ち', '18:30', '19:15', '00:45']);
  // 9. 同じ日の二重申請（承認待ち・承認済みがある）
  assert.match(gas.g.submitOvertimeRequest(req({ plannedEnd: '20:00' })).message, /すでに提出されています（ステータス：承認待ち）/);

  const day = (d) => '2026-06-0' + d;
  // 3. 30分未満は申請不要（保存しない）
  assert.match(gas.g.submitOvertimeRequest(req({ targetDate: day(2), plannedEnd: '18:59' })).message, /30分未満の残業は事前申請不要です/);
  // 4. 30分ちょうどは申請できる / 5. 31分も申請できる
  assert.equal(gas.g.submitOvertimeRequest(req({ targetDate: day(3), plannedEnd: '19:00' })).data.plannedOvertime, '00:30');
  assert.equal(gas.g.submitOvertimeRequest(req({ targetDate: day(4), plannedEnd: '19:01' })).data.plannedOvertime, '00:31');
  // 6. 過去日は拒否
  assert.match(gas.g.submitOvertimeRequest(req({ targetDate: '2026-05-31' })).message, /過去の日付は申請できません/);
  // 7. 終了時刻が開始以前
  assert.match(gas.g.submitOvertimeRequest(req({ targetDate: day(5), plannedEnd: '18:30' })).message, /予定終了は予定開始より後/);
  assert.match(gas.g.submitOvertimeRequest(req({ targetDate: day(5), plannedEnd: '17:00' })).message, /予定終了は予定開始より後/);
  // 8. 理由なし・未入力
  assert.match(gas.g.submitOvertimeRequest(req({ targetDate: day(5), reason: '  ' })).message, /申請理由を入力してください/);
  assert.match(gas.g.submitOvertimeRequest(req({ targetDate: '' })).message, /対象日/);
  assert.match(gas.g.submitOvertimeRequest(req({ targetDate: day(5), plannedStart: '' })).message, /予定開始/);
  assert.match(gas.g.submitOvertimeRequest(req({ targetDate: day(5), plannedEnd: '' })).message, /予定終了/);

  // 2. フレックス社員は対象外（申請できない・画面用データも出さない）
  gas.loginAs(FLEX);
  assert.match(gas.g.submitOvertimeRequest(req({ targetDate: day(5) })).message, /フレックス勤務の方は、残業申請の対象外です/);
  assert.equal(gas.g.getStaffDashboard(['overtime']).data.overtime.data, null);
  assert.equal(gas.main.rows('残業申請').length, 3, 'エラーのときは保存しない');
});

test('残業申請 10〜12：自分の申請だけ取得・管理者の承認/却下が本人に反映', () => {
  const gas = ready();
  gas.g.appendRecords_('スタッフマスタ', [{ '社員ID': 'E004', '氏名': '田中', 'メールアドレス': 'tanaka@example.com', '権限': 'staff', '勤務区分': '固定勤務', '在籍状況': '在籍' }]);
  gas.setNow('2026-06-01 10:00');
  gas.loginAs(FIXED);
  const a = gas.g.submitOvertimeRequest({ targetDate: '2026-06-01', plannedStart: '18:30', plannedEnd: '19:30', reason: 'A' }).data.requestId;
  const b = gas.g.submitOvertimeRequest({ targetDate: '2026-06-02', plannedStart: '18:30', plannedEnd: '19:30', reason: 'B' }).data.requestId;
  gas.loginAs('tanaka@example.com');
  gas.g.submitOvertimeRequest({ targetDate: '2026-06-01', plannedStart: '18:30', plannedEnd: '20:00', reason: '田中の申請' });

  // 10. 自分の申請だけ
  gas.loginAs(FIXED);
  let mine = gas.g.getStaffDashboard(['overtime']).data.overtime.data;
  assert.deepEqual(mine.map((x) => x.reason).sort(), ['A', 'B']);
  assert.deepEqual(gas.g.getMyOvertimeRequests().data.map((x) => x.employeeId), ['E002', 'E002']);
  assert.match(gas.g.approveOvertimeRequest(a).message, /管理者権限がありません/, '一般スタッフは承認できない');

  // 11・12. 管理者が承認・却下 → 本人の画面に反映（却下理由も見える）
  gas.loginAs(ADMIN);
  assert.equal(gas.g.getAdminDashboard({ parts: ['overtime'] }).data.overtime.pendingCount, 3, '管理者画面に自動で表示');
  assert.equal(gas.g.approveOvertimeRequest(a).success, true);
  assert.equal(gas.g.rejectOvertimeRequest(b, '別の日に調整してください').success, true);
  gas.loginAs(FIXED);
  mine = gas.g.getStaffDashboard(['overtime']).data.overtime.data;
  const byReason = Object.fromEntries(mine.map((x) => [x.reason, x]));
  assert.equal(byReason.A.status, '承認済み');
  assert.equal(byReason.B.status, '却下');
  assert.match(byReason.B.note, /却下理由：別の日に調整してください/);
  // 却下された日は、もう一度申請できる
  assert.equal(gas.g.submitOvertimeRequest({ targetDate: '2026-06-02', plannedStart: '18:30', plannedEnd: '19:00', reason: '再申請' }).success, true);
});

test('残業申請 13・14：承認済みなら要確認なし、承認待ちのままなら要確認（実績は丸めない）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 10:00');
  const approved = gas.g.submitOvertimeRequest({ targetDate: '2026-06-01', plannedStart: '18:30', plannedEnd: '19:15', reason: '承認される' }).data.requestId;
  gas.g.submitOvertimeRequest({ targetDate: '2026-06-02', plannedStart: '18:30', plannedEnd: '19:15', reason: '承認待ちのまま' });
  gas.loginAs(ADMIN);
  gas.g.approveOvertimeRequest(approved);
  gas.loginAs(FIXED);
  for (const d of ['2026-06-01', '2026-06-02']) {
    gas.setNow(d + ' 09:30'); gas.g.clockIn('出社');
    gas.setNow(d + ' 19:12'); gas.g.clockOut();
  }
  const rows = gas.main.rows('勤怠記録');
  // 13. 予定 18:30〜19:15（承認済み）・実績 19:12 → 社内超過 00:42、要確認なし
  assert.deepEqual([rows[0]['社内超過時間'], rows[0]['事前残業申請'], rows[0]['要確認'], rows[0]['退勤']], ['00:42', '承認済み', '', '19:12']);
  // 14. 承認待ちは承認済み扱いにしない → 要確認
  assert.deepEqual([rows[1]['社内超過時間'], rows[1]['事前残業申請'], rows[1]['要確認']], ['00:42', '承認待ち', '要確認']);
  // 実績残業は予定（00:45）と別に保存し、予定に丸めない
  const ot = gas.main.rows('残業申請');
  assert.deepEqual([ot[0]['予定残業時間'], ot[0]['実績残業']], ['00:45', '00:42']);
  assert.deepEqual([ot[1]['予定残業時間'], ot[1]['実績残業']], ['00:45', '00:42']);
});

test('残業申請 15：同じ申請を続けて送っても1件だけ（ロック＋二重申請チェック）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 10:00');
  const req = { targetDate: '2026-06-01', plannedStart: '18:30', plannedEnd: '19:30', reason: '連打' };
  const results = [1, 2, 3, 4, 5].map(() => gas.g.submitOvertimeRequest(req));
  assert.equal(results.filter((r) => r.success).length, 1);
  assert.equal(gas.main.rows('残業申請').length, 1);
  assert.ok(results.slice(1).every((r) => /すでに提出されています/.test(r.message)));
});

test('残業申請：申請不要の上限は設定シート「残業_申請不要上限」を使う（画面用の値とサーバーの判定）', () => {
  const gas = ready();
  const settings = gas.main.getSheetByName('設定');
  const row = settings.data.findIndex((r) => r[0] === '残業_申請不要上限');
  const req = (end, date) => ({ targetDate: date, plannedStart: '18:30', plannedEnd: end, reason: '図面' });
  gas.loginAs(FIXED);
  gas.setNow('2026-06-01 10:00');

  settings.data[row][1] = '00:45';
  assert.deepEqual(plain(gas.g.getStaffDashboard(['overtimeRule']).data.overtimeRule.data), { freeLimitMinutes: 45, freeLimitLabel: '45分' });
  let r = gas.g.submitOvertimeRequest(req('19:14', '2026-06-01'));
  assert.match(r.message, /^45分未満の残業は事前申請不要です（予定残業時間：00:44）$/);
  assert.equal(gas.g.submitOvertimeRequest(req('19:15', '2026-06-01')).success, true, '45分ちょうどは申請できる');

  settings.data[row][1] = '01:30';
  assert.equal(gas.g.getStaffDashboard(['overtimeRule']).data.overtimeRule.data.freeLimitLabel, '1時間30分');
  assert.match(gas.g.submitOvertimeRequest(req('19:59', '2026-06-02')).message, /^1時間30分未満の残業は事前申請不要です/);
  assert.equal(gas.g.submitOvertimeRequest(req('20:00', '2026-06-02')).success, true);

  settings.data[row][1] = '00:30';
  assert.match(gas.g.submitOvertimeRequest(req('18:59', '2026-06-03')).message, /^30分未満の残業は事前申請不要です/);
  assert.deepEqual([0, 30, 60, 75].map((m) => gas.g.formatDurationLabel_(m)), ['0分', '30分', '1時間', '1時間15分']);

  gas.loginAs(FLEX);
  assert.equal(gas.g.getStaffDashboard(['overtimeRule']).data.overtimeRule.data, null, 'フレックスには返さない');
  gas.loginAs('nobody@example.com');
  assert.equal(gas.g.getStaffDashboard(['overtimeRule']).data.overtimeRule.success, false, '未登録なら返さない');
});

test('ロゴ：assets/logo.png から Logo.html を作る（PNG以外・大きすぎる画像は止める）', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { buildLogo } = require('../leaf-portal/tools/build-logo');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logo-'));
  const out = path.join(dir, 'Logo.html');
  const png = path.join(__dirname, '..', 'leaf-portal', 'assets', 'logo.png');
  buildLogo(png, out);
  assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'leaf-portal', 'gas', 'Logo.html'), 'utf8'), 'リポジトリの Logo.html は最新の logo.png から作られている');
  const notPng = path.join(dir, 'x.png');
  fs.writeFileSync(notPng, 'hello');
  assert.throws(() => buildLogo(notPng, out), /PNG 画像ではありません/);
  const big = path.join(dir, 'big.png');
  fs.writeFileSync(big, Buffer.concat([fs.readFileSync(png).subarray(0, 8), Buffer.alloc(300 * 1024)]));
  assert.throws(() => buildLogo(big, out), /大きすぎます/);
});

test('ロゴ：Logo.html の中身が画像の形でなければ、ロゴなし（会社名だけ）で表示する', () => {
  const gas = createLeafGas();
  const real = gas.g.HtmlService.createHtmlOutputFromFile;
  gas.g.HtmlService.createHtmlOutputFromFile = (name) => (name === 'Logo' ? { getContent: () => '"><script>alert(1)</script>' } : real(name));
  const html = gas.g.doGet().getContent();
  assert.doesNotMatch(html, /<img class="brand-logo"|alert\(1\)/);
  assert.match(html, /<span class="brand-name">Leaf Co\.,Ltd\.<\/span>/);
});

test('HTML：コメントや説明文の中にテンプレートの記号（<? <?= <?!=）がない', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'leaf-portal', 'gas');
  const problems = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    // HTMLコメントの中（Apps Script はコメントの中の記号も実行しようとする）
    for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) {
      if (m[0].includes('<?')) problems.push(file + '：コメントの中に「<?」があります');
    }
    // 中身が空の <?= ?> / <?!= ?>
    if (/<\?!?=\s*\?>/.test(text)) problems.push(file + '：中身が空の <?= ?> / <?!= ?> があります');
    // テンプレートとして評価するのは Index.html だけ。ほかのファイルに記号があると、そのまま画面に出てしまう
    if (file !== 'Index.html' && text.includes('<?')) problems.push(file + '：テンプレートではないファイルに「<?」があります');
  }
  assert.deepEqual(problems, []);
});

test('テスト用のまね：空のスクリプトレットは本物の Apps Script と同じく構文エラーになる', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'leaf-portal', 'gas', 'Index.html');
  const original = fs.readFileSync(file, 'utf8');
  const gas = createLeafGas();
  const realRead = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => (String(p) === file ? original.replace('</body>', '<!-- 例：<?!= ?> --></body>') : realRead(p, ...rest));
  try {
    assert.throws(() => gas.g.doGet(), /Unexpected token ';'/);
  } finally {
    fs.readFileSync = realRead;
  }
  assert.doesNotThrow(() => gas.g.doGet(), '元の Index.html は正常に評価できる');
});
