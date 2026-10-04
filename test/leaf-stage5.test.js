'use strict';
// 段階5のテスト：社内詳細月次・社員別詳細CSV・接客集計・日報確認集計・月次CSVの追加・社労士確認用の詳細表・理由付き要確認一覧
// （すべて読み取りと集計だけ。法定時間外・週40時間・深夜・法定休日・割増はまだ計算しない）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const MITSUYAMA = 'hiroki@example.com'; // 役員・admin（勤怠集計 対象外）
const INOKURA = 'atsushi@example.com';  // 役員・staff（勤怠集計 対象外）
const OMORI = 'sachiko@example.com';    // フレックス
const MURATA = 'kiyoko@example.com';    // フレックス
const NAKATSUI = 'yuuki@example.com';   // 固定勤務
const KUBO = 'ayumi@example.com';       // 固定勤務

function office() {
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
  ]);
  const settings = gas.main.getSheetByName('設定');
  settings.data.find((r) => r[0] === '自動休憩_適用開始')[1] = '06:00'; // 本番と同じ
  gas.g.clearTableCache_();
  gas.setNow('2026-10-15 20:00');
  return gas;
}
const NOW = '2026-10-15 20:00';
/** steps: [['09:00','clockIn','出社'], ...] を date の時刻で順に実行 */
function run(gas, email, date, steps) {
  gas.loginAs(email);
  for (const [time, fn, arg] of steps) {
    gas.setNow(date + ' ' + time);
    const r = arg === undefined ? gas.g[fn]() : gas.g[fn](arg);
    assert.equal(r.success, true, date + ' ' + time + ' ' + fn + '：' + r.message);
  }
  gas.setNow(NOW);
}
const work = (gas, email, date, from, to, style) => run(gas, email, date, [[from, 'clockIn', style || '出社'], [to, 'clockOut']]);
const asAdmin = (gas) => { gas.loginAs(MITSUYAMA); gas.setNow(NOW); };
const month = (gas, id) => { asAdmin(gas); const r = gas.g.getAdminEmployeeMonth(id, '2026-10'); assert.equal(r.success, true, r.message); return r.data; };
const dayOf = (m, date) => m.days.find((d) => d.date === date);
const csvLines = (res) => res.data.csv.replace(/^﻿/, '').split('\r\n');
const snapshot = (gas) => JSON.stringify(gas.main.sheets.map((s) => [s.getName(), s.data]));

// ============================================================ 社内詳細月次

test('社内詳細月次：20日締め（10月分＝9/21〜10/20）を1日1行。期間外（9/20・10/21）は入らない', () => {
  const gas = office();
  work(gas, NAKATSUI, '2026-09-20', '09:30', '18:30');
  work(gas, NAKATSUI, '2026-09-21', '09:30', '18:30');
  work(gas, NAKATSUI, '2026-10-20', '09:30', '18:30');
  const m = month(gas, 'E005');
  assert.deepEqual([m.from, m.to, m.days.length, m.periodText], ['2026-09-21', '2026-10-20', 30, '2026年10月分 対象期間：2026/09/21〜2026/10/20']);
  assert.deepEqual([m.days[0].date, m.days[0].weekday, m.days[0].workTime], ['2026-09-21', '月', '08:00']);
  assert.equal(m.totals.workDays, 2, '9/20 は9月分');
  assert.equal(dayOf(m, '2026-10-03').hasAttendance, false, '勤務のない日も1行');
});

