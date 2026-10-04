'use strict';
// 段階2：直行・直帰・現場名・日備考・出張・自家用車の業務走行距離・交通費明細のテスト
const test = require('node:test');
const assert = require('node:assert');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const ADMIN = 'admin@example.com';
const FIXED = 'fixed@example.com';
const FLEX = 'flex@example.com';
const plain = (v) => JSON.parse(JSON.stringify(v));

/** 日報_未提出判定開始日を入れる（段階5の修正：空欄の間は日報の未提出を判定しない） */
function setReportMissingFrom(gas, value) {
  gas.main.getSheetByName('設定').data.find((r) => r[0] === '日報_未提出判定開始日')[1] = value;
  gas.g.clearTableCache_();
}

function ready() {
  const gas = createLeafGas({ email: ADMIN });
  gas.g.setupSystem();
  gas.g.appendRecords_('スタッフマスタ', [
    { '社員ID': 'E001', '氏名': '山田', 'メールアドレス': ADMIN, '権限': 'admin', '勤務区分': '固定勤務', '在籍状況': '在籍' },
    { '社員ID': 'E002', '氏名': '佐藤', 'メールアドレス': FIXED, '権限': 'staff', '勤務区分': '固定勤務', '在籍状況': '在籍' },
    { '社員ID': 'E003', '氏名': '鈴木', 'メールアドレス': FLEX, '権限': 'staff', '勤務区分': 'フレックス', '在籍状況': '在籍' },
  ]);
  setReportMissingFrom(gas, '2026-01-01');
  return gas;
}
function run(gas, date, steps) {
  for (const [time, fn, ...args] of steps) {
    gas.setNow(time.length > 5 ? time : date + ' ' + time);
    const r = gas.g[fn](...args);
    assert.equal(r.success, true, time + ' ' + fn + '：' + r.message);
  }
}
const ok = (r) => { assert.equal(r.success, true, r.message); return r; };
const att = (gas, id) => gas.main.rows('勤怠記録').find((r) => r['勤怠ID'] === id);
const seg = (gas, id) => gas.main.rows('勤務区間履歴').filter((r) => r['勤怠ID'] === id)
  .map((r) => [r['勤務形態'], r['開始時刻'] + '-' + r['終了時刻'], r['直行'], r['直帰'], r['現場名'], r['備考']].join('|'));
const pick = (r, keys) => keys.map((k) => r[k]);
const trRows = (gas) => gas.main.rows('交通費明細');
const tr = (o) => ({ date: '2026-10-05', mode: '電車', from: '堺', to: '難波', purpose: '打合せ', amount: '450', ...o });

test('setupSystem：交通費明細シートと勤怠記録の4列を追加する。2回目は何も変えない（二重の列・シートを作らない）', () => {
  const gas = ready();
  assert.deepEqual(gas.main.getSheetByName('交通費明細').data[0], ['明細ID', '日付', '社員ID', '氏名', '交通手段', '出発地', '到着地', '目的・現場', '金額', '自家用車使用',
    '業務走行距離', '備考', '削除フラグ', '登録日時', '更新日時']);
  assert.deepEqual(gas.main.getSheetByName('勤怠記録').data[0].slice(-4), ['日備考', '出張', '直行', '直帰']);
  const before = JSON.stringify(gas.main.sheets.map((s) => [s.getName(), s.data]));
  gas.g.setupSystem();
  assert.equal(JSON.stringify(gas.main.sheets.map((s) => [s.getName(), s.data])), before);
  assert.equal(gas.main.sheets.filter((s) => s.getName() === '交通費明細').length, 1);
  assert.equal(gas.main.getSheetByName('勤怠記録').data[0].length, 31, '22列＋段階1の5列＋段階2の4列');
});

