'use strict';
// 段階4のテスト（日報）：日付・担当者の自動入力、接客記録（主担当／副担当・主担当者・来場きっかけ）、書き忘れた日、
// 確認・未確認者、コメント（送信ID・管理者の削除）、未提出の判定（出勤実績ベース）、管理者の日別・月別、権限、暦月
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const MITSUYAMA = 'hiroki@example.com'; // 役員・admin（勤怠集計 対象外 → 日報提出 対象外。確認は対象）
const INOKURA = 'atsushi@example.com';  // 役員・staff（同上）
const OMORI = 'sachiko@example.com';
const MURATA = 'kiyoko@example.com';
const NAKATSUI = 'yuuki@example.com';
const KUBO = 'ayumi@example.com';

/** 実際に近い6名。setupSystem の後に追加するので、日報提出対象・日報確認対象は空欄（＝勤怠集計対象に合わせる／対象） */
function office(extra) {
  const gas = createLeafGas({ email: MITSUYAMA });
  gas.g.setupSystem();
  const base = { '在籍状況': '在籍', '雇用区分': '正社員', '有給申請対象': '対象', ...(extra || {}) };
  gas.g.appendRecords_('スタッフマスタ', [
    { ...base, '社員ID': 'E001', '氏名': '光山大樹', 'メールアドレス': MITSUYAMA, '権限': 'admin', '勤務区分': '固定勤務', '部署': '管理', '勤怠集計対象': '対象外', '有給申請対象': '対象外' },
    { ...base, '社員ID': 'E002', '氏名': '猪倉厚', 'メールアドレス': INOKURA, '権限': 'staff', '勤務区分': '固定勤務', '部署': '管理', '勤怠集計対象': '対象外', '有給申請対象': '対象外' },
    { ...base, '社員ID': 'E003', '氏名': '大森紗智子', 'メールアドレス': OMORI, '権限': 'staff', '勤務区分': 'フレックス', '部署': '一般' },
    { ...base, '社員ID': 'E004', '氏名': '村田清子', 'メールアドレス': MURATA, '権限': 'staff', '勤務区分': 'フレックス', '部署': '一般' },
    { ...base, '社員ID': 'E005', '氏名': '中津井祐貴', 'メールアドレス': NAKATSUI, '権限': 'staff', '勤務区分': '固定勤務', '部署': '一般' },
    { ...base, '社員ID': 'E006', '氏名': '久保亜弓', 'メールアドレス': KUBO, '権限': 'staff', '勤務区分': '固定勤務', '部署': '一般' },
  ]);
  gas.setNow('2026-10-08 18:00');
  return gas;
}
const customer = (over) => ({ customerName: '山田様', customerNameUnknown: false, role: '主担当', visitTrigger: 'Google検索', ...over });
const staffCol = (gas, id, col, value) => {
  const sheet = gas.main.getSheetByName('スタッフマスタ');
  sheet.data.find((r) => r[0] === id)[sheet.data[0].indexOf(col)] = value;
  gas.g.clearTableCache_();
};
/** その日に出勤・退勤する */
function work(gas, email, date, from, to) {
  gas.loginAs(email);
  gas.setNow(date + ' ' + (from || '09:30'));
  assert.equal(gas.g.clockIn('出社').success, true);
  gas.setNow(date + ' ' + (to || '18:30'));
  assert.equal(gas.g.clockOut().success, true);
}
const submitAs = (gas, email, now, input) => {
  gas.loginAs(email);
  gas.setNow(now);
  const r = gas.g.submitReport({ workContent: '業務', ...input });
  assert.equal(r.success, true, r.message);
  return r.data.reportId;
};

// ============================================================ setupSystem