test('社内詳細月次：複数区間・会社＋在宅・中断・再出勤・自動休憩（6:00ちょうど／6:01）は勤務区間と中断履歴から計算した値', () => {
  const gas = office();
  // 会社 9:00〜12:00 → 中断（私用）12:00〜12:30 → 在宅で再開 12:30〜15:00 → 退勤 → 在宅で再出勤 19:00〜20:00
  run(gas, NAKATSUI, '2026-10-01', [['09:00', 'clockIn', '出社'], ['12:00', 'startBreak', ''], ['12:30', 'resumeWork', '在宅'], ['15:00', 'clockOut'],
    ['19:00', 'clockIn', '在宅'], ['20:00', 'clockOut']]);
  // 同じ場所で中断 12:00〜13:00（私用の中抜け。昼休みは自動休憩）
  run(gas, NAKATSUI, '2026-10-02', [['09:00', 'clockIn', '出社'], ['12:00', 'startBreak', ''], ['13:00', 'resumeWork', '出社'], ['18:00', 'clockOut']]);
  work(gas, NAKATSUI, '2026-10-05', '09:00', '15:00'); // 6時間ちょうど → 自動休憩なし
  work(gas, NAKATSUI, '2026-10-06', '09:00', '15:01'); // 6時間01分 → 自動休憩1時間
  const m = month(gas, 'E005');
  const d1 = dayOf(m, '2026-10-01');
  assert.deepEqual([d1.workPlace, d1.segmentCount, d1.clockIn, d1.clockOut], ['会社＋在宅', 3, '09:00', '20:00']);
  assert.deepEqual(d1.segments.map((s) => s.place + ' ' + s.start + '〜' + s.end), ['会社 09:00〜12:00', '在宅 12:30〜15:00', '在宅 19:00〜20:00']);
  assert.deepEqual(d1.interruptions, [{ start: '12:00', end: '12:30' }]);
  // 区間 3:00＋2:30＋1:00＝6:30（区間の外の中断30分は区間に含まれないので二重に引かない）→ 6時間超なので自動休憩1:00 → 実働5:30
  assert.deepEqual([d1.breakTotal, d1.autoBreak, d1.workTime, d1.officeTime, d1.remoteTime], ['00:30', '01:00', '05:30', '03:00', '03:30']);
  // R-1（A案・現状維持）：中断は私用の中抜け、昼休みは自動休憩。実働＝勤務区間−中断−自動休憩
  const d2 = dayOf(m, '2026-10-02');
  assert.deepEqual([d2.breakTotal, d2.autoBreak, d2.workTime, d2.segmentCount], ['01:00', '01:00', '07:00', 1]);
  assert.deepEqual([dayOf(m, '2026-10-05').autoBreak, dayOf(m, '2026-10-05').workTime], ['00:00', '06:00'], '6時間ちょうどは引かない');
  assert.deepEqual([dayOf(m, '2026-10-06').autoBreak, dayOf(m, '2026-10-06').workTime], ['01:00', '05:01'], '6時間01分は1時間引く');
  assert.deepEqual([m.totals.workDays, m.totals.workTime, m.totals.breakTotal, m.totals.autoBreak], [4, '23:31', '01:30', '03:00']);
  // 勤怠記録の値と一致（勤怠記録は同じ計算で書かれている）
  const att = gas.main.rows('勤怠記録').find((r) => r['日付'] === '2026-10-01');
  assert.equal(att['実働時間'], d1.workTime);
});

