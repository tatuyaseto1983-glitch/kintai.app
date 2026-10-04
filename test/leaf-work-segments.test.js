'use strict';
// 段階1：勤務区間（出社⇄在宅の切替・再出勤・中断の重なり・20日締め・移行）のテスト
// 番号は「段階1の必須テスト 1〜38」に合わせています（39 は本番シートの複製での移行リハーサル＝Google 実機で行う）
const test = require('node:test');
const assert = require('node:assert');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const ADMIN = 'admin@example.com';
const FIXED = 'fixed@example.com';
const FLEX = 'flex@example.com';
const plain = (v) => JSON.parse(JSON.stringify(v));

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

/** 時刻を進めながら操作する。steps は [時刻, 関数名, 引数...] */
function run(gas, date, steps) {
  const results = [];
  for (const [time, fn, ...args] of steps) {
    gas.setNow((time.length > 5 ? time : date + ' ' + time));
    const r = gas.g[fn](...args);
    assert.equal(r.success, true, time + ' ' + fn + '：' + r.message);
    results.push(r);
  }
  return results;
}
const att = (gas, id) => gas.main.rows('勤怠記録').find((r) => r['勤怠ID'] === id);
const segs = (gas, id) => gas.main.rows('勤務区間履歴').filter((r) => r['勤怠ID'] === id)
  .map((r) => r['区間番号'] + ':' + r['勤務形態'] + ' ' + r['開始時刻'] + '-' + r['終了時刻']);
const pick = (r, keys) => keys.map((k) => r[k]);
const SUMMARY = ['出勤', '退勤', '勤務形態', '勤務形態区分', '勤務区間数', '出社時間', '在宅時間', '自動休憩', '実働時間', '状態'];

/** 純粋な計算（固定勤務・09:30〜18:30・自動休憩1時間） */
function calc(gas, segments, interruptions = [], extra = {}) {
  const m = gas.g.toMinutes_;
  return plain(gas.g.calculateSegmentedWorkTime_({
    segments: segments.map(([style, s, e]) => ({ style, startMinutes: m(s), endMinutes: m(e) })),
    interruptions: interruptions.map(([s, e]) => ({ startMinutes: m(s), endMinutes: m(e) })),
    isFixed: true, standardStartMinutes: 570, standardEndMinutes: 1110, autoBreakMinutes: 60, autoBreakThresholdMinutes: 0,
    overtimeFreeLimitMinutes: 30, overtimeUnitMinutes: 1, ...extra,
  }));
}

test('1・2・3. 出社→在宅、在宅→出社、出社→在宅→出社（区間が分かれ、勤怠記録は1日の合計）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  const [, sw] = run(gas, '2026-09-01', [['09:30', 'clockIn', '出社'], ['12:00', 'switchWorkStyle', '在宅'], ['18:30', 'clockOut']]);
  assert.match(sw.message, /出社から在宅に切り替えました（12:00）/);
  assert.deepEqual(segs(gas, 'AT-20260901-E002'), ['1:出社 09:30-12:00', '2:在宅 12:00-18:30']);
  assert.deepEqual(pick(att(gas, 'AT-20260901-E002'), SUMMARY), ['09:30', '18:30', '出社', '出社＋在宅', '2', '02:30', '06:30', '01:00', '08:00', '退勤済み']);

  run(gas, '2026-09-02', [['09:30', 'clockIn', '在宅'], ['13:00', 'switchWorkStyle', '出社'], ['18:30', 'clockOut']]);
  assert.deepEqual(pick(att(gas, 'AT-20260902-E002'), SUMMARY), ['09:30', '18:30', '在宅', '出社＋在宅', '2', '05:30', '03:30', '01:00', '08:00', '退勤済み'],
    '勤務形態区分は決まった順（出社＋在宅）。勤務形態は最初の区間');

  run(gas, '2026-09-03', [['09:30', 'clockIn', '出社'], ['11:00', 'switchWorkStyle', '在宅'], ['15:00', 'switchWorkStyle', '出社'], ['18:30', 'clockOut']]);
  assert.deepEqual(segs(gas, 'AT-20260903-E002'), ['1:出社 09:30-11:00', '2:在宅 11:00-15:00', '3:出社 15:00-18:30']);
  assert.deepEqual(pick(att(gas, 'AT-20260903-E002'), SUMMARY), ['09:30', '18:30', '出社', '出社＋在宅', '3', '05:00', '04:00', '01:00', '08:00', '退勤済み']);
  assert.deepEqual(gas.main.rows('勤務区間履歴').filter((r) => r['勤怠ID'] === 'AT-20260903-E002').map((r) => r['区間実働']), ['01:30', '04:00', '03:30']);

  // 同じ勤務形態への切替・中断中の切替はできない
  run(gas, '2026-09-04', [['09:30', 'clockIn', '出社']]);
  gas.setNow('2026-09-04 10:00');
  assert.match(gas.g.switchWorkStyle('出社').message, /すでに出社で勤務中です/);
  gas.g.startBreak('');
  assert.match(gas.g.switchWorkStyle('在宅').message, /中断中は切り替えできません/);
  assert.match(gas.g.switchWorkStyle('現場').message, /切り替え先の勤務形態/, '段階1の画面で選べるのは出社・在宅だけ');
});