test('setupSystem：スタッフマスタに日報提出対象（勤怠集計対象から）・日報確認対象（全員対象）、日報・接客・コメントに列を右端に追加。2回目は何も変えない', () => {
  const gas = createLeafGas({ email: MITSUYAMA });
  gas.g.setupSystem();
  // 段階3までの形に戻す（新しい列がない状態）
  const cut = (name, cols) => { const s = gas.main.getSheetByName(name); s.data = s.data.map((r) => r.slice(0, s.data[0].length - cols)); };
  cut('スタッフマスタ', 2); cut('日報', 1); cut('日報_接客', 4); cut('日報_コメント', 5);
  const staff = gas.main.getSheetByName('スタッフマスタ');
  const h = staff.data[0];
  const row = (id, target, status) => h.map((c) => ({ '社員ID': id, '氏名': id, 'メールアドレス': id + '@x.jp', '権限': 'staff', '在籍状況': status || '在籍', '勤怠集計対象': target }[c] || ''));
  staff.data.push(row('E001', '対象外'), row('E002', '対象外'), row('E003', ''), row('E004', '対象', '休職'));
  const rep = gas.main.getSheetByName('日報');
  rep.data.push(rep.data[0].map((c) => ({ '日報ID': 'DR-1', '日付': '2026-10-01', '社員ID': 'E003', '日報ステータス': 'submitted' }[c] || '')));
  const cu = gas.main.getSheetByName('日報_接客');
  cu.data.push(cu.data[0].map((c) => ({ '接客ID': 'CU-1', '日報ID': 'DR-1', '社員ID': 'E003', '顧客名': '旧データ様', '来場のきっかけ': 'Web検索' }[c] || '')));
  gas.g.clearTableCache_();
  const log = gas.g.setupSystem();
  assert.match(log, /スタッフマスタ：足りない列を右端に追加しました（日報提出対象、日報確認対象）。日報提出対象の初期値を入れました（対象 2名・対象外 2名/);
  assert.match(log, /日報確認対象の初期値を入れました（全員 対象/);
  assert.match(log, /日報_接客：足りない列を右端に追加しました（担当区分、主担当者ID、主担当者名、日付）。既存の接客記録 1件に日付を入れました/);
  assert.match(log, /日報_コメント：足りない列を右端に追加しました（削除、削除者ID、削除者名、削除日時、送信ID）/);
  assert.match(log, /日報：足りない列を右端に追加しました（下書き保存日時）/);
  const rows = gas.main.rows('スタッフマスタ');
  assert.deepEqual(rows.map((r) => [r['日報提出対象'], r['日報確認対象']]), [['対象外', '対象'], ['対象外', '対象'], ['対象', '対象'], ['対象', '対象']]);
  const c = gas.main.rows('日報_接客')[0];
  assert.deepEqual([c['日付'], c['担当区分'], c['来場のきっかけ']], ['2026-10-01', '', 'Web検索'], '担当区分・旧来場きっかけは書き換えない');
  // 既存の値は変えない・2回目は何も変わらない
  staff.data[3][staff.data[0].indexOf('日報提出対象')] = '対象外';
  const before = JSON.stringify(gas.main.sheets.map((s) => s.data));
  gas.g.setupSystem();
  assert.equal(JSON.stringify(gas.main.sheets.map((s) => s.data)), before);
});

// ============================================================ 本人：日付・担当者・下書き・提出・1日1件

test('本人：日付は今日・担当者はログインから自動。他人の社員IDを送っても自分の日報。下書き→提出、1日1件', () => {
  const gas = office();
  gas.loginAs(OMORI);
  const ed = gas.g.getReportEditor().data;
  assert.deepEqual([ed.date, ed.employeeName, ed.report], ['2026-10-08', '大森紗智子', null]);
  const d = gas.g.saveReportDraft({ employeeId: 'E005', name: '中津井祐貴', workContent: '下書き' });
  assert.deepEqual([d.data.date, d.data.employeeId, d.data.name, d.data.status], ['2026-10-08', 'E003', '大森紗智子', 'draft']);
  assert.equal(gas.main.rows('日報')[0]['下書き保存日時'], '2026-10-08 18:00:00');
  // reportId なしでもう一度保存しても、同じ日の自分の日報を更新する（2件にならない）
  gas.setNow('2026-10-08 18:05');
  gas.g.saveReportDraft({ workContent: '下書き2' });
  const s = gas.g.submitReport({ workContent: '提出' });
  assert.equal(s.success, true, s.message);
  assert.equal(gas.main.rows('日報').length, 1, '1社員×1日1件');
  assert.deepEqual([s.data.status, s.data.version, s.data.reportId], ['submitted', 1, d.data.reportId]);
  assert.equal(gas.main.rows('日報')[0]['下書き保存日時'], '2026-10-08 18:05:00', '提出では下書き保存日時を変えない');
  // 再編集：バージョンが上がり、履歴を残す
  const u = gas.g.submitReport({ reportId: s.data.reportId, workContent: '提出（修正）' });
  assert.equal(u.data.version, 2);
  assert.deepEqual(gas.main.rows('日報_更新履歴').map((h) => h['操作']), ['下書き保存', '下書き保存', '提出', '修正']);
});