test('社内詳細月次：休日出勤（承認済み）・1日有給・半休・直行・直帰・現場・出張・交通費・距離・残業申請・日報', () => {
  const gas = office();
  // 承認済みの休日出勤（10/4）
  gas.loginAs(NAKATSUI); gas.setNow('2026-10-01 09:00');
  const hw = gas.g.submitHolidayWorkRequest({ workDate: '2026-10-04', plannedStart: '09:00', plannedEnd: '17:00', reason: '立ち会い', content: '検査',
    compDayType: '未定', compDayDate: '', note: '', site: '' }).data.requestId;
  // 1日有給（10/7）・午後半休（10/8）
  const pl1 = gas.g.submitPaidLeaveRequest({ date: '2026-10-07', leaveType: '1日有給', reason: '私用' }).data.requestId;
  const pl2 = gas.g.submitPaidLeaveRequest({ date: '2026-10-08', leaveType: '午後半休', reason: '通院' }).data.requestId;
  gas.loginAs(MITSUYAMA);
  for (const id of [pl1, pl2]) assert.equal(gas.g.approvePaidLeaveRequest(id).success, true);
  assert.equal(gas.g.approveHolidayWorkRequest(hw).success, true);
  work(gas, NAKATSUI, '2026-10-04', '10:00', '16:00');
  work(gas, NAKATSUI, '2026-10-08', '09:30', '13:30');
  // 直行・現場・直帰・出張・交通費（10/9）
  run(gas, NAKATSUI, '2026-10-09', [['09:30', 'clockIn', '出社'], ['19:30', 'clockOut']]);
  gas.loginAs(NAKATSUI); gas.setNow('2026-10-10 09:00');
  assert.equal(gas.g.saveMyDayDetail({ date: '2026-10-09', businessTrip: true, dayNote: '熊本出張', segments: [{ number: 1, direct: true, directReturn: true, site: '堺市○○様邸', note: '' }] }).success, true);
  assert.equal(gas.g.addTransportExpense({ date: '2026-10-09', mode: '自家用車', km: '32.5', amount: '', purpose: '堺市○○様邸' }).success, true);
  assert.equal(gas.g.addTransportExpense({ date: '2026-10-09', mode: '駐車場', amount: '800', purpose: '堺市○○様邸' }).success, true);
  gas.loginAs(NAKATSUI); gas.setNow('2026-10-09 20:00');
  assert.equal(gas.g.submitReport({ workContent: '現場' }).success, true);
  const m = month(gas, 'E005');
  const d4 = dayOf(m, '2026-10-04');
  assert.deepEqual([d4.holidayWork, d4.holidayWorkTime, d4.late, d4.internalExcess], [true, '06:00', '', ''], '承認済み休日出勤：実働、遅刻・社内超過なし');
  const d7 = dayOf(m, '2026-10-07');
  assert.deepEqual([d7.hasAttendance, d7.leaveType, d7.leaveTime, d7.workTime], [false, '1日有給', '08:00', ''], '勤怠記録がない有給の日も出す');
  const d8 = dayOf(m, '2026-10-08');
  assert.deepEqual([d8.leaveType, d8.leaveTime, d8.workTime, d8.earlyLeave], ['午後半休', '04:00', '04:00', ''], '有給と実働は別々');
  const d9 = dayOf(m, '2026-10-09');
  assert.deepEqual([d9.direct, d9.directReturn, d9.sites, d9.businessTrip, d9.dayNote, d9.kmText, d9.transportAmount, d9.transportCount],
    [true, true, ['堺市○○様邸'], true, '熊本出張', '32.5km', 800, 2]);
  assert.deepEqual([d9.internalExcess, d9.overtimeRequest, d9.reportStatus], ['01:00', 'なし', '提出済み']);
  assert.deepEqual(d9.reasons.map((r) => r.category + ':' + r.text), ['残業:残業：30分以上で承認済みの事前申請なし']);
  const t = m.totals;
  assert.deepEqual([t.holidayWorkDays, t.holidayWorkTime, t.leaveDays, t.leaveTime, t.directDays, t.businessTripDays, t.kmText, t.transportAmount],
    [1, '06:00', 2, '12:00', 1, 1, '32.5km', 800]);
});

// ============================================================ 理由付き要確認一覧

test('要確認一覧：理由付き（打刻漏れ・残業申請なし・1日有給＋勤務・事後有給・日報未提出／下書き）。区分ごとの件数。今日までの日だけ', () => {
  const gas = office();
  run(gas, KUBO, '2026-10-01', [['09:30', 'clockIn', '出社']]); // 退勤なし（打刻漏れ）
  work(gas, KUBO, '2026-10-02', '09:30', '19:30');               // 社内超過1時間・事前申請なし
  gas.loginAs(KUBO); gas.setNow('2026-10-05 09:00');
  const late = gas.g.submitPaidLeaveRequest({ date: '2026-10-02', leaveType: '1日有給', reason: '体調不良' }).data.requestId; // 事後申請
  gas.loginAs(MITSUYAMA); gas.g.approvePaidLeaveRequest(late);
  gas.loginAs(KUBO); gas.setNow('2026-10-02 20:00');
  gas.g.saveReportDraft({ workContent: '途中' });                // 10/2 は下書きだけ
  work(gas, KUBO, '2026-10-16', '09:30', '18:30');               // 今日より後（10/15 時点では数えない）
  asAdmin(gas);
  const res = gas.g.getAdminMonthlyAnalysis('2026-10');
  assert.equal(res.success, true, res.message);
  const c = res.data.checks;
  assert.equal(c.until, '2026-10-15');
  const kubo = c.items.filter((x) => x.employeeId === 'E006');
  assert.deepEqual(kubo.map((x) => x.date + ' ' + x.reasons.map((r) => '［' + r.category + '］' + r.text).join('')), [
    '2026-10-01 ［打刻］退勤なし［日報］日報未提出',
    '2026-10-02 ［残業］残業：30分以上で承認済みの事前申請なし［有給・申請］1日有給日に勤務実績あり［有給・申請］事後申請（有給）［日報］日報未提出（下書きあり）',
  ]);
  assert.ok(!c.items.some((x) => x.date > '2026-10-15'));
  assert.ok(!c.items.some((x) => x.employeeId === 'E001' || x.employeeId === 'E002'), '勤怠集計対象外（役員）は出さない');
  assert.deepEqual(c.byCategory, { 打刻: 1, 残業: 1, '有給・申請': 2, 日報: 2 });
  assert.ok(c.byReason.some((x) => x.reason === '退勤なし' && x.count === 1));
});

