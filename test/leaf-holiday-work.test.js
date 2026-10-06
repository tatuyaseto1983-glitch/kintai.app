'use strict';
// 休日出勤申請のテスト（対象者・入力・状態の流れ・権限・勤怠記録を変えないこと・準備前の動き）
const test = require('node:test');
const assert = require('node:assert');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const MITSUYAMA = 'hiroki@example.com'; // 役員・admin（休日出勤申請 対象外）
const INOKURA = 'atsushi@example.com';  // 役員・staff（休日出勤申請 対象外）
const OMORI = 'sachiko@example.com';    // フレックス
const MURATA = 'kiyoko@example.com';
const NAKATSUI = 'yuuki@example.com';   // 固定勤務
const KUBO = 'ayumi@example.com';

/** 実際のスタッフマスタに近い6名（休日出勤申請対象：光山・猪倉は対象外、一般4名は対象） */
function office() {
  const gas = createLeafGas({ email: MITSUYAMA });
  gas.g.setupSystem();
  const base = { '在籍状況': '在籍', '雇用区分': '正社員' };
  gas.g.appendRecords_('スタッフマスタ', [
    { ...base, '社員ID': 'E001', '氏名': '光山大樹', 'メールアドレス': MITSUYAMA, '権限': 'admin', '勤務区分': '固定勤務', '部署': '管理', '勤怠集計対象': '対象外', '休日出勤申請対象': '対象外' },
    { ...base, '社員ID': 'E002', '氏名': '猪倉厚', 'メールアドレス': INOKURA, '権限': 'staff', '勤務区分': '固定勤務', '部署': '管理', '勤怠集計対象': '対象外', '休日出勤申請対象': '対象外' },
    { ...base, '社員ID': 'E003', '氏名': '大森紗智子', 'メールアドレス': OMORI, '権限': 'staff', '勤務区分': 'フレックス', '部署': '一般', '休日出勤申請対象': '対象' },
    { ...base, '社員ID': 'E004', '氏名': '村田清子', 'メールアドレス': MURATA, '権限': 'staff', '勤務区分': 'フレックス', '部署': '一般', '休日出勤申請対象': '対象' },
    { ...base, '社員ID': 'E005', '氏名': '中津井祐貴', 'メールアドレス': NAKATSUI, '権限': 'staff', '勤務区分': '固定勤務', '部署': '一般', '休日出勤申請対象': '対象' },
    { ...base, '社員ID': 'E006', '氏名': '久保亜弓', 'メールアドレス': KUBO, '権限': 'staff', '勤務区分': '固定勤務', '部署': '一般', '休日出勤申請対象': '対象' },
  ]);
  gas.setNow('2026-10-02 10:00');
  return gas;
}
const plan = (over) => ({
  workDate: '2026-10-10', plannedStart: '09:00', plannedEnd: '17:00', reason: '現場立ち会い', content: '配筋検査の立ち会い',
  compDayType: '取得予定', compDayDate: '2026-10-14', note: '', ...over,
});
const staffCell = (gas, id, col) => {
  const sheet = gas.main.getSheetByName('スタッフマスタ');
  return sheet.data.find((r) => r[0] === id)[sheet.data[0].indexOf(col)];
};

// ============================================================ 列の追加と初期値

