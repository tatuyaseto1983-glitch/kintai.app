'use strict';
// 段階3のテスト（有給休暇申請・半休の遅刻早退・フレックスの有給・要確認・20日締めの集計・休日出勤申請の現場・権限）
//
// 今回はシフト管理を使わない（Config.gs の SHIFT_FEATURE.enabled = false）。前半はその状態（今回の運用）のテスト。
// 後半の「将来用」は、シフト管理を使うとき（enabled = true）の判定が壊れていないかを確かめるテスト（今は画面・運用では使わない）。
const test = require('node:test');
const assert = require('node:assert');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const MITSUYAMA = 'hiroki@example.com'; // 役員・admin（勤怠集計 対象外 → 有給申請 対象外）
const INOKURA = 'atsushi@example.com';  // 役員・admin（2人目の管理者。光山さん本人の申請の承認用）
const OMORI = 'sachiko@example.com';    // フレックス
const NAKATSUI = 'yuuki@example.com';   // 固定勤務（09:30〜18:30）
const KUBO = 'ayumi@example.com';       // 固定勤務

const STAFF = [['E003', '大森紗智子'], ['E005', '中津井祐貴'], ['E006', '久保亜弓']];

/**
 * 管理者2名・一般3名。
 * shifts を渡したときだけ「将来用」：シフト管理を使う状態にして、shifts（日付 → 区分）を登録する（指定のない日は未登録）
 */
function office(shifts) {
  const gas = createLeafGas({ email: MITSUYAMA });
  if (shifts) gas.eval('SHIFT_FEATURE.enabled = true');
  gas.g.setupSystem();
  const base = { '在籍状況': '在籍', '雇用区分': '正社員', '部署': '一般', '休日出勤申請対象': '対象', '有給申請対象': '対象' };
  gas.g.appendRecords_('スタッフマスタ', [
    { ...base, '社員ID': 'E001', '氏名': '光山大樹', 'メールアドレス': MITSUYAMA, '権限': 'admin', '勤務区分': '固定勤務', '部署': '管理', '勤怠集計対象': '対象外', '休日出勤申請対象': '対象外', '有給申請対象': '対象外' },
    { ...base, '社員ID': 'E002', '氏名': '猪倉厚', 'メールアドレス': INOKURA, '権限': 'admin', '勤務区分': '固定勤務', '部署': '管理' },
    { ...base, '社員ID': 'E003', '氏名': '大森紗智子', 'メールアドレス': OMORI, '権限': 'staff', '勤務区分': 'フレックス' },
    { ...base, '社員ID': 'E005', '氏名': '中津井祐貴', 'メールアドレス': NAKATSUI, '権限': 'staff', '勤務区分': '固定勤務' },
    { ...base, '社員ID': 'E006', '氏名': '久保亜弓', 'メールアドレス': KUBO, '権限': 'staff', '勤務区分': '固定勤務' },
  ]);
  setSetting(gas, '自動休憩_適用開始', '06:00'); // 本番と同じ（6時間以下の日は自動休憩を引かない）
  if (shifts) setShifts(gas, shifts);
  gas.setNow('2026-10-02 08:00');
  return gas;
}
/** { '2026-10-10': '休日', ... } を一般3名（と猪倉さん）のシフトとして登録 */
function setShifts(gas, byDate, ids) {
  const who = ids || [...STAFF, ['E002', '猪倉厚']];
  const rows = [];
  for (const [date, type] of Object.entries(byDate)) for (const [id, name] of who) rows.push({ '日付': date, '社員ID': id, '氏名': name, 'シフト区分': type });
  gas.g.appendRecords_('シフト', rows);
  gas.g.clearTableCache_();
}
/** 9/21〜10/31 の平日=通常勤務・土=休日・日=法定休日 */
function calendarShifts() {
  const out = {};
  for (let t = Date.UTC(2026, 8, 21); t <= Date.UTC(2026, 9, 31); t += 86400000) {
    const d = new Date(t);
    const w = d.getUTCDay();
    out[d.toISOString().slice(0, 10)] = w === 0 ? '法定休日' : w === 6 ? '休日' : '通常勤務';
  }
  return out;
}
const setSetting = (gas, key, value) => {
  const sheet = gas.main.getSheetByName('設定');
  sheet.data.find((r) => r[0] === key)[1] = value;
  gas.g.clearTableCache_();
};
const hwPlan = (over) => ({
  workDate: '2026-10-10', plannedStart: '09:00', plannedEnd: '17:00', reason: '現場立ち会い', content: '配筋検査',
  compDayType: '取得予定', compDayDate: '2026-10-14', note: '', site: '堺市○○様邸', ...over,
});
const pl = (over) => ({ date: '2026-10-07', leaveType: '1日有給', reason: '私用のため', note: '', ...over });
const att = (gas, id) => gas.main.rows('勤怠記録').find((r) => r['勤怠ID'] === id);
/** その人のその日の打刻（出勤→退勤） */
function work(gas, email, date, from, to, style) {
  gas.loginAs(email);
  gas.setNow(date + ' ' + from);
  const r = gas.g.clockIn(style || '出社');
  assert.equal(r.success, true, r.message);
  if (to) {
    gas.setNow(date + ' ' + to);
    const o = gas.g.clockOut();
    assert.equal(o.success, true, o.message);
  }
  gas.setNow('2026-10-02 08:00');
}
const monthlyRow = (gas, name, month) => {
  gas.loginAs(MITSUYAMA);
  const d = gas.g.getAdminDashboard({ month: month || '2026-10', date: '2026-10-02' }).data;
  return d.monthly.rows.find((r) => r.name === name);
};
const dayOf = (gas, id, date) => {
  gas.loginAs(MITSUYAMA);
  const ctx = gas.g.buildDayStatusContext_();
  const rec = gas.main.rows('勤怠記録').find((r) => r['社員ID'] === id && r['日付'] === date) || null;
  return gas.g.buildDayStatus_(id, date, rec, ctx);
};

// ============================================================ 準備（setupSystem）

test('setupSystem：有給休暇申請シートを作り、有給申請対象は勤怠集計対象から初期値。シフトシートは作らない。2回目は何も変えない', () => {
  const gas = createLeafGas({ email: MITSUYAMA });
  const staff = gas.main.insertSheet('スタッフマスタ');
  const head = ['社員ID', '氏名', 'メールアドレス', '権限', '雇用区分', '勤務区分', '標準出勤', '標準退勤', '1日所定時間', '週所定時間', '月所定時間', '在籍状況', '入社日', '部署', '備考', '勤怠集計対象'];
  const row = (id, target) => [id, id, id + '@example.com', 'staff', '正社員', '固定勤務', '09:30', '18:30', '08:00', '', '', '在籍', '', '一般', '', target];
  staff.data = [head, row('E001', '対象外'), row('E003', ''), row('E005', '対象')];
  const log = gas.g.setupSystem();
  assert.match(log, /有給申請対象の初期値を入れました（対象 2名・対象外 1名/);
  const h = staff.data[0];
  assert.deepEqual(h.slice(16), ['休日出勤申請対象', '有給申請対象'], '右端に追加');
  assert.deepEqual(staff.data.slice(1).map((r) => r[17]), ['対象外', '対象', '対象']);
  assert.equal(gas.main.getSheetByName('シフト'), null, 'シフト管理を使わない間はシフトシートを作らない');
  assert.deepEqual(gas.main.getSheetByName('休日出勤申請').data[0].slice(25), ['現場'], '休日出勤申請は「現場」だけ右端に足す');
  assert.deepEqual(gas.main.getSheetByName('有給休暇申請').data[0], ['申請ID', '申請日時', '社員ID', '氏名', '対象日', '有給種別', '理由', '備考',
    '申請時シフト区分', '事後申請', 'ステータス', '承認者ID', '承認者名', '承認日時', '却下理由', '取消申請日時', '取消承認日時', '取消理由',
    '取消処理者ID', '取消処理者名', '取消却下理由', '更新日時']);
  const settings = Object.fromEntries(gas.main.rows('設定').map((r) => [r['項目'] || Object.values(r)[0], r['値']]));
  assert.deepEqual(['有給_1日時間', '有給_半日時間', '午前半休_勤務開始', '午後半休_勤務終了', 'フレックス_有給算入'].map((k) => settings[k]),
    ['08:00', '04:00', '14:30', '13:30', '未確定']);
  // 有給申請対象は別管理：勤怠集計対象を変えても、2回目の setupSystem でも上書きしない
  staff.data[2][15] = '対象外';
  staff.data[3][17] = '対象外';
  const before = JSON.stringify(gas.main.sheets.map((s) => s.data));
  gas.g.setupSystem();
  assert.equal(JSON.stringify(gas.main.sheets.map((s) => s.data)), before, '2回目は何も変わらない（冪等）');
});