// ============================================================ 接客記録

test('接客：0件・1件・複数件。主担当／副担当、副担当は主担当者（氏名はマスタから）。顧客名・未確認・来場きっかけ・日付を保存', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const zero = gas.g.submitReport({ workContent: '事務作業' });
  assert.deepEqual([zero.success, zero.data.customerCount], [true, 0], '接客0件でも提出できる');
  const one = gas.g.submitReport({ reportId: zero.data.reportId, workContent: '事務作業', customers: [customer()] });
  assert.equal(one.data.customerCount, 1);
  const many = gas.g.submitReport({
    reportId: zero.data.reportId, workContent: '来場対応',
    customers: [
      customer(),
      customer({ customerName: '佐藤様', role: '副担当', mainStaffId: 'E006', mainStaffName: 'なりすまし', visitTrigger: 'Yahoo!検索' }),
      customer({ customerName: '', customerNameUnknown: true, visitTrigger: '未確認' }),
      customer({ customerName: '鈴木様', visitTrigger: '検索（不明）', resultNote: '駐車場の質問あり' }),
    ],
  });
  assert.equal(many.success, true, many.message);
  assert.equal(many.data.customerCount, 4);
  const rows = gas.main.rows('日報_接客').filter((r) => r['削除'] !== '1');
  assert.deepEqual(rows.map((r) => [r['顧客名'], r['顧客名未確認'], r['担当区分'], r['主担当者ID'], r['主担当者名'], r['来場のきっかけ'], r['日付']]), [
    ['山田様', '', '主担当', '', '', 'Google検索', '2026-10-08'],
    ['佐藤様', '', '副担当', 'E006', '久保亜弓', 'Yahoo!検索', '2026-10-08'],
    ['', '1', '主担当', '', '', '未確認', '2026-10-08'],
    ['鈴木様', '', '主担当', '', '', '検索（不明）', '2026-10-08'],
  ], '主担当者名は画面から送られた値ではなくスタッフマスタから');
  assert.equal(rows[3]['補足コメント'], '駐車場の質問あり', '画面の「備考」は既存の補足コメント列に保存');
  const view = many.data.customers[1];
  assert.deepEqual([view.role, view.mainStaffId, view.mainStaffName], ['副担当', 'E006', '久保亜弓']);
});

test('接客：提出時の必須は 顧客名か未確認・担当区分・副担当の主担当者・来場きっかけ。対応結果・次回対応は任意。下書きは途中でも保存できる', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const submit = (c) => gas.g.submitReport({ workContent: '業務', customers: [c] }).message;
  assert.match(submit(customer({ customerName: '' })), /接客1：顧客名を入力するか、「未確認」にチェックしてください/);
  assert.match(submit(customer({ role: '' })), /担当区分（主担当／副担当）を選んでください/);
  assert.match(submit(customer({ role: '副担当' })), /副担当のときは主担当者を選んでください/);
  assert.match(submit(customer({ role: '副担当', mainStaffId: 'E005' })), /自分以外の社員を選んでください/);
  assert.match(submit(customer({ role: '副担当', mainStaffId: 'E999' })), /主担当者がスタッフ一覧にいません/);
  assert.match(submit(customer({ visitTrigger: '' })), /来場のきっかけを選んでください（分からないときは「未確認」）/);
  assert.match(submit(customer({ visitTrigger: 'テレビ' })), /来場のきっかけは/);
  assert.equal(gas.main.rows('日報').length, 0, '失敗した提出では何も保存しない');
  // 下書きは途中でも保存できる
  assert.equal(gas.g.saveReportDraft({ customers: [{ customerName: '' }, customer({ role: '副担当' })] }).success, true);
  // 任意項目は空でも提出できる。主担当のときに送られた主担当者は保存しない
  const ok = gas.g.submitReport({ workContent: '業務', customers: [customer({ result: '', nextAction: '', content: '', mainStaffId: 'E006' })] });
  assert.equal(ok.success, true, ok.message);
  assert.equal(gas.main.rows('日報_接客').filter((r) => r['削除'] !== '1')[0]['主担当者ID'], '');
});