test('setupSystem：「休日出勤申請対象」列を右端に追加し、勤怠集計対象をもとに初期値を入れる（あとは別管理）', () => {
  const gas = createLeafGas({ email: MITSUYAMA });
  const staff = gas.main.insertSheet('スタッフマスタ');
  const head = ['社員ID', '氏名', 'メールアドレス', '権限', '雇用区分', '勤務区分', '標準出勤', '標準退勤', '1日所定時間', '週所定時間', '月所定時間', '在籍状況', '入社日', '部署', '備考', '勤怠集計対象'];
  const row = (id, name, target) => [id, name, id + '@example.com', 'staff', '正社員', '固定勤務', '09:30', '18:30', '08:00', '', '', '在籍', '', '一般', '', target];
  staff.data = [head, row('E001', '光山大樹', '対象外'), row('E002', '猪倉厚', '対象外'), row('E003', '大森紗智子', ''), row('E004', '村田清子', '対象'),
    row('E005', '中津井祐貴', ''), row('E006', '久保亜弓', '')];
  const before = JSON.stringify(staff.data.map((r) => r.slice(0, 16)));
  const log = gas.g.setupSystem();
  assert.match(log, /スタッフマスタ：足りない列を右端に追加しました（休日出勤申請対象、有給申請対象、日報提出対象、日報確認対象、自己承認可）。休日出勤申請対象の初期値を入れました（対象 4名・対象外 2名/);
  assert.equal(staff.data[0][16], '休日出勤申請対象', '右端（Q列）に追加');
  assert.deepEqual(staff.data.slice(1).map((r) => r[16]), ['対象外', '対象外', '対象', '対象', '対象', '対象']);
  assert.equal(JSON.stringify(staff.data.map((r) => r.slice(0, 16))), before, '既存の列・値は変えない');
  // 別管理：勤怠集計対象を変えても、休日出勤申請対象は変わらない。2回目の setupSystem でも上書きしない
  staff.data[3][15] = '対象外';
  staff.data[4][16] = '対象外';
  gas.g.setupSystem();
  assert.deepEqual(staff.data.slice(1).map((r) => r[16]), ['対象外', '対象外', '対象', '対象外', '対象', '対象']);
  assert.ok(gas.main.getSheetByName('休日出勤申請'), '休日出勤申請シートを作成');
  assert.deepEqual(gas.main.getSheetByName('休日出勤申請').data[0].slice(0, 20), ['申請ID', '申請日時', '社員ID', '氏名', '休日出勤日', '開始予定時刻',
    '終了予定時刻', '予定勤務時間', '休日出勤理由', '業務内容', '振替休日区分', '振替休日予定日', '備考', 'ステータス', '承認者ID', '承認者名', '承認日時',
    '却下理由', '取消申請日時', '取消承認日時']);
  assert.deepEqual(gas.main.getSheetByName('休日出勤申請').data[0].slice(20), ['取消理由', '取消処理者ID', '取消処理者名', '取消却下理由', '更新日時', '現場'], '段階3の「現場」は右端に（申請時シフト区分はシフト管理を使うときだけ）');
});

// ============================================================ 対象者

test('対象者：「休日出勤申請対象」が「対象」の在籍者だけ。対象外・空欄・休職は画面に出さず、サーバーでも拒否', () => {
  const gas = office();
  for (const email of [MITSUYAMA, INOKURA]) {
    gas.loginAs(email);
    const d = gas.g.getMyHolidayWorkRequests().data;
    assert.deepEqual([d.eligible, d.requests], [false, []], email + '：カードを出さない');
    assert.match(gas.g.submitHolidayWorkRequest(plan()).message, /休日出勤申請の対象外です/, email + '：直接呼んでも拒否');
  }
  for (const email of [OMORI, NAKATSUI]) { // フレックスも固定勤務も申請できる
    gas.loginAs(email);
    assert.equal(gas.g.getMyHolidayWorkRequests().data.eligible, true);
    assert.equal(gas.g.submitHolidayWorkRequest(plan()).success, true, email);
  }
  const sheet = gas.main.getSheetByName('スタッフマスタ');
  const col = sheet.data[0].indexOf('休日出勤申請対象');
  const kubo = sheet.data.find((r) => r[0] === 'E006');
  kubo[col] = ''; // 空欄は申請できない
  gas.g.clearTableCache_();
  gas.loginAs(KUBO);
  assert.match(gas.g.submitHolidayWorkRequest(plan()).message, /対象外/);
  kubo[col] = '対象';
  kubo[sheet.data[0].indexOf('在籍状況')] = '休職';
  gas.g.clearTableCache_();
  assert.match(gas.g.submitHolidayWorkRequest(plan()).message, /対象外/);
  // 勤怠集計対象とは別：勤怠集計対象外でも、休日出勤申請対象なら申請できる
  const inokura = sheet.data.find((r) => r[0] === 'E002');
  inokura[col] = '対象';
  gas.g.clearTableCache_();
  gas.loginAs(INOKURA);
  assert.equal(gas.g.submitHolidayWorkRequest(plan()).success, true);
  assert.equal(staffCell(gas, 'E002', '勤怠集計対象'), '対象外');
});