test('4・5. 退勤後の再出勤（09:30〜16:00 出社＋18:00〜20:00 在宅 → 2区間）と1日3区間', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  const r = run(gas, '2026-09-01', [['09:30', 'clockIn', '出社'], ['16:00', 'clockOut'], ['18:00', 'clockIn', '在宅'], ['20:00', 'clockOut']]);
  assert.match(r[2].message, /再出勤しました（在宅・18:00）/);
  assert.deepEqual(segs(gas, 'AT-20260901-E002'), ['1:出社 09:30-16:00', '2:在宅 18:00-20:00']);
  const a = att(gas, 'AT-20260901-E002');
  assert.deepEqual(pick(a, SUMMARY), ['09:30', '20:00', '出社', '出社＋在宅', '2', '06:30', '02:00', '01:00', '07:30', '退勤済み']);
  assert.equal(a['社内超過時間'], '01:30', '18:30〜20:00 に実際に働いた時間');
  assert.equal(a['早退'], '', '早退は最後の終了（20:00）で判定');
  assert.equal(gas.main.rows('勤怠記録').length, 1, '1日1行のまま');

  // 1日3区間：出社 → 在宅へ切替 → 退勤 → 出社で再出勤 → 退勤
  run(gas, '2026-09-02', [['09:30', 'clockIn', '出社'], ['12:00', 'switchWorkStyle', '在宅'], ['15:00', 'clockOut'], ['16:00', 'clockIn', '出社'], ['18:30', 'clockOut']]);
  assert.deepEqual(segs(gas, 'AT-20260902-E002'), ['1:出社 09:30-12:00', '2:在宅 12:00-15:00', '3:出社 16:00-18:30']);
  assert.deepEqual(pick(att(gas, 'AT-20260902-E002'), SUMMARY), ['09:30', '18:30', '出社', '出社＋在宅', '3', '05:00', '03:00', '01:00', '07:00', '退勤済み']);

  // 勤務中・中断中には再出勤できない（二重出勤）
  run(gas, '2026-09-03', [['09:30', 'clockIn', '出社']]);
  gas.setNow('2026-09-03 10:00');
  assert.match(gas.g.clockIn('在宅').message, /本日はすでに出勤済みです/);
});

test('6・7・8・9. 中断→同じ形態で再開／出社中断→在宅再開／在宅中断→出社再開（二重控除なし）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  run(gas, '2026-09-01', [['09:30', 'clockIn', '出社'], ['12:00', 'startBreak', '昼'], ['13:00', 'resumeWork', '出社'], ['18:30', 'clockOut']]);
  assert.deepEqual(segs(gas, 'AT-20260901-E002'), ['1:出社 09:30-18:30'], '同じ勤務形態なら区間は1つのまま');
  assert.deepEqual(pick(att(gas, 'AT-20260901-E002'), ['中断合計', '自動休憩', '実働時間', '出社時間']), ['01:00', '01:00', '07:00', '08:00']);
  // 以前の画面（勤務形態を送らない）からの再開も同じ
  run(gas, '2026-09-02', [['09:30', 'clockIn', '在宅'], ['12:00', 'startBreak', ''], ['12:30', 'resumeWork'], ['18:30', 'clockOut']]);
  assert.deepEqual(segs(gas, 'AT-20260902-E002'), ['1:在宅 09:30-18:30']);

  // 12:00 出社を中断 → 12:30 在宅で再開：出社は 12:00 で終わり、在宅は 12:30 から
  const r = run(gas, '2026-09-03', [['09:30', 'clockIn', '出社'], ['12:00', 'startBreak', '移動'], ['12:30', 'resumeWork', '在宅'], ['18:30', 'clockOut']]);
  assert.match(r[2].message, /在宅で再開しました（出社から在宅に切り替え／中断 00:30/);
  assert.deepEqual(segs(gas, 'AT-20260903-E002'), ['1:出社 09:30-12:00', '2:在宅 12:30-18:30']);
  const a = att(gas, 'AT-20260903-E002');
  assert.deepEqual(pick(a, ['中断合計', '出社時間', '在宅時間', '自動休憩', '実働時間']), ['00:30', '02:30', '06:00', '01:00', '07:30'],
    '中断は区間の外なので実働からは引かない（区間の外の時間はもともと数えない）＝二重に引かない');
  const br = gas.main.rows('中断履歴').find((b) => b['勤怠ID'] === 'AT-20260903-E002');
  assert.equal(br['勤務区間ID'], 'WS-20260903-E002-01', '中断には中断したときの区間IDが入る');

  run(gas, '2026-09-04', [['09:30', 'clockIn', '在宅'], ['15:00', 'startBreak', ''], ['16:00', 'resumeWork', '出社'], ['18:30', 'clockOut']]);
  assert.deepEqual(segs(gas, 'AT-20260904-E002'), ['1:在宅 09:30-15:00', '2:出社 16:00-18:30']);
  assert.deepEqual(pick(att(gas, 'AT-20260904-E002'), ['出社時間', '在宅時間', '実働時間']), ['02:30', '05:30', '07:00']);

  // 9. 区間外の中断：計算でも引かない
  const c = calc(gas, [['出社', '09:30', '12:00'], ['在宅', '12:30', '18:30']], [['12:00', '12:30']]);
  assert.deepEqual([c.interruptionMinutes, c.netMinutes], [0, 450]);
});

test('10・11. 区間と一部だけ重なる中断／複数の中断（重なっていても二重に引かない）', () => {
  const gas = ready();
  let c = calc(gas, [['出社', '09:00', '12:00'], ['在宅', '13:00', '18:00']], [['11:30', '13:30']]);
  assert.deepEqual([c.segments[0].interruptionMinutes, c.segments[1].interruptionMinutes, c.interruptionMinutes], [30, 30, 60], '区間に重なる部分だけ引く');
  assert.deepEqual([c.officeMinutes, c.remoteMinutes, c.netMinutes], [150, 270, 360]);
  c = calc(gas, [['出社', '09:00', '18:00']], [['10:00', '10:30'], ['10:15', '10:45'], ['15:00', '15:10']]);
  assert.equal(c.interruptionMinutes, 55, '10:00〜10:45 と 15:00〜15:10（重なった部分は1回だけ）');
});

test('12〜15. 自動休憩は1日1回／出社・在宅・現場外出の時間', () => {
  const gas = ready();
  let c = calc(gas, [['出社', '09:00', '11:00'], ['在宅', '11:00', '14:00'], ['出社', '15:00', '18:00']]);
  assert.deepEqual([c.autoBreakMinutes, c.officeMinutes, c.remoteMinutes, c.netMinutes], [60, 300, 180, 420], '区間が3つでも自動休憩は1回');
  c = calc(gas, [['出社', '09:00', '11:00'], ['在宅', '12:00', '13:00']], [], { autoBreakThresholdMinutes: 360 });
  assert.equal(c.autoBreakMinutes, 0, '合計が適用開始以下なら引かない（区間ごとではなく1日で判定）');
  c = calc(gas, [['出社', '08:00', '10:00'], ['現場', '10:00', '15:00'], ['外出', '15:00', '16:00'], ['在宅', '16:00', '17:00']], [['12:00', '12:30']]);
  assert.deepEqual([c.officeMinutes, c.remoteMinutes, c.siteOutingMinutes], [120, 60, 330], '現場・外出は合わせて「現場外出時間」（中断を除く）');
  assert.equal(c.netMinutes, 120 + 60 + 330 - 60, '出社＋在宅＋現場外出 − 自動休憩 ＝ 実働');
});