test('勤務場所は会社（出社）・在宅の2択だけ。直行・直帰・直行直帰・現場名は付帯情報として保存する', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  // 1. 勤務場所は2択だけ（現場・外出は打刻できない）
  assert.deepEqual(plain(gas.g.punchWorkStyles_()), ['出社', '在宅']);
  gas.setNow('2026-10-04 09:00');
  for (const bad of ['現場', '外出']) assert.match(gas.g.clockIn(bad).message, /勤務形態/, bad + 'は選べない');
  assert.equal(gas.main.rows('勤怠記録').length, 0);
  // 4. 直行＋現場名：会社（勤務場所）のまま、直行と現場名を付帯情報として持つ
  run(gas, '2026-10-05', [['09:30', 'clockIn', '出社', { direct: true, site: '堺市○○様邸' }], ['14:00', 'switchWorkStyle', '在宅'], ['18:30', 'clockOut']]);
  assert.deepEqual(seg(gas, 'AT-20261005-E002'), ['出社|09:30-14:00|○||堺市○○様邸|', '在宅|14:00-18:30||||']);
  assert.deepEqual(pick(att(gas, 'AT-20261005-E002'), ['直行', '直帰', '勤務形態区分', '出社時間', '在宅時間', '現場外出時間']), ['○', '', '出社＋在宅', '04:30', '04:30', ''],
    '現場外出時間は新しい集計では使わない');
  // 5. 直帰
  run(gas, '2026-10-06', [['09:30', 'clockIn', '出社'], ['18:30', 'clockOut', { directReturn: true }]]);
  assert.deepEqual(pick(att(gas, 'AT-20261006-E002'), ['直行', '直帰']), ['', '○']);
  // 6. 直行直帰
  run(gas, '2026-10-07', [['08:30', 'clockIn', '出社', { direct: true, site: '和泉市□□様邸' }], ['17:00', 'clockOut', { directReturn: true }]]);
  assert.deepEqual(pick(att(gas, 'AT-20261007-E002'), ['直行', '直帰', '勤務形態']), ['○', '○', '出社']);
  assert.deepEqual(seg(gas, 'AT-20261007-E002'), ['出社|08:30-17:00|○|○|和泉市□□様邸|']);
  const tl = plain(gas.g.buildAttendanceTimeline_(gas.g.findAttendance_('E002', '2026-10-07'), { showSeconds: false })).events.map((e) => e.time + ' ' + e.label);
  assert.deepEqual(tl, ['08:30 直行で出勤（和泉市□□様邸）', '17:00 退勤（直帰）']);
  // 現場名だけ（直行なし）は「現場：」を付ける
  run(gas, '2026-10-08', [['09:00', 'clockIn', '在宅', { site: '見積先' }], ['10:00', 'clockOut']]);
  assert.deepEqual(plain(gas.g.buildAttendanceTimeline_(gas.g.findAttendance_('E002', '2026-10-08'), { showSeconds: false })).events.map((e) => e.label),
    ['在宅で出勤（現場：見積先）', '退勤']);
});

test('以前に保存された「現場」「外出」の勤務区間があっても、読み取り・集計・表示で壊れない（書き換えない）', () => {
  const gas = ready();
  // 段階2の途中の版で保存された旧データ（現場・外出の区間）をそのまま入れる
  gas.g.appendRecords_('勤怠記録', [{ '勤怠ID': 'AT-20261003-E002', '日付': '2026-10-03', '社員ID': 'E002', '氏名': '佐藤', '勤務区分': '固定勤務',
    '勤務形態': '現場', '出勤': '09:00', '退勤': '13:00', '状態': '退勤済み', '勤務形態区分': '現場＋外出', '現場外出時間': '04:00' }]);
  gas.g.appendRecords_('勤務区間履歴', [
    { '勤務区間ID': 'WS-20261003-E002-01', '勤怠ID': 'AT-20261003-E002', '日付': '2026-10-03', '社員ID': 'E002', '氏名': '佐藤', '区間番号': '1', '勤務形態': '現場', '開始時刻': '09:00', '終了時刻': '12:00', '現場名': '堺市○○様邸' },
    { '勤務区間ID': 'WS-20261003-E002-02', '勤怠ID': 'AT-20261003-E002', '日付': '2026-10-03', '社員ID': 'E002', '氏名': '佐藤', '区間番号': '2', '勤務形態': '外出', '開始時刻': '12:00', '終了時刻': '13:00' },
  ]);
  const segBefore = JSON.stringify(gas.main.getSheetByName('勤務区間履歴').data);
  gas.loginAs(ADMIN);
  gas.setNow('2026-10-05 09:00');
  const d = ok(gas.g.getAdminDayDetail('E002', '2026-10-03')).data;
  assert.deepEqual(d.detail.segments.map((x) => [x.place, x.legacy]), [['現場（旧）', true], ['外出（旧）', true]], '旧データとして表示');
  assert.equal(d.detail.workPlace, '現場（旧）＋外出（旧）');
  assert.deepEqual(d.events.map((e) => e.label), ['現場（旧）で出勤（現場：堺市○○様邸）', '勤務場所を外出（旧）へ切替', '退勤']);
  ok(gas.g.getAdminDashboard({ month: '2026-10' }));
  ok(gas.g.exportAdminAttendanceCsv({ type: 'monthly', month: '2026-10' }));
  ok(gas.g.recalculateThisMonth());
  const a = att(gas, 'AT-20261003-E002');
  assert.deepEqual(pick(a, ['実働時間', '出社時間', '在宅時間', '現場外出時間', '勤務形態区分']), ['03:00', '00:00', '00:00', '04:00', '現場＋外出'],
    '旧データも実働には入る（4:00−自動休憩1:00）。現場外出時間の以前の値は書き換えない');
  assert.equal(JSON.stringify(gas.main.getSheetByName('勤務区間履歴').data.map((r) => r.slice(0, 9))), JSON.stringify(JSON.parse(segBefore).map((r) => r.slice(0, 9))), '勤務形態・時刻は書き換えない');
  // 本人の画面でも読める
  gas.loginAs(FIXED);
  const mine = ok(gas.g.getMyDayDetail('2026-10-03')).data;
  assert.deepEqual(mine.segments.map((x) => x.place), ['現場（旧）', '外出（旧）']);
});