// ============================================================ 今回の範囲：シフトなしで申請・承認できる

test('シフト管理を使わない：シフトがなくても休日出勤・有給を申請・承認できる。シフトを理由に要確認にしない', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const hw = gas.g.submitHolidayWorkRequest(hwPlan({ workDate: '2026-10-07' })); // 平日でも土日でも受け付ける（シフトで判定しない）
  assert.equal(hw.success, true, hw.message);
  assert.equal(hw.message, '休日出勤を申請しました（2026-10-07）。管理者の承認をお待ちください', '以前と同じ文言（シフトの案内を出さない）');
  const leave = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-10' })); // 土曜でも受け付ける
  assert.equal(leave.success, true, leave.message);
  assert.doesNotMatch(leave.message, /シフト|未登録/);
  assert.equal(leave.data.shiftAtRequest, '', '申請時シフト区分は空欄');
  gas.loginAs(MITSUYAMA);
  const d = gas.g.getAdminDashboard({ date: '2026-10-02' }).data;
  assert.equal(d.shiftEnabled, false);
  assert.deepEqual([d.holidayWork.pending[0].currentShift, d.holidayWork.pending[0].approvable], ['', true]);
  assert.deepEqual([d.paidLeave.pending[0].currentShift, d.paidLeave.pending[0].approvable], ['', true]);
  assert.equal(gas.g.approveHolidayWorkRequest(hw.data.requestId).success, true, 'シフト未登録でも承認できる');
  assert.equal(gas.g.approvePaidLeaveRequest(leave.data.requestId).success, true, 'シフト未登録でも承認できる');
  // 勤務しても、シフト未登録・未申請休日出勤 などの要確認は出さない。申請のない日は区分なし（通常のバッジも出さない）
  work(gas, NAKATSUI, '2026-10-07', '09:00', '12:00');
  work(gas, KUBO, '2026-10-11', '09:00', '12:00');
  const st = dayOf(gas, 'E006', '2026-10-11');
  assert.deepEqual([st.shiftType, st.kind, st.holidayWork, st.checks, st.badges], ['', '', null, [], []], '申請のない日曜の勤務');
  const hwDay = dayOf(gas, 'E005', '2026-10-07');
  assert.deepEqual([hwDay.kind, hwDay.checks, hwDay.badges.map((b) => b.text)], ['休日出勤', [], ['休出']], '承認済み休日出勤の日は「休日出勤」');
  const row = monthlyRow(gas, '久保亜弓').days;
  assert.deepEqual([row.holidayWorkDays, row.legalHolidayWorkDays, row.checkCount], [0, 0, 0]);
  // スタッフ画面：シフトの表示はしない
  gas.loginAs(NAKATSUI);
  assert.equal(gas.g.getMyPaidLeaveRequests().data.shiftEnabled, false);
  assert.equal(gas.g.getMyHolidayWorkRequests().data.shiftEnabled, false);
  assert.deepEqual(gas.g.getMyHolidayWorkRequests().data.requests.map((r) => r.currentShift), ['']);
  assert.deepEqual([gas.g.getMyShiftOn('2026-10-07').data.enabled, gas.g.getMyShifts().data.enabled], [false, false]);
});

test('シフト管理を使わない：休日出勤申請は「現場」を保存し、以前の流れ（承認待ち→承認／取消申請→取消済み）のまま', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const a = gas.g.submitHolidayWorkRequest(hwPlan());
  const row = () => gas.main.rows('休日出勤申請').find((r) => r['申請ID'] === a.data.requestId);
  assert.deepEqual([row()['現場'], row()['ステータス'], a.data.statusLabel, a.data.site], ['堺市○○様邸', '申請中', '承認待ち', '堺市○○様邸']);
  assert.equal('申請時シフト区分' in row(), false, '申請時シフト区分の列は作らない');
  gas.loginAs(MITSUYAMA);
  gas.g.approveHolidayWorkRequest(a.data.requestId);
  gas.loginAs(NAKATSUI);
  gas.g.requestHolidayWorkCancellation(a.data.requestId, '不要になった');
  gas.loginAs(MITSUYAMA);
  gas.g.approveHolidayWorkCancellation(a.data.requestId);
  assert.equal(row()['ステータス'], '取消済み');
});

// ============================================================ 今回の範囲：承認済みの休日出勤の日の勤怠（シフトなし）

/** 中津井さんの 2026-10-10 の休日出勤申請を出し、status まで進める（承認済み／申請中／却下／取消済み） */
function holidayWorkWithStatus(gas, status, date) {
  const workDate = date || '2026-10-10';
  gas.loginAs(NAKATSUI);
  const id = gas.g.submitHolidayWorkRequest(hwPlan({ workDate })).data.requestId;
  gas.loginAs(MITSUYAMA);
  if (status === '承認済み' || status === '取消済み' || status === '取消申請中') gas.g.approveHolidayWorkRequest(id);
  if (status === '却下') gas.g.rejectHolidayWorkRequest(id, '今回は不要');
  if (status === '取消済み' || status === '取消申請中') {
    gas.loginAs(NAKATSUI);
    gas.g.requestHolidayWorkCancellation(id, '不要になった');
    gas.loginAs(MITSUYAMA);
    if (status === '取消済み') gas.g.approveHolidayWorkCancellation(id);
  }
  assert.equal(gas.main.rows('休日出勤申請').find((r) => r['申請ID'] === id)['ステータス'], status);
  return id;
}
const judgedCols = (r) => [r['遅刻'], r['早退'], r['社内超過時間'], r['30分以上'], r['事前残業申請'], r['要確認']];