test('16・17. 社内超過は18:30以降に実際に働いた時間（中断を除く）。法定時間外とは別', () => {
  const gas = ready();
  let c = calc(gas, [['出社', '09:30', '16:00'], ['在宅', '18:00', '20:00']], [['19:00', '19:20']]);
  assert.equal(c.internalExcessMinutes, 70, '18:30〜20:00 の 1:30 から 19:00〜19:20 を除いて 1:10');
  c = calc(gas, [['出社', '09:30', '20:00']], [['18:00', '19:00']]);
  assert.equal(c.internalExcessMinutes, 60, '18:30をまたぐ中断は 18:30〜19:00 の分だけ除く');
  assert.equal(c.requiresPreApproval, true);
  c = calc(gas, [['出社', '09:30', '18:30']]);
  assert.equal(c.internalExcessMinutes, 0);
  assert.equal(Object.keys(c).some((k) => /legal|法定/.test(k)), false, '法定の時間外労働は計算しない（社内超過だけ）');
});

test('18〜20. 遅刻は最初の開始、早退は最後の終了で判定。フレックスは判定しない', () => {
  const gas = ready();
  let c = calc(gas, [['在宅', '10:00', '12:00'], ['出社', '13:00', '18:30']]);
  assert.equal(c.lateMinutes, 30);
  c = calc(gas, [['出社', '09:30', '12:00'], ['在宅', '13:00', '17:00']]);
  assert.equal(c.earlyLeaveMinutes, 90);
  c = calc(gas, [['出社', '10:00', '12:00'], ['在宅', '13:00', '17:00']], [], { isFixed: false });
  assert.deepEqual([c.lateMinutes, c.earlyLeaveMinutes, c.internalExcessMinutes], [0, 0, 0]);

  gas.loginAs(FLEX);
  run(gas, '2026-09-01', [['11:00', 'clockIn', '在宅'], ['13:00', 'switchWorkStyle', '出社'], ['16:00', 'clockOut']]);
  const a = att(gas, 'AT-20260901-E003');
  assert.deepEqual(pick(a, ['遅刻', '早退', '社内超過時間', '実働時間']), ['', '', '', '04:00']);
  gas.loginAs(FIXED);
  run(gas, '2026-09-01', [['10:00', 'clockIn', '在宅'], ['12:00', 'clockOut'], ['13:00', 'clockIn', '出社'], ['17:00', 'clockOut']]);
  assert.deepEqual(pick(att(gas, 'AT-20260901-E002'), ['遅刻', '早退']), ['00:30', '01:30']);
});

test('21・22. 日付をまたぐ勤務・再出勤での日付またぎ', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  run(gas, '2026-09-01', [['2026-09-01 22:00', 'clockIn', '出社'], ['2026-09-02 00:30', 'switchWorkStyle', '在宅'], ['2026-09-02 02:00', 'clockOut']]);
  assert.deepEqual(segs(gas, 'AT-20260901-E002'), ['1:出社 22:00-00:30', '2:在宅 00:30-02:00'], '前日の勤怠に続けて記録する');
  assert.deepEqual(pick(att(gas, 'AT-20260901-E002'), ['出勤', '退勤', '出社時間', '在宅時間', '実働時間', '社内超過時間']),
    ['22:00', '02:00', '02:30', '01:30', '03:00', '04:00']);

  run(gas, '2026-09-03', [['2026-09-03 09:30', 'clockIn', '出社'], ['2026-09-03 18:30', 'clockOut'], ['2026-09-03 23:00', 'clockIn', '在宅'], ['2026-09-04 01:00', 'clockOut']]);
  assert.deepEqual(segs(gas, 'AT-20260903-E002'), ['1:出社 09:30-18:30', '2:在宅 23:00-01:00']);
  assert.deepEqual(pick(att(gas, 'AT-20260903-E002'), ['出勤', '退勤', '勤務区間数', '実働時間', '社内超過時間']), ['09:30', '01:00', '2', '10:00', '02:00']);
  assert.equal(gas.main.rows('勤怠記録').filter((r) => r['日付'] === '2026-09-04').length, 0, '翌日の勤怠は作らない');
});

test('23. 区間を指定した打刻修正（承認で区間を書き換え、1日の合計を計算し直す）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  run(gas, '2026-09-01', [['09:30', 'clockIn', '出社'], ['16:00', 'clockOut'], ['18:00', 'clockIn', '在宅'], ['20:00', 'clockOut']]);
  gas.setNow('2026-09-02 09:00');
  let r = gas.g.submitCorrectionRequest({ targetDate: '2026-09-01', item: '区間終了', segmentNo: '1', after: '16:30', reason: '退勤の押し遅れ' });
  assert.equal(r.success, true, r.message);
  assert.deepEqual([r.data.segmentNo, r.data.before, r.data.after], ['1', '16:00', '16:30']);
  assert.match(gas.g.submitCorrectionRequest({ targetDate: '2026-09-01', item: '区間開始', segmentNo: '3', after: '18:00', reason: 'x' }).message, /区間3はありません/);
  r = gas.g.submitCorrectionRequest({ targetDate: '2026-09-01', item: '区間勤務形態', segmentNo: '2', after: '出社', reason: '会社で作業' });
  assert.equal(r.success, true, r.message);
  const ids = gas.main.rows('打刻修正申請').map((x) => x['申請ID']);

  gas.loginAs(ADMIN);
  assert.equal(gas.g.approveCorrectionRequest(ids[0]).success, true);
  assert.equal(gas.g.approveCorrectionRequest(ids[1]).success, true);
  assert.deepEqual(segs(gas, 'AT-20260901-E002'), ['1:出社 09:30-16:30', '2:出社 18:00-20:00']);
  assert.deepEqual(pick(att(gas, 'AT-20260901-E002'), ['出勤', '退勤', '勤務形態区分', '出社時間', '在宅時間', '実働時間', '打刻修正状況']),
    ['09:30', '20:00', '出社', '09:00', '00:00', '08:00', '修正済み']);

  // 退勤（以前からの項目）は最後の区間の終了を直す。重なる修正は止める
  gas.loginAs(FIXED);
  r = gas.g.submitCorrectionRequest({ targetDate: '2026-09-01', item: '区間開始', segmentNo: '2', after: '16:00', reason: '重なる' });
  gas.loginAs(ADMIN);
  const bad = gas.g.approveCorrectionRequest(r.data.requestId);
  assert.equal(bad.success, false);
  assert.match(bad.message, /前の区間の終了より前/);
  assert.deepEqual(segs(gas, 'AT-20260901-E002'), ['1:出社 09:30-16:30', '2:出社 18:00-20:00'], '承認できなければ何も変えない');
  gas.loginAs(FIXED);
  r = gas.g.submitCorrectionRequest({ targetDate: '2026-09-01', item: '退勤', after: '21:00', reason: 'x' });
  gas.loginAs(ADMIN);
  assert.equal(gas.g.approveCorrectionRequest(r.data.requestId).success, true);
  assert.deepEqual(segs(gas, 'AT-20260901-E002'), ['1:出社 09:30-16:30', '2:出社 18:00-21:00']);
  assert.equal(att(gas, 'AT-20260901-E002')['退勤'], '21:00');
});