test('付帯情報は本人が当月分を承認なしで直せる（直行・直帰・現場名・備考・日備考・出張）。時刻は変えない', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  run(gas, '2026-10-05', [['09:30', 'clockIn', '出社'], ['13:00', 'switchWorkStyle', '在宅'], ['18:30', 'clockOut']]);
  const before = pick(att(gas, 'AT-20261005-E002'), ['出勤', '退勤', '実働時間', '社内超過時間', '出社時間']);
  gas.setNow('2026-10-06 09:00');
  const r = ok(gas.g.saveMyDayDetail({
    date: '2026-10-05', dayNote: '午後は現場対応', businessTrip: true,
    segments: [{ number: 1, direct: false, directReturn: false, site: '', note: '図面作成' }, { number: 2, direct: false, directReturn: true, site: '堺市○○様邸', note: '' }],
  }));
  assert.match(r.message, /日の情報・区間の情報を保存しました/);
  assert.deepEqual(seg(gas, 'AT-20261005-E002'), ['出社|09:30-13:00||||図面作成', '在宅|13:00-18:30||○|堺市○○様邸|']);
  const a = att(gas, 'AT-20261005-E002');
  assert.deepEqual(pick(a, ['日備考', '出張', '直行', '直帰']), ['午後は現場対応', '○', '', '○']);
  assert.deepEqual(pick(a, ['出勤', '退勤', '実働時間', '社内超過時間', '出社時間']), before, '時刻・実働は変わらない');
  // 時刻・勤務形態は受け付けない（項目にない）／申請も作らない
  ok(gas.g.saveMyDayDetail({ date: '2026-10-05', segments: [{ number: 1, start: '08:00', style: '在宅', site: 'x' }] }));
  assert.deepEqual(seg(gas, 'AT-20261005-E002')[0], '出社|09:30-13:00|||x|', '開始時刻・勤務形態は変わらない（備考は空で上書き＝入力どおり）');
  assert.equal(gas.main.rows('打刻修正申請').length, 0);
  // 日備考・出張は勤怠記録がある日だけ
  assert.match(gas.g.saveMyDayDetail({ date: '2026-10-04', dayNote: 'x' }).message, /勤怠記録がないため/);
  assert.match(gas.g.saveMyDayDetail({ date: '2026-10-04', segments: [{ number: 1 }] }).message, /勤怠記録がないため/);
  // 出張を外す
  ok(gas.g.saveMyDayDetail({ date: '2026-10-05', businessTrip: false }));
  assert.equal(att(gas, 'AT-20261005-E002')['出張'], '');
  // 再計算しても日備考は消えない
  gas.loginAs(ADMIN);
  gas.g.recalculateThisMonth();
  assert.equal(att(gas, 'AT-20261005-E002')['日備考'], '午後は現場対応');
});