test('来場きっかけ：新しい選択肢（Google／Yahoo!／検索（不明）／未確認 など）。以前の値（Web検索・看板・通りがかり・イベント）は書き換えず読めて、保存し直せる', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const ch = gas.g.getReportEditor().data.choices;
  assert.deepEqual(ch.visitTriggers, ['Google検索', 'Yahoo!検索', '検索（不明）', 'Googleマップ', 'Instagram', 'LINE', '紹介', '既存顧客', '看板', '通りがかり',
    'チラシ', 'イベント（見学会など）', 'その他', '未確認']);
  assert.deepEqual(ch.legacyVisitTriggers, ['Web検索', '看板・通りがかり', 'イベント']);
  assert.deepEqual(ch.staffOptions.map((s) => s.employeeId), ['E001', 'E002', 'E003', 'E004', 'E006'], '主担当者の候補は自分以外の在籍者');
  // 段階4より前の接客記録（担当区分なし・旧来場きっかけ）
  const r = gas.g.submitReport({ workContent: '業務', customers: [customer()] });
  const sheet = gas.main.getSheetByName('日報_接客');
  const h = sheet.data[0];
  sheet.data[1][h.indexOf('担当区分')] = '';
  sheet.data[1][h.indexOf('来場のきっかけ')] = 'Web検索';
  gas.g.clearTableCache_();
  const view = gas.g.getReportDetail(r.data.reportId).data.report.customers[0];
  assert.deepEqual([view.role, view.visitTrigger], ['主担当', 'Web検索'], '担当区分が空欄の旧データは主担当として読む');
  // 画面から同じ内容で保存し直しても、変更なし（旧値も受け付ける）
  const same = gas.g.submitReport({ reportId: r.data.reportId, workContent: '業務', customers: [view] });
  assert.match(same.message, /変更がないため/);
  assert.equal(gas.main.rows('日報_接客')[0]['来場のきっかけ'], 'Web検索', '自動で変換・書き換えしない');
});

// ============================================================ 書き忘れた日（7日前まで・勤務実績あり）

test('過去の日：7日前まで・勤務実績がある日だけ本人が新しく作れる。8日以上前・勤務なし・先の日付は作れない', () => {
  const gas = office();
  work(gas, NAKATSUI, '2026-10-01'); // 7日前
  work(gas, NAKATSUI, '2026-09-30'); // 8日前
  work(gas, NAKATSUI, '2026-10-06');
  gas.loginAs(NAKATSUI);
  gas.setNow('2026-10-08 09:00');
  assert.deepEqual(gas.g.getReportList().data.missingDates, ['2026-10-06', '2026-10-01'], '書き忘れた日の一覧（新しい順・8日前は出さない）');
  const ed = gas.g.getReportEditor('', '2026-10-06').data;
  assert.deepEqual([ed.date, ed.report], ['2026-10-06', null], '過去の日の入力画面はその日付');
  const r = gas.g.submitReport({ date: '2026-10-06', workContent: '書き忘れ' });
  assert.equal(r.success, true, r.message);
  assert.equal(r.data.date, '2026-10-06');
  assert.equal(gas.g.submitReport({ date: '2026-10-01', workContent: '7日前' }).success, true);
  assert.match(gas.g.submitReport({ date: '2026-09-30', workContent: '8日前' }).message, /7日より前のため、日報を新しく作れません。必要な場合は管理者に相談/);
  assert.match(gas.g.submitReport({ date: '2026-10-05', workContent: '勤務なし' }).message, /勤務の記録がないため/);
  assert.match(gas.g.submitReport({ date: '2026-10-09', workContent: '明日' }).message, /先の日付/);
  assert.match(gas.g.getReportEditor('', '2026-09-30').message, /7日より前/);
  assert.deepEqual(gas.g.getReportList().data.missingDates, []);
  // 既にある過去の日報は、日付を指定しても新しく作らず、その日報を編集する（1日1件）
  const again = gas.g.submitReport({ date: '2026-10-06', workContent: '書き忘れ（修正）' });
  assert.deepEqual([again.data.reportId, again.data.version], [r.data.reportId, 2]);
});

// ============================================================ 他社員：閲覧・確認・未確認者

