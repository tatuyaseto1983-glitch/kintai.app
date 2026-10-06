'use strict';
// 稟議申請のテスト：新規申請・承認・却下・自己承認・概算→確定金額（入力・訂正）・再承認・再承認却下・権限（サーバー側）。
// 既存の残業申請・休日出勤申請が同じスプレッドシートで今までどおり動くことも確認する。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const PRESIDENT = 'boss@example.com';   // E001 社長：管理者・自己承認可＝TRUE
const MANAGER = 'manager@example.com';  // E002 管理者（自己承認可なし）
const STAFF = 'staff@example.com';      // E005 一般
const OTHER = 'other@example.com';      // E006 一般
const LEAVE_ADMIN = 'leave@example.com'; // E007 管理者だが休職中
const NOW = '2026-10-06 10:00';

function office() {
  const gas = createLeafGas({ email: PRESIDENT });
  gas.g.setupSystem();
  const base = { '在籍状況': '在籍', '雇用区分': '正社員', '勤務区分': '固定勤務', '部署': '一般', '休日出勤申請対象': '対象', '有給申請対象': '対象' };
  gas.g.appendRecords_('スタッフマスタ', [
    { ...base, '社員ID': 'E001', '氏名': '光山大樹', 'メールアドレス': PRESIDENT, '権限': 'admin', '勤怠集計対象': '対象外', '自己承認可': 'TRUE' },
    { ...base, '社員ID': 'E002', '氏名': '管理太郎', 'メールアドレス': MANAGER, '権限': 'admin', '自己承認可': 'FALSE' },
    { ...base, '社員ID': 'E005', '氏名': '中津井祐貴', 'メールアドレス': STAFF, '権限': 'staff' },
    { ...base, '社員ID': 'E006', '氏名': '久保亜弓', 'メールアドレス': OTHER, '権限': 'staff' },
    { ...base, '社員ID': 'E007', '氏名': '休職管理', 'メールアドレス': LEAVE_ADMIN, '権限': 'admin', '在籍状況': '休職' },
  ]);
  gas.g.clearTableCache_();
  gas.setNow(NOW);
  return gas;
}
const as = (gas, email) => { gas.loginAs(email); gas.setNow(NOW); gas.g.clearTableCache_(); return gas.g; };
const input = (over) => ({ itemName: 'ダイニングチェア', quantity: '2', expenseType: '備品購入', purpose: 'ショールームの展示替え', certainty: '概算',
  amount: '100000', plannedDate: '2026-10-20', attachmentUrl: 'https://drive.google.com/file/d/abc/view', ...over });
function submit(gas, email, over) {
  const r = as(gas, email).submitRingiRequest(input(over));
  assert.equal(r.success, true, r.message);
  return r.data.ringiId;
}
const ok = (r) => { assert.equal(r.success, true, r.message); return r; };
const ng = (r, re) => { assert.equal(r.success, false, 'エラーになるはず：' + r.message); if (re) assert.match(r.message, re); return r; };
const row = (gas, id) => gas.main.rows('稟議管理').find((r) => r['稟議ID'] === id);
const history = (gas, id) => gas.main.rows('稟議_更新履歴').filter((r) => r['稟議ID'] === id);
const snapshot = (gas) => JSON.stringify(gas.main.sheets.map((s) => [s.getName(), s.data]));
/** 申請 → 承認（E002）まで */
function approved(gas, over) {
  const id = submit(gas, STAFF, over);
  ok(as(gas, MANAGER).approveRingiRequest(id));
  return id;
}

// ============================================================ 準備

