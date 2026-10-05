'use strict';
// 再計算のプレビュー・確認後の再計算・「設定変更後に未再計算」の印・自動休憩_適用開始_有効日のテスト。
// 本番で見つかった例（2026/10/5 大森さん 04:57〜08:18。打刻時の自動休憩_適用開始が 00:00 だったため自動休憩 01:00・実働 02:21 で保存）を再現する。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const ADMIN = 'hiroki@example.com';
const OMORI = 'sachiko@example.com';   // フレックス
const NAKATSUI = 'yuuki@example.com';  // 固定勤務
const NOW = '2026-10-15 20:00';

function office() {
  const gas = createLeafGas({ email: ADMIN });
  gas.g.setupSystem();
  const base = { '在籍状況': '在籍', '雇用区分': '正社員', '有給申請対象': '対象', '休日出勤申請対象': '対象', '部署': '一般', '権限': 'staff' };
  gas.g.appendRecords_('スタッフマスタ', [
    { ...base, '社員ID': 'E001', '氏名': '光山大樹', 'メールアドレス': ADMIN, '権限': 'admin', '勤務区分': '固定勤務', '勤怠集計対象': '対象外' },
    { ...base, '社員ID': 'E003', '氏名': '大森紗智子', 'メールアドレス': OMORI, '勤務区分': 'フレックス' },
    { ...base, '社員ID': 'E005', '氏名': '中津井祐貴', 'メールアドレス': NAKATSUI, '勤務区分': '固定勤務' },
  ]);
  setSetting(gas, '自動休憩_適用開始', '00:00'); // 本番の以前の値
  gas.setNow(NOW);
  return gas;
}
function setSetting(gas, key, value) {
  const row = gas.main.getSheetByName('設定').data.find((r) => r[0] === key);
  assert.ok(row, key);
  row[1] = value;
  gas.g.clearTableCache_();
}
function run(gas, email, date, steps) {
  gas.loginAs(email);
  for (const [time, fn, arg] of steps) {
    gas.setNow(date + ' ' + time);
    const r = arg === undefined ? gas.g[fn]() : gas.g[fn](arg);
    assert.equal(r.success, true, date + ' ' + time + ' ' + fn + '：' + r.message);
  }
  gas.setNow(NOW);
  gas.g.clearTableCache_();
}
const work = (gas, email, date, from, to) => run(gas, email, date, [[from, 'clockIn', '出社'], [to, 'clockOut']]);
const asAdmin = (gas) => { gas.loginAs(ADMIN); gas.setNow(NOW); gas.g.clearTableCache_(); };
const snapshot = (gas) => JSON.stringify(gas.main.sheets.map((s) => [s.getName(), s.data]));
const stored = (gas, id, date) => {
  const sh = gas.main.getSheetByName('勤怠記録');
  const h = sh.data[0];
  const row = sh.data.find((r) => String(r[h.indexOf('社員ID')]) === id && String(r[h.indexOf('日付')]).slice(0, 10) === date);
  return { autoBreak: row[h.indexOf('自動休憩')], workTime: row[h.indexOf('実働時間')], excess: row[h.indexOf('社内超過時間')] };
};
const daily = (gas, date) => {
  asAdmin(gas);
  const r = gas.g.getAdminDashboard({ parts: ['summary', 'daily'], date });
  assert.equal(r.success, true, r.message);
  return r.data;
};
const preview = (gas, params) => {
  asAdmin(gas);
  const r = gas.g.previewAttendanceRecalculation(params);
  assert.equal(r.success, true, r.message);
  return r.data;
};
/** .xlsx（ZIP）の中の全ファイルをつないだ文字列 */
function unzipText(buf) {
  const zlib = require('node:zlib');
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const lp = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.slice(lp, lp + size);
    out.push((buf.readUInt16LE(p + 10) === 8 ? zlib.inflateRawSync(data) : data).toString('utf8'));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out.join('\n');
}
const PERIOD = { from: '2026-09-21', to: '2026-10-20' };

/** 本番の例：打刻時は 00:00 → あとで 06:00・有効日 2026-09-21 に変更 */
function incident(beforeChange) {
  const gas = office();
  work(gas, OMORI, '2026-10-05', '04:57', '08:18');
  if (beforeChange) beforeChange(gas); // 設定を変える前（00:00 のとき）に打刻した記録
  assert.deepEqual(stored(gas, 'E003', '2026-10-05'), { autoBreak: '01:00', workTime: '02:21', excess: '' }, '打刻時の設定（00:00）で保存');
  setSetting(gas, '自動休憩_適用開始', '06:00');
  setSetting(gas, '自動休憩_適用開始_有効日', '2026-09-21');
  return gas;
}