/** 以前のコードで作られた勤怠（勤務区間なし）を直接入れる */
function seedLegacy(gas, date, extra = {}) {
  const id = 'AT-' + date.replace(/-/g, '') + '-E002';
  gas.g.appendRecords_('勤怠記録', [{
    '勤怠ID': id, '日付': date, '社員ID': 'E002', '氏名': '佐藤', '勤務区分': '固定勤務', '勤務形態': '出社',
    '出勤': '09:30', '退勤': '19:00', '自動休憩': '01:00', '中断合計': '00:20', '実働時間': '08:10', '社内超過時間': '00:30', '状態': '退勤済み', ...extra,
  }]);
  return id;
}

test('24・25. 以前の勤怠は1区間として読む（シートには書かない）。区間を作るのは今の勤務を操作したときだけ', () => {
  const gas = ready();
  const past = seedLegacy(gas, '2026-08-25');
  gas.g.appendRecords_('中断履歴', [{ '中断ID': 'BR-20260825-E002-01', '勤怠ID': past, '日付': '2026-08-25', '社員ID': 'E002', '氏名': '佐藤', '中断開始': '12:00', '再開': '12:20', '中断時間': '00:20' }]);
  gas.loginAs(ADMIN);
  let d = gas.g.getAttendanceDetail(past);
  assert.equal(d.success, true, d.message);
  assert.deepEqual(d.data.segments.map((s) => [s.number, s.style, s.start, s.end, s.virtual]), [[1, '出社', '09:30', '19:00', true]]);
  assert.equal(d.data.breaks.length, 1);
  assert.equal(gas.main.rows('勤務区間履歴').length, 0, '読むだけでは区間を作らない');
  // 明示して再計算したときだけ、新しい計算で合計を入れる（値は以前と同じ）
  gas.setNow('2026-08-30 09:00');
  gas.g.recalculateThisMonth();
  assert.deepEqual(pick(att(gas, past), ['出勤', '退勤', '実働時間', '社内超過時間', '勤務区間数', '勤務形態区分', '出社時間']),
    ['09:30', '19:00', '08:10', '00:30', '1', '出社', '09:10']);
  assert.equal(gas.main.rows('勤務区間履歴').length, 0, '再計算でも過去の日に区間は作らない');

  // 以前のコードで出勤した「今日」の記録 → 切替のときに区間を作る
  const today = seedLegacy(gas, '2026-09-01', { '退勤': '', '自動休憩': '', '実働時間': '', '社内超過時間': '', '中断合計': '00:00', '状態': '勤務中' });
  gas.g.appendRecords_('中断履歴', [{ '中断ID': 'BR-20260901-E002-01', '勤怠ID': today, '日付': '2026-09-01', '社員ID': 'E002', '氏名': '佐藤', '中断開始': '10:00', '再開': '10:10', '中断時間': '00:10' }]);
  gas.loginAs(FIXED);
  run(gas, '2026-09-01', [['12:00', 'switchWorkStyle', '在宅'], ['18:30', 'clockOut']]);
  assert.deepEqual(segs(gas, today), ['1:出社 09:30-12:00', '2:在宅 12:00-18:30']);
  assert.equal(gas.main.rows('中断履歴').find((b) => b['勤怠ID'] === today)['勤務区間ID'], 'WS-20260901-E002-01', '今日の以前の中断にも区間IDを入れる');
  assert.deepEqual(segs(gas, past), [], '過去の日はそのまま');
  assert.deepEqual(pick(att(gas, today), ['出社時間', '在宅時間', '実働時間']), ['02:20', '06:30', '07:50']);
});