test('setupSystem：「稟議管理」「稟議_更新履歴」シートを作り、スタッフマスタの右端に「自己承認可」（全員 FALSE）を足す。2回目は何も変えない', () => {
  const gas = createLeafGas({ email: PRESIDENT });
  gas.g.setupSystem();
  const staff = gas.main.getSheetByName('スタッフマスタ');
  // 「自己承認可」がない以前の形に戻して、社員を入れておく
  staff.data = staff.data.map((r) => r.slice(0, staff.data[0].length - 1));
  const h = staff.data[0];
  staff.data.push(h.map((c) => ({ '社員ID': 'E001', '氏名': '光山大樹', 'メールアドレス': PRESIDENT, '権限': 'admin', '在籍状況': '在籍' }[c] || '')));
  staff.data.push(h.map((c) => ({ '社員ID': 'E005', '氏名': '中津井祐貴', 'メールアドレス': STAFF, '権限': 'staff', '在籍状況': '在籍' }[c] || '')));
  gas.g.clearTableCache_();
  const log = gas.g.setupSystem();
  assert.match(log, /スタッフマスタ：足りない列を右端に追加しました（自己承認可）。自己承認可の初期値を入れました（全員 FALSE/);
  assert.deepEqual(gas.main.rows('スタッフマスタ').map((r) => r['自己承認可']), ['FALSE', 'FALSE']);
  assert.deepEqual(gas.main.getSheetByName('稟議管理').data[0], ['稟議ID', '申請日時', '申請者メール', '申請者名', '社員ID', '購入品名', '購入数量', '経費種別',
    '支出理由・目的', '金額の確度', '申請金額', '支出予定日', '添付資料URL', '申請状態', '承認者', '承認者メール', '承認日時', '却下理由', '確定金額',
    '確定金額入力者', '確定金額入力者メール', '確定金額入力日時', '概算との差額', '再承認要否', '再承認者', '再承認者メール', '再承認日時', '最終更新日時', '却下区分']);
  assert.ok(gas.main.getSheetByName('稟議_更新履歴'));
  const before = snapshot(gas);
  gas.g.setupSystem();
  assert.equal(snapshot(gas), before, '2回目は何も変わらない');
});

// ============================================================ 新規申請

test('新規申請：申請者（申請日・メール・氏名・社員ID）はログイン情報から自動。画面から送られた社員ID・氏名・メールは使わない。申請中で履歴に「申請」', () => {
  const gas = office();
  const r = ok(as(gas, STAFF).submitRingiRequest(input({ employeeId: 'E001', applicantName: '光山大樹', email: PRESIDENT })));
  assert.match(r.data.ringiId, /^RG-20261006100000-E005$/);
  const x = row(gas, r.data.ringiId);
  assert.deepEqual([x['申請日時'], x['申請者メール'], x['申請者名'], x['社員ID']], ['2026-10-06 10:00:00', STAFF, '中津井祐貴', 'E005']);
  assert.deepEqual([x['購入品名'], x['購入数量'], x['経費種別'], x['支出理由・目的'], x['金額の確度'], x['申請金額'], x['支出予定日'], x['添付資料URL'], x['申請状態']],
    ['ダイニングチェア', 2, '備品購入', 'ショールームの展示替え', '概算', 100000, '2026-10-20', 'https://drive.google.com/file/d/abc/view', '申請中']);
  assert.deepEqual(history(gas, r.data.ringiId).map((h) => [h['操作'], h['操作者'], h['変更後の申請状態']]), [['申請', '中津井祐貴', '申請中']]);
  // 同じ秒にもう1件 → 稟議IDは重ならない
  const second = ok(as(gas, STAFF).submitRingiRequest(input({ certainty: '確定' }))).data.ringiId;
  assert.equal(second, 'RG-20261006100000-E005-2');
  // 自分の申請だけが一覧に出る
  submit(gas, OTHER);
  const mine = ok(as(gas, STAFF).getMyRingiRequests()).data;
  assert.deepEqual(mine.requests.map((v) => v.employeeId), ['E005', 'E005']);
  assert.ok(!JSON.stringify(mine).includes(STAFF), '一覧にメールアドレスは出さない');
  assert.deepEqual(mine.expenseTypes, ['備品購入', '旅費交通費', '接待交際費', '研修費', '広告宣伝費', '雑費', 'その他']);
});