test('自家用車の距離（小数可）は交通費明細の自家用車の1行として保存し、勤怠記録には保存しない', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  run(gas, '2026-10-05', [['09:30', 'clockIn', '出社', { direct: true, site: '堺市○○様邸' }], ['17:00', 'clockOut']]);
  gas.setNow('2026-10-05 17:10');
  ok(gas.g.saveMyDayDetail({ date: '2026-10-05', car: { use: true, km: '32.5' } }));
  let rows = trRows(gas);
  assert.equal(rows.length, 1);
  assert.deepEqual(pick(rows[0], ['交通手段', '自家用車使用', '業務走行距離', '金額', '目的・現場', '削除フラグ']), ['自家用車', '○', '32.5', '', '堺市○○様邸', '']);
  assert.equal(Object.values(att(gas, 'AT-20261005-E002')).some((v) => String(v).includes('32.5')), false, '勤怠記録には距離を保存しない');
  // 1件だけなら詳細画面から更新（行は増えない）
  ok(gas.g.saveMyDayDetail({ date: '2026-10-05', car: { use: true, km: '40' } }));
  rows = trRows(gas);
  assert.deepEqual([rows.length, rows[0]['業務走行距離']], [1, '40']);
  let d = ok(gas.g.getMyDayDetail('2026-10-05')).data;
  assert.deepEqual([d.car.use, d.car.km, d.car.count], [true, 40, 1]);
  // 使用しない → 削除フラグ（行は残る）
  ok(gas.g.saveMyDayDetail({ date: '2026-10-05', car: { use: false } }));
  assert.deepEqual([trRows(gas).length, trRows(gas)[0]['削除フラグ']], [1, '○']);
  // 勤怠記録がない日でも自家用車は登録できる
  ok(gas.g.saveMyDayDetail({ date: '2026-10-04', car: { use: true, km: '12.3' } }));
  // 小数の確認
  for (const bad of ['32.55', '-1', '0', '1001', 'abc']) {
    assert.equal(gas.g.saveMyDayDetail({ date: '2026-10-04', car: { use: true, km: bad } }).success, false, bad);
  }
  assert.equal(ok(gas.g.saveMyDayDetail({ date: '2026-10-04', car: { use: true, km: '0.1' } })).success, true);
  // 2件以上あるときは詳細画面からは変えられない（交通費から1件ずつ）
  ok(gas.g.addTransportExpense(tr({ date: '2026-10-04', mode: '自家用車', km: '5', amount: '', purpose: '資材の受け取り' })));
  d = ok(gas.g.getMyDayDetail('2026-10-04')).data;
  assert.deepEqual([d.car.count, d.car.km, d.car.single], [2, 5.1, '']);
  assert.match(gas.g.saveMyDayDetail({ date: '2026-10-04', car: { use: true, km: '20' } }).message, /自家用車の明細が 2件/);
});

test('交通費：1件・同日複数・電車＋駐車場・自家用車＋高速・修正・論理削除（削除済みは集計に入れない）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  gas.setNow('2026-10-05 18:00');
  const one = ok(gas.g.addTransportExpense(tr({})));
  assert.match(one.message, /交通費を登録しました（2026-10-05・電車・450円）/);
  assert.deepEqual(pick(trRows(gas)[0], ['明細ID', '社員ID', '氏名', '交通手段', '金額', '自家用車使用', '業務走行距離']), ['TR-20261005-E002-01', 'E002', '佐藤', '電車', '450', '', '']);
  // 同じ日に複数：電車＋駐車場、自家用車＋高速
  ok(gas.g.addTransportExpense(tr({ mode: '駐車場', from: '', to: '', amount: '800', purpose: '堺市○○様邸' })));
  ok(gas.g.addTransportExpense(tr({ mode: '自家用車', amount: '', km: '58.4', purpose: '和泉市の現場' })));
  ok(gas.g.addTransportExpense(tr({ mode: '高速道路', amount: '1,320', privateCar: true, purpose: '和泉市の現場' })));
  let list = ok(gas.g.getMyTransportExpenses()).data;
  assert.equal(list.items.length, 4);
  assert.deepEqual([list.totals.amount, list.totals.km, list.totals.count], [450 + 800 + 1320, 58.4, 4], '距離は自家用車の行だけ');
  assert.deepEqual(trRows(gas).map((r) => r['自家用車使用']), ['', '', '○', '○'], '高速は自家用車で使った印だけ（距離は持たない）');
  assert.match(gas.g.addTransportExpense(tr({ mode: '高速道路', km: '10' })).message, /自家用車」のときだけ/);
  assert.match(gas.g.addTransportExpense(tr({ amount: '' })).message, /金額を入力/);
  assert.match(gas.g.addTransportExpense(tr({ amount: '12.5' })).message, /整数/);
  assert.match(gas.g.addTransportExpense(tr({ purpose: '' })).message, /目的・現場/);
  assert.match(gas.g.addTransportExpense(tr({ mode: '飛行機' })).message, /交通手段/);
  // 修正
  const id = list.items[0].expenseId;
  ok(gas.g.updateTransportExpense(id, tr({ amount: '470', note: '往復' })));
  assert.deepEqual(pick(trRows(gas)[0], ['金額', '備考']), ['470', '往復']);
  assert.notEqual(trRows(gas)[0]['更新日時'], '', '更新日時が入る');
  // 論理削除
  gas.setNow('2026-10-05 18:30');
  ok(gas.g.deleteTransportExpense(id));
  assert.deepEqual(pick(trRows(gas)[0], ['削除フラグ', '更新日時']), ['○', '2026-10-05 18:30:00']);
  assert.equal(trRows(gas).length, 4, '行は消さない');
  list = ok(gas.g.getMyTransportExpenses()).data;
  assert.deepEqual([list.items.length, list.totals.amount], [3, 800 + 1320], '削除済みは一覧・合計に入れない');
  assert.match(gas.g.updateTransportExpense(id, tr({})).message, /見つかりません/, '削除済みは直せない');
  assert.match(gas.g.deleteTransportExpense(id).message, /見つかりません/);
  // シートで直接削除フラグを入れた場合（TRUE など）も削除済みとして扱う
  const sheet = gas.main.getSheetByName('交通費明細');
  sheet.data[2][sheet.data[0].indexOf('削除フラグ')] = 'TRUE';
  gas.g.clearTableCache_();
  assert.equal(ok(gas.g.getMyTransportExpenses()).data.items.length, 2);
});

