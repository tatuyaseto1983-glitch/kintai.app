'use strict';
// 全スタッフ勤務状況（役員の除外）と、日報（下書き・提出・確認・コメント・修正）のテスト
const test = require('node:test');
const assert = require('node:assert');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const MITSUYAMA = 'hiroki@example.com'; // 役員・admin（勤怠集計対象外）
const INOKURA = 'atsushi@example.com';  // 役員・staff（勤怠集計対象外）
const OMORI = 'sachiko@example.com';
const MURATA = 'kiyoko@example.com';
const NAKATSUI = 'yuuki@example.com';
const KUBO = 'ayumi@example.com';

/** 実際のスタッフマスタに近い6名（光山・猪倉は勤怠集計対象外） */
function office() {
  const gas = createLeafGas({ email: MITSUYAMA });
  gas.g.setupSystem();
  const base = { '在籍状況': '在籍', '雇用区分': '正社員' };
  gas.g.appendRecords_('スタッフマスタ', [
    { ...base, '社員ID': 'E001', '氏名': '光山大樹', 'メールアドレス': MITSUYAMA, '権限': 'admin', '勤務区分': '固定勤務', '部署': '管理', '勤怠集計対象': '対象外' },
    { ...base, '社員ID': 'E002', '氏名': '猪倉厚', 'メールアドレス': INOKURA, '権限': 'staff', '勤務区分': '固定勤務', '部署': '管理', '勤怠集計対象': '対象外' },
    { ...base, '社員ID': 'E003', '氏名': '大森紗智子', 'メールアドレス': OMORI, '権限': 'staff', '勤務区分': 'フレックス', '部署': '一般' },
    { ...base, '社員ID': 'E004', '氏名': '村田清子', 'メールアドレス': MURATA, '権限': 'staff', '勤務区分': 'フレックス', '部署': '一般' },
    { ...base, '社員ID': 'E005', '氏名': '中津井祐貴', 'メールアドレス': NAKATSUI, '権限': 'staff', '勤務区分': '固定勤務', '部署': '一般' },
    { ...base, '社員ID': 'E006', '氏名': '久保亜弓', 'メールアドレス': KUBO, '権限': 'staff', '勤務区分': '固定勤務', '部署': '一般' },
  ]);
  return gas;
}
const customer = (over) => ({
  customerName: '山田様', customerNameUnknown: false, visitTrigger: 'Instagram', visitTriggerOther: '',
  content: '新築の相談', result: '見積提出', resultNote: '', nextAction: '必要', nextActionDetail: '電話', ...over,
});

// ============================================================ 全スタッフ勤務状況

test('勤務状況：勤怠集計対象外（光山・猪倉）は一覧・人数・集計・CSVから除外。アカウントは使える', () => {
  const gas = office();
  for (const [email, style] of [[MITSUYAMA, '出社'], [INOKURA, '在宅'], [OMORI, '在宅'], [NAKATSUI, '出社']]) {
    gas.loginAs(email);
    gas.setNow('2026-10-02 09:30');
    assert.equal(gas.g.clockIn(style).success, true, '役員も打刻はできる');
  }
  gas.loginAs(NAKATSUI);
  gas.setNow('2026-10-02 18:30');
  gas.g.clockOut();

  gas.loginAs(OMORI);
  const list = gas.g.getTodayStaffStatus().data.staff.map((s) => s.name);
  assert.deepEqual(list, ['大森紗智子', '村田清子', '中津井祐貴', '久保亜弓'], 'スタッフ画面の全スタッフ勤務状況');

  gas.loginAs(MITSUYAMA);
  assert.equal(gas.g.getCurrentUser().data.employeeId, 'E001', '役員もログインできる');
  const d = gas.g.getAdminDashboard({ date: '2026-10-02' }).data;
  assert.deepEqual([d.summary.present, d.summary.remote, d.summary.working, d.summary.finished, d.summary.notStarted], [2, 1, 1, 1, 2]);
  assert.deepEqual(d.daily.rows.map((r) => r.name), ['大森紗智子', '村田清子', '中津井祐貴', '久保亜弓'], '日別一覧');
  assert.deepEqual(d.monthly.rows.map((r) => r.name), ['大森紗智子', '村田清子', '中津井祐貴', '久保亜弓'], '月別集計');
  assert.ok(!d.flex.rows.some((r) => /光山|猪倉/.test(r.name)));
  const csv = gas.g.exportAdminAttendanceCsv({ type: 'daily', date: '2026-10-02' }).data.csv;
  assert.doesNotMatch(csv, /光山|猪倉/, 'CSV');
  assert.match(csv, /大森紗智子/);
  // 以前の管理者用の関数も同じ
  assert.deepEqual(gas.g.getDailyAttendance('2026-10-02').data.records.map((r) => r.name), ['大森紗智子', '村田清子', '中津井祐貴', '久保亜弓']);
  assert.ok(!gas.g.getAllAttendance('2026-10-01', '2026-10-31').data.records.some((r) => /光山|猪倉/.test(r.name)));
  assert.doesNotMatch(gas.g.exportAttendanceCsv('2026-10').data.csv, /光山|猪倉/);
  // 本人の勤怠は本人が見られる
  assert.equal(gas.g.getMyAttendance('2026-10').data.records.length, 1);
});