test('新規申請：入力チェック（数量は1以上の整数・金額は1〜1億の整数・確度は確定/概算・経費種別・URLは https://・支出予定日は過去も可）', () => {
  const gas = office();
  const g = as(gas, STAFF);
  for (const [over, re] of [
    [{ itemName: '' }, /購入品名を入力/], [{ quantity: '0' }, /購入数量は 1〜/], [{ quantity: '1.5' }, /購入数量は数字だけ/], [{ quantity: '' }, /購入数量は数字だけ/],
    [{ expenseType: '消耗品' }, /経費種別は/], [{ purpose: ' ' }, /支出理由・目的を入力/], [{ certainty: '未定' }, /金額の確度は/],
    [{ amount: '1,000' }, /数字だけ/], [{ amount: '1000円' }, /数字だけ/], [{ amount: '１０００' }, /数字だけ/], [{ amount: '-1' }, /数字だけ/],
    [{ amount: '0' }, /1〜100,000,000/], [{ amount: '100000001' }, /1〜100,000,000/], [{ plannedDate: '' }, /支出予定日/],
    [{ attachmentUrl: 'http://example.com/a' }, /https:\/\//], [{ attachmentUrl: 'javascript:alert(1)' }, /https:\/\//],
  ]) ng(g.submitRingiRequest(input(over)), re);
  assert.equal(gas.main.rows('稟議管理').length, 0, '何も保存しない');
  ok(g.submitRingiRequest(input({ amount: '1', plannedDate: '2026-09-01', attachmentUrl: '' })));
  ok(g.submitRingiRequest(input({ amount: '100000000' })));
});

// ============================================================ 承認・却下

test('通常承認：在籍中の管理者が承認 → 承認済。承認者・承認者メール・承認日時を自動記録', () => {
  const gas = office();
  const id = submit(gas, STAFF);
  const r = ok(as(gas, MANAGER).approveRingiRequest(id));
  assert.equal(r.data.status, '承認済');
  const x = row(gas, id);
  assert.deepEqual([x['申請状態'], x['承認者'], x['承認者メール'], x['承認日時'], x['却下理由']], ['承認済', '管理太郎', MANAGER, '2026-10-06 10:00:00', '']);
  assert.deepEqual(history(gas, id).map((h) => h['操作']), ['申請', '承認']);
  ng(as(gas, MANAGER).approveRingiRequest(id), /「申請中」ではない/);
});

test('通常却下：却下理由は必須。却下・却下区分＝通常却下。履歴に「却下」', () => {
  const gas = office();
  const id = submit(gas, STAFF);
  ng(as(gas, MANAGER).rejectRingiRequest(id, '  '), /却下理由を入力/);
  assert.equal(row(gas, id)['申請状態'], '申請中');
  ok(as(gas, MANAGER).rejectRingiRequest(id, '予算超過のため'));
  const x = row(gas, id);
  assert.deepEqual([x['申請状態'], x['却下理由'], x['却下区分'], x['承認者']], ['却下', '予算超過のため', '通常却下', '管理太郎']);
  assert.deepEqual(history(gas, id).map((h) => [h['操作'], h['理由・備考']]), [['申請', '申請金額 100,000円（概算）'], ['却下', '却下理由：予算超過のため']]);
  ng(as(gas, STAFF).enterRingiFinalAmount(id, '90000'), /「承認済」「再承認待ち」/);
});

// ============================================================ 自己承認

test('自己承認不可：自己承認可でない管理者は、自分の稟議を承認・却下できない（ほかの管理者・社長は処理できる）', () => {
  const gas = office();
  const id = submit(gas, MANAGER);
  ng(as(gas, MANAGER).approveRingiRequest(id), /自分の稟議は承認・却下できません/);
  ng(as(gas, MANAGER).rejectRingiRequest(id, 'x'), /自分の稟議は承認・却下できません/);
  assert.equal(row(gas, id)['申請状態'], '申請中');
  const dash = ok(as(gas, MANAGER).getAdminDashboard({ parts: ['ringi'] })).data.ringi;
  const v = dash.pending.find((x) => x.ringiId === id);
  assert.deepEqual([v.canDecide, v.selfBlocked], [false, true], '画面にも承認ボタンを出さない（表示は目安）');
  ok(as(gas, PRESIDENT).approveRingiRequest(id));
  assert.equal(row(gas, id)['承認者'], '光山大樹');
});

test('社長のみ自己承認可：自己承認可＝TRUE（文字・チェックボックスどちらでも）の管理者は自分の稟議を承認できる。FALSE に戻すとできない', () => {
  const gas = office();
  const id = submit(gas, PRESIDENT);
  const v = ok(as(gas, PRESIDENT).getAdminDashboard({ parts: ['ringi'] })).data.ringi.pending.find((x) => x.ringiId === id);
  assert.equal(v.canDecide, true);
  ok(as(gas, PRESIDENT).approveRingiRequest(id));
  assert.deepEqual([row(gas, id)['申請状態'], row(gas, id)['承認者']], ['承認済', '光山大樹']);
  // チェックボックス（true）でも可
  const staffSheet = gas.main.getSheetByName('スタッフマスタ');
  const col = staffSheet.data[0].indexOf('自己承認可');
  staffSheet.data[1][col] = true;
  const id2 = submit(gas, PRESIDENT);
  ok(as(gas, PRESIDENT).approveRingiRequest(id2));
  // FALSE にすると自分の稟議は処理できない（毎回スタッフマスタを読み直す）
  staffSheet.data[1][col] = 'FALSE';
  const id3 = submit(gas, PRESIDENT);
  ng(as(gas, PRESIDENT).approveRingiRequest(id3), /自分の稟議は承認・却下できません/);
  // 一般社員に TRUE を入れても、管理者でなければ承認できない
  staffSheet.data[3][col] = 'TRUE';
  const id4 = submit(gas, STAFF);
  ng(as(gas, STAFF).approveRingiRequest(id4), /管理者権限がありません/);
});

// ============================================================ 概算・確定金額

test('概算申請・確定金額入力：承認後に本人が入力。概算以下なら承認済のまま・再承認要否＝不要・差額＝確定−申請。申請金額は変えない', () => {
  const gas = office();
  const id = submit(gas, STAFF);
  ng(as(gas, STAFF).enterRingiFinalAmount(id, '90000'), /「承認済」「再承認待ち」/, '承認前は入力できない');
  ok(as(gas, MANAGER).approveRingiRequest(id));
  ng(as(gas, STAFF).enterRingiFinalAmount(id, '90,000'), /数字だけ/);
  const r = ok(as(gas, STAFF).enterRingiFinalAmount(id, '90000'));
  assert.match(r.message, /確定金額を入力しました（90,000円・差額 -10,000円）。申請金額以下のため「承認済」です/);
  const x = row(gas, id);
  assert.deepEqual([x['申請金額'], x['確定金額'], x['確定金額入力者'], x['確定金額入力者メール'], x['確定金額入力日時'], x['概算との差額'], x['再承認要否'], x['申請状態']],
    [100000, 90000, '中津井祐貴', STAFF, '2026-10-06 10:00:00', -10000, '不要', '承認済']);
  // 金額が同じ（＝申請金額ちょうど）も再承認不要
  const id2 = approved(gas);
  ok(as(gas, STAFF).enterRingiFinalAmount(id2, '100000'));
  assert.deepEqual([row(gas, id2)['概算との差額'], row(gas, id2)['再承認要否'], row(gas, id2)['申請状態']], [0, '不要', '承認済']);
  // 「確定」の稟議には確定金額を入力しない
  const fixed = approved(gas, { certainty: '確定' });
  ng(as(gas, STAFF).enterRingiFinalAmount(fixed, '100000'), /「概算」の稟議だけ/);
});

test('確定金額訂正：入力済みでも本人・管理者が訂正でき、変更前・変更後の金額・変更者・日時を履歴に残す。同じ金額はエラー', () => {
  const gas = office();
  const id = approved(gas);
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '90000'));
  gas.setNow('2026-10-07 15:30');
  gas.loginAs(MANAGER); gas.g.clearTableCache_();
  const r = ok(gas.g.enterRingiFinalAmount(id, '95000', '請求書で確認'));
  assert.match(r.message, /確定金額を訂正しました（95,000円・差額 -5,000円）/);
  const x = row(gas, id);
  assert.deepEqual([x['確定金額'], x['確定金額入力者'], x['確定金額入力者メール'], x['確定金額入力日時'], x['申請金額']], [95000, '管理太郎', MANAGER, '2026-10-07 15:30:00', 100000]);
  const h = history(gas, id).filter((y) => /確定金額/.test(y['操作']));
  assert.deepEqual(h.map((y) => [y['操作'], y['変更前の確定金額'], y['変更後の確定金額'], y['操作者'], y['操作者メール'], y['日時']]), [
    ['確定金額入力', '', 90000, '中津井祐貴', STAFF, '2026-10-06 10:00:00'],
    ['確定金額訂正', 90000, 95000, '管理太郎', MANAGER, '2026-10-07 15:30:00'],
  ]);
  assert.match(h[1]['理由・備考'], /請求書で確認/);
  ng(as(gas, STAFF).enterRingiFinalAmount(id, '95000'), /今と同じ/);
});