// ============================================================ 接客集計（暦月）

test('接客集計：暦月（10/1〜10/31）。会社件数は主担当だけ、副担当は別集計。来場きっかけは主担当で数え、旧値は「（旧）」で小計に含める。下書きは数えない', () => {
  const gas = office();
  const submit = (email, now, customers) => { gas.loginAs(email); gas.setNow(now); const r = gas.g.submitReport({ workContent: '来場', customers }); assert.equal(r.success, true, r.message); return r.data.reportId; };
  const c = (over) => ({ customerName: '山田様', role: '主担当', visitTrigger: 'Google検索', ...over });
  submit(NAKATSUI, '2026-09-30 19:00', [c()]);                                             // 9月（入らない）
  submit(NAKATSUI, '2026-10-01 19:00', [c(), c({ customerName: '佐藤様', visitTrigger: 'Yahoo!検索' })]);
  submit(KUBO, '2026-10-01 19:00', [c({ customerName: '山田 様', role: '副担当', mainStaffId: 'E005' })]); // 主担当 中津井 の記録あり
  const rep = submit(KUBO, '2026-10-02 19:00', [c({ customerName: '鈴木様', role: '副担当', mainStaffId: 'E003', visitTrigger: '紹介' })]); // 主担当側なし
  submit(OMORI, '2026-10-31 19:00', [c({ customerName: '高橋様', visitTrigger: '未確認' }), c({ customerName: '', customerNameUnknown: true, visitTrigger: '検索（不明）' })]);
  submit(MURATA, '2026-11-01 19:00', [c()]);                                                // 11月（入らない）
  gas.loginAs(MURATA); gas.setNow('2026-10-03 19:00'); gas.g.saveReportDraft({ customers: [c()] }); // 下書き（数えない）
  // 旧値の記録（段階4より前）：担当区分なし・Web検索／看板・通りがかり／イベント
  const old = submit(MURATA, '2026-10-05 19:00', [c({ customerName: 'A様' }), c({ customerName: 'B様' }), c({ customerName: 'C様' })]);
  const sheet = gas.main.getSheetByName('日報_接客');
  const h = sheet.data[0];
  const olds = sheet.data.filter((r) => r[h.indexOf('日報ID')] === old);
  ['Web検索', '看板・通りがかり', 'イベント'].forEach((v, i) => { olds[i][h.indexOf('来場のきっかけ')] = v; olds[i][h.indexOf('担当区分')] = ''; });
  // 同じ日・同じ顧客を2人が主担当で記録（重複の候補）
  submit(OMORI, '2026-10-01 19:30', [c({ customerName: '佐藤 様', visitTrigger: 'Instagram' })]);
  gas.g.clearTableCache_();
  asAdmin(gas);
  const s = gas.g.getAdminMonthlyAnalysis('2026-10').data.sales;
  assert.deepEqual([s.from, s.to], ['2026-10-01', '2026-10-31']);
  assert.deepEqual([s.companyMainCount, s.subCount], [8, 2], '会社件数は主担当だけ（旧データの空欄は主担当）');
  assert.deepEqual(s.employees.map((e) => e.name + ':' + e.mainCount + '/' + e.subCount), ['大森紗智子:3/0', '村田清子:3/0', '中津井祐貴:2/0', '久保亜弓:0/2']);
  assert.deepEqual(s.triggers.map((t) => t.label + ':' + t.count), ['Google検索:1', 'Yahoo!検索:1', '検索（不明）:1', 'Instagram:1', '未確認:1', 'Web検索（旧）:1', '看板・通りがかり（旧）:1', 'イベント（旧）:1']);
  assert.deepEqual(s.groups.map((g) => g.name + ':' + g.count), ['検索（合計）:4', 'イベント（合計）:1']);
  assert.deepEqual(s.warnings.map((w) => w.type + ' ' + w.date), ['主担当の重複の候補 2026-10-01', '主担当側の記録なし 2026-10-02']);
  assert.match(s.warnings[1].text, /久保亜弓（副担当）の「鈴木様」：主担当 大森紗智子/);
  assert.ok(gas.main.rows('日報_接客').find((r) => r['日報ID'] === rep), 'データは書き換えない（警告だけ）');
});