test('他社員：提出済みは閲覧・確認できる、下書きは閲覧できない。二重確認しても1件。自分の確認状態・未確認者が分かる', () => {
  const gas = office();
  gas.loginAs(KUBO);
  const draft = gas.g.saveReportDraft({ workContent: '下書きのメモ' }).data.reportId;
  const id = submitAs(gas, OMORI, '2026-10-08 18:00', { customers: [customer()] });
  gas.loginAs(NAKATSUI);
  assert.match(gas.g.getReportDetail(draft).message, /日報が見つかりません/, '他人の下書きは取れない');
  assert.doesNotMatch(JSON.stringify(gas.g.getReportList().data), /下書きのメモ/);
  assert.equal(gas.g.getReportDetail(id).success, true);
  assert.equal(gas.g.confirmReport(id).success, true);
  assert.match(gas.g.confirmReport(id).message, /すでに確認済みです/);
  assert.equal(gas.main.rows('日報_確認').length, 1, '二重に記録しない');
  const mine = gas.g.getReportList().data.reports.find((r) => r.reportId === id);
  assert.deepEqual([mine.myConfirmed, mine.confirmedCount, mine.targetCount], [true, 1, 5]);
  assert.deepEqual(mine.pendingNames, ['光山大樹', '猪倉厚', '村田清子', '久保亜弓'], '本人（大森）と確認済み（中津井）を除く。役員も含む');
  // 日報確認対象「対象外」・休職の人は確認の対象から外す（対象外の人は確認できない）
  staffCol(gas, 'E002', '日報確認対象', '対象外');
  staffCol(gas, 'E006', '在籍状況', '休職');
  const item = gas.g.getReportList().data.reports.find((r) => r.reportId === id);
  assert.deepEqual([item.targetCount, item.pendingNames], [3, ['光山大樹', '村田清子']]);
  gas.loginAs(INOKURA);
  assert.match(gas.g.confirmReport(id).message, /日報の確認の対象ではないため/);
  // 再編集で全員「未確認」に戻る
  submitAs(gas, OMORI, '2026-10-08 19:00', { reportId: id, workContent: '修正', customers: [customer()] });
  gas.loginAs(NAKATSUI);
  const after = gas.g.getReportList().data.reports.find((r) => r.reportId === id);
  assert.deepEqual([after.myConfirmed, after.confirmedCount, after.showUpdated], [false, 0, true]);
});

// ============================================================ コメント

test('コメント：複数件・コメント者ID/名/日時/本文を記録。送信IDが同じなら1件だけ。編集の関数はない。削除は管理者だけ（行は残し、削除者・日時を記録）', () => {
  const gas = office();
  const id = submitAs(gas, OMORI, '2026-10-08 18:00', {});
  gas.loginAs(NAKATSUI);
  gas.setNow('2026-10-08 18:10');
  const a = gas.g.addReportComment(id, 'お疲れさまです', 'S-abc');
  assert.equal(a.success, true, a.message);
  const again = gas.g.addReportComment(id, 'お疲れさまです', 'S-abc'); // 連打・通信の再送
  assert.match(again.message, /すでに投稿されています/);
  gas.loginAs(MURATA);
  gas.g.addReportComment(id, '確認しました', 'S-def');
  let rows = gas.main.rows('日報_コメント');
  assert.equal(rows.length, 2, '同じ送信IDは1件だけ');
  assert.deepEqual([rows[0]['社員ID'], rows[0]['社員名'], rows[0]['コメント'], rows[0]['投稿日時'], rows[0]['送信ID']], ['E005', '中津井祐貴', 'お疲れさまです', '2026-10-08 18:10:00', 'S-abc']);
  assert.equal(gas.g.getReportList().data.reports[0].commentCount, 2);
  assert.equal(typeof gas.g.updateReportComment, 'undefined', 'コメントを編集する関数はない');
  // 一般社員は削除できない
  const cid = rows[0]['コメントID'];
  assert.match(gas.g.deleteReportComment(cid).message, /管理者権限がありません/);
  assert.equal(gas.g.getReportDetail(id).data.canDeleteComment, false);
  // 管理者は削除できる（行は残る）
  gas.loginAs(MITSUYAMA);
  gas.setNow('2026-10-08 18:30');
  assert.equal(gas.g.getReportDetail(id).data.canDeleteComment, true);
  const del = gas.g.deleteReportComment(cid);
  assert.equal(del.success, true, del.message);
  rows = gas.main.rows('日報_コメント');
  assert.equal(rows.length, 2, '行は消さない');
  assert.deepEqual([rows[0]['削除'], rows[0]['削除者ID'], rows[0]['削除者名'], rows[0]['削除日時']], ['1', 'E001', '光山大樹', '2026-10-08 18:30:00']);
  assert.deepEqual(gas.g.getReportDetail(id).data.comments.map((c) => c.text), ['確認しました'], '削除したコメントは画面に出さない');
  assert.equal(gas.g.getReportList().data.reports[0].commentCount, 1);
  assert.match(gas.g.deleteReportComment(cid).message, /すでに削除されています/);
});