// ============================================================ 入力

test('入力：申請者はサーバーが決める・過去日不可（当日可）・日付またぎ不可・必須項目・振替休日の条件・二重申請', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const submit = (over) => gas.g.submitHolidayWorkRequest(plan(over));
  assert.match(submit({ workDate: '' }).message, /休日出勤日/);
  assert.match(submit({ workDate: '2026-10-01' }).message, /過去の日付は申請できません/);
  assert.match(submit({ plannedEnd: '09:00' }).message, /日付をまたぐ休日出勤は申請できません/);
  assert.match(submit({ plannedStart: '22:00', plannedEnd: '02:00' }).message, /終了予定時刻は開始予定時刻より後/);
  assert.match(submit({ reason: ' ' }).message, /休日出勤理由を入力してください/);
  assert.match(submit({ content: '' }).message, /業務内容を入力してください/);
  assert.match(submit({ compDayType: '' }).message, /振替休日区分は「取得予定」「取得予定なし」「未定」/);
  assert.match(submit({ compDayDate: '2026-10-10' }).message, /休日出勤日と別の日/);
  assert.match(submit({ compDayDate: '2026-09-30' }).message, /過去の日付は指定できません/);

  // 画面から社員ID・氏名・ステータスを送っても使わない。当日は申請できる
  const r = submit({ workDate: '2026-10-02', plannedStart: '13:00', plannedEnd: '18:30', employeeId: 'E003', name: '大森紗智子', status: '承認済み', note: '<b>メモ</b>' });
  assert.equal(r.success, true, r.message);
  assert.deepEqual([r.data.employeeId, r.data.name, r.data.status, r.data.plannedSpan, r.data.note], ['E005', '中津井祐貴', '申請中', '05:30', '<b>メモ</b>']);
  const row = gas.main.rows('休日出勤申請')[0];
  assert.deepEqual([row['休日出勤日'], row['開始予定時刻'], row['終了予定時刻'], row['予定勤務時間'], row['振替休日区分'], row['振替休日予定日']],
    ['2026-10-02', '13:00', '18:30', '05:30', '取得予定', '2026-10-14']);
  assert.match(row['申請ID'], /^HW-\d{14}-E005$/);

  // 振替休日：取得予定でも日付未定なら空欄で申請できる。取得予定以外の日付は保存しない
  assert.equal(submit({ workDate: '2026-10-11', compDayDate: '' }).data.compDayDate, '');
  assert.equal(submit({ workDate: '2026-10-12', compDayType: '未定', compDayDate: '2026-10-20' }).data.compDayDate, '');
  // 二重申請（申請中・承認済み・取消申請中）は不可。却下・取消済みのあとは申請し直せる
  assert.match(submit({ workDate: '2026-10-12' }).message, /2026-10-12 の休日出勤申請はすでにあります（ステータス：承認待ち）/);
  const id = gas.main.rows('休日出勤申請').find((x) => x['休日出勤日'] === '2026-10-12')['申請ID'];
  gas.g.withdrawHolidayWorkRequest(id);
  assert.equal(submit({ workDate: '2026-10-12' }).success, true, '取消済みのあとは申請し直せる');
});

// ============================================================ 状態の流れと権限