test('承認済み休日出勤：11:00開始 → 遅刻なし。20:00終了 → 社内超過なし。実働はそのまま。残業申請の判定にも入れない', () => {
  const gas = office();
  holidayWorkWithStatus(gas, '承認済み');
  work(gas, NAKATSUI, '2026-10-10', '11:00', '20:00');
  const r = att(gas, 'AT-20261010-E005');
  assert.deepEqual(judgedCols(r), ['', '', '', '', '', ''], '遅刻・早退・社内超過・30分以上・事前残業申請・要確認（残業）はすべて空欄');
  assert.deepEqual([r['出勤'], r['退勤'], r['自動休憩'], r['実働時間']], ['11:00', '20:00', '01:00', '08:00'], '実働は通常どおり計算した値のまま');
  const d = dayOf(gas, 'E005', '2026-10-10');
  assert.deepEqual([d.kind, d.holidayWork, d.checks], ['休日出勤', { kind: '休日出勤', minutes: 480, approved: true }, []]);
  const m = monthlyRow(gas, '中津井祐貴');
  assert.deepEqual([m.days.holidayWorkDays, m.days.holidayWorkTime, m.needsCheckCount], [1, '08:00', 0], '月次の休日出勤 1日・8:00。残業の要確認に数えない');
});

test('承認済み休日出勤：15:00終了 → 早退なし', () => {
  const gas = office();
  holidayWorkWithStatus(gas, '承認済み');
  work(gas, NAKATSUI, '2026-10-10', '09:30', '15:00');
  const r = att(gas, 'AT-20261010-E005');
  assert.deepEqual([r['遅刻'], r['早退'], r['実働時間']], ['', '', '05:30']);
});

test('承認済み休日出勤：打刻の後に承認しても、遅刻・早退・社内超過だけ消す（打刻・実働・勤務区間は変えない）。取消が承認されたら元の判定に戻す', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const id = gas.g.submitHolidayWorkRequest(hwPlan()).data.requestId;
  work(gas, NAKATSUI, '2026-10-10', '11:00', '20:00');
  const before = att(gas, 'AT-20261010-E005');
  assert.deepEqual(judgedCols(before).slice(0, 3), ['01:30', '', '01:30'], '承認前（申請中）は通常勤務日の基準');
  const keep = [before['出勤'], before['退勤'], before['実働時間'], before['自動休憩']];
  const segs = JSON.stringify(gas.main.getSheetByName('勤務区間履歴').data.map((row) => row.filter((_, i) => i !== gas.main.getSheetByName('勤務区間履歴').data[0].indexOf('更新日時'))));
  gas.loginAs(MITSUYAMA);
  gas.g.approveHolidayWorkRequest(id);
  const after = att(gas, 'AT-20261010-E005');
  assert.deepEqual(judgedCols(after), ['', '', '', '', '', '']);
  assert.deepEqual([after['出勤'], after['退勤'], after['実働時間'], after['自動休憩']], keep);
  assert.equal(JSON.stringify(gas.main.getSheetByName('勤務区間履歴').data.map((row) => row.filter((_, i) => i !== gas.main.getSheetByName('勤務区間履歴').data[0].indexOf('更新日時')))), segs, '勤務区間は変えない');
  // 取消申請中のあいだは、まだ承認済みとして扱う。取消が承認されたら元に戻す
  gas.loginAs(NAKATSUI);
  gas.g.requestHolidayWorkCancellation(id, '予定変更');
  gas.loginAs(MITSUYAMA);
  gas.g.recalculateThisMonth();
  assert.deepEqual(judgedCols(att(gas, 'AT-20261010-E005')).slice(0, 3), ['', '', ''], '取消申請中はまだ承認済み');
  gas.g.approveHolidayWorkCancellation(id);
  const back = att(gas, 'AT-20261010-E005');
  assert.deepEqual([back['遅刻'], back['社内超過時間'], back['30分以上'], back['事前残業申請'], back['要確認']], ['01:30', '01:30', '○', 'なし', '要確認'], '取消済み → 通常勤務日の判定（残業の事前申請の確認も戻る）');
  assert.equal(back['実働時間'], keep[2]);
});

for (const status of ['申請中', '却下', '取消済み']) {
  test('休日出勤申請が「' + status + '」の日は 休日出勤として扱わない（遅刻・社内超過は通常どおり、区分なし）', () => {
    const gas = office();
    holidayWorkWithStatus(gas, status);
    work(gas, NAKATSUI, '2026-10-10', '11:00', '20:00');
    const r = att(gas, 'AT-20261010-E005');
    assert.deepEqual([r['遅刻'], r['社内超過時間'], r['実働時間']], ['01:30', '01:30', '08:00']);
    const d = dayOf(gas, 'E005', '2026-10-10');
    assert.deepEqual([d.kind, d.holidayWork], ['', null]);
    assert.equal(monthlyRow(gas, '中津井祐貴').days.holidayWorkDays, 0);
  });
}

test('シフト無効時は法定休日かどうかを推測しない：日曜の承認済み休日出勤も「休日出勤」（法定休日出勤にしない）', () => {
  const gas = office();
  holidayWorkWithStatus(gas, '承認済み', '2026-10-11'); // 日曜
  work(gas, NAKATSUI, '2026-10-11', '09:00', '13:00');
  const d = dayOf(gas, 'E005', '2026-10-11');
  assert.deepEqual([d.kind, d.holidayWork.kind, d.shiftType, d.badges.map((b) => b.text)], ['休日出勤', '休日出勤', '', ['休出']]);
  const m = monthlyRow(gas, '中津井祐貴').days;
  assert.deepEqual([m.holidayWorkDays, m.holidayWorkTime, m.legalHolidayWorkDays, m.legalHolidayWorkTime], [1, '04:00', 0, '00:00']);
  gas.loginAs(MITSUYAMA);
  const csv = gas.g.exportAdminAttendanceCsv({ type: 'monthly', month: '2026-10' }).data.csv;
  assert.doesNotMatch(csv, /法定休日/);
  assert.match(csv, /2026-10-11,E005[^\n]*,休日出勤,,,\r?$/m);
});

test('シフト管理を使わない：手で作ったシフトシートがあっても読まない・変えない', () => {
  const gas = office();
  const sheet = gas.main.insertSheet('シフト');
  sheet.data = [['日付', '社員ID', '氏名', 'シフト区分'], ['2026-10-07', 'E005', '中津井祐貴', '休日']];
  const before = JSON.stringify(sheet.data);
  gas.g.clearTableCache_();
  gas.loginAs(NAKATSUI);
  assert.equal(gas.g.submitPaidLeaveRequest(pl()).success, true, 'シフトが休日でも拒否しない（読まない）');
  gas.loginAs(MITSUYAMA);
  gas.g.setupSystem();
  assert.equal(JSON.stringify(sheet.data), before, 'setupSystem でも触らない');
  assert.deepEqual(dayOf(gas, 'E005', '2026-10-07').checks, []);
});

// ============================================================ 将来用：シフトの判定（SHIFT_FEATURE.enabled = true のとき。今は使わない）

test('将来用 setupSystem：シフト管理を使うときは シフトシート と 休日出勤申請の「申請時シフト区分」を作る', () => {
  const gas = office({});
  assert.deepEqual(gas.main.getSheetByName('シフト').data[0], ['日付', '社員ID', '氏名', 'シフト区分', '予定開始', '予定終了', '備考', '登録日時', '更新日時']);
  assert.deepEqual(gas.main.getSheetByName('休日出勤申請').data[0].slice(25), ['現場', '申請時シフト区分']);
});

// ============================================================ シフトの判定