test('交通費の期間は20日締め（前月21日〜当月20日）。本人が変更できるのは今の期間の今日までだけ', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  gas.setNow('2026-10-20 18:00');
  ok(gas.g.addTransportExpense(tr({ date: '2026-09-21' })));
  ok(gas.g.addTransportExpense(tr({ date: '2026-10-20', amount: '100' })));
  assert.match(gas.g.addTransportExpense(tr({ date: '2026-09-20' })).message, /締めた後の期間（2026年9月分）/);
  assert.match(gas.g.addTransportExpense(tr({ date: '2026-10-21' })).message, /未来の日付/);
  let list = ok(gas.g.getMyTransportExpenses()).data;
  assert.deepEqual([list.periodText, list.items.length, list.editable], ['2026年10月分 対象期間：2026/09/21〜2026/10/20', 2, true]);
  // 10/21 になると 10月分は本人から変更できない（表示はできる）
  gas.setNow('2026-10-21 09:00');
  const id = list.items[0].expenseId;
  assert.match(gas.g.updateTransportExpense(id, tr({ date: '2026-09-21' })).message, /締めた後の期間（2026年10月分）のため変更できません/);
  assert.match(gas.g.deleteTransportExpense(id).message, /締めた後の期間/);
  assert.match(gas.g.saveMyDayDetail({ date: '2026-10-20', car: { use: true, km: '3' } }).message, /締めた後の期間/);
  list = ok(gas.g.getMyTransportExpenses('2026-10')).data;
  assert.deepEqual([list.items.length, list.editable], [2, false]);
  list = ok(gas.g.getMyTransportExpenses()).data;
  assert.deepEqual([list.month, list.from, list.items.length, list.editable], ['2026-11', '2026-10-21', 0, true]);
  // 今の期間の明細を、前の期間の日付へ移すこともできない
  ok(gas.g.addTransportExpense(tr({ date: '2026-10-21' })));
  const cur = ok(gas.g.getMyTransportExpenses()).data.items[0].expenseId;
  assert.match(gas.g.updateTransportExpense(cur, tr({ date: '2026-10-20' })).message, /締めた後の期間/);
});