test('勤務状況：「勤怠集計対象」列がない以前のスタッフマスタでも、全員を対象として動く', () => {
  const gas = createLeafGas({ email: OMORI });
  const staff = gas.main.insertSheet('スタッフマスタ');
  staff.data = [['社員ID', '氏名', 'メールアドレス', '権限', '雇用区分', '勤務区分', '標準出勤', '標準退勤', '1日所定時間', '週所定時間', '月所定時間', '在籍状況', '入社日', '部署', '備考'],
    ['E003', '大森紗智子', OMORI, 'staff', '正社員', '固定勤務', '', '', '', '', '', '在籍', '', '一般', '']];
  for (const name of ['勤怠記録', '中断履歴', '打刻修正申請', '残業申請', '日報', '設定']) {
    const def = gas.eval('SHEET_DEFINITIONS').find((d) => d.name === name);
    gas.main.insertSheet(name).data = [def.headers.slice()];
  }
  gas.g.appendRecords_('設定', gas.eval('DEFAULT_SETTINGS').map((d) => ({ '項目': d.key, '値': d.value })));
  assert.equal(gas.g.getCurrentUser().success, true, 'setupSystem 前でもログインできる');
  assert.deepEqual(gas.g.getTodayStaffStatus().data.staff.map((s) => s.name), ['大森紗智子']);
  assert.match(gas.g.getReportList().message, /setupSystem\(\) を実行してください/, '日報の新機能は setupSystem を案内する');
  gas.g.setupSystem();
  assert.ok(staff.data[0].includes('勤怠集計対象'), 'setupSystem で列が右端に追加される');
  assert.equal(gas.g.getReportList().success, true);
});

// ============================================================ 日報：保存・提出

test('日報：日付・担当者はサーバーが決める（画面から送った日付・社員ID・氏名は使わない）', () => {
  const gas = office();
  gas.loginAs(OMORI);
  gas.setNow('2026-10-02 18:00');
  const r = gas.g.saveReportDraft({ date: '2026-01-01', employeeId: 'E005', name: '中津井祐貴', workContent: '現場' });
  assert.equal(r.success, true, r.message);
  assert.deepEqual([r.data.date, r.data.employeeId, r.data.name], ['2026-10-02', 'E003', '大森紗智子']);
  const row = gas.main.rows('日報')[0];
  assert.deepEqual([row['日付'], row['社員ID'], row['氏名'], row['日報ステータス'], row['ステータス'], row['バージョン']], ['2026-10-02', 'E003', '大森紗智子', 'draft', '下書き', '0']);
  // 日をまたいでから提出しても、日付は作った日のまま
  gas.setNow('2026-10-03 08:00');
  const s = gas.g.submitReport({ reportId: r.data.reportId, workContent: '現場' });
  assert.equal(s.data.date, '2026-10-02');
  // 他人の日報IDを指定して書き換えることはできない
  gas.loginAs(NAKATSUI);
  assert.match(gas.g.submitReport({ reportId: r.data.reportId, workContent: 'なりすまし' }).message, /他の社員の日報は編集できません/);
  assert.match(gas.g.getReportEditor(r.data.reportId).message, /編集できる日報が見つかりません/);
});