test('概算超過への訂正：1円でも申請金額を超えたら 再承認要否＝要・再承認待ち。概算以下への訂正：承認済に戻る（再承認待ちの間も訂正できる）', () => {
  const gas = office();
  const id = approved(gas);
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '90000'));
  const over = ok(as(gas, STAFF).enterRingiFinalAmount(id, '100001'));
  assert.match(over.message, /差額 \+1円）。申請金額を超えたため「再承認待ち」/);
  assert.deepEqual([row(gas, id)['申請状態'], row(gas, id)['再承認要否'], row(gas, id)['概算との差額']], ['再承認待ち', '要', 1]);
  // 再承認待ちの間に、概算以下へ訂正 → 承認済・不要
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '99999'));
  assert.deepEqual([row(gas, id)['申請状態'], row(gas, id)['再承認要否'], row(gas, id)['概算との差額']], ['承認済', '不要', -1]);
  // もう一度超える → 再承認待ち
  ok(as(gas, MANAGER).enterRingiFinalAmount(id, '120000'));
  assert.deepEqual([row(gas, id)['申請状態'], row(gas, id)['再承認要否']], ['再承認待ち', '要']);
  assert.deepEqual(history(gas, id).map((h) => [h['操作'], h['変更前の申請状態'], h['変更後の申請状態']]), [
    ['申請', '', '申請中'], ['承認', '申請中', '承認済'], ['確定金額入力', '承認済', '承認済'], ['確定金額訂正', '承認済', '再承認待ち'],
    ['確定金額訂正', '再承認待ち', '承認済'], ['確定金額訂正', '承認済', '再承認待ち'],
  ]);
  assert.equal(row(gas, id)['申請金額'], 100000, '申請金額は書き換えない');
});