test('26・27・28. 移行：dry-run は書かない／execute で区間を作る／2回目は何もしない（勤怠記録の値は変えない）', () => {
  const gas = ready();
  const a = seedLegacy(gas, '2026-08-25');
  const b = seedLegacy(gas, '2026-08-26', { '勤務形態': '在宅' });
  gas.g.appendRecords_('中断履歴', [{ '中断ID': 'BR-1', '勤怠ID': a, '日付': '2026-08-25', '社員ID': 'E002', '氏名': '佐藤', '中断開始': '12:00', '再開': '12:20', '中断時間': '00:20' }]);
  gas.loginAs(FIXED);
  run(gas, '2026-09-01', [['09:30', 'clockIn', '出社'], ['18:30', 'clockOut']]); // 新しい記録（区間あり）
  gas.loginAs(ADMIN);
  const before = JSON.stringify(gas.main.sheets.map((s) => s.data));

  let r = gas.g.migrateAttendanceToWorkSegments();
  assert.equal(JSON.stringify(gas.main.sheets.map((s) => s.data)), before, 'dry-run はシートを変えない');
  assert.deepEqual([r.data.execute, r.data.targetCount, r.data.plannedSegments, r.data.breakCount, r.data.skippedExisting], [false, 2, 2, 1, 1]);
  assert.match(r.message, /確認だけ・dry-run.*対象 2件/);
  assert.match(r.message, /2026-08-26 佐藤：在宅 09:30〜19:00/);

  const attBefore = JSON.stringify(gas.main.getSheetByName('勤怠記録').data);
  r = gas.g.migrateAttendanceToWorkSegments({ execute: true });
  assert.deepEqual([r.data.execute, r.data.segmentCount, r.data.breakCount], [true, 2, 1]);
  assert.deepEqual(segs(gas, a), ['1:出社 09:30-19:00']);
  assert.deepEqual(segs(gas, b), ['1:在宅 09:30-19:00']);
  assert.equal(gas.main.rows('中断履歴').find((x) => x['中断ID'] === 'BR-1')['勤務区間ID'], 'WS-20260825-E002-01');
  assert.equal(JSON.stringify(gas.main.getSheetByName('勤怠記録').data), attBefore, '勤怠記録は変えない');

  const afterFirst = JSON.stringify(gas.main.sheets.map((s) => s.data));
  r = gas.g.migrateAttendanceToWorkSegments({ execute: true });
  assert.deepEqual([r.data.targetCount, r.data.skippedExisting], [0, 3]);
  assert.equal(JSON.stringify(gas.main.sheets.map((s) => s.data)), afterFirst, '2回目は何も変わらない');

  // Webアプリ経由（操作者≠所有者）では実行できない。setupSystem からは呼ばない
  gas.g.Session.getEffectiveUser = () => ({ getEmail: () => ADMIN });
  gas.loginAs(FIXED);
  assert.throws(() => gas.g.migrateAttendanceToWorkSegments({ execute: true }), /Webアプリからは実行できません/);
  assert.doesNotMatch(require('node:fs').readFileSync(require('node:path').join(__dirname, '../leaf-portal/gas/Setup.gs'), 'utf8'), /migrateAttendanceToWorkSegments/);
});

test('29・30. 他人の勤務区間は取得できない／同じ操作を続けて送っても1回だけ', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  run(gas, '2026-09-01', [['09:30', 'clockIn', '出社'], ['12:00', 'switchWorkStyle', '在宅']]);
  gas.loginAs(FLEX);
  assert.match(gas.g.getAttendanceDetail('AT-20260901-E002').message, /管理者/);
  const status = gas.g.getTodayStaffStatus().data.staff.find((s) => s.name === '佐藤');
  assert.deepEqual(Object.keys(status).sort(), ['isSelf', 'label', 'name', 'status', 'workStyle']);
  assert.equal(status.label, '勤務中（在宅）');
  const dash = gas.g.getStaffDashboard(['today']).data.today.data;
  assert.equal(dash.record, null, '自分（鈴木）の今日の記録だけ。佐藤さんの区間は入らない');
  assert.doesNotMatch(JSON.stringify(gas.g.getStaffDashboard().data), /WS-|"09:30"|出社＋在宅/, "佐藤さんの区間・出勤時刻は返さない");
  gas.loginAs(FIXED);
  const mine = gas.g.getStaffDashboard(['today']).data.today.data;
  assert.deepEqual(mine.timeline.segments.map((s) => s.style + s.start), ['出社09:30', '在宅12:00']);
  assert.equal(mine.record.currentStyle, '在宅');

  // 連打：同じ切替を2回送っても2回目はエラー（区間は増えない）。ロックの中で状態を確認している
  gas.setNow('2026-09-01 13:00');
  assert.equal(gas.g.switchWorkStyle('出社').success, true);
  assert.equal(gas.g.switchWorkStyle('出社').success, false);
  assert.equal(segs(gas, 'AT-20260901-E002').length, 3);
  gas.setNow('2026-09-01 18:30');
  assert.equal(gas.g.clockOut().success, true);
  assert.equal(gas.g.clockOut().success, false);
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '../leaf-portal/gas/WorkSegmentService.gs'), 'utf8'),
    /function switchWorkStyle\(workStyle\) \{\s*return runApi_\(function \(\) \{\s*return withLock_/, '切替はロックの中で処理');
});

test('31〜35. 20日締めの境界（8/20→8月分、8/21→9月分、9/20→9月分、9/21→10月分、年またぎ・うるう年）', () => {
  const gas = ready();
  const label = (d) => gas.g.getPayrollPeriodForDate_(d, 20).label;
  assert.deepEqual(['2026-08-20', '2026-08-21', '2026-09-20', '2026-09-21', '2026-12-20', '2026-12-21', '2027-01-20', '2027-01-21'].map(label),
    ['2026年8月分', '2026年9月分', '2026年9月分', '2026年10月分', '2026年12月分', '2027年1月分', '2027年1月分', '2027年2月分']);
  const p = plain(gas.g.getPayrollPeriod_(2026, 9, 20));
  assert.deepEqual([p.label, p.startDate, p.endDate, p.periodText], ['2026年9月分', '2026-08-21', '2026-09-20', '2026年9月分 対象期間：2026/08/21〜2026/09/20']);
  assert.deepEqual(pick(plain(gas.g.getPayrollPeriod_(2027, 1, 20)), ['startDate', 'endDate']), ['2026-12-21', '2027-01-20'], '年またぎ');
  assert.deepEqual(pick(plain(gas.g.getPayrollPeriod_(2028, 3, 20)), ['startDate', 'endDate']), ['2028-02-21', '2028-03-20'], 'うるう年でも同じ');
  assert.deepEqual(pick(plain(gas.g.getPayrollPeriod_(2027, 3, 20)), ['startDate', 'endDate']), ['2027-02-21', '2027-03-20']);
  assert.equal(gas.g.getSettings_().monthClosingDay, 20, '初期値は20日締め');
  assert.equal(gas.main.rows('設定').find((r) => r['項目'] === '月_締め日')['値'], '20');
  // 末日締め（設定を「末日」にした場合）も同じ関数で
  assert.deepEqual(pick(plain(gas.g.getPayrollPeriod_(2028, 2, 0)), ['startDate', 'endDate', 'label']), ['2028-02-01', '2028-02-29', '2028年2月分']);
});