// ============================================================ 設定変更後に未再計算の印（表示は保存値のまま）

test('未再計算の印：設定を 06:00 に変えた後、日次一覧は保存値（01:00・02:21）のまま表示し「設定変更後に未再計算」と変わる値を出す。画面を開いても書き換えない', () => {
  const gas = incident();
  const before = snapshot(gas);
  const d = daily(gas, '2026-10-05');
  const row = d.daily.rows.find((r) => r.employeeId === 'E003');
  assert.deepEqual([row.autoBreak, row.workTime], ['01:00', '02:21'], '表示は保存値のまま（自動では再計算しない）');
  assert.equal(row.recalcStale.text, '自動休憩 01:00→00:00・実働 02:21→03:21');
  assert.equal(d.summary.recalcStaleRecords, 1, 'サマリーに件数');
  assert.equal(snapshot(gas), before, '画面を開いただけではシートは変わらない');
  // 社内詳細月次・要確認一覧にも理由として出る（区分「再計算」）
  const m = gas.g.getAdminEmployeeMonth('E003', '2026-10').data.days.find((x) => x.date === '2026-10-05');
  assert.ok(m.reasons.some((r) => r.category === '再計算' && r.text === '設定変更後に未再計算（自動休憩 01:00→00:00・実働 02:21→03:21）'));
  const checks = gas.g.getAdminMonthlyAnalysis('2026-10').data.checks;
  assert.equal(checks.byCategory['再計算'], 1);
});

test('未再計算の印：設定を変えていない記録・勤務中の記録には付けない', () => {
  const gas = office();
  work(gas, OMORI, '2026-10-05', '04:57', '08:18');
  run(gas, NAKATSUI, '2026-10-15', [['09:30', 'clockIn', '出社']]); // 勤務中
  const d = daily(gas, '2026-10-05');
  assert.equal(d.daily.rows.find((r) => r.employeeId === 'E003').recalcStale, null);
  assert.equal(d.summary.recalcStaleRecords, 0);
  setSetting(gas, '自動休憩_適用開始', '06:00');
  const d15 = daily(gas, '2026-10-15');
  assert.equal(d15.daily.rows.find((r) => r.employeeId === 'E005').recalcStale, null, '勤務中（退勤前）は判定しない');
});

// ============================================================ プレビュー（書き込みなし）

test('プレビュー：社員名・日付・自動休憩 変更前→変更後・実働 変更前→変更後・変更理由を返し、シートには書き込まない', () => {
  const gas = incident();
  work(gas, OMORI, '2026-10-06', '09:00', '18:00'); // 9時間：06:00 を超えるので自動休憩はそのまま（変わらない）
  const before = snapshot(gas);
  const p = preview(gas, PERIOD);
  assert.equal(snapshot(gas), before, 'プレビューは書き込まない');
  assert.equal(p.targetCount, 2);
  assert.equal(p.changedCount, 1, '変わる記録だけ');
  const r = p.rows[0];
  assert.deepEqual([r.name, r.date, r.weekday], ['大森紗智子', '2026-10-05', '月']);
  assert.deepEqual(r.autoBreak, { before: '01:00', after: '00:00', changed: true });
  assert.deepEqual(r.workTime, { before: '02:21', after: '03:21', changed: true });
  assert.deepEqual(r.others, []);
  assert.deepEqual(r.reasons, ['自動休憩の設定（自動休憩_適用開始 06:00）：中断を除いた勤務 03:21 はそれ以下のため自動休憩なし']);
  assert.ok(r.fingerprint);
  assert.match(p.notes[0], /適用開始 06:00（2026\/09\/21 以降の勤務日。それより前の日は 00:00）/);
});

test('プレビュー：固定勤務の遅刻・早退・社内超過など、再計算で変わるほかの項目と理由も出す', () => {
  const gas = office();
  work(gas, NAKATSUI, '2026-10-01', '09:30', '19:30'); // 標準退勤 18:30 → 社内超過 01:00
  assert.equal(stored(gas, 'E005', '2026-10-01').excess, '01:00');
  setSetting(gas, '固定勤務_標準退勤', '18:00');
  const r = preview(gas, PERIOD).rows.find((x) => x.employeeId === 'E005');
  assert.deepEqual(r.autoBreak, { before: '01:00', after: '01:00', changed: false }, '変わらない項目もそのまま見せる');
  assert.ok(r.others.some((o) => o.label === '社内超過' && o.before === '01:00' && o.after === '01:30'), JSON.stringify(r.others));
  assert.ok(r.reasons.some((x) => /固定勤務の標準時刻/.test(x)));
});