test('日報：接客記録（件数は自動・未確認は別項目・条件つきの入力・削除しても行は残す）', () => {
  const gas = office();
  gas.loginAs(OMORI);
  gas.setNow('2026-10-02 18:00');
  // 下書きは途中でも保存できる
  let r = gas.g.saveReportDraft({ workContent: '', customers: [{ customerName: '' }, customer({ visitTrigger: 'その他' })] });
  assert.equal(r.success, true, r.message);
  assert.equal(r.data.customerCount, 2);
  // 提出のときは必須項目をチェック
  const submit = (customers) => gas.g.submitReport({ reportId: r.data.reportId, workContent: '業務', customers });
  assert.match(submit([customer({ customerName: '' })]).message, /接客1：顧客名を入力するか、「未確認」にチェックしてください/);
  assert.match(submit([customer({ visitTrigger: '' })]).message, /来場のきっかけを選んでください/);
  assert.match(submit([customer({ visitTrigger: 'その他' })]).message, /「その他の内容」を入力してください/);
  assert.match(submit([customer({ result: '' })]).message, /対応結果を選んでください/);
  assert.match(submit([customer({ nextAction: '' })]).message, /次回対応（必要／不要）を選んでください/);
  assert.match(submit([customer({ nextAction: '必要', nextActionDetail: '' })]).message, /次回対応内容を入力してください/);
  assert.match(submit([customer({ visitTrigger: 'テレビ' })]).message, /来場のきっかけは/);
  assert.match(gas.g.submitReport({ reportId: r.data.reportId, workContent: ' ' }).message, /本日の業務内容/);

  r = submit([
    customer({ customerName: '入力しても未確認なら保存しない', customerNameUnknown: true, visitTrigger: '未確認' }),
    customer({ visitTrigger: 'その他', visitTriggerOther: '知人のSNS', nextAction: '不要', nextActionDetail: '不要なら保存しない' }),
    customer({ customerName: '佐々木様' }),
  ]);
  assert.equal(r.success, true, r.message);
  assert.equal(r.data.customerCount, 3);
  const rows = gas.main.rows('日報_接客').filter((x) => x['削除'] !== '1');
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0]['顧客名'], rows[0]['顧客名未確認']], ['', '1'], '「未確認」は顧客名に文字として入れず、別の項目');
  assert.deepEqual([rows[1]['その他の内容'], rows[1]['次回対応'], rows[1]['次回対応内容']], ['知人のSNS', '不要', '']);
  assert.equal(gas.main.rows('日報')[0]['接客件数'], '3');

  // 2件目を削除して修正 → 行は残して「削除」に1
  const kept = r.data.customers.filter((c, i) => i !== 1);
  r = gas.g.submitReport({ reportId: r.data.reportId, workContent: '業務', customers: kept });
  assert.equal(r.data.customerCount, 2);
  assert.equal(gas.main.rows('日報_接客').length, 5, '下書きの2件＋提出の3件。削除した記録も行は残っている');
  assert.equal(gas.main.rows('日報_接客').filter((x) => x['削除'] !== '1').length, 2);
  assert.deepEqual(r.data.customers.map((c) => c.customerName), ['', '佐々木様']);
});

test('日報：提出で提出日時・最終更新日時・バージョン1、更新履歴を残す。変更なしの再提出はバージョンを上げない', () => {
  const gas = office();
  gas.loginAs(OMORI);
  gas.setNow('2026-10-02 18:10');
  const d = gas.g.saveReportDraft({ workContent: '下書き' });
  gas.setNow('2026-10-02 18:20');
  const s = gas.g.submitReport({ reportId: d.data.reportId, workContent: '提出', customers: [customer()] });
  assert.deepEqual([s.data.status, s.data.version, s.data.submittedAt.slice(0, 16), s.data.updatedAt.slice(0, 16)], ['submitted', 1, '2026-10-02 18:20', '2026-10-02 18:20']);
  gas.setNow('2026-10-02 18:30');
  const same = gas.g.submitReport({ reportId: d.data.reportId, workContent: '提出', customers: s.data.customers });
  assert.match(same.message, /変更がないため/);
  assert.equal(gas.main.rows('日報')[0]['バージョン'], '1');
  gas.setNow('2026-10-02 18:40');
  const u = gas.g.submitReport({ reportId: d.data.reportId, workContent: '提出（修正）', customers: s.data.customers });
  assert.deepEqual([u.data.version, u.data.submittedAt.slice(0, 16), u.data.updatedAt.slice(0, 16)], [2, '2026-10-02 18:20', '2026-10-02 18:40'], '提出日時は最初のまま');
  const hist = gas.main.rows('日報_更新履歴');
  assert.deepEqual(hist.map((h) => h['操作'] + h['バージョン']), ['下書き保存0', '提出1', '修正2']);
  assert.match(hist[2]['内容'], /提出（修正）/, 'その時点の内容を保存');
});

// ============================================================ 日報：閲覧の権限