test('他人の交通費は取得・修正・削除できない。管理者は全社員分を見られる（日次・月次）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  gas.setNow('2026-10-05 18:00');
  const mine = ok(gas.g.addTransportExpense(tr({}))).data.expenseId;
  ok(gas.g.saveMyDayDetail({ date: '2026-10-05', car: { use: true, km: '10.5' } }));
  gas.loginAs(FLEX);
  ok(gas.g.addTransportExpense(tr({ amount: '300' })));
  assert.equal(ok(gas.g.getMyTransportExpenses()).data.items.length, 1, '自分の分だけ');
  assert.doesNotMatch(JSON.stringify(gas.g.getMyTransportExpenses().data), /佐藤|E002/);
  assert.match(gas.g.updateTransportExpense(mine, tr({ amount: '1' })).message, /見つかりません/);
  assert.match(gas.g.deleteTransportExpense(mine).message, /見つかりません/);
  assert.equal(trRows(gas)[0]['金額'], '450', '他人の明細は変わらない');
  // 社員IDを送っても、ログイン中の人として扱う
  ok(gas.g.addTransportExpense(tr({ employeeId: 'E002', amount: '1' })));
  assert.equal(trRows(gas).pop()['社員ID'], 'E003');
  assert.match(gas.g.getAdminDayDetail('E002', '2026-10-05').message, /管理者/);
  assert.equal(ok(gas.g.getMyDayDetail('2026-10-05')).data.car.count, 0, '鈴木さんの詳細に佐藤さんの自家用車は出ない');
  // 管理者：日別の詳細と月次の合計
  gas.loginAs(ADMIN);
  const d = ok(gas.g.getAdminDayDetail('E002', '2026-10-05')).data;
  assert.deepEqual([d.record, d.detail.transports.length, d.detail.car.km, d.detail.transportTotals.amount], [null, 2, 10.5, 450], '勤怠記録がない日も交通費を見られる');
  const m = gas.g.getAdminDashboard({ month: '2026-10', parts: ['monthly'] }).data.monthly.rows;
  const sato = m.find((x) => x.name === '佐藤');
  const suzuki = m.find((x) => x.name === '鈴木');
  assert.deepEqual([sato.mileageKm, sato.transportAmount, sato.mileageText, sato.transportAmountText], [10.5, 450, '10.5km', '450円']);
  assert.deepEqual([suzuki.mileageKm, suzuki.transportAmount], [0, 301]);
});

test('日次・月次の集計（月次CSVの列）と、走行距離を二重に計上しない', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  run(gas, '2026-10-05', [['09:30', 'clockIn', '出社', { direct: true, site: '堺市○○様邸' }], ['17:00', 'clockOut', { directReturn: true }]]);
  gas.setNow('2026-10-05 17:10');
  ok(gas.g.saveMyDayDetail({ date: '2026-10-05', dayNote: '直行直帰', businessTrip: true, car: { use: true, km: '32.5' } }));
  ok(gas.g.addTransportExpense(tr({ mode: '高速道路', amount: '1320', privateCar: true })));
  ok(gas.g.addTransportExpense(tr({ mode: '駐車場', amount: '600' })));
  // 同じ距離をもう一度保存しても、行は増えず距離も増えない
  ok(gas.g.saveMyDayDetail({ date: '2026-10-05', car: { use: true, km: '32.5' } }));
  const d = ok(gas.g.getMyDayDetail('2026-10-05')).data;
  assert.deepEqual([d.car.km, d.car.count, d.transportTotals.km, d.transportTotals.amount, d.dayNote, d.businessTrip, d.direct, d.directReturn],
    [32.5, 1, 32.5, 1920, '直行直帰', true, true, true]);
  gas.setNow('2026-10-06 18:00');
  ok(gas.g.addTransportExpense(tr({ date: '2026-10-06', mode: '自家用車', amount: '', km: '7.5' })));
  const month = ok(gas.g.getMyTransportExpenses()).data.totals;
  assert.deepEqual([month.km, month.amount, month.kmText], [40, 1920, '40.0km'], '月次：距離は自家用車の行の合計だけ');
  gas.loginAs(ADMIN);
  gas.setNow('2026-10-07 09:00');
  const csv = ok(gas.g.exportAdminAttendanceCsv({ type: 'monthly', month: '2026-10' })).data.csv.split('\r\n');
  assert.ok(csv[0].endsWith(',日備考,出張,直行,直帰,現場,業務走行距離,交通費合計,日の区分,有給種別,有給時間,要確認（申請）,休日出勤時間,日報,要確認の理由'));
  assert.match(csv[1], /,直行直帰,○,○,○,堺市○○様邸,32\.5,1920,,,,,,未提出,日報未提出$/);
  const sato = gas.g.getAdminDashboard({ month: '2026-10', parts: ['monthly'] }).data.monthly.rows.find((x) => x.name === '佐藤');
  assert.deepEqual([sato.mileageKm, sato.transportAmount], [40, 1920]);
});

test('画面：スタッフ画面の許可リストに交通費・詳細の関数があり、管理者用の関数は含まない。HTMLは文字として表示', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../leaf-portal/gas/DetailScripts.html'), 'utf8');
  const list = src.match(/var DETAIL_FUNCTIONS = \[([^\]]+)\]/)[1];
  for (const fn of ['getMyDayDetail', 'saveMyDayDetail', 'getMyTransportExpenses', 'addTransportExpense', 'updateTransportExpense', 'deleteTransportExpense']) assert.match(list, new RegExp("'" + fn + "'"));
  assert.doesNotMatch(list, /Admin|approve|getAttendanceDetail/);
  assert.doesNotMatch(src, /innerHTML/);
});