// ============================================================ 再承認

test('再承認：管理者だけ。再承認済・再承認者・メール・日時を保存。自己再承認は自己承認可の人だけ', () => {
  const gas = office();
  const id = approved(gas);
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '130000'));
  ng(as(gas, STAFF).reapproveRingiRequest(id), /管理者権限がありません/);
  ng(as(gas, MANAGER).approveRingiRequest(id), /「申請中」ではない/, '再承認待ちは通常の承認では処理しない');
  const r = ok(as(gas, MANAGER).reapproveRingiRequest(id));
  assert.equal(r.data.status, '再承認済');
  const x = row(gas, id);
  assert.deepEqual([x['申請状態'], x['再承認者'], x['再承認者メール'], x['再承認日時'], x['承認者']], ['再承認済', '管理太郎', MANAGER, '2026-10-06 10:00:00', '管理太郎']);
  assert.equal(history(gas, id).slice(-1)[0]['操作'], '再承認');
  // 自分の稟議の再承認：自己承認可でない管理者は不可、社長は可
  const own = submit(gas, MANAGER);
  ok(as(gas, PRESIDENT).approveRingiRequest(own));
  ok(as(gas, MANAGER).enterRingiFinalAmount(own, '150000'));
  ng(as(gas, MANAGER).reapproveRingiRequest(own), /自分の稟議は承認・却下できません/);
  ng(as(gas, MANAGER).rejectRingiReapproval(own, 'x'), /自分の稟議は承認・却下できません/);
  const boss = submit(gas, PRESIDENT);
  ok(as(gas, PRESIDENT).approveRingiRequest(boss));
  ok(as(gas, PRESIDENT).enterRingiFinalAmount(boss, '150000'));
  ok(as(gas, PRESIDENT).reapproveRingiRequest(boss));
  assert.equal(row(gas, boss)['申請状態'], '再承認済');
});