test('日報：下書きは本人だけ。他の社員・管理者・役員には一覧にも詳細にも出ない', () => {
  const gas = office();
  gas.loginAs(OMORI);
  gas.setNow('2026-10-02 18:00');
  const draft = gas.g.saveReportDraft({ workContent: '下書きの秘密メモ' }).data.reportId;
  gas.loginAs(MURATA);
  const sub = gas.g.submitReport({ workContent: '村田の提出' }).data.reportId;

  gas.loginAs(OMORI);
  let list = gas.g.getReportList().data;
  assert.deepEqual(list.myDrafts.map((x) => x.reportId), [draft]);
  assert.equal(gas.g.getReportDetail(draft).data.report.workContent, '下書きの秘密メモ');

  for (const viewer of [MITSUYAMA, INOKURA, NAKATSUI]) {
    gas.loginAs(viewer);
    list = gas.g.getReportList().data;
    assert.deepEqual(list.reports.map((x) => x.reportId), [sub], viewer + '：提出済みは見える');
    assert.deepEqual(list.myDrafts, []);
    assert.doesNotMatch(JSON.stringify(list), /下書きの秘密メモ/);
    const detail = gas.g.getReportDetail(draft);
    assert.deepEqual([detail.success, detail.message, detail.data], [false, '日報が見つかりません', null], viewer + '：他人の下書きは「見つかりません」');
    assert.match(gas.g.confirmReport(draft).message, /日報が見つかりません/);
    assert.match(gas.g.addReportComment(draft, 'x').message, /日報が見つかりません/);
  }
  gas.loginAs(MITSUYAMA);
  assert.doesNotMatch(JSON.stringify(gas.g.getAdminDashboard({ date: '2026-10-02' })), /下書きの秘密メモ/, '管理者画面にも出ない');
});

// ============================================================ 日報：確認・修正・コメント

test('日報：「確認しました」（提出者は対象外・役員は対象・確認済み人数）', () => {
  const gas = office();
  gas.loginAs(OMORI);
  gas.setNow('2026-10-02 18:00');
  const id = gas.g.submitReport({ workContent: '提出', customers: [customer(), customer(), customer()] }).data.reportId;
  assert.match(gas.g.confirmReport(id).message, /自分の日報は確認の対象外です/);

  gas.loginAs(INOKURA); // 役員も確認できる
  gas.setNow('2026-10-02 18:20');
  let d = gas.g.confirmReport(id).data;
  assert.deepEqual([d.confirmation.confirmedCount, d.confirmation.targetCount], [1, 5], '分母は在籍6名−提出者1名（役員を含む）');
  assert.match(gas.g.confirmReport(id).message, /すでに確認済みです/);
  gas.loginAs(MITSUYAMA);
  gas.setNow('2026-10-02 18:25');
  d = gas.g.confirmReport(id).data;
  assert.deepEqual(d.confirmation.confirmed.map((c) => c.name + ' ' + c.confirmedAt.slice(11, 16)), ['光山大樹 18:25', '猪倉厚 18:20']);
  assert.deepEqual(d.confirmation.pending.map((c) => c.name), ['村田清子', '中津井祐貴', '久保亜弓']);
  const row = gas.main.rows('日報_確認')[0];
  assert.deepEqual([row['日報ID'], row['社員ID'], row['確認者名'], row['日報バージョン']], [id, 'E002', '猪倉厚', '1']);

  const item = gas.g.getReportList().data.reports[0];
  assert.deepEqual([item.customerCount, item.confirmedCount, item.targetCount, item.myConfirmed, item.showUpdated], [3, 2, 5, true, false]);
  // 退職者は分母に入らない
  gas.main.getSheetByName('スタッフマスタ').data[6][11] = '退職';
  assert.equal(gas.g.getReportDetail(id).data.confirmation.targetCount, 4);
});