test('将来用 シフト：通常勤務・休日・法定休日・未登録・重複・不備。法定休日は曜日ではなくシフトシートだけで決まる', () => {
  const gas = office({ '2026-10-05': '通常勤務', '2026-10-10': '休日', '2026-10-11': '法定休日', '2026-10-04': '通常勤務' });
  gas.g.appendRecords_('シフト', [
    { '日付': '2026-10-06', '社員ID': 'E005', '氏名': '中津井祐貴', 'シフト区分': '通常勤務' },
    { '日付': '2026-10-06', '社員ID': 'E005', '氏名': '中津井祐貴', 'シフト区分': '休日' },
    { '日付': '2026-10-08', '社員ID': 'E005', '氏名': '中津井祐貴', 'シフト区分': '公休' },
  ]);
  gas.g.clearTableCache_();
  gas.loginAs(NAKATSUI);
  const on = (d) => gas.g.getMyShiftOn(d).data.type;
  assert.deepEqual(['2026-10-05', '2026-10-10', '2026-10-11', '2026-10-06', '2026-10-07', '2026-10-08'].map(on),
    ['通常勤務', '休日', '法定休日', 'シフト重複', '未登録', 'シフト不備']);
  assert.equal(on('2026-10-04'), '通常勤務', '日曜でもシフトが通常勤務なら通常勤務（曜日では法定休日にしない）');
  assert.equal(on('2026-10-18'), '未登録', '行がない日曜は未登録（法定休日とはみなさない）');
  const my = gas.g.getMyShifts().data;
  assert.deepEqual([my.from, my.to, my.days.length], ['2026-09-21', '2026-10-20', 30], '今の20日締め期間');
  assert.equal(my.days.find((d) => d.date === '2026-10-06').type, 'シフト重複');
  // 重複・不備は要確認
  assert.deepEqual(dayOf(gas, 'E005', '2026-10-06').checks, ['シフト重複']);
  assert.deepEqual(dayOf(gas, 'E005', '2026-10-08').checks, ['シフト区分の値が正しくない']);
});

test('将来用 シフト：自分のシフトだけ返す（他の人の行の内容は出ない）', () => {
  const gas = office({});
  gas.g.appendRecords_('シフト', [
    { '日付': '2026-10-05', '社員ID': 'E006', '氏名': '久保亜弓', 'シフト区分': '休日', '備考': '久保さんの私用' },
    { '日付': '2026-10-05', '社員ID': 'E005', '氏名': '中津井祐貴', 'シフト区分': '通常勤務' },
  ]);
  gas.g.clearTableCache_();
  gas.loginAs(NAKATSUI);
  const json = JSON.stringify(gas.g.getMyShifts().data);
  assert.doesNotMatch(json, /久保/);
  assert.equal(gas.g.getMyShiftOn('2026-10-05').data.type, '通常勤務');
});

// ---- 将来用：休日出勤との連携

test('将来用 休日出勤：通常勤務日は申請不要で拒否。休日・法定休日は申請でき、現場・申請時シフト区分を保存。表示は承認待ち', () => {
  const gas = office({ '2026-10-09': '通常勤務', '2026-10-10': '休日', '2026-10-11': '法定休日' });
  gas.loginAs(NAKATSUI);
  assert.match(gas.g.submitHolidayWorkRequest(hwPlan({ workDate: '2026-10-09' })).message, /通常勤務日のため休日出勤申請は不要です/);
  const a = gas.g.submitHolidayWorkRequest(hwPlan());
  assert.equal(a.success, true, a.message);
  const b = gas.g.submitHolidayWorkRequest(hwPlan({ workDate: '2026-10-11' }));
  assert.equal(b.success, true, b.message);
  const row = gas.main.rows('休日出勤申請').find((r) => r['申請ID'] === a.data.requestId);
  assert.deepEqual([row['現場'], row['申請時シフト区分'], row['ステータス']], ['堺市○○様邸', '休日', '申請中'], 'シートの値は以前と同じ「申請中」');
  assert.equal(a.data.statusLabel, '承認待ち', '画面には承認待ちと表示');
  assert.equal(gas.main.rows('休日出勤申請').find((r) => r['申請ID'] === b.data.requestId)['申請時シフト区分'], '法定休日');
  gas.loginAs(MITSUYAMA);
  assert.equal(gas.g.approveHolidayWorkRequest(a.data.requestId).success, true);
  assert.equal(gas.g.approveHolidayWorkRequest(b.data.requestId).success, true);
});

test('将来用 休日出勤：シフト未登録・重複の日は申請を受け付けるが承認できない。シフト登録後に承認できる', () => {
  const gas = office({});
  gas.g.appendRecords_('シフト', [
    { '日付': '2026-10-17', '社員ID': 'E005', 'シフト区分': '休日' }, { '日付': '2026-10-17', '社員ID': 'E005', 'シフト区分': '休日' },
  ]);
  gas.g.clearTableCache_();
  gas.loginAs(NAKATSUI);
  const a = gas.g.submitHolidayWorkRequest(hwPlan());
  assert.equal(a.success, true, '未登録でも受け付ける');
  assert.match(a.message, /未登録/);
  const b = gas.g.submitHolidayWorkRequest(hwPlan({ workDate: '2026-10-17' }));
  assert.equal(b.success, true);
  assert.equal(gas.main.rows('休日出勤申請').find((r) => r['申請ID'] === a.data.requestId)['申請時シフト区分'], '未登録');
  gas.loginAs(MITSUYAMA);
  const pend = gas.g.getAdminDashboard({ date: '2026-10-02' }).data.holidayWork.pending;
  assert.deepEqual(pend.map((x) => [x.currentShift, x.approvable]), [['未登録', false], ['シフト重複', false]]);
  assert.match(gas.g.approveHolidayWorkRequest(a.data.requestId).message, /シフト未登録/);
  assert.equal(gas.g.approveHolidayWorkRequest(b.data.requestId).success, false, '重複は承認できない');
  // シフトを通常勤務で登録しても承認できない。休日で登録すると承認できる
  setShifts(gas, { '2026-10-10': '通常勤務' }, [['E005', '中津井祐貴']]);
  assert.match(gas.g.approveHolidayWorkRequest(a.data.requestId).message, /通常勤務/);
  gas.main.getSheetByName('シフト').data.forEach((r) => { if (r[0] === '2026-10-10') r[3] = '休日'; });
  gas.g.clearTableCache_();
  assert.equal(gas.g.approveHolidayWorkRequest(a.data.requestId).success, true);
  assert.deepEqual(gas.main.rows('休日出勤申請').filter((r) => r['申請ID'] === a.data.requestId).map((r) => r['ステータス']), ['承認済み']);
});

test('将来用 休日出勤：実績は予定に丸めず実際の実働。休日・法定休日の区分ごとに日数・時間を数える', () => {
  const gas = office(calendarShifts());
  gas.loginAs(NAKATSUI);
  const a = gas.g.submitHolidayWorkRequest(hwPlan({ workDate: '2026-10-10', plannedStart: '10:00', plannedEnd: '16:00' })).data.requestId;
  const b = gas.g.submitHolidayWorkRequest(hwPlan({ workDate: '2026-10-11', plannedStart: '09:00', plannedEnd: '12:00' })).data.requestId;
  gas.loginAs(MITSUYAMA);
  gas.g.approveHolidayWorkRequest(a);
  gas.g.approveHolidayWorkRequest(b);
  work(gas, NAKATSUI, '2026-10-10', '10:02', '15:10');
  work(gas, NAKATSUI, '2026-10-11', '09:00', '13:15');
  const d10 = dayOf(gas, 'E005', '2026-10-10');
  assert.deepEqual([d10.kind, d10.holidayWork.minutes, d10.holidayWork.approved, d10.checks], ['休日出勤', 308, true, []], '5:08（予定の6:00にしない）');
  assert.equal(att(gas, 'AT-20261010-E005')['実働時間'], '05:08');
  const d11 = dayOf(gas, 'E005', '2026-10-11');
  assert.deepEqual([d11.kind, d11.holidayWork.minutes], ['法定休日出勤', 255]);
  assert.deepEqual(d11.badges.map((x) => x.text), ['法休出']);
  const row = monthlyRow(gas, '中津井祐貴');
  assert.deepEqual([row.days.holidayWorkDays, row.days.holidayWorkTime, row.days.legalHolidayWorkDays, row.days.legalHolidayWorkTime],
    [1, '05:08', 1, '04:15']);
});