// ============================================================ 日報確認集計（暦月）

test('日報確認集計：提出・未提出・下書きのみ・提出率、確認した人数・確認率、確認する人ごとの確認率、未確認者', () => {
  const gas = office();
  work(gas, NAKATSUI, '2026-10-01', '09:30', '18:30');
  work(gas, NAKATSUI, '2026-10-02', '09:30', '18:30');
  work(gas, NAKATSUI, '2026-10-05', '09:30', '18:30');
  gas.loginAs(NAKATSUI); gas.setNow('2026-10-01 19:00');
  const a = gas.g.submitReport({ workContent: '1日' }).data.reportId;
  gas.setNow('2026-10-02 19:00'); gas.g.saveReportDraft({ workContent: '途中' }); // 下書きのみ
  // 10/5 は日報なし（未提出）
  for (const email of [KUBO, MITSUYAMA]) { gas.loginAs(email); gas.g.confirmReport(a); }
  asAdmin(gas);
  const r = gas.g.getAdminMonthlyAnalysis('2026-10').data.reports;
  assert.deepEqual([r.from, r.to, r.until], ['2026-10-01', '2026-10-31', '2026-10-15']);
  const n = r.authors.find((x) => x.name === '中津井祐貴');
  assert.deepEqual([n.workDays, n.submitted, n.missing, n.draftOnly, n.submitRate, n.confirmed, n.targets, n.confirmRate], [3, 1, 1, 1, 33.3, 2, 5, 40]);
  assert.deepEqual(r.reports.map((x) => [x.date, x.confirmedCount, x.targetCount, x.pendingNames.join('、')]), [['2026-10-01', 2, 5, '猪倉厚、大森紗智子、村田清子']]);
  const readers = Object.fromEntries(r.readers.map((x) => [x.name, x.confirmed + '/' + x.required + '=' + x.rate]));
  assert.deepEqual([readers['久保亜弓'], readers['光山大樹'], readers['猪倉厚'], readers['中津井祐貴']], ['1/1=100', '1/1=100', '0/1=0', '0/0=null']);
  assert.deepEqual([r.totals.submitted, r.totals.missing, r.totals.draftOnly, r.totals.confirmRate], [1, 1, 1, 40]);
  assert.ok(!r.authors.some((x) => x.name === '光山大樹'), '提出対象外の役員は、提出したときだけ提出側に出す');
});

// ============================================================ CSV（社員別詳細・月次CSVの追加・月次サマリー・社労士確認用）

test('社員別詳細CSV：1日1行（勤務のない日も）・勤務区間・要確認の理由・合計行。月次CSVに休日出勤時間・日報・要確認の理由を追加', () => {
  const gas = office();
  run(gas, NAKATSUI, '2026-10-01', [['09:00', 'clockIn', '出社'], ['13:00', 'switchWorkStyle', '在宅'], ['19:00', 'clockOut']]);
  asAdmin(gas);
  const res = gas.g.exportAdminEmployeeMonthCsv('E005', '2026-10');
  assert.equal(res.success, true, res.message);
  assert.equal(res.data.fileName, 'kintai_detail_E005_2026-10.csv');
  const lines = csvLines(res);
  assert.equal(lines[0], '日付,曜日,勤務場所,勤務区間数,勤務区間,出勤,退勤,中断,自動休憩,実働,会社時間,在宅時間,遅刻,早退,社内超過,休日出勤,休日出勤時間,有給種別,有給時間,直行,直帰,現場,出張,日備考,業務走行距離,交通費,残業申請,日報,要確認の理由');
  assert.equal(lines.length, 1 + 30 + 1, '見出し＋30日＋合計');
  assert.equal(lines.find((l) => l.startsWith('2026-10-01')), '2026-10-01,木,会社＋在宅,2,会社 09:00〜13:00／在宅 13:00〜19:00,09:00,19:00,00:00,01:00,09:00,04:00,06:00,,,00:30,,,,,,,,,,,,なし,未提出,残業：30分以上で承認済みの事前申請なし・日報未提出');
  assert.equal(lines.find((l) => l.startsWith('2026-10-02')), '2026-10-02,金' + ',,'.repeat(13) + ',', '勤務のない日も1行');
  assert.match(lines[lines.length - 1], /^合計,,,,,1日,,00:00,01:00,09:00,04:00,06:00,/);
  const monthly = csvLines(gas.g.exportAdminAttendanceCsv({ type: 'monthly', month: '2026-10' }));
  assert.match(monthly[0], /,要確認（申請）,休日出勤時間,日報,要確認の理由$/);
});