test('勤務場所の切替・再開・再出勤：同じ勤務場所なら区間を作らない。表示は会社／在宅（中断中（会社）など）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  const id = 'AT-20261005-E002';
  const segs = () => gas.main.rows('勤務区間履歴').filter((r) => r['勤怠ID'] === id).map((r) => r['勤務形態'] + ' ' + r['開始時刻'] + '-' + r['終了時刻']);
  const label = () => gas.g.getTodayStaffStatus().data.staff.find((s) => s.name === '佐藤').label;
  run(gas, '2026-10-05', [['09:00', 'clockIn', '出社']]);
  assert.equal(label(), '会社勤務中');
  gas.setNow('2026-10-05 09:30');
  const same = gas.g.switchWorkStyle('出社');
  assert.deepEqual([same.success, /現在と同じ勤務場所です（会社）/.test(same.message)], [false, true]);
  assert.deepEqual(segs(), ['出社 09:00-'], '同じ勤務場所の切替では区間を作らない');
  // 15. 在宅→会社 の切替も
  run(gas, '2026-10-05', [['10:00', 'switchWorkStyle', '在宅'], ['11:00', 'switchWorkStyle', '出社']]);
  assert.equal(label(), '会社勤務中');
  // 13. 中断中に同じ勤務場所で再開 → 区間は増えない
  run(gas, '2026-10-05', [['12:00', 'startBreak', '']]);
  assert.equal(label(), '中断中（会社）');
  const r = ok(gas.g.resumeWork('出社'));
  assert.match(r.message, /再開しました（会社勤務・中断/);
  assert.deepEqual(segs(), ['出社 09:00-10:00', '在宅 10:00-11:00', '出社 11:00-']);
  // 16. 中断中に 会社→在宅 へ変えて再開（中断は区間の外）
  run(gas, '2026-10-05', [['13:00', 'startBreak', ''], ['13:30', 'resumeWork', '在宅']]);
  assert.deepEqual(segs().slice(-2), ['出社 11:00-13:00', '在宅 13:30-']);
  assert.equal(label(), '在宅勤務中');
  // 19. 再出勤は選んだ勤務場所
  run(gas, '2026-10-05', [['15:00', 'clockOut'], ['16:00', 'clockIn', '出社'], ['17:00', 'clockOut']]);
  assert.deepEqual(segs().slice(-1), ['出社 16:00-17:00']);
  const ev = plain(gas.g.buildAttendanceTimeline_(gas.g.findAttendance_('E002', '2026-10-05'), { showSeconds: false })).events.map((e) => e.label);
  assert.deepEqual(ev, ['会社で出勤', '勤務場所を在宅へ切替', '勤務場所を会社へ切替', '中断', '再開（会社）', '中断', '再開（在宅）', '退勤', '会社で再出勤', '退勤']);
  assert.equal(att(gas, id)['勤務形態区分'], '出社＋在宅', '内部の値は出社のまま');
  assert.equal(ok(gas.g.getMyAttendance()).data.records[0].workPlace, '会社＋在宅', '画面用は会社＋在宅');
  assert.equal(att(gas, id)['現場外出時間'], '', '現場外出時間は新しい集計では使わない');
});