test('状態の流れ：申請中→承認済み（承認者ID・氏名・日時）／却下（理由必須）、管理者以外は承認不可、処理済みは再処理不可', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const a = gas.g.submitHolidayWorkRequest(plan()).data.requestId;
  const b = gas.g.submitHolidayWorkRequest(plan({ workDate: '2026-10-11' })).data.requestId;
  for (const email of [NAKATSUI, INOKURA, OMORI]) {
    gas.loginAs(email);
    for (const fn of ['approveHolidayWorkRequest', 'rejectHolidayWorkRequest', 'approveHolidayWorkCancellation', 'rejectHolidayWorkCancellation']) {
      assert.match(gas.g[fn](a, '理由').message, /管理者権限がありません/, email + ' ' + fn);
    }
  }
  gas.loginAs(MITSUYAMA);
  gas.setNow('2026-10-02 11:00');
  let r = gas.g.approveHolidayWorkRequest(a);
  assert.equal(r.success, true, r.message);
  const row = gas.main.rows('休日出勤申請').find((x) => x['申請ID'] === a);
  assert.deepEqual([row['ステータス'], row['承認者ID'], row['承認者名'], row['承認日時'].slice(0, 16)], ['承認済み', 'E001', '光山大樹', '2026-10-02 11:00']);
  assert.match(gas.g.approveHolidayWorkRequest(a).message, /「申請中」ではないため処理できません（今のステータス：承認済み）/);
  assert.match(gas.g.rejectHolidayWorkRequest(b, ' ').message, /却下理由を入力してください/);
  r = gas.g.rejectHolidayWorkRequest(b, '人員が足りているため');
  assert.deepEqual([r.data.status, r.data.rejectReason, r.data.approverId], ['却下', '人員が足りているため', 'E001']);
  assert.match(gas.g.approveHolidayWorkRequest('HW-なし').message, /見つかりません/);
  // 本人の画面：ステータスと却下理由が分かる
  gas.loginAs(NAKATSUI);
  const mine = gas.g.getMyHolidayWorkRequests().data.requests;
  assert.deepEqual(mine.map((x) => x.workDate + ':' + x.status), ['2026-10-11:却下', '2026-10-10:承認済み']);
  assert.equal(mine[0].rejectReason, '人員が足りているため');
});

test('取り下げ・取消：申請中は本人が即取消済み。承認済みは取消申請中→管理者が承認（取消済み）／却下（承認済みに戻る）', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const p = gas.g.submitHolidayWorkRequest(plan()).data.requestId;
  const q = gas.g.submitHolidayWorkRequest(plan({ workDate: '2026-10-11' })).data.requestId;
  // 他人は取り下げ・取消申請できない
  gas.loginAs(OMORI);
  assert.match(gas.g.withdrawHolidayWorkRequest(p).message, /休日出勤申請が見つかりません/);
  assert.match(gas.g.requestHolidayWorkCancellation(p, 'x').message, /休日出勤申請が見つかりません/);
  // 申請中 → 本人が取り下げ → 取消済み（管理者の承認なし）
  gas.loginAs(NAKATSUI);
  assert.match(gas.g.requestHolidayWorkCancellation(p, 'x').message, /「承認済み」の申請だけ/);
  let r = gas.g.withdrawHolidayWorkRequest(p);
  assert.deepEqual([r.success, r.data.status, r.data.cancelHandlerName], [true, '取消済み', '中津井祐貴']);
  assert.match(gas.g.withdrawHolidayWorkRequest(p).message, /「申請中」の申請だけ/);

  gas.loginAs(MITSUYAMA);
  gas.g.approveHolidayWorkRequest(q);
  gas.loginAs(NAKATSUI);
  assert.match(gas.g.withdrawHolidayWorkRequest(q).message, /承認済みの場合は「取消申請」/, '承認済みは直接取り下げできない');
  assert.match(gas.g.requestHolidayWorkCancellation(q, '').message, /取消の理由を入力してください/);
  gas.setNow('2026-10-03 09:00');
  r = gas.g.requestHolidayWorkCancellation(q, '立ち会い不要になった');
  assert.deepEqual([r.data.status, r.data.cancelReason, r.data.cancelRequestedAt.slice(0, 16)], ['取消申請中', '立ち会い不要になった', '2026-10-03 09:00']);
  gas.loginAs(MITSUYAMA);
  assert.match(gas.g.approveHolidayWorkRequest(q).message, /「申請中」ではない/);
  assert.match(gas.g.rejectHolidayWorkCancellation(q, '').message, /取消を却下する理由を入力してください/);
  r = gas.g.rejectHolidayWorkCancellation(q, '予定どおりお願いします');
  assert.deepEqual([r.data.status, r.data.cancelRejectReason, r.data.approverName], ['承認済み', '予定どおりお願いします', '光山大樹'], '承認済みに戻る');
  gas.loginAs(NAKATSUI);
  gas.g.requestHolidayWorkCancellation(q, 'やはり不要');
  gas.loginAs(MITSUYAMA);
  gas.setNow('2026-10-03 10:00');
  r = gas.g.approveHolidayWorkCancellation(q);
  assert.deepEqual([r.data.status, r.data.cancelApprovedAt.slice(0, 16), r.data.cancelHandlerName], ['取消済み', '2026-10-03 10:00', '光山大樹']);
  // 過去の休日出勤は取消申請できない
  gas.loginAs(KUBO);
  gas.setNow('2026-10-02 10:00');
  const old = gas.g.submitHolidayWorkRequest(plan({ workDate: '2026-10-04' })).data.requestId;
  gas.loginAs(MITSUYAMA);
  gas.g.approveHolidayWorkRequest(old);
  gas.loginAs(KUBO);
  gas.setNow('2026-10-05 09:00');
  assert.match(gas.g.requestHolidayWorkCancellation(old, 'x').message, /過去の休日出勤は取消申請できません/);
});