test('月次サマリーCSV：社員ごとの合計（20日締め）。フレックスの有給算入は「未確定」のまま', () => {
  const gas = office();
  work(gas, OMORI, '2026-10-01', '09:00', '18:00');
  work(gas, NAKATSUI, '2026-10-01', '09:30', '18:30');
  asAdmin(gas);
  const res = gas.g.exportAdminMonthlySummaryCsv('2026-10');
  assert.equal(res.success, true, res.message);
  const lines = csvLines(res);
  assert.match(lines[0], /^社員ID,氏名,部署,勤務区分,出勤日数,実働,.*,フレックス有給算入$/);
  assert.equal(lines.length, 1 + 4, '勤怠集計対象の4名（役員は出さない）');
  assert.match(lines.find((l) => l.startsWith('E003')), /^E003,大森紗智子,一般,フレックス,1,08:00,.*,138:00,08:00,00:00,130:00,00:00,未確定$/);
  assert.match(lines.find((l) => l.startsWith('E005')), /^E005,中津井祐貴,一般,固定勤務,1,08:00,/);
});

test('社労士確認用の詳細表：勤怠集計対象×20日締めの全日＋社員ごとの合計。確定項目だけ値で出し、法定時間外・深夜・法定休日は「未確定」の空欄', () => {
  const gas = office();
  run(gas, NAKATSUI, '2026-10-01', [['09:00', 'clockIn', '出社'], ['12:00', 'startBreak', ''], ['12:30', 'resumeWork', '在宅'], ['23:00', 'clockOut']]);
  asAdmin(gas);
  const res = gas.g.exportSharoushiDetailCsv('2026-10');
  assert.equal(res.success, true, res.message);
  const lines = csvLines(res);
  assert.equal(lines[0], '社員ID,氏名,勤務区分,日付,曜日,出勤,退勤,勤務区間,会社時間,在宅時間,中断（私用の中抜け）,休憩（自動）,実働,休日出勤（承認済み）,休日出勤時間,有給種別,有給時間,出張,直行,直帰,要確認の理由,法定時間外（未確定）,深夜（未確定）,法定休日（未確定）');
  assert.equal(lines.length, 1 + 4 * (30 + 1), '4名×（30日＋合計）');
  const row = lines.find((l) => l.startsWith('E005,中津井祐貴,固定勤務,2026-10-01'));
  assert.equal(row, 'E005,中津井祐貴,固定勤務,2026-10-01,木,09:00,23:00,会社 09:00〜12:00／在宅 12:30〜23:00,03:00,10:30,00:30,01:00,12:30,,,,,,,,残業：30分以上で承認済みの事前申請なし・日報未提出,,,',
    '22時以降の勤務があっても深夜は計算しない（未確定）');
  assert.ok(!lines.some((l) => /^E00[12],/.test(l)), '勤怠集計対象外（役員）は出さない');
  assert.ok(lines.some((l) => l.startsWith('E005,中津井祐貴,固定勤務,合計,,1日,')));
  assert.ok(res.data.notes.some((n) => /法定時間外・深夜・法定休日は社労士の確認待ち/.test(n)));
  assert.ok(res.data.notes.some((n) => /中断（私用の中抜け）/.test(n)));
});

// ============================================================ 権限・読み取りだけ・未実装の確認