test('将来用 休日出勤：休日・法定休日は遅刻・早退・社内超過を判定しない', () => {
  const gas = office(calendarShifts());
  gas.loginAs(NAKATSUI);
  const id = gas.g.submitHolidayWorkRequest(hwPlan({ workDate: '2026-10-10' })).data.requestId;
  gas.loginAs(MITSUYAMA);
  gas.g.approveHolidayWorkRequest(id);
  work(gas, NAKATSUI, '2026-10-10', '11:00', '20:00');
  const r = att(gas, 'AT-20261010-E005');
  assert.deepEqual([r['遅刻'], r['早退'], r['社内超過時間']], ['', '', '']);
  // 同じ打刻でも通常勤務日なら遅刻・社内超過になる
  work(gas, NAKATSUI, '2026-10-09', '11:00', '20:00');
  const n = att(gas, 'AT-20261009-E005');
  assert.deepEqual([n['遅刻'], n['社内超過時間']], ['01:30', '01:30']);
});

test('将来用 休日出勤：承認済みの申請がない休日の勤務は 要確認（未申請休日出勤）。取消済み＋勤務も要確認', () => {
  const gas = office(calendarShifts());
  work(gas, NAKATSUI, '2026-10-10', '09:00', '12:00');
  assert.deepEqual(dayOf(gas, 'E005', '2026-10-10').checks, ['未申請休日出勤']);
  gas.loginAs(KUBO);
  const id = gas.g.submitHolidayWorkRequest(hwPlan({ workDate: '2026-10-03' })).data.requestId;
  gas.loginAs(MITSUYAMA);
  gas.g.approveHolidayWorkRequest(id);
  gas.loginAs(KUBO);
  gas.g.requestHolidayWorkCancellation(id, '予定がなくなった');
  gas.loginAs(MITSUYAMA);
  gas.g.approveHolidayWorkCancellation(id);
  work(gas, KUBO, '2026-10-03', '09:00', '12:00');
  const d = dayOf(gas, 'E006', '2026-10-03');
  assert.deepEqual([d.kind, d.checks], ['休日出勤', ['取消済み休日出勤＋実勤務']]);
  assert.deepEqual(d.badges.map((x) => x.text), ['休出', '要確認']);
  // 承認待ちのまま勤務しても未申請扱い（承認済みがない）
  assert.equal(monthlyRow(gas, '中津井祐貴').days.checkCount, 1);
});

test('休日出勤と有給は同じ日に申請できない（どちらの順でも拒否）', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  assert.equal(gas.g.submitPaidLeaveRequest(pl()).success, true);
  assert.match(gas.g.submitHolidayWorkRequest(hwPlan({ workDate: '2026-10-07' })).message, /有給休暇の申請があります.*休日出勤申請はできません/);
  // 休日出勤が先 → 同じ日の有給は拒否
  assert.equal(gas.g.submitHolidayWorkRequest(hwPlan({ workDate: '2026-10-08' })).success, true);
  assert.match(gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-08' })).message, /休日出勤の申請があります.*有給申請はできません/);
});

// ============================================================ 有給休暇申請

test('有給：対象者だけ。対象外・管理者（対象外）・空欄は画面に出さず、直接呼んでも拒否', () => {
  const gas = office();
  gas.loginAs(MITSUYAMA);
  assert.deepEqual([gas.g.getMyPaidLeaveRequests().data.eligible], [false]);
  assert.match(gas.g.submitPaidLeaveRequest(pl()).message, /有給休暇申請の対象外です/);
  const sheet = gas.main.getSheetByName('スタッフマスタ');
  const col = sheet.data[0].indexOf('有給申請対象');
  sheet.data.find((r) => r[0] === 'E006')[col] = '';
  gas.g.clearTableCache_();
  gas.loginAs(KUBO);
  assert.equal(gas.g.getMyPaidLeaveRequests().data.eligible, false, '空欄は対象外');
  gas.loginAs(NAKATSUI);
  assert.equal(gas.g.getMyPaidLeaveRequests().data.eligible, true);
  gas.loginAs(OMORI);
  assert.equal(gas.g.submitPaidLeaveRequest(pl()).success, true, 'フレックスも申請できる');
});