test('自分の申請は承認できない（管理者が申請対象になった場合）', () => {
  const gas = office();
  const sheet = gas.main.getSheetByName('スタッフマスタ');
  sheet.data.find((r) => r[0] === 'E001')[sheet.data[0].indexOf('休日出勤申請対象')] = '対象';
  gas.g.clearTableCache_();
  gas.loginAs(MITSUYAMA);
  const id = gas.g.submitHolidayWorkRequest(plan()).data.requestId;
  assert.match(gas.g.approveHolidayWorkRequest(id).message, /自分の休日出勤申請は承認・却下できません/);
});

// ============================================================ 勤怠との関係

test('勤怠：承認しても打刻・実働は変わらない（遅刻・早退・社内超過だけ付けない計算に直す）。予定と実績は 社員ID＋日付 で照合できる', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const a = gas.g.submitHolidayWorkRequest(plan({ workDate: '2026-10-02', plannedStart: '10:00', plannedEnd: '16:00' })).data.requestId;
  gas.setNow('2026-10-02 10:02');
  gas.g.clockIn('出社');
  gas.setNow('2026-10-02 16:10');
  gas.g.clockOut();
  const pick = () => { const r = gas.main.rows('勤怠記録')[0]; return [r['出勤'], r['退勤'], r['実働時間'], r['遅刻'], r['社内超過時間']]; };
  assert.deepEqual(pick(), ['10:02', '16:10', '05:08', '00:32', '00:00'], '承認前は通常勤務日の基準（09:30）で遅刻');
  const segBefore = JSON.stringify(gas.main.getSheetByName('勤務区間履歴').data);
  gas.loginAs(MITSUYAMA);
  assert.match(gas.g.approveHolidayWorkRequest(a).message, /遅刻・早退・社内超過を計算し直しました/);
  assert.deepEqual(pick(), ['10:02', '16:10', '05:08', '', ''], '承認後は遅刻・社内超過を付けない。打刻・実働はそのまま');
  assert.equal(JSON.stringify(gas.main.getSheetByName('勤務区間履歴').data), segBefore, '勤務区間は変えない');
  const before = JSON.stringify(gas.main.getSheetByName('勤怠記録').data);

  const map = gas.g.buildHolidayWorkPlanMap_();
  assert.deepEqual(Object.keys(map), ['E005|2026-10-02']);
  const d = gas.g.getAdminDashboard({ date: '2026-10-02' }).data;
  const item = d.holidayWork.processed.find((x) => x.requestId === a);
  assert.deepEqual([item.actual.attendanceId, item.actual.clockIn, item.actual.clockOut, item.plannedStart, item.plannedEnd],
    ['AT-20261002-E005', '10:02', '16:10', '10:00', '16:00'], '予定と実績を並べられる');
  assert.equal(JSON.stringify(gas.main.getSheetByName('勤怠記録').data), before);
});