test('36・37・38. フレックス138時間・月次CSV・管理者の月次は21日〜20日で集計し、期間を表示する', () => {
  const gas = ready();
  const seed = (id, date, work) => gas.g.appendRecords_('勤怠記録', [{
    '勤怠ID': 'AT-' + date.replace(/-/g, '') + '-' + id, '日付': date, '社員ID': id, '氏名': id === 'E003' ? '鈴木' : '佐藤',
    '勤務区分': id === 'E003' ? 'フレックス' : '固定勤務', '勤務形態': '出社', '出勤': '09:00', '退勤': '18:00', '実働時間': work, '状態': '退勤済み',
  }]);
  for (const d of ['2026-08-20', '2026-08-21', '2026-09-20', '2026-09-21']) { seed('E003', d, '08:00'); seed('E002', d, '08:00'); }

  gas.loginAs(FLEX);
  gas.setNow('2026-09-20 12:00');
  const m = gas.g.getFlexSummary().data.month;
  assert.deepEqual([m.from, m.to, m.periodText, m.worked, m.workDays, m.scheduled, m.remaining],
    ['2026-08-21', '2026-09-20', '2026年9月分 対象期間：2026/08/21〜2026/09/20', '16:00', 2, '138:00', '122:00'], '8/21 と 9/20 だけ（8/20・9/21 は入らない）');
  const my = gas.g.getMyAttendance('2026-09').data;
  assert.deepEqual([my.from, my.to, my.periodText, my.records.map((r) => r.date)], ['2026-08-21', '2026-09-20', '2026年9月分 対象期間：2026/08/21〜2026/09/20', ['2026-08-21', '2026-09-20']]);

  gas.loginAs(ADMIN);
  gas.setNow('2026-09-25 12:00');
  const csv = gas.g.exportAdminAttendanceCsv({ type: 'monthly', month: '2026-09' });
  assert.match(csv.message, /2026年9月分 対象期間：2026\/08\/21〜2026\/09\/20/);
  assert.deepEqual(csv.data.csv.split('\r\n').slice(1).map((l) => l.slice(0, 10)), ['2026-08-21', '2026-08-21', '2026-09-20', '2026-09-20']);
  const old = gas.g.exportAttendanceCsv('2026-09');
  assert.equal(old.data.csv.split('\r\n').length, 5);
  assert.ok(old.data.csv.split('\r\n')[0].endsWith(',勤務形態区分,勤務区間数,出社時間,在宅時間,現場外出時間'), '以前のCSVも新しい列は右端に');
  const monthly = gas.g.getAdminDashboard({ month: '2026-09', parts: ['monthly'] }).data.monthly;
  assert.equal(monthly.periodText, '2026年9月分 対象期間：2026/08/21〜2026/09/20');
  assert.equal(monthly.rows.find((r) => r.name === '鈴木').flex.worked, '16:00');
  assert.equal(gas.g.getMonthlyAttendance('2026-09').data.periodText, '2026年9月分 対象期間：2026/08/21〜2026/09/20');
  // 今日（9/25）の「今月」は10月分
  assert.equal(gas.g.getAdminDashboard({ parts: ['monthly'] }).data.month, '2026-10');
});

test('setupSystem 前（勤務区間履歴シートがない）でも、出勤・中断・再開・退勤は以前どおり動く', () => {
  const gas = ready();
  const idx = gas.main.sheets.findIndex((s) => s.getName() === '勤務区間履歴');
  gas.main.sheets.splice(idx, 1);
  gas.loginAs(FIXED);
  run(gas, '2026-09-01', [['09:30', 'clockIn', '出社'], ['12:00', 'startBreak', ''], ['12:20', 'resumeWork', '出社'], ['19:00', 'clockOut']]);
  assert.deepEqual(pick(att(gas, 'AT-20260901-E002'), ['出勤', '退勤', '中断合計', '実働時間', '社内超過時間']), ['09:30', '19:00', '00:20', '08:10', '00:30']);
  gas.setNow('2026-09-01 20:00');
  assert.match(gas.g.clockIn('在宅').message, /setupSystem\(\)/, '再出勤は準備ができてから');
});

test('勤怠記録をシートで直接直して再計算したときは、その値を勤務区間にも反映する（直した値を消さない）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  run(gas, '2026-09-01', [['09:30', 'clockIn', '出社'], ['12:00', 'switchWorkStyle', '在宅'], ['19:12', 'clockOut']]);
  const sheet = gas.main.getSheetByName('勤怠記録');
  sheet.data[1][sheet.data[0].indexOf('退勤')] = '18:40';
  gas.loginAs(ADMIN);
  gas.setNow('2026-09-02 09:00');
  gas.g.recalculateThisMonth();
  assert.deepEqual(segs(gas, 'AT-20260901-E002'), ['1:出社 09:30-12:00', '2:在宅 12:00-18:40']);
  assert.deepEqual(pick(att(gas, 'AT-20260901-E002'), ['退勤', '社内超過時間', '在宅時間']), ['18:40', '00:10', '06:40']);
  // 区間が成り立たない値（最初の区間の終了より後の出勤）は反映しない
  sheet.data[1][sheet.data[0].indexOf('出勤')] = '13:00';
  gas.g.recalculateThisMonth();
  assert.deepEqual(segs(gas, 'AT-20260901-E002'), ['1:出社 09:30-12:00', '2:在宅 12:00-18:40']);
  assert.equal(att(gas, 'AT-20260901-E002')['出勤'], '09:30');
});

test('日報一覧は暦月（1日〜末日）のまま。勤怠の月次は20日締め（期間の関数を分けている）', () => {
  const gas = ready();
  assert.deepEqual(pick(plain(gas.g.getReportMonthPeriod_('2026-10')), ['label', 'from', 'to']), ['2026年10月', '2026-10-01', '2026-10-31']);
  assert.deepEqual(pick(plain(gas.g.getReportMonthPeriod_('2028-02')), ['from', 'to']), ['2028-02-01', '2028-02-29']);
  gas.loginAs(FIXED);
  gas.setNow('2026-09-25 18:00');
  const list = gas.g.getReportList({}).data;
  assert.deepEqual([list.month, list.from, list.to], ['2026-09', '2026-09-01', '2026-09-30'], '9/25 の日報一覧は9月（暦月）');
  assert.deepEqual(pick(gas.g.getReportList({ month: '2026-10' }).data, ['from', 'to']), ['2026-10-01', '2026-10-31']);
  const my = gas.g.getMyAttendance().data;
  assert.deepEqual([my.month, my.from, my.to], ['2026-10', '2026-09-21', '2026-10-20'], '同じ日の勤怠は10月分（20日締め）');
  const src = ['DailyReportService.gs', 'DailyReportShareService.gs'].map((f) => require('node:fs').readFileSync(require('node:path').join(__dirname, '../leaf-portal/gas', f), 'utf8')).join('');
  assert.doesNotMatch(src, /getPayrollPeriod|monthClosingDay/, '日報は給与の締め期間を使わない');
});