test('将来用 有給：通常勤務の日は申請・承認できる。休日・法定休日は拒否。未登録・重複は受け付けるが承認できない', () => {
  const gas = office({ '2026-10-07': '通常勤務', '2026-10-10': '休日', '2026-10-11': '法定休日' });
  gas.g.appendRecords_('シフト', [{ '日付': '2026-10-13', '社員ID': 'E005', 'シフト区分': '通常勤務' }, { '日付': '2026-10-13', '社員ID': 'E005', 'シフト区分': '通常勤務' }]);
  gas.g.clearTableCache_();
  gas.loginAs(NAKATSUI);
  assert.match(gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-10' })).message, /休日のため有給申請は不要です/);
  assert.match(gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-11' })).message, /休日のため有給申請は不要です/);
  const ok = gas.g.submitPaidLeaveRequest(pl());
  assert.equal(ok.success, true, ok.message);
  assert.deepEqual([ok.data.status, ok.data.statusLabel, ok.data.shiftAtRequest, ok.data.late], ['申請中', '承認待ち', '通常勤務', false]);
  const un = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-14', leaveType: '午前半休' }));
  assert.equal(un.success, true);
  assert.match(un.message, /未登録のため、シフトが通常勤務に決まるまで承認されません/);
  const dup = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-13', leaveType: '午後半休' }));
  assert.equal(dup.success, true);
  gas.loginAs(MITSUYAMA);
  const pend = gas.g.getAdminDashboard({ date: '2026-10-02' }).data.paidLeave.pending;
  assert.deepEqual(pend.map((x) => [x.date, x.currentShift, x.approvable]),
    [['2026-10-07', '通常勤務', true], ['2026-10-13', 'シフト重複', false], ['2026-10-14', '未登録', false]]);
  assert.match(gas.g.approvePaidLeaveRequest(un.data.requestId).message, /シフト未登録のため承認できません/);
  assert.equal(gas.g.approvePaidLeaveRequest(dup.data.requestId).success, false);
  const ap = gas.g.approvePaidLeaveRequest(ok.data.requestId);
  assert.equal(ap.success, true, ap.message);
  const row = gas.main.rows('有給休暇申請').find((r) => r['申請ID'] === ok.data.requestId);
  assert.deepEqual([row['ステータス'], row['承認者ID'], row['承認者名'], !!row['承認日時']], ['承認済み', 'E001', '光山大樹', true]);
  // 承認後にシフトが休日へ変わったら要確認
  gas.main.getSheetByName('シフト').data.forEach((r) => { if (r[0] === '2026-10-07' && r[1] === 'E005') r[3] = '休日'; });
  gas.g.clearTableCache_();
  assert.deepEqual(dayOf(gas, 'E005', '2026-10-07').checks, ['申請後にシフト区分が変更（有給申請と不一致）']);
});

test('有給：1日1件。承認待ち・承認済み・取消申請中があれば同じ日は申請できない。取下げ・却下後は申請できる', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const a = gas.g.submitPaidLeaveRequest(pl()).data.requestId;
  assert.match(gas.g.submitPaidLeaveRequest(pl({ leaveType: '午前半休' })).message, /有給申請はすでにあります（1日有給・承認待ち）/);
  gas.g.withdrawPaidLeaveRequest(a);
  const b = gas.g.submitPaidLeaveRequest(pl({ leaveType: '午前半休' }));
  assert.equal(b.success, true, '取り下げた後は申請できる');
  gas.loginAs(MITSUYAMA);
  assert.match(gas.g.rejectPaidLeaveRequest(b.data.requestId, '').message, /却下理由/, '却下理由は必須');
  assert.equal(gas.g.rejectPaidLeaveRequest(b.data.requestId, '繁忙期のため').success, true);
  gas.loginAs(NAKATSUI);
  assert.equal(gas.g.submitPaidLeaveRequest(pl({ leaveType: '午後半休' })).success, true, '却下の後は申請できる');
  const mine = gas.g.getMyPaidLeaveRequests().data.requests;
  assert.deepEqual(mine.map((r) => r.status).sort(), ['却下', '取消済み', '申請中'].sort());
  assert.equal(mine.find((r) => r.status === '却下').rejectReason, '繁忙期のため');
});

test('有給：状態の流れ（取下げ・取消申請・取消承認・取消却下）。取下げは承認待ちだけ、取消申請は承認済みだけ', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const a = gas.g.submitPaidLeaveRequest(pl()).data.requestId;
  const b = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-08' })).data.requestId;
  assert.match(gas.g.requestPaidLeaveCancellation(a, '不要').message, /取消申請できるのは「承認済み」の申請だけです（今のステータス：承認待ち）/);
  gas.loginAs(MITSUYAMA);
  gas.g.approvePaidLeaveRequest(a);
  gas.g.approvePaidLeaveRequest(b);
  gas.loginAs(NAKATSUI);
  assert.match(gas.g.withdrawPaidLeaveRequest(a).message, /取り下げできるのは「承認待ち」の申請だけです/);
  assert.match(gas.g.requestPaidLeaveCancellation(a, '').message, /取消理由/);
  assert.equal(gas.g.requestPaidLeaveCancellation(a, '予定が変わった').success, true);
  assert.equal(gas.g.requestPaidLeaveCancellation(b, '念のため').success, true);
  gas.loginAs(MITSUYAMA);
  assert.equal(gas.g.getAdminDashboard({}).data.summary.pendingPaidLeave, 2);
  assert.equal(gas.g.approvePaidLeaveCancellation(a).success, true);
  assert.match(gas.g.rejectPaidLeaveCancellation(b, '').message, /取消を却下する理由/);
  assert.equal(gas.g.rejectPaidLeaveCancellation(b, '業務の調整が済んでいるため').success, true);
  const rows = Object.fromEntries(gas.main.rows('有給休暇申請').map((r) => [r['申請ID'], r]));
  assert.deepEqual([rows[a]['ステータス'], rows[a]['取消理由'], !!rows[a]['取消承認日時'], rows[a]['取消処理者名']], ['取消済み', '予定が変わった', true, '光山大樹']);
  assert.deepEqual([rows[b]['ステータス'], rows[b]['取消却下理由']], ['承認済み', '業務の調整が済んでいるため']);
  assert.match(gas.g.approvePaidLeaveCancellation(a).message, /取消申請中」ではないため/, '二重処理は止める');
});

test('有給：事後申請は今の20日締め期間の中だけ（事後申請=○・要確認）。締めた後の期間は拒否', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  assert.match(gas.g.submitPaidLeaveRequest(pl({ date: '2026-09-18' })).message, /締めた後の期間（2026年9月分）のため申請できません/);
  const a = gas.g.submitPaidLeaveRequest(pl({ date: '2026-09-21' }));
  assert.equal(a.success, true, '期間の初日（9/21）は申請できる');
  assert.equal(a.data.late, true);
  assert.match(a.message, /事後申請/);
  const b = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-01', leaveType: '午後半休' }));
  assert.equal(gas.main.rows('有給休暇申請').find((r) => r['申請ID'] === b.data.requestId)['事後申請'], '○');
  gas.loginAs(MITSUYAMA);
  gas.g.approvePaidLeaveRequest(a.data.requestId);
  assert.deepEqual(dayOf(gas, 'E005', '2026-09-21').checks, ['事後申請（有給）']);
  assert.deepEqual(dayOf(gas, 'E005', '2026-10-01').checks, ['事後申請（有給）'], '承認前でも事後申請は要確認');
  // 締め日の翌日になると、前の期間（10/20まで）は申請できない
  gas.setNow('2026-10-21 08:00');
  gas.loginAs(NAKATSUI);
  assert.match(gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-20' })).message, /締めた後の期間（2026年10月分）/);
});

test('有給：1日有給は勤怠記録がなくても8:00として表示・集計。勤務実績があれば両方残して要確認', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const a = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-07' })).data.requestId;
  const b = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-08' })).data.requestId;
  gas.loginAs(MITSUYAMA);
  gas.g.approvePaidLeaveRequest(a);
  gas.g.approvePaidLeaveRequest(b);
  const d7 = dayOf(gas, 'E005', '2026-10-07');
  assert.deepEqual([d7.worked, d7.leave.type, d7.leave.minutes, d7.checks], [false, '1日有給', 480, []]);
  assert.deepEqual(d7.badges.map((x) => x.text), ['有給']);
  work(gas, NAKATSUI, '2026-10-08', '10:00', '12:00');
  const r = att(gas, 'AT-20261008-E005');
  assert.deepEqual([r['実働時間'], r['遅刻'], r['早退']], ['02:00', '', ''], '1日有給の日は遅刻・早退にしない。実働は残す');
  const d8 = dayOf(gas, 'E005', '2026-10-08');
  assert.deepEqual([d8.workMinutes, d8.leave.minutes, d8.checks], [120, 480, ['1日有給日に勤務実績あり']]);
  const row = monthlyRow(gas, '中津井祐貴');
  assert.deepEqual([row.days.fullLeaveDays, row.days.leaveTime, row.days.checkCount], [2, '16:00', 1]);
  // 日別の一覧：勤怠記録がない日も区分（有給）を出す
  const daily = gas.g.getAdminDashboard({ date: '2026-10-07' }).data.daily;
  const item = daily.rows.find((x) => x.name === '中津井祐貴');
  assert.deepEqual(item.day.badges.map((x) => x.text), ['有給']);
});