test('日報：提出後の修正で全員「未確認」に戻り「更新あり」。確認の履歴は残り、再確認で解除', () => {
  const gas = office();
  gas.loginAs(OMORI);
  gas.setNow('2026-10-02 18:00');
  const id = gas.g.submitReport({ workContent: '初版' }).data.reportId;
  gas.loginAs(MURATA); gas.setNow('2026-10-02 18:20'); gas.g.confirmReport(id);
  gas.loginAs(KUBO); gas.setNow('2026-10-02 18:25'); gas.g.confirmReport(id);

  gas.loginAs(OMORI); gas.setNow('2026-10-02 18:40');
  assert.equal(gas.g.submitReport({ reportId: id, workContent: '修正版' }).data.version, 2);

  gas.loginAs(MURATA); gas.setNow('2026-10-02 19:00');
  let d = gas.g.getReportDetail(id).data;
  assert.equal(d.confirmation.confirmedCount, 0, '修正すると全員未確認に戻る');
  assert.equal(d.showUpdated, true);
  assert.equal(d.confirmation.pending.find((p) => p.name === '村田清子').confirmedOlderAt.slice(11, 16), '18:20');
  let item = gas.g.getReportList().data.reports[0];
  assert.deepEqual([item.showUpdated, item.myConfirmed, item.isUpdated], [true, false, true]);
  d = gas.g.confirmReport(id).data;
  assert.deepEqual([d.showUpdated, d.myConfirmed, d.confirmation.confirmedCount], [false, true, 1], '再確認でその人の「更新あり」は解除');
  assert.deepEqual(d.confirmationHistory.map((h) => h.name + ' v' + h.version + ' ' + h.at.slice(11, 16)), ['村田清子 v1 18:20', '久保亜弓 v1 18:25', '村田清子 v2 19:00']);
  assert.deepEqual(d.updateHistory.map((h) => h.action + ' v' + h.version + ' ' + h.at.slice(11, 16)), ['提出 v1 18:00', '修正 v2 18:40']);
  assert.equal(gas.main.rows('日報_確認').length, 3, '過去の確認履歴は消さない');

  gas.loginAs(KUBO);
  item = gas.g.getReportList().data.reports[0];
  assert.equal(item.showUpdated, true, 'まだ再確認していない人には「更新あり」');
  gas.loginAs(OMORI);
  item = gas.g.getReportList().data.reports[0];
  assert.deepEqual([item.showUpdated, item.isUpdated], [false, true], '本人には「更新あり」は出さない（修正済みの表示）');
});

test('日報：コメント（任意・古い順・提出済みだけ・本文とIDを保存）', () => {
  const gas = office();
  gas.loginAs(OMORI);
  gas.setNow('2026-10-02 18:00');
  const draft = gas.g.saveReportDraft({ workContent: '下書き' }).data.reportId;
  assert.match(gas.g.addReportComment(draft, 'x').message, /提出済みの日報にだけコメントできます/);
  const id = gas.g.submitReport({ reportId: draft, workContent: '提出' }).data.reportId;
  gas.loginAs(INOKURA); gas.setNow('2026-10-02 18:30');
  assert.match(gas.g.addReportComment(id, '  ').message, /コメントを入力してください/);
  gas.g.addReportComment(id, '<script>alert(1)</script> お疲れさまです');
  gas.loginAs(OMORI); gas.setNow('2026-10-02 18:35');
  const d = gas.g.addReportComment(id, 'ありがとうございます').data;
  assert.deepEqual(d.comments.map((c) => c.name + ':' + c.text), ['猪倉厚:<script>alert(1)</script> お疲れさまです', '大森紗智子:ありがとうございます']);
  assert.equal(d.confirmation.confirmedCount, 0, 'コメントしても確認にはならない（別）');
  const row = gas.main.rows('日報_コメント')[0];
  assert.deepEqual([row['日報ID'], row['社員ID'], row['社員名']], [id, 'E002', '猪倉厚']);
  assert.match(row['コメントID'], /^CM-/);
});

test('日報：以前のデータ（確認済み・課題・困りごと）は提出済み・バージョン1として表示', () => {
  const gas = office();
  gas.g.appendRecords_('日報', [{ '日報ID': 'DR-20260930-E005', '日付': '2026-09-30', '社員ID': 'E005', '氏名': '中津井祐貴', '本日の業務内容': '以前の日報',
    '課題・困りごと': '以前の課題', '明日の予定': '見積', '提出日時': '2026-09-30 18:00:00', 'ステータス': '確認済み' }]);
  gas.loginAs(OMORI);
  gas.setNow('2026-10-02 10:00');
  const list = gas.g.getReportList({ month: '2026-09' }).data.reports;
  assert.deepEqual(list.map((x) => x.reportId + ':' + x.status + ':v' + x.version), ['DR-20260930-E005:submitted:v1']);
  const d = gas.g.getReportDetail('DR-20260930-E005').data;
  assert.deepEqual([d.report.issues, d.report.legacy.tomorrowPlan, d.canConfirm], ['以前の課題', '見積', true]);
});

test('日報の画面：呼べる関数はすべてサーバーにあり、管理者用の関数は含まない', () => {
  const gas = office();
  const html = gas.g.doGet({ parameter: { view: 'reports' } }).getContent();
  assert.match(html, /data-initial-view="reports"/);
  const list = JSON.parse(html.match(/REPORT_FUNCTIONS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  for (const fn of list) assert.equal(typeof gas.g[fn], 'function', fn);
  for (const fn of ['requireAdmin', 'getAdminDashboard', 'setupSystem']) assert.ok(!list.includes(fn));
  assert.doesNotMatch(gas.g.HtmlService.createHtmlOutputFromFile('ReportScripts').getContent(), /innerHTML/, 'innerHTML を使わない');
});