// ---------------------------------------------------------------- Google実機テストで見つかった不具合（出勤が再出勤・同じ分の操作で上書きされた）
const SEQ = ['出勤', '退勤', '勤務区間数'];
const events = (gas, id, opts = { showSeconds: false }) => plain(gas.g.buildAttendanceTimeline_(gas.g.findRecords_('勤怠記録', (r) => r['勤怠ID'] === id)[0], opts))
  .events.map((e) => e.time + ' ' + e.label);
const nowSec = (gas, text) => gas.eval(`APP_RUNTIME.now = new Date(${JSON.stringify(text.replace(' ', 'T') + '+09:00')})`);

test('不具合の再現：同じ分に 出勤→中断→再開→中断→在宅で再開→退勤 しても、出勤は最初の開始（12:10）のまま', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  run(gas, '2026-10-05', [['12:10', 'clockIn', '出社'], ['12:10', 'startBreak', ''], ['12:10', 'resumeWork', '出社'], ['12:10', 'startBreak', ''], ['12:11', 'resumeWork', '在宅'], ['12:11', 'clockOut']]);
  const id = 'AT-20261005-E002';
  assert.deepEqual(segs(gas, id), ['1:出社 12:10-12:10', '2:在宅 12:11-12:11'], '最初の区間の開始・勤務形態を書き換えない');
  assert.deepEqual(pick(att(gas, id), ['出勤', '退勤', '勤務形態', '勤務区間数', '中断合計', '実働時間']), ['12:10', '12:11', '出社', '2', '00:01', '00:00']);
  assert.deepEqual(events(gas, id), ['12:10 出社で出勤', '12:10 中断', '12:10 再開（出社）', '12:10 中断', '12:11 再開（在宅）', '12:11 退勤'], '時刻順・操作の順');
});

test('再出勤しても最初の出勤時刻が変わらない／2回再出勤しても変わらない／最終退勤だけが更新される', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  const id = 'AT-20261005-E002';
  run(gas, '2026-10-05', [['12:05', 'clockIn', '出社'], ['12:10', 'clockOut'], ['12:11', 'clockIn', '在宅']]);
  assert.deepEqual(pick(att(gas, id), SEQ.concat('状態')), ['12:05', '', '2', '勤務中'], '再出勤中：出勤はそのまま、退勤は勤務中なので空欄');
  run(gas, '2026-10-05', [['12:20', 'clockOut']]);
  assert.deepEqual(pick(att(gas, id), SEQ), ['12:05', '12:20', '2']);
  run(gas, '2026-10-05', [['12:30', 'clockIn', '出社'], ['12:40', 'clockOut']]);
  assert.deepEqual(pick(att(gas, id), SEQ), ['12:05', '12:40', '3'], '2回目の再出勤：出勤 12:05 のまま、退勤だけ 12:40 に');
  assert.deepEqual(segs(gas, id), ['1:出社 12:05-12:10', '2:在宅 12:11-12:20', '3:出社 12:30-12:40']);
  // 退勤した同じ分に同じ勤務形態で再出勤しても、前の区間を開き直さず新しい区間にする
  run(gas, '2026-10-05', [['12:40', 'clockIn', '出社'], ['12:45', 'clockOut']]);
  assert.deepEqual(pick(att(gas, id), SEQ), ['12:05', '12:45', '4']);
  assert.deepEqual(segs(gas, id).slice(2), ['3:出社 12:30-12:40', '4:出社 12:40-12:45']);
  assert.deepEqual(events(gas, id), ['12:05 出社で出勤', '12:10 退勤', '12:11 在宅で再出勤', '12:20 退勤', '12:30 出社で再出勤', '12:40 退勤', '12:40 出社で再出勤', '12:45 退勤']);
});

test('日次再計算後も、出勤＝最初の開始・退勤＝最後の終了になる。シート直接修正→再計算でも同じ原則', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  const id = 'AT-20261005-E002';
  run(gas, '2026-10-05', [['12:05', 'clockIn', '出社'], ['12:10', 'clockOut'], ['12:11', 'clockIn', '在宅'], ['12:20', 'clockOut']]);
  gas.loginAs(ADMIN);
  gas.setNow('2026-10-06 09:00');
  gas.g.recalculateThisMonth();
  assert.deepEqual(pick(att(gas, id), SEQ), ['12:05', '12:20', '2'], '再計算しても変わらない');

  // 勤怠記録の出勤を直接 12:00 に直して再計算 → 最初の区間の開始に反映（区間2の開始は変えない）
  const sheet = gas.main.getSheetByName('勤怠記録');
  const row = sheet.data.findIndex((r) => r[0] === id);
  sheet.data[row][sheet.data[0].indexOf('出勤')] = '12:00';
  gas.g.recalculateThisMonth();
  assert.deepEqual(segs(gas, id), ['1:出社 12:00-12:10', '2:在宅 12:11-12:20']);
  assert.deepEqual(pick(att(gas, id), SEQ), ['12:00', '12:20', '2']);
  // 退勤を直接 12:25 に → 最後に終わった区間（区間2）の終了に反映
  sheet.data[row][sheet.data[0].indexOf('退勤')] = '12:25';
  gas.g.recalculateThisMonth();
  assert.deepEqual(segs(gas, id), ['1:出社 12:00-12:10', '2:在宅 12:11-12:25']);
  // 勤務区間履歴を直接直した場合も、出勤・退勤は区間の最小開始・最大終了から作り直す
  const ws = gas.main.getSheetByName('勤務区間履歴');
  const wrow = ws.data.findIndex((r) => r[0] === 'WS-20261005-E002-02');
  ws.data[wrow][ws.data[0].indexOf('終了時刻')] = '12:30';
  sheet.data[row][sheet.data[0].indexOf('退勤')] = ''; // 勤怠記録の退勤を空にした状態（勤務区間を正とする）
  gas.g.recalculateThisMonth();
  assert.deepEqual(pick(att(gas, id), SEQ), ['12:00', '12:30', '2']);
  // 純粋な計算：区間番号の順と時刻の順が違っていても、最小の開始・最大の終了を使う
  const m = gas.g.toMinutes_;
  const sum = plain(gas.g.summarizeDaySegments_([
    { style: '在宅', startMinutes: m('13:00'), endMinutes: m('14:00') }, { style: '出社', startMinutes: m('09:00'), endMinutes: m('10:00') }]));
  assert.deepEqual([sum.clockIn, sum.clockOut, sum.workStyle], ['13:00', '10:00', '在宅'], '区間1の開始より前の時刻は翌日扱い（日付またぎ）＝出勤は区間1、退勤は翌日10:00');
  const sum2 = plain(gas.g.summarizeDaySegments_([
    { style: '出社', startMinutes: m('09:00'), endMinutes: m('12:00') }, { style: '在宅', startMinutes: m('11:00'), endMinutes: m('11:30') }]));
  assert.deepEqual([sum2.clockIn, sum2.clockOut], ['09:00', '12:00'], '最後の区間ではなく、いちばん遅い終了');
});