test('プレビュー：社員と期間で絞れる（ほかの社員・期間外の記録は出さない）。期間・社員の入力チェック', () => {
  const gas = incident((g) => {
    work(g, NAKATSUI, '2026-10-05', '09:00', '13:00'); // 4時間・00:00 で自動休憩 01:00 → 変わる
    work(g, OMORI, '2026-10-21', '04:57', '08:18');    // 11月分（期間外）
  });
  assert.equal(preview(gas, PERIOD).changedCount, 2);
  const one = preview(gas, { ...PERIOD, employeeId: 'E005' });
  assert.deepEqual(one.rows.map((r) => r.name), ['中津井祐貴']);
  assert.equal(one.employeeName, '中津井祐貴');
  assert.equal(preview(gas, { from: '2026-10-06', to: '2026-10-20' }).targetCount, 0, '期間外は対象外');
  asAdmin(gas);
  for (const [params, msg] of [[{ from: '2026-10-20', to: '2026-09-21' }, /開始日は終了日より前/], [{ from: '2026-01-01', to: '2026-10-20' }, /93日以内/],
    [{ ...PERIOD, employeeId: 'E999' }, /見つかりません/], [{ from: 'x', to: '2026-10-20' }, /開始日は/]]) {
    const r = gas.g.previewAttendanceRecalculation(params);
    assert.equal(r.success, false);
    assert.match(r.message, msg);
  }
});

// ============================================================ 有効日（2026/09/21）

test('自動休憩_適用開始_有効日：2026-09-21 より前の日は 00:00（常に差し引く）のまま。9/21 以降だけ 06:00。前の月は未再計算にならない', () => {
  const gas = office();
  work(gas, OMORI, '2026-09-20', '04:57', '08:18'); // 9月分
  work(gas, OMORI, '2026-09-21', '04:57', '08:18'); // 10月分の初日
  setSetting(gas, '自動休憩_適用開始', '06:00');
  setSetting(gas, '自動休憩_適用開始_有効日', '2026-09-21');
  const p = preview(gas, { from: '2026-09-01', to: '2026-10-20' });
  assert.deepEqual(p.rows.map((r) => r.date), ['2026-09-21']);
  assert.equal(daily(gas, '2026-09-20').daily.rows.find((r) => r.employeeId === 'E003').recalcStale, null);
  // 有効日の後に打刻した日は 06:00 で保存される（9/20 の打刻を直しても 00:00 のまま）
  work(gas, OMORI, '2026-10-07', '04:57', '08:18');
  assert.deepEqual(stored(gas, 'E003', '2026-10-07'), { autoBreak: '00:00', workTime: '03:21', excess: '' });
  // 有効日が空欄ならすべての日に 06:00
  setSetting(gas, '自動休憩_適用開始_有効日', '');
  assert.deepEqual(preview(gas, { from: '2026-09-01', to: '2026-10-20' }).rows.map((r) => r.date), ['2026-09-20', '2026-09-21']);
});

test('6時間ちょうどは引かず、6時間を超えたら1時間引く（フレックス・固定勤務で同じ）', () => {
  const gas = office();
  setSetting(gas, '自動休憩_適用開始', '06:00');
  work(gas, OMORI, '2026-10-05', '09:00', '15:00');
  work(gas, OMORI, '2026-10-06', '09:00', '15:01');
  work(gas, NAKATSUI, '2026-10-05', '09:30', '15:30');
  work(gas, NAKATSUI, '2026-10-06', '09:30', '15:31');
  assert.deepEqual(stored(gas, 'E003', '2026-10-05'), { autoBreak: '00:00', workTime: '06:00', excess: '' });
  assert.deepEqual(stored(gas, 'E003', '2026-10-06'), { autoBreak: '01:00', workTime: '05:01', excess: '' });
  assert.deepEqual([stored(gas, 'E005', '2026-10-05').autoBreak, stored(gas, 'E005', '2026-10-05').workTime], ['00:00', '06:00']);
  assert.deepEqual([stored(gas, 'E005', '2026-10-06').autoBreak, stored(gas, 'E005', '2026-10-06').workTime], ['01:00', '05:01']);
});

// ============================================================ 確認後の再計算