test('管理者画面：処理待ち（申請中・取消申請中）の件数と一覧。サマリーにも件数', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const a = gas.g.submitHolidayWorkRequest(plan()).data.requestId;
  gas.g.submitHolidayWorkRequest(plan({ workDate: '2026-10-11' }));
  gas.loginAs(OMORI);
  gas.g.submitHolidayWorkRequest(plan({ workDate: '2026-10-09' }));
  gas.loginAs(MITSUYAMA);
  gas.g.approveHolidayWorkRequest(a);
  gas.loginAs(NAKATSUI);
  gas.g.requestHolidayWorkCancellation(a, '不要');
  gas.loginAs(MITSUYAMA);
  const d = gas.g.getAdminDashboard({ date: '2026-10-02' }).data;
  assert.deepEqual(d.holidayWork.pending.map((x) => x.workDate + ':' + x.status), ['2026-10-09:申請中', '2026-10-10:取消申請中', '2026-10-11:申請中']);
  assert.deepEqual([d.holidayWork.pendingCount, d.summary.pendingHolidayWork], [3, 3]);
  assert.equal(d.holidayWork.pending[0].department, '一般');
  // 一般社員は管理者画面のデータを取れない
  gas.loginAs(NAKATSUI);
  assert.match(gas.g.getAdminDashboard({}).message, /管理者権限がありません/);
});

// ============================================================ 準備前（setupSystem 前）

test('setupSystem 前：休日出勤のカードは出さず、申請・承認は setupSystem を案内。ほかの機能は動く', () => {
  const gas = createLeafGas({ email: NAKATSUI });
  gas.g.setupSystem();
  gas.g.appendRecords_('スタッフマスタ', [
    { '社員ID': 'E005', '氏名': '中津井祐貴', 'メールアドレス': NAKATSUI, '権限': 'staff', '勤務区分': '固定勤務', '在籍状況': '在籍', '休日出勤申請対象': '対象' },
    { '社員ID': 'E001', '氏名': '光山大樹', 'メールアドレス': MITSUYAMA, '権限': 'admin', '勤務区分': '固定勤務', '在籍状況': '在籍' },
  ]);
  gas.main.deleteSheet(gas.main.getSheetByName('休日出勤申請')); // 以前の環境（シートなし）を再現
  gas.g.clearTableCache_();
  const d = gas.g.getMyHolidayWorkRequests();
  assert.deepEqual([d.success, d.data.eligible, d.data.setupRequired], [true, false, true]);
  assert.match(gas.g.submitHolidayWorkRequest(plan()).message, /setupSystem\(\) を実行してください/);
  assert.equal(gas.g.clockIn('出社').success, true, '打刻はそのまま使える');
  gas.loginAs(MITSUYAMA);
  const admin = gas.g.getAdminDashboard({}).data;
  assert.deepEqual([admin.holidayWork.setupRequired, admin.summary.pendingHolidayWork], [true, 0]);
  assert.match(gas.g.approveHolidayWorkRequest('x').message, /setupSystem\(\) を実行してください/);
});

// ============================================================ 画面

test('画面：呼べる関数はサーバーにあり、スタッフ画面の許可リストに管理者用の関数を含まない。innerHTML を使わない', () => {
  const gas = office();
  const html = gas.g.doGet({ parameter: {} }).getContent();
  const staffList = JSON.parse(html.match(/HW_FUNCTIONS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  for (const fn of staffList) assert.equal(typeof gas.g[fn], 'function', fn);
  assert.ok(!staffList.some((fn) => /approve|reject/.test(fn)), '承認・却下はスタッフ画面から呼べない');
  const adminList = html.match(/ADMIN_FUNCTIONS = \[([\s\S]*?)\]/)[1];
  for (const fn of ['approveHolidayWorkRequest', 'rejectHolidayWorkRequest', 'approveHolidayWorkCancellation', 'rejectHolidayWorkCancellation']) {
    assert.match(adminList, new RegExp("'" + fn + "'"));
    assert.equal(typeof gas.g[fn], 'function');
  }
  assert.doesNotMatch(gas.g.HtmlService.createHtmlOutputFromFile('HolidayWorkScripts').getContent(), /innerHTML/);
  assert.match(html, /id="holidayWorkCard" hidden/, '最初は隠しておき、対象の人だけサーバーの判定で表示');
  assert.match(html, />予定拘束時間</);
  assert.doesNotMatch(html, />予定勤務時間</, '画面では「予定勤務時間」と書かない');
});