test('直行は、その日の最初の出勤のときだけ設定できる（再出勤・再開・勤務場所の切替では設定できず、後の区間へ引き継がない）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  const id = 'AT-20261005-E002';
  const directs = () => gas.main.rows('勤務区間履歴').filter((r) => r['勤怠ID'] === id).map((r) => r['区間番号'] + ':' + (r['直行'] || '-') + ':' + (r['現場名'] || ''));
  const labels = () => plain(gas.g.buildAttendanceTimeline_(gas.g.findAttendance_('E002', '2026-10-05'), { showSeconds: false })).events.map((e) => e.label);
  // 最初の出勤では直行を設定できる（区間1に 直行 ○・現場名）
  run(gas, '2026-10-05', [['09:00', 'clockIn', '出社', { direct: true, site: '堺市○○様邸' }]]);
  assert.deepEqual(directs(), ['1:○:堺市○○様邸']);
  assert.deepEqual(labels(), ['直行で出勤（堺市○○様邸）']);
  // 勤務場所の切替では設定できない（送られてきたら止める・区間は作らない）
  gas.setNow('2026-10-05 10:00');
  assert.match(gas.g.switchWorkStyle('在宅', { direct: true }).message, /直行は、その日の最初の出勤のときだけ選べます/);
  assert.equal(directs().length, 1);
  run(gas, '2026-10-05', [['10:00', 'switchWorkStyle', '在宅']]);
  // 再開では設定できない
  run(gas, '2026-10-05', [['11:00', 'startBreak', '']]);
  gas.setNow('2026-10-05 11:30');
  assert.match(gas.g.resumeWork('出社', { direct: true }).message, /最初の出勤のときだけ/);
  run(gas, '2026-10-05', [['11:30', 'resumeWork', '出社'], ['12:00', 'clockOut']]);
  // 再出勤では設定できない
  gas.setNow('2026-10-05 13:00');
  assert.match(gas.g.clockIn('在宅', { direct: true, site: 'x' }).message, /最初の出勤のときだけ/);
  assert.equal(gas.main.rows('勤怠記録').find((r) => r['勤怠ID'] === id)['状態'], '退勤済み', '止めたときは再出勤しない');
  run(gas, '2026-10-05', [['13:00', 'clockIn', '在宅'], ['14:00', 'clockOut']]);
  // 後続の区間へ直行を引き継がない。日次まとめの直行は最初の区間で判定
  assert.deepEqual(directs(), ['1:○:堺市○○様邸', '2:-:', '3:-:', '4:-:']);
  assert.equal(att(gas, id)['直行'], '○');
  assert.deepEqual(labels(), ['直行で出勤（堺市○○様邸）', '勤務場所を在宅へ切替', '中断', '再開（会社）', '退勤', '在宅で再出勤', '退勤']);
  // 現場名なしの直行は「直行で出勤」
  run(gas, '2026-10-06', [['09:00', 'clockIn', '在宅', { direct: true }], ['10:00', 'clockOut']]);
  assert.deepEqual(plain(gas.g.buildAttendanceTimeline_(gas.g.findAttendance_('E002', '2026-10-06'), { showSeconds: false })).events.map((e) => e.label), ['直行で出勤', '退勤']);
  // 詳細の編集でも、直行は最初の区間だけ（2つ目以降に付けようとすると止める）
  gas.setNow('2026-10-06 18:00');
  assert.match(gas.g.saveMyDayDetail({ date: '2026-10-05', segments: [{ number: 2, direct: true }] }).message, /最初の区間（最初の出勤）だけ/);
  ok(gas.g.saveMyDayDetail({ date: '2026-10-05', segments: [{ number: 1, direct: false, site: '堺市○○様邸' }] }));
  assert.equal(att(gas, id)['直行'], '', '最初の区間の直行を外せば日次まとめも外れる');
  const d = ok(gas.g.getMyDayDetail('2026-10-05')).data;
  assert.deepEqual(d.segments.map((x) => x.first), [true, false, false, false]);
});

test('以前の版で再出勤の区間に直行が付いたデータは、書き換えずに読める（日次まとめは最初の区間で判定）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  run(gas, '2026-10-05', [['09:00', 'clockIn', '出社'], ['12:00', 'clockOut'], ['13:00', 'clockIn', '在宅'], ['15:00', 'clockOut']]);
  // 以前の版で付いた「再出勤の区間の直行」を直接入れる
  const sheet = gas.main.getSheetByName('勤務区間履歴');
  sheet.data[2][sheet.data[0].indexOf('直行')] = '○';
  gas.g.clearTableCache_();
  const before = JSON.stringify(sheet.data);
  gas.loginAs(ADMIN);
  gas.setNow('2026-10-06 09:00');
  ok(gas.g.recalculateThisMonth());
  assert.equal(att(gas, 'AT-20261005-E002')['直行'], '', '最初の区間が直行でなければ、日次まとめの直行は付かない');
  assert.equal(JSON.stringify(sheet.data.map((r) => r.slice(0, 13))), JSON.stringify(JSON.parse(before).map((r) => r.slice(0, 13))), '勤務区間の直行は書き換えない');
  const d = ok(gas.g.getAdminDayDetail('E002', '2026-10-05')).data;
  assert.deepEqual(d.events.map((e) => e.label), ['会社で出勤', '退勤', '在宅で再出勤・直行', '退勤']);
  assert.deepEqual(d.detail.segments.map((x) => x.direct), [false, true]);
  // 本人が詳細を保存しても、2つ目の区間の直行（以前のデータ）は消えない
  gas.loginAs(FIXED);
  ok(gas.g.saveMyDayDetail({ date: '2026-10-05', segments: [{ number: 2, direct: true, site: '' }], dayNote: 'メモ' }));
  assert.equal(gas.main.rows('勤務区間履歴')[1]['直行'], '○');
});