test('再計算：プレビューで確認した記録だけを書き換える（確認していない記録はそのまま・印も残る）', () => {
  const gas = incident((g) => work(g, NAKATSUI, '2026-10-05', '09:00', '13:00'));
  const p = preview(gas, PERIOD);
  assert.equal(p.changedCount, 2);
  const omori = p.rows.find((r) => r.employeeId === 'E003');
  const r = gas.g.applyAttendanceRecalculation({ ...PERIOD, items: [{ attendanceId: omori.attendanceId, fingerprint: omori.fingerprint }] });
  assert.equal(r.success, true, r.message);
  assert.equal(r.message, '確認した勤怠記録 1件を再計算しました');
  gas.g.clearTableCache_();
  assert.deepEqual(stored(gas, 'E003', '2026-10-05'), { autoBreak: '00:00', workTime: '03:21', excess: '' });
  assert.deepEqual([stored(gas, 'E005', '2026-10-05').autoBreak, stored(gas, 'E005', '2026-10-05').workTime], ['01:00', '03:00'], '確認していない記録は変えない');
  const d = daily(gas, '2026-10-05');
  assert.equal(d.daily.rows.find((x) => x.employeeId === 'E003').recalcStale, null, '再計算した記録の印は消える');
  assert.ok(d.daily.rows.find((x) => x.employeeId === 'E005').recalcStale, '確認していない記録の印は残る');
  assert.deepEqual(preview(gas, PERIOD).rows.map((x) => x.employeeId), ['E005']);
});

test('再計算：プレビューのあとで記録・設定が変わったら、何も書き換えずに止める', () => {
  const gas = incident();
  const p = preview(gas, PERIOD);
  const items = p.rows.map((r) => ({ attendanceId: r.attendanceId, fingerprint: r.fingerprint }));
  setSetting(gas, '自動休憩_適用開始', '03:00'); // プレビュー後に設定が変わった
  asAdmin(gas);
  const before = snapshot(gas);
  const r = gas.g.applyAttendanceRecalculation({ ...PERIOD, items });
  assert.equal(r.success, false);
  assert.match(r.message, /プレビューのあとで勤怠記録・設定が変わったため、再計算していません（1件）/);
  assert.equal(snapshot(gas), before);
  // 期間外の記録・空の指定も実行しない
  assert.equal(gas.g.applyAttendanceRecalculation({ from: '2026-10-06', to: '2026-10-20', items }).success, false);
  assert.match(gas.g.applyAttendanceRecalculation({ ...PERIOD, items: [] }).message, /先にプレビュー/);
  assert.equal(snapshot(gas), before);
});

// ============================================================ 権限・画面から確認なしで再計算しない

test('権限：一般スタッフはプレビュー・再計算を使えない。画面とメニューからは確認なしの再計算（recalculateThisMonth）を呼ばない', () => {
  const gas = incident();
  gas.loginAs(OMORI);
  for (const fn of ['previewAttendanceRecalculation', 'applyAttendanceRecalculation']) {
    const r = gas.g[fn]({ ...PERIOD, items: [{ attendanceId: 'x', fingerprint: 'y' }] });
    assert.deepEqual([r.success, /管理者権限がありません/.test(r.message), r.data], [false, true, null], fn);
  }
  const html = gas.g.doGet({ parameter: {} }).getContent();
  const adminList = JSON.parse(html.match(/ADMIN_FUNCTIONS = (\[[\s\S]*?\])/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  assert.ok(adminList.includes('previewAttendanceRecalculation') && adminList.includes('applyAttendanceRecalculation'));
  assert.ok(!adminList.includes('recalculateThisMonth'), '管理者画面から確認なしの再計算はできない');
  const setup = fs.readFileSync(path.join(__dirname, '../leaf-portal/gas/Setup.gs'), 'utf8');
  assert.ok(!/addItem\([^)]*recalculateThisMonth/.test(setup), 'メニューにも出さない');
  assert.ok(!/id="btnRecalc"/.test(html));
});

// ============================================================ 社労士向けの出力

test('社労士向けの出力：未再計算の印は備考・要確認の理由に入れず、完了メッセージで知らせる', () => {
  const gas = incident();
  asAdmin(gas);
  const csv = gas.g.exportSharoushiDetailCsv('2026-10');
  assert.equal(csv.success, true, csv.message);
  assert.ok(!csv.data.csv.includes('未再計算'));
  assert.match(csv.message, /注意：設定変更後に未再計算の記録が 1件あります/);
  const xlsx = gas.g.exportSharoushiTimecardXlsx('2026-10');
  assert.equal(xlsx.success, true, xlsx.message);
  const text = unzipText(Buffer.from(xlsx.data.base64, 'base64'));
  assert.match(text, /大森紗智子/, 'ZIP を開けている');
  assert.ok(!text.includes('未再計算'), 'Excel の中にも入れない');
  assert.match(xlsx.message, /注意：設定変更後に未再計算の記録が 1件あります/);
});