test('再承認却下：却下理由は必須。申請状態＝却下・却下区分＝再承認却下（通常の却下と区別）。履歴は「再承認却下」。承認の記録は残す', () => {
  const gas = office();
  const id = approved(gas);
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '130000'));
  ng(as(gas, MANAGER).rejectRingiReapproval(id, ''), /却下理由を入力/);
  ng(as(gas, MANAGER).rejectRingiRequest(id, '超過'), /「申請中」ではない/);
  ok(as(gas, MANAGER).rejectRingiReapproval(id, '超過分は認められません'));
  const x = row(gas, id);
  assert.deepEqual([x['申請状態'], x['却下区分'], x['却下理由'], x['再承認者'], x['承認者'], x['承認日時'], x['確定金額']],
    ['却下', '再承認却下', '超過分は認められません', '管理太郎', '管理太郎', '2026-10-06 10:00:00', 130000]);
  assert.deepEqual(history(gas, id).slice(-1).map((h) => [h['操作'], h['変更前の申請状態'], h['変更後の申請状態']]), [['再承認却下', '再承認待ち', '却下']]);
  ng(as(gas, STAFF).enterRingiFinalAmount(id, '100000'), /「承認済」「再承認待ち」/, '却下のあとは確定金額を変えられない');
  const detail = ok(as(gas, STAFF).getRingiRequestDetail(id)).data;
  assert.equal(detail.rejectKind, '再承認却下');
});

test('再承認済後の金額変更不可：本人も管理者も確定金額を変えられない', () => {
  const gas = office();
  const id = approved(gas);
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '130000'));
  ok(as(gas, MANAGER).reapproveRingiRequest(id));
  const before = snapshot(gas);
  ng(as(gas, STAFF).enterRingiFinalAmount(id, '100000'), /再承認済みのため、確定金額は変更できません/);
  ng(as(gas, PRESIDENT).enterRingiFinalAmount(id, '140000'), /再承認済みのため/);
  assert.equal(snapshot(gas), before);
  assert.equal(ok(as(gas, STAFF).getRingiRequestDetail(id)).data.canEnterFinalAmount, false);
});

// ============================================================ 権限（サーバー側）