test('有給：午前半休は 14:30 を基準に遅刻、18:30 を基準に早退。承認・取消で遅刻だけ計算し直し、打刻・実働は変えない', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const id = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-07', leaveType: '午前半休' })).data.requestId;
  work(gas, NAKATSUI, '2026-10-07', '14:40', '18:00');
  let r = att(gas, 'AT-20261007-E005');
  assert.deepEqual([r['遅刻'], r['早退']], ['05:10', '00:30'], '承認前は通常（09:30）基準');
  const keep = [r['出勤'], r['退勤'], r['実働時間']];
  gas.loginAs(MITSUYAMA);
  assert.match(gas.g.approvePaidLeaveRequest(id).message, /遅刻・早退を計算し直しました/);
  r = att(gas, 'AT-20261007-E005');
  assert.deepEqual([r['遅刻'], r['早退'], r['社内超過時間']], ['00:10', '00:30', '00:00']);
  assert.deepEqual([r['出勤'], r['退勤'], r['実働時間']], keep, '打刻・実働は変えない');
  const d = dayOf(gas, 'E005', '2026-10-07');
  assert.deepEqual([d.leave.minutes, d.workMinutes, d.badges.map((x) => x.text)], [240, 200, ['午前休']], '有給4:00と実働3:20は別々');
  // 承認後の出勤で、14:30ちょうどなら遅刻なし
  gas.loginAs(KUBO);
  const k = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-09', leaveType: '午前半休' })).data.requestId;
  gas.loginAs(MITSUYAMA);
  gas.g.approvePaidLeaveRequest(k);
  gas.loginAs(KUBO);
  gas.setNow('2026-10-09 14:30');
  const c = gas.g.clockIn('出社');
  assert.equal(c.data.late, '', c.message);
  // 取消が承認されたら通常の基準に戻す
  gas.loginAs(NAKATSUI);
  gas.setNow('2026-10-02 08:00');
  gas.g.requestPaidLeaveCancellation(id, '出勤できたため');
  gas.loginAs(MITSUYAMA);
  gas.g.approvePaidLeaveCancellation(id);
  r = att(gas, 'AT-20261007-E005');
  assert.deepEqual([r['遅刻'], r['実働時間']], ['05:10', keep[2]]);
});

test('有給：午後半休は 13:30 を基準に早退。13:30 まで働けば早退なし', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const a = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-07', leaveType: '午後半休' })).data.requestId;
  gas.loginAs(KUBO);
  const b = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-07', leaveType: '午後半休' })).data.requestId;
  gas.loginAs(MITSUYAMA);
  gas.g.approvePaidLeaveRequest(a);
  gas.g.approvePaidLeaveRequest(b);
  work(gas, NAKATSUI, '2026-10-07', '09:30', '13:00');
  work(gas, KUBO, '2026-10-07', '09:40', '13:30');
  const n = att(gas, 'AT-20261007-E005');
  const k = att(gas, 'AT-20261007-E006');
  assert.deepEqual([n['遅刻'], n['早退']], ['', '00:30']);
  assert.deepEqual([k['遅刻'], k['早退']], ['00:10', '']);
  assert.equal(dayOf(gas, 'E006', '2026-10-07').badges.map((x) => x.text).join(','), '午後休');
});

test('有給：半休の基準時刻の設定が正しくないときは通常の基準で判定し、要確認（半休基準等の設定不備）', () => {
  const gas = office();
  setSetting(gas, '午前半休_勤務開始', 'お昼');
  gas.loginAs(NAKATSUI);
  const id = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-07', leaveType: '午前半休' })).data.requestId;
  gas.loginAs(MITSUYAMA);
  gas.g.approvePaidLeaveRequest(id);
  work(gas, NAKATSUI, '2026-10-07', '14:30', '18:30');
  assert.equal(att(gas, 'AT-20261007-E005')['遅刻'], '05:00');
  assert.deepEqual(dayOf(gas, 'E005', '2026-10-07').checks, ['半休基準等の設定不備']);
});

test('フレックス：有給算入が未確定のときは実働と有給を別に表示し、138時間には足さない', () => {
  const gas = office();
  gas.loginAs(OMORI);
  const id = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-07' })).data.requestId;
  gas.loginAs(MITSUYAMA);
  gas.g.approvePaidLeaveRequest(id);
  work(gas, OMORI, '2026-10-06', '09:00', '19:00');
  const row = monthlyRow(gas, '大森紗智子');
  assert.equal(row.flex.paidLeaveMode, '未確定');
  assert.equal(row.flex.paidLeave, '08:00');
  assert.equal(row.flex.worked, '09:00', '実働だけ（有給は足さない）');
  const before = row.flex.remaining;
  // 「算入する」にすると不足時間が8時間減る（社労士確認後に切り替える想定）
  setSetting(gas, 'フレックス_有給算入', '算入する');
  const after = monthlyRow(gas, '大森紗智子').flex.remaining;
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  assert.equal(toMin(before) - toMin(after), 480);
  assert.equal(monthlyRow(gas, '大森紗智子').flex.worked, '09:00', '算入しても実働の表示は変えない');
});

test('月次：20日締めの期間で、承認済み休日出勤・有給の回数と時間・在宅日数・要確認件数を数える（法定休日出勤はシフト管理を始めてから）', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const ids = [
    gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-07' })).data.requestId,
    gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-08', leaveType: '午前半休' })).data.requestId,
    gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-09', leaveType: '午後半休' })).data.requestId,
    gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-21' })).data.requestId, // 次の期間（11月分）
  ];
  const hw = gas.g.submitHolidayWorkRequest(hwPlan({ workDate: '2026-10-17' })).data.requestId;
  gas.loginAs(MITSUYAMA);
  ids.forEach((id) => assert.equal(gas.g.approvePaidLeaveRequest(id).success, true));
  gas.g.approveHolidayWorkRequest(hw);
  work(gas, NAKATSUI, '2026-10-17', '09:00', '12:00');
  work(gas, NAKATSUI, '2026-10-18', '09:00', '11:00'); // 申請なし：休日か分からないので休日出勤にも要確認にもしない
  work(gas, NAKATSUI, '2026-10-13', '09:30', '18:30', '在宅');
  work(gas, NAKATSUI, '2026-10-20', '09:30', '18:30', '在宅');
  work(gas, NAKATSUI, '2026-10-21', '09:30', '18:30', '在宅'); // 次の期間
  const d = monthlyRow(gas, '中津井祐貴').days;
  assert.deepEqual([d.holidayWorkDays, d.holidayWorkTime, d.legalHolidayWorkDays], [1, '03:00', 0], '承認済みの 10/17 だけ');
  assert.deepEqual([d.fullLeaveDays, d.amLeaveDays, d.pmLeaveDays, d.leaveTime], [1, 1, 1, '16:00']);
  assert.deepEqual([d.remoteDays, d.checkCount], [2, 0]);
  const nov = monthlyRow(gas, '中津井祐貴', '2026-11').days;
  assert.deepEqual([nov.fullLeaveDays, nov.remoteDays, nov.checks], [1, 1, [{ date: '2026-10-21', reason: '1日有給日に勤務実績あり' }]], '10/21 は11月分');
});

test('将来用 月次：シフト管理を使うときは、休日出勤・法定休日出勤の日数・時間と 未申請休日出勤 の要確認も数える', () => {
  const gas = office(calendarShifts());
  gas.loginAs(NAKATSUI);
  const hw = gas.g.submitHolidayWorkRequest(hwPlan({ workDate: '2026-10-17' })).data.requestId;
  gas.loginAs(MITSUYAMA);
  gas.g.approveHolidayWorkRequest(hw);
  work(gas, NAKATSUI, '2026-10-17', '09:00', '12:00');
  work(gas, NAKATSUI, '2026-10-18', '09:00', '11:00');
  const d = monthlyRow(gas, '中津井祐貴').days;
  assert.deepEqual([d.holidayWorkDays, d.holidayWorkTime, d.legalHolidayWorkDays, d.legalHolidayWorkTime], [1, '03:00', 1, '02:00']);
  assert.deepEqual(d.checks, [{ date: '2026-10-18', reason: '未申請休日出勤' }]);
});