// ============================================================ 管理者：未提出の判定・日別・月別

test('未提出の判定：出勤あり＋提出済み／下書きのみ／日報なし、出勤なし（1日有給を含む）、出勤なし＋提出済み。役員（提出対象外）は提出したときだけ出す', () => {
  const gas = office();
  work(gas, OMORI, '2026-10-07');   // 提出済み
  work(gas, MURATA, '2026-10-07');  // 下書きのみ
  work(gas, NAKATSUI, '2026-10-07'); // 日報なし
  work(gas, MITSUYAMA, '2026-10-07'); // 役員：出勤あり・日報なし → 一覧に出さない
  submitAs(gas, OMORI, '2026-10-07 19:00', { customers: [customer()] });
  gas.loginAs(MURATA); gas.setNow('2026-10-07 19:00');
  gas.g.saveReportDraft({ workContent: '下書きの中身' });
  submitAs(gas, INOKURA, '2026-10-07 19:10', {}); // 役員：出勤なしで提出
  // 久保さん：1日有給（出勤なし）→ 対象外
  gas.loginAs(KUBO); gas.setNow('2026-10-05 09:00');
  const pl = gas.g.submitPaidLeaveRequest({ date: '2026-10-07', leaveType: '1日有給', reason: '私用' }).data.requestId;
  gas.loginAs(MITSUYAMA);
  assert.equal(gas.g.approvePaidLeaveRequest(pl).success, true);
  gas.setNow('2026-10-08 10:00');
  const rep = gas.g.getAdminDashboard({ date: '2026-10-07', parts: ['reports'] }).data.reports;
  assert.deepEqual(rep.rows.map((r) => r.name + ':' + r.status), ['猪倉厚:提出済み', '大森紗智子:提出済み', '村田清子:未提出（下書きあり）', '中津井祐貴:未提出', '久保亜弓:対象外']);
  assert.deepEqual([rep.submittedCount, rep.notSubmittedCount, rep.draftOnlyCount, rep.noneCount], [2, 2, 1, 1]);
  assert.doesNotMatch(JSON.stringify(rep), /下書きの中身/, '下書きの本文は管理者にも返さない');
  const omori = rep.rows.find((r) => r.name === '大森紗智子');
  assert.deepEqual([omori.customerCount, omori.commentCount, omori.confirmedCount, omori.targetCount, omori.pendingNames],
    [1, 0, 0, 5, ['光山大樹', '猪倉厚', '村田清子', '中津井祐貴', '久保亜弓']]);
});

test('管理者 月別（暦月）：勤務日数・提出数・未提出数・下書きのみ数（未提出・下書きのみは前日まで）。一般社員は管理者APIを呼べない', () => {
  const gas = office();
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']) work(gas, NAKATSUI, d);
  work(gas, NAKATSUI, '2026-09-30'); // 前の月（暦月では9月）
  submitAs(gas, NAKATSUI, '2026-10-01 19:00', {});
  submitAs(gas, NAKATSUI, '2026-10-02 19:00', {});
  gas.loginAs(NAKATSUI); gas.setNow('2026-10-05 19:00');
  gas.g.saveReportDraft({ workContent: '途中' });
  gas.setNow('2026-10-08 19:00'); // 今日（10/8）はまだ書ける → 未提出に数えない
  gas.loginAs(MITSUYAMA);
  const m = gas.g.getAdminDashboard({ date: '2026-10-08', parts: ['reports'] }).data.reports.monthly;
  assert.deepEqual([m.from, m.to, m.month], ['2026-10-01', '2026-10-31', '2026-10'], '暦月（1日〜末日）。20日締めではない');
  const n = m.rows.find((r) => r.name === '中津井祐貴');
  assert.deepEqual([n.workDays, n.submittedCount, n.notSubmittedCount, n.draftOnlyCount], [6, 2, 2, 1], '10/6・10/7 が未提出、10/5 が下書きのみ。9/30 は数えない');
  assert.deepEqual(m.rows.map((r) => r.name), ['大森紗智子', '村田清子', '中津井祐貴', '久保亜弓'], '月別は日報提出対象者（役員は対象外）');
  gas.loginAs(NAKATSUI);
  assert.match(gas.g.getAdminDashboard({ parts: ['reports'] }).message, /管理者権限がありません/);
});