test('一般社員による不正承認防止：画面を通さず関数を直接呼んでも、承認・却下・再承認・再承認却下はできない（休職中の管理者も不可）', () => {
  const gas = office();
  const id = submit(gas, STAFF);
  const over = approved(gas);
  ok(as(gas, STAFF).enterRingiFinalAmount(over, '200000'));
  const before = snapshot(gas);
  for (const email of [STAFF, OTHER, LEAVE_ADMIN]) {
    const g = as(gas, email);
    for (const [fn, args] of [['approveRingiRequest', [id]], ['rejectRingiRequest', [id, 'x']], ['reapproveRingiRequest', [over]], ['rejectRingiReapproval', [over, 'x']]]) {
      const r = g[fn](...args);
      assert.deepEqual([r.success, /管理者権限がありません/.test(r.message), r.data], [false, true, null], email + ' ' + fn);
    }
    const dash = g.getAdminDashboard({ parts: ['ringi'] });
    if (email === LEAVE_ADMIN) {
      // 休職中の管理者が管理者画面を開けるのは既存の動き（requireAdmin は権限だけを見る）。稟議の承認ボタンは出さない
      assert.ok(dash.data.ringi.pending.every((v) => !v.canDecide) && dash.data.ringi.reapproval.every((v) => !v.canReapprove));
    } else {
      assert.equal(dash.success, false, email + ' は管理者画面のデータも取れない');
    }
  }
  assert.equal(snapshot(gas), before, 'シートは変わらない');
  // 画面側：スタッフ画面から呼べる関数に承認系は入っていない。サーバー側はすべての承認系で requireRingiApprover_ を通す
  const html = gas.g.doGet({ parameter: {} }).getContent();
  const staffFns = JSON.parse(html.match(/RINGI_FUNCTIONS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  assert.deepEqual(staffFns, ['getMyRingiRequests', 'submitRingiRequest', 'getRingiRequestDetail', 'enterRingiFinalAmount']);
  const src = fs.readFileSync(path.join(__dirname, '../leaf-portal/gas/RingiService.gs'), 'utf8');
  const decide = src.slice(src.indexOf('function decideRingi_('), src.indexOf('\n}\n', src.indexOf('function decideRingi_(')));
  assert.match(decide, /const admin = requireRingiApprover_\(\);/);
});

test('一般社員による他人の確定金額変更防止：他人の稟議は確定金額を変えられず、詳細も見られない（存在も返さない）', () => {
  const gas = office();
  const id = approved(gas);
  const before = snapshot(gas);
  ng(as(gas, OTHER).enterRingiFinalAmount(id, '90000'), /稟議が見つかりません/);
  ng(as(gas, OTHER).getRingiRequestDetail(id), /稟議が見つかりません/);
  assert.equal(ok(as(gas, OTHER).getMyRingiRequests()).data.requests.length, 0);
  assert.equal(snapshot(gas), before);
  // 管理者は他人の稟議の確定金額を入力できる
  ok(as(gas, MANAGER).enterRingiFinalAmount(id, '90000'));
  assert.equal(row(gas, id)['確定金額入力者'], '管理太郎');
});

test('管理者画面：申請中・再承認待ちの一覧（稟議ID・申請日・申請者名・購入品名・申請金額・金額の確度・申請状態）と処理済み', () => {
  const gas = office();
  const p = submit(gas, STAFF, { itemName: '照明' });
  const r = approved(gas, { itemName: 'カーテン' });
  ok(as(gas, STAFF).enterRingiFinalAmount(r, '150000'));
  const done = approved(gas, { itemName: 'スツール', certainty: '確定' });
  const d = ok(as(gas, MANAGER).getAdminDashboard({ parts: ['ringi'] })).data.ringi;
  assert.deepEqual([d.pendingCount, d.reapprovalCount], [1, 1]);
  const v = d.pending[0];
  assert.deepEqual([v.ringiId, v.requestDate, v.applicantName, v.itemName, v.amount, v.certainty, v.status, v.canDecide], [p, '2026-10-06', '中津井祐貴', '照明', 100000, '概算', '申請中', true]);
  assert.deepEqual([d.reapproval[0].ringiId, d.reapproval[0].status, d.reapproval[0].canReapprove, d.reapproval[0].diff], [r, '再承認待ち', true, 50000]);
  assert.deepEqual(d.processed.map((x) => x.ringiId), [done]);
});

// ============================================================ 既存機能

test('既存の残業申請・休日出勤申請は今までどおり（申請・承認・自分の申請の承認禁止）', () => {
  const gas = office();
  submit(gas, STAFF);
  const ot = ok(as(gas, STAFF).submitOvertimeRequest({ targetDate: '2026-10-07', plannedStart: '18:30', plannedEnd: '20:00', reason: '現場対応' }));
  ok(as(gas, MANAGER).approveOvertimeRequest(ot.data.requestId));
  assert.equal(gas.main.rows('残業申請')[0]['ステータス'], '承認済み');
  const hw = ok(as(gas, STAFF).submitHolidayWorkRequest({ workDate: '2026-10-11', plannedStart: '09:00', plannedEnd: '17:00', reason: '立ち会い', content: '検査',
    compDayType: '未定', compDayDate: '', note: '', site: '' }));
  ok(as(gas, MANAGER).approveHolidayWorkRequest(hw.data.requestId));
  assert.equal(gas.main.rows('休日出勤申請')[0]['ステータス'], '承認済み');
  const own = ok(as(gas, MANAGER).submitHolidayWorkRequest({ workDate: '2026-10-12', plannedStart: '09:00', plannedEnd: '17:00', reason: 'x', content: 'x',
    compDayType: '未定', compDayDate: '', note: '', site: '' }));
  ng(as(gas, MANAGER).approveHolidayWorkRequest(own.data.requestId), /自分の休日出勤申請は承認・却下できません/);
  ok(as(gas, PRESIDENT).approveHolidayWorkRequest(own.data.requestId)); // ほかの管理者の申請としては承認できる（今までどおり）
  assert.equal(gas.main.rows('休日出勤申請').find((x) => x['申請ID'] === own.data.requestId)['ステータス'], '承認済み');
  // 社長（自己承認可＝TRUE）でも、自分の休日出勤申請は今までどおり承認できない（自己承認可は稟議だけのルール）
  const bossHw = ok(as(gas, PRESIDENT).submitHolidayWorkRequest({ workDate: '2026-10-13', plannedStart: '09:00', plannedEnd: '17:00', reason: 'x', content: 'x',
    compDayType: '未定', compDayDate: '', note: '', site: '' }));
  ng(as(gas, PRESIDENT).approveHolidayWorkRequest(bossHw.data.requestId), /自分の休日出勤申請は承認・却下できません/);
});