test('CSV：日の区分（休日出勤か空欄）・有給種別・有給時間・要確認（申請）を右端に出す（シフト区分の列は出さない）', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const id = gas.g.submitPaidLeaveRequest(pl({ date: '2026-10-07', leaveType: '午後半休' })).data.requestId;
  gas.loginAs(MITSUYAMA);
  gas.g.approvePaidLeaveRequest(id);
  work(gas, NAKATSUI, '2026-10-07', '09:30', '13:30');
  work(gas, NAKATSUI, '2026-10-10', '09:00', '12:00');
  gas.loginAs(MITSUYAMA);
  const csv = gas.g.exportAdminAttendanceCsv({ type: 'monthly', month: '2026-10' }).data.csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  assert.match(csv[0], /,交通費合計,日の区分,有給種別,有給時間,要確認（申請）$/);
  assert.ok(csv.some((l) => /^2026-10-07,E005/.test(l) && /,,午後半休,04:00,$/.test(l)), csv.join('\n'));
  assert.ok(csv.some((l) => /^2026-10-10,E005/.test(l) && /,,,,$/.test(l) && !/休日|未申請|未登録/.test(l)), '申請のない土曜の勤務は区分・要確認なし');
});

test('将来用 CSV：シフト管理を使うときは シフト区分・日の区分 も出す', () => {
  const gas = office(calendarShifts());
  work(gas, NAKATSUI, '2026-10-10', '09:00', '12:00');
  gas.loginAs(MITSUYAMA);
  const csv = gas.g.exportAdminAttendanceCsv({ type: 'monthly', month: '2026-10' }).data.csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  assert.match(csv[0], /,シフト区分,日の区分,有給種別,有給時間,要確認（シフト・申請）$/);
  assert.ok(csv.some((l) => /^2026-10-10,E005/.test(l) && /,休日,休日出勤,,,未申請休日出勤$/.test(l)), csv.join('\n'));
});

// ============================================================ 権限・安全

test('権限：一般社員は有給の承認系と他の人のデータを使えない。自分の申請の承認もできない', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const id = gas.g.submitPaidLeaveRequest(pl()).data.requestId;
  for (const fn of ['approvePaidLeaveRequest', 'rejectPaidLeaveRequest', 'approvePaidLeaveCancellation', 'rejectPaidLeaveCancellation']) {
    assert.match(gas.g[fn](id, '理由').message, /管理者権限がありません/, fn);
  }
  assert.match(gas.g.getAdminDashboard({}).message, /管理者権限がありません/);
  // 他人の申請は取り下げ・取消申請できず、一覧にも出ない
  gas.loginAs(KUBO);
  assert.match(gas.g.withdrawPaidLeaveRequest(id).message, /有給申請が見つかりません/);
  assert.match(gas.g.requestPaidLeaveCancellation(id, 'x').message, /有給申請が見つかりません/);
  assert.deepEqual(gas.g.getMyPaidLeaveRequests().data.requests, []);
  assert.equal(gas.main.rows('有給休暇申請')[0]['ステータス'], '申請中', '何も変わらない');
  // 社員IDを送っても無視して本人で申請する
  const own = gas.g.submitPaidLeaveRequest({ ...pl(), employeeId: 'E005', date: '2026-10-07' });
  assert.equal(own.data.employeeId, 'E006');
  // 管理者本人の申請は本人が承認できない（別の管理者は承認できる）
  gas.loginAs(INOKURA);
  const mine = gas.g.submitPaidLeaveRequest(pl());
  assert.equal(mine.success, true, mine.message);
  assert.match(gas.g.approvePaidLeaveRequest(mine.data.requestId).message, /自分の有給申請は承認・却下できません/);
  gas.loginAs(MITSUYAMA);
  assert.equal(gas.g.approvePaidLeaveRequest(mine.data.requestId).success, true);
});

test('安全：書き込みは LockService の中で行い、同時の二重申請は1件だけ通る', () => {
  const gas = office();
  gas.loginAs(NAKATSUI);
  const first = gas.g.submitPaidLeaveRequest(pl());
  const second = gas.g.submitPaidLeaveRequest(pl());
  assert.deepEqual([first.success, second.success], [true, false], 'ボタンの二度押しでも2件目は止まる');
  assert.equal(gas.main.rows('有給休暇申請').length, 1);
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../leaf-portal/gas/PaidLeaveService.gs'), 'utf8');
  for (const fn of ['submitPaidLeaveRequest', 'withdrawPaidLeaveRequest', 'requestPaidLeaveCancellation', 'approvePaidLeaveRequest', 'rejectPaidLeaveRequest',
    'approvePaidLeaveCancellation', 'rejectPaidLeaveCancellation']) {
    const body = src.slice(src.indexOf('function ' + fn + '('), src.indexOf('\n}\n', src.indexOf('function ' + fn + '(')));
    assert.match(body, /withLock_/, fn + ' は withLock_ の中で書き込む');
  }
});

test('setupSystem 前：有給のカードは出さず、申請は setupSystem を案内。打刻はそのまま使える', () => {
  const gas = office();
  gas.main.deleteSheet(gas.main.getSheetByName('有給休暇申請'));
  gas.g.clearTableCache_();
  gas.loginAs(NAKATSUI);
  const d = gas.g.getMyPaidLeaveRequests().data;
  assert.deepEqual([d.eligible, d.setupRequired], [false, true]);
  assert.match(gas.g.submitPaidLeaveRequest(pl()).message, /setupSystem\(\) を実行してください/);
  assert.equal(gas.g.clockIn('出社').success, true, '打刻はそのまま使える');
  gas.loginAs(MITSUYAMA);
  const admin = gas.g.getAdminDashboard({}).data;
  assert.deepEqual([admin.paidLeave.setupRequired, admin.summary.pendingPaidLeave], [true, 0]);
});

test('画面：有給の画面から呼ぶ関数はサーバーにあり、管理者用の関数を含まない。innerHTML を使わない', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '../leaf-portal/gas');
  const src = fs.readFileSync(path.join(dir, 'PaidLeaveScripts.html'), 'utf8');
  const list = JSON.parse(src.match(/PL_FUNCTIONS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  const gas = office();
  list.forEach((fn) => assert.equal(typeof gas.g[fn], 'function', fn));
  assert.ok(!list.some((fn) => /approve|reject|Admin/.test(fn)));
  assert.doesNotMatch(src, /innerHTML/);
  const index = fs.readFileSync(path.join(dir, 'Index.html'), 'utf8');
  for (const id of ['paidLeaveCard', 'paidLeaveMiniList', 'btnOpenPaidLeave', 'btnOpenPaidLeaveHistory', 'btnOpenShifts']) assert.match(index, new RegExp('id="' + id + '"'), id);
  assert.match(index, /includeHtml_\('PaidLeaveView'\)[\s\S]*includeHtml_\('PaidLeaveScripts'\)/);
  assert.match(index, /<div class="card link-card" id="shiftCard" hidden>/, 'シフトのカードは最初から隠す（シフト管理を使うときだけ出す）');
});
