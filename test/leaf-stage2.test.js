'use strict';
// 段階2：直行・直帰・現場名・日備考・出張・自家用車の業務走行距離・交通費明細のテスト
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

test('直行・直帰・直行直帰・現場名（打刻のときに入れる／勤務形態は現場・外出も選べる。現場と外出は別々に保存）', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  // 直行：現場に直行 → 会社に戻る
  run(gas, '2026-10-05', [['09:30', 'clockIn', '現場', { direct: true, site: '堺市○○様邸' }], ['14:00', 'switchWorkStyle', '出社'], ['18:30', 'clockOut']]);
  assert.deepEqual(seg(gas, 'AT-20261005-E002'), ['現場|09:30-14:00|○||堺市○○様邸|', '出社|14:00-18:30||||']);
  assert.deepEqual(pick(att(gas, 'AT-20261005-E002'), ['直行', '直帰', '勤務形態区分', '現場外出時間', '出社時間']), ['○', '', '出社＋現場', '04:30', '04:30']);
  // 直帰：会社 → 外出して直帰
  run(gas, '2026-10-06', [['09:30', 'clockIn', '出社'], ['15:00', 'switchWorkStyle', '外出', { site: '大阪市△△' }], ['18:30', 'clockOut', { directReturn: true }]]);
  assert.deepEqual(seg(gas, 'AT-20261006-E002'), ['出社|09:30-15:00||||', '外出|15:00-18:30||○|大阪市△△|']);
  assert.deepEqual(pick(att(gas, 'AT-20261006-E002'), ['直行', '直帰']), ['', '○']);
  // 直行直帰：現場に直行して直帰
  run(gas, '2026-10-07', [['08:30', 'clockIn', '現場', { direct: true, site: '和泉市□□様邸' }], ['17:00', 'clockOut', { directReturn: true }]]);
  assert.deepEqual(pick(att(gas, 'AT-20261007-E002'), ['直行', '直帰', '勤務形態']), ['○', '○', '現場']);
  assert.deepEqual(seg(gas, 'AT-20261007-E002'), ['現場|08:30-17:00|○|○|和泉市□□様邸|']);
  // 時系列にも出る
  const tl = plain(gas.g.buildAttendanceTimeline_(gas.g.findAttendance_('E002', '2026-10-07'), { showSeconds: false })).events.map((e) => e.time + ' ' + e.label);
  assert.deepEqual(tl, ['08:30 現場で出勤・直行（和泉市□□様邸）', '17:00 退勤（直帰）']);
  // 現場と外出は別々に保存（集計は現場外出時間にまとめる）
  run(gas, '2026-10-08', [['09:00', 'clockIn', '現場'], ['12:00', 'switchWorkStyle', '外出'], ['13:00', 'clockOut']]);
  assert.deepEqual(gas.main.rows('勤務区間履歴').filter((r) => r['勤怠ID'] === 'AT-20261008-E002').map((r) => r['勤務形態']), ['現場', '外出']);
  assert.deepEqual(pick(att(gas, 'AT-20261008-E002'), ['勤務形態区分', '現場外出時間']), ['現場＋外出', '04:00']);
});

test('付帯情報は本人が当月分を承認なしで直せる（直行・直帰・現場名・備考・日備考・出張）。時刻は変えない', () => {
  const gas = ready();
  gas.loginAs(FIXED);
  run(gas, '2026-10-05', [['09:30', 'clockIn', '出社'], ['13:00', 'switchWorkStyle', '現場'], ['18:30', 'clockOut']]);
  const before = pick(att(gas, 'AT-20261005-E002'), ['出勤', '退勤', '実働時間', '社内超過時間', '出社時間']);
  gas.setNow('2026-10-06 09:00');
  const r = ok(gas.g.saveMyDayDetail({
    date: '2026-10-05', dayNote: '午後は現場対応', businessTrip: true,
    segments: [{ number: 1, direct: false, directReturn: false, site: '', note: '図面作成' }, { number: 2, direct: false, directReturn: true, site: '堺市○○様邸', note: '' }],
  }));
  assert.match(r.message, /日の情報・区間の情報を保存しました/);
  assert.deepEqual(seg(gas, 'AT-20261005-E002'), ['出社|09:30-13:00||||図面作成', '現場|13:00-18:30||○|堺市○○様邸|']);
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
  run(gas, '2026-10-05', [['09:30', 'clockIn', '現場', { direct: true, site: '堺市○○様邸' }], ['17:00', 'clockOut']]);
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
  run(gas, '2026-10-05', [['09:30', 'clockIn', '現場', { direct: true, site: '堺市○○様邸' }], ['17:00', 'clockOut', { directReturn: true }]]);
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
  assert.ok(csv[0].endsWith(',日備考,出張,直行,直帰,業務走行距離,交通費合計'));
  assert.match(csv[1], /,直行直帰,○,○,○,32\.5,1920$/);
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