// ============================================================ セキュリティ・同時操作・暦月

test('セキュリティ：他人の下書きは取れない・他人の日報は編集できない・確認やコメントの書き込みはロックの中', () => {
  const gas = office();
  gas.loginAs(KUBO);
  const draft = gas.g.saveReportDraft({ workContent: '秘密' }).data.reportId;
  const sub = submitAs(gas, OMORI, '2026-10-08 18:00', {});
  gas.loginAs(NAKATSUI);
  assert.match(gas.g.getReportDetail(draft).message, /日報が見つかりません/);
  assert.match(gas.g.getReportEditor(draft).message, /編集できる日報が見つかりません/);
  assert.match(gas.g.submitReport({ reportId: sub, workContent: '書き換え' }).message, /他の社員の日報は編集できません/);
  assert.match(gas.g.saveReportDraft({ reportId: draft, workContent: '書き換え' }).message, /他の社員の日報は編集できません/);
  assert.match(gas.g.confirmReport(draft).message, /日報が見つかりません/);
  assert.match(gas.g.addReportComment(draft, 'x', 'S1').message, /日報が見つかりません/);
  const src = ['DailyReportService.gs', 'DailyReportShareService.gs'].map((f) => fs.readFileSync(path.join(__dirname, '../leaf-portal/gas', f), 'utf8')).join('\n');
  for (const fn of ['saveReportDraft', 'submitReport', 'confirmReport', 'addReportComment', 'deleteReportComment']) {
    const start = src.indexOf('function ' + fn + '(');
    assert.match(src.slice(start, src.indexOf('\n}\n', start)), /withLock_/, fn + ' は withLock_ の中');
  }
  assert.match(src.slice(src.indexOf('function deleteReportComment('), src.indexOf('\n}\n', src.indexOf('function deleteReportComment('))), /requireAdmin\(\)/);
});

test('同時の確認：2人が続けて確認しても、同じ人の確認は1件だけ（日報ID＋社員ID＋バージョンで一意）', () => {
  const gas = office();
  const id = submitAs(gas, OMORI, '2026-10-08 18:00', {});
  for (const email of [NAKATSUI, KUBO, NAKATSUI, KUBO]) { gas.loginAs(email); gas.g.confirmReport(id); }
  const rows = gas.main.rows('日報_確認');
  assert.deepEqual(rows.map((r) => r['社員ID'] + ':' + r['日報バージョン']), ['E005:1', 'E006:1']);
});

test('暦月：10/1〜10/31 が10月の日報（9/30・11/1 は入らない）。日報は20日締めの関数を使わない', () => {
  const gas = office();
  for (const [date, now] of [['2026-09-30', '2026-09-30 19:00'], ['2026-10-01', '2026-10-01 19:00'], ['2026-10-31', '2026-10-31 19:00'], ['2026-11-01', '2026-11-01 19:00']]) {
    submitAs(gas, OMORI, now, { workContent: date });
  }
  gas.loginAs(NAKATSUI);
  gas.setNow('2026-11-01 20:00');
  const oct = gas.g.getReportList({ month: '2026-10' }).data;
  assert.deepEqual([oct.from, oct.to], ['2026-10-01', '2026-10-31']);
  assert.deepEqual(oct.reports.map((r) => r.date), ['2026-10-31', '2026-10-01']);
  const src = ['DailyReportService.gs', 'DailyReportShareService.gs'].map((f) => fs.readFileSync(path.join(__dirname, '../leaf-portal/gas', f), 'utf8')).join('\n');
  assert.doesNotMatch(src, /getPayrollPeriod/, '日報は20日締めの関数を使わない');
  const admin = fs.readFileSync(path.join(__dirname, '../leaf-portal/gas/AdminDashboardService.gs'), 'utf8');
  const fnSrc = admin.slice(admin.indexOf('function buildAdminReportMonthly_('), admin.indexOf('\n}\n', admin.indexOf('function buildAdminReportMonthly_(')));
  assert.match(fnSrc, /getReportMonthPeriodForDate_/);
  assert.doesNotMatch(fnSrc, /getPayrollPeriod/);
});