test('勤務区間と中断を時刻順に並べたとき矛盾しない（指定の例と、日付またぎ）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  const id = 'AT-20261005-E002';
  run(gas, '2026-10-05', [['12:05', 'clockIn', '出社'], ['12:07', 'startBreak', ''], ['12:08', 'resumeWork', '出社'], ['12:09', 'switchWorkStyle', '在宅'],
    ['12:10', 'startBreak', ''], ['12:11', 'resumeWork', '在宅'], ['12:12', 'clockOut'], ['12:15', 'clockIn', '在宅'], ['12:20', 'clockOut']]);
  const list = events(gas, id);
  assert.deepEqual(list, ['12:05 出社で出勤', '12:07 中断', '12:08 再開（出社）', '12:09 在宅へ切替', '12:10 中断', '12:11 再開（在宅）', '12:12 退勤', '12:15 在宅で再出勤', '12:20 退勤']);
  assert.deepEqual(pick(att(gas, id), SEQ), ['12:05', '12:20', '3']);
  // 中断 → 別の勤務形態で再開：「中断」と「再開（在宅）」が1回ずつ（再開が二重に出ない）
  run(gas, '2026-10-06', [['09:30', 'clockIn', '出社'], ['12:00', 'startBreak', ''], ['12:30', 'resumeWork', '在宅'], ['18:30', 'clockOut']]);
  assert.deepEqual(events(gas, 'AT-20261006-E002'), ['09:30 出社で出勤', '12:00 中断', '12:30 再開（在宅）', '18:30 退勤']);
  // 日付またぎ：翌日の時刻は後ろに並ぶ
  run(gas, '2026-10-07', [['2026-10-07 22:00', 'clockIn', '出社'], ['2026-10-07 23:30', 'startBreak', ''], ['2026-10-08 00:10', 'resumeWork', '在宅'], ['2026-10-08 01:00', 'clockOut']]);
  assert.deepEqual(events(gas, 'AT-20261007-E002'), ['22:00 出社で出勤', '23:30 中断', '00:10 再開（在宅）', '01:00 退勤']);
  // 並びの時刻は単調に増える（矛盾しない）
  const tl = plain(gas.g.buildTimelineEvents_(gas.g.getDaySegments_(gas.g.findAttendance_('E002', '2026-10-05'), gas.g.getSegmentRowsOfAttendance_(id)),
    gas.main.rows('中断履歴').filter((b) => b['勤怠ID'] === id).map((b) => ({ segmentId: b['勤務区間ID'], startMinutes: gas.g.toMinutes_(b['中断開始']), endMinutes: gas.g.toMinutes_(b['再開']) }))));
  tl.forEach((e, i) => { if (i) assert.ok(e.abs >= tl[i - 1].abs, '時刻が戻らない'); });
});

test('テスト環境の詳細表示だけ、打刻した時刻を秒まで（HH:mm:ss）表示する。直した時刻は秒を出さない', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  const id = 'AT-20261005-E002';
  nowSec(gas, '2026-10-05 12:10:05'); assert.equal(gas.g.clockIn('出社').success, true);
  nowSec(gas, '2026-10-05 12:10:20'); gas.g.startBreak('');
  nowSec(gas, '2026-10-05 12:10:40'); gas.g.resumeWork('在宅');
  nowSec(gas, '2026-10-05 12:10:55'); gas.g.clockOut();
  assert.deepEqual(events(gas, id, { showSeconds: true }), ['12:10:05 出社で出勤', '12:10:20 中断', '12:10:40 再開（在宅）', '12:10:55 退勤']);
  assert.deepEqual(events(gas, id, { showSeconds: false }), ['12:10 出社で出勤', '12:10 中断', '12:10 再開（在宅）', '12:10 退勤'], '本番の通常画面は分まで');
  assert.equal(plain(gas.g.buildAttendanceTimeline_(gas.g.findAttendance_('E002', '2026-10-05'))).showSeconds, false, 'スプレッドシート名に「テスト」がなければ秒は出さない');
  gas.main.setName && gas.main.setName('【テスト】リーフ勤怠管理');
  if (gas.main.getName() === '【テスト】リーフ勤怠管理') assert.equal(plain(gas.g.buildAttendanceTimeline_(gas.g.findAttendance_('E002', '2026-10-05'))).showSeconds, true);
  assert.equal(gas.main.rows('勤務区間履歴')[0]['開始打刻日時'], '2026-10-05 12:10:05');
  assert.equal(gas.main.rows('中断履歴')[0]['再開打刻日時'], '2026-10-05 12:10:40');
  // 打刻修正で区間2の終了を直す → その時刻は秒を出さない（直した時刻が正）
  gas.setNow('2026-10-06 09:00');
  const r = gas.g.submitCorrectionRequest({ targetDate: '2026-10-05', item: '区間終了', segmentNo: '2', after: '12:30', reason: 'x' });
  gas.loginAs(ADMIN);
  gas.g.approveCorrectionRequest(r.data.requestId);
  assert.deepEqual(events(gas, id, { showSeconds: true }).slice(-1), ['12:30 退勤']);
  assert.deepEqual(pick(att(gas, id), SEQ), ['12:10', '12:30', '2']);
});