test('セキュリティ：一般スタッフは他人の月次詳細・社労士出力・集計・各CSVを取得できない', () => {
  const gas = office();
  work(gas, KUBO, '2026-10-01', '09:30', '18:30');
  gas.loginAs(NAKATSUI);
  for (const [fn, args] of [['getAdminEmployeeMonth', ['E006', '2026-10']], ['getAdminEmployeeMonth', ['E005', '2026-10']], ['exportAdminEmployeeMonthCsv', ['E006', '2026-10']],
    ['getAdminMonthlyAnalysis', ['2026-10']], ['exportAdminMonthlySummaryCsv', ['2026-10']], ['exportSharoushiDetailCsv', ['2026-10']]]) {
    const r = gas.g[fn](...args);
    assert.deepEqual([r.success, /管理者権限がありません/.test(r.message), r.data], [false, true, null], fn);
  }
  const src = fs.readFileSync(path.join(__dirname, '../leaf-portal/gas/AdminMonthlyService.gs'), 'utf8');
  for (const fn of ['getAdminEmployeeMonth', 'exportAdminEmployeeMonthCsv', 'getAdminMonthlyAnalysis', 'exportAdminMonthlySummaryCsv', 'exportSharoushiDetailCsv']) {
    const start = src.indexOf('function ' + fn + '(');
    assert.match(src.slice(start, src.indexOf('\n}\n', start)), /requireAdmin\(\)/, fn + ' は requireAdmin() を通す');
  }
  const html = gas.g.doGet({ parameter: {} }).getContent();
  const staffList = JSON.parse(html.match(/HW_FUNCTIONS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  assert.ok(!staffList.some((f) => /Admin|Sharoushi/.test(f)));
});

test('読み取りだけ：段階5の関数を全部呼んでも、シートは1文字も変わらない', () => {
  const gas = office();
  work(gas, NAKATSUI, '2026-10-01', '09:30', '19:30');
  gas.loginAs(NAKATSUI); gas.setNow('2026-10-01 20:00');
  gas.g.submitReport({ workContent: 'x', customers: [{ customerName: '山田様', role: '主担当', visitTrigger: 'Web検索' }] });
  asAdmin(gas);
  const before = snapshot(gas);
  for (const r of [gas.g.getAdminEmployeeMonth('E005', '2026-10'), gas.g.exportAdminEmployeeMonthCsv('E005', '2026-10'), gas.g.getAdminMonthlyAnalysis('2026-10'),
    gas.g.exportAdminMonthlySummaryCsv('2026-10'), gas.g.exportSharoushiDetailCsv('2026-10'), gas.g.exportAdminAttendanceCsv({ type: 'monthly', month: '2026-10' })]) {
    assert.equal(r.success, true, r.message);
  }
  assert.equal(snapshot(gas), before);
});

test('まだ計算しないもの：法定時間外・週40時間・深夜・法定休日・割増の関数はない（未実装テストとして名前だけ確認）', () => {
  const gas = office();
  for (const fn of ['calculateLegalOvertime_', 'calculateWeekly40_', 'calculateNightMinutes_', 'calculatePremium_']) {
    assert.equal(typeof gas.g[fn], 'undefined', fn + ' は社労士の確認後に実装');
  }
  const src = fs.readdirSync(path.join(__dirname, '../leaf-portal/gas')).filter((f) => f.endsWith('.gs'))
    .map((f) => fs.readFileSync(path.join(__dirname, '../leaf-portal/gas', f), 'utf8')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // コメント（例の説明）は除く
  assert.doesNotMatch(src, /22:00|1320|週40/, '深夜（22時）・週40時間の計算式を入れていない');
});

test.todo('法定時間外（日8時間超）：社労士回答 Q-1 の後に実装');
test.todo('法定時間外（週40時間超・週の起算日）：社労士回答 Q-1 の後に実装');
test.todo('深夜時間（時間帯・早朝側・重複の表示）：社労士回答 Q-5 の後に実装');
test.todo('法定休日（定め方・入力方法）：社労士回答 Q-6 と R-4 の後に実装');
test.todo('フレックスの法定時間外・有給算入：社労士回答 Q-3・Q-4 の後に実装');

test('R-1（A案・現状維持）：画面に「中断は私用の中抜け、昼休みは中断にしない」を明記。計算は 実働＝勤務区間−中断−自動休憩 のまま', () => {
  const gas = office();
  const html = gas.g.doGet({ parameter: {} }).getContent();
  assert.match(html, /id="breakRuleNote"[^>]*>［中断］は私用外出・通院など、勤務から離れるときに押します。<strong>昼休みは中断にしないでください<\/strong>（昼休みは自動休憩として実働から差し引きます）。/);
  run(gas, NAKATSUI, '2026-10-02', [['09:00', 'clockIn', '出社'], ['12:00', 'startBreak', '通院'], ['13:00', 'resumeWork', '出社'], ['18:00', 'clockOut']]);
  const a = gas.main.rows('勤怠記録')[0];
  assert.deepEqual([a['中断合計'], a['自動休憩'], a['実働時間']], ['01:00', '01:00', '07:00']);
});
