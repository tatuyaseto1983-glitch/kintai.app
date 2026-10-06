'use strict';
// 各種申請（残業・有給休暇・休日出勤・稟議）のメール通知のテスト（NotificationService.gs）。
// 宛先はスタッフマスタ（在籍・権限＝admin）から、送るのは保存の後、送信に失敗しても申請・承認は成功のまま。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const BOSS = 'boss@example.com';       // E001 管理者（社長・自己承認可）
const MANAGER = 'manager@example.com'; // E002 管理者
const STAFF = 'staff@example.com';     // E005 一般
const LEAVE = 'leave@example.com';     // E007 管理者だが休職中（通知しない）
const NOW = '2026-10-06 10:00';

function office() {
  const gas = createLeafGas({ email: BOSS });
  gas.g.setupSystem();
  const base = { '在籍状況': '在籍', '雇用区分': '正社員', '勤務区分': '固定勤務', '部署': '一般', '休日出勤申請対象': '対象', '有給申請対象': '対象' };
  gas.g.appendRecords_('スタッフマスタ', [
    { ...base, '社員ID': 'E001', '氏名': '光山大樹', 'メールアドレス': BOSS, '権限': 'admin', '自己承認可': 'TRUE' },
    { ...base, '社員ID': 'E002', '氏名': '管理太郎', 'メールアドレス': MANAGER, '権限': 'admin' },
    { ...base, '社員ID': 'E005', '氏名': '中津井祐貴', 'メールアドレス': STAFF, '権限': 'staff' },
    { ...base, '社員ID': 'E007', '氏名': '休職管理', 'メールアドレス': LEAVE, '権限': 'admin', '在籍状況': '休職' },
  ]);
  gas.g.clearTableCache_();
  gas.setNow(NOW);
  gas.clearMails();
  // console.error を記録する（送信エラーのログを確かめる）
  gas.eval('var __errors = []; console.error = function (m) { __errors.push(String(m)); };');
  return gas;
}
const as = (gas, email) => { gas.loginAs(email); gas.setNow(NOW); return gas.g; };
const ok = (r) => { assert.equal(r.success, true, r.message); return r; };
const mailsTo = (gas, to) => gas.mails.filter((m) => m.to === to);
const errors = (gas) => gas.eval('__errors');
const setSetting = (gas, key, value) => { gas.main.getSheetByName('設定').data.find((r) => r[0] === key)[1] = value; gas.g.clearTableCache_(); };
const overtime = { targetDate: '2026-10-07', plannedStart: '18:30', plannedEnd: '20:00', reason: '現場対応' };
const holiday = { workDate: '2026-10-11', plannedStart: '09:00', plannedEnd: '17:00', reason: '立ち会い', content: '配筋検査', compDayType: '未定', compDayDate: '', note: '', site: '堺市○○様邸' };
const ringi = { itemName: 'ダイニングチェア', quantity: '2', expenseType: '備品購入', purpose: '展示替え', certainty: '概算', amount: '100000', plannedDate: '2026-10-20', attachmentUrl: '' };

// ============================================================ 申請時

test('残業申請：申請時は管理者（在籍・admin）へ「新しい申請」、本人へ「受け付けました」。休職中の管理者・一般社員には送らない', () => {
  const gas = office();
  ok(as(gas, STAFF).submitOvertimeRequest(overtime));
  assert.deepEqual(gas.mails.map((m) => m.to).sort(), [BOSS, MANAGER, STAFF].sort());
  assert.equal(mailsTo(gas, LEAVE).length, 0, '休職中の管理者には送らない');
  const admin = mailsTo(gas, MANAGER)[0];
  assert.equal(admin.subject, '【Leaf Co.,Ltd. 社内ポータル】新しい残業申請が届きました（中津井祐貴・10/7 18:30〜20:00）');
  assert.match(admin.body, /^管理太郎 さん\n\n中津井祐貴 さんから残業申請が届きました。管理者画面で承認・却下してください。/);
  assert.match(admin.body, /申請ID：OT-20261006100000-E005\n申請者：中津井祐貴（E005）\n対象日：2026-10-07\n予定：18:30〜20:00（予定残業 01:30）\n申請理由：現場対応/);
  assert.match(admin.body, /ポータルを開く：https:\/\/script\.google\.com\/.+\/exec/);
  const receipt = mailsTo(gas, STAFF)[0];
  assert.equal(receipt.subject, '【Leaf Co.,Ltd. 社内ポータル】残業申請を受け付けました（10/7 18:30〜20:00）');
  assert.match(receipt.body, /残業申請を受け付けました。管理者の承認をお待ちください。/);
  assert.equal(admin.name, 'Leaf Co.,Ltd. 社内ポータル');
});

test('管理者が申請した場合：本人には受付の通知、管理者への通知はほかの管理者だけ（自分には「新しい申請」を送らない）', () => {
  const gas = office();
  ok(as(gas, MANAGER).submitHolidayWorkRequest(holiday));
  assert.deepEqual(gas.mails.map((m) => [m.to, /新しい休日出勤申請/.test(m.subject) ? '管理者へ' : '受付']).sort(), [[BOSS, '管理者へ'], [MANAGER, '受付']]);
});

test('管理者宛の通知先はスタッフマスタから：管理者を増やす・メールを変える・退職にすると、コードを変えずに宛先が変わる', () => {
  const gas = office();
  const sheet = gas.main.getSheetByName('スタッフマスタ');
  const h = sheet.data[0];
  sheet.data.push(h.map((c) => ({ '社員ID': 'E009', '氏名': '新管理', 'メールアドレス': 'new-admin@example.com', '権限': 'admin', '在籍状況': '在籍' }[c] || '')));
  sheet.data.find((r) => r[0] === 'E002')[h.indexOf('メールアドレス')] = 'manager2@example.com';
  sheet.data.find((r) => r[0] === 'E001')[h.indexOf('在籍状況')] = '退職';
  gas.g.clearTableCache_();
  ok(as(gas, STAFF).submitPaidLeaveRequest({ date: '2026-10-08', leaveType: '1日有給', reason: '私用' }));
  assert.deepEqual(gas.mails.filter((m) => /新しい/.test(m.subject)).map((m) => m.to).sort(), ['manager2@example.com', 'new-admin@example.com']);
  const src = fs.readFileSync(path.join(__dirname, '../leaf-portal/gas/NotificationService.gs'), 'utf8');
  assert.ok(!/['"][^'"\s]+@[^'"\s]+['"]/.test(src), 'NotificationService.gs にメールアドレスを書いていない');
});

// ============================================================ 承認・却下

test('残業・有給・休日出勤：承認は本人へ「承認されました」、却下は本人へ却下理由つき。管理者へは送らない', () => {
  const gas = office();
  const ot = ok(as(gas, STAFF).submitOvertimeRequest(overtime)).data.requestId;
  const pl = ok(as(gas, STAFF).submitPaidLeaveRequest({ date: '2026-10-08', leaveType: '午後半休', reason: '通院' })).data.requestId;
  const hw = ok(as(gas, STAFF).submitHolidayWorkRequest(holiday)).data.requestId;
  gas.clearMails();
  ok(as(gas, MANAGER).approveOvertimeRequest(ot));
  ok(as(gas, MANAGER).rejectPaidLeaveRequest(pl, '繁忙期のため別の日にしてください'));
  ok(as(gas, BOSS).approveHolidayWorkRequest(hw));
  assert.deepEqual(gas.mails.map((m) => m.to), [STAFF, STAFF, STAFF], '結果は申請者本人だけ');
  assert.deepEqual(gas.mails.map((m) => m.subject), [
    '【Leaf Co.,Ltd. 社内ポータル】残業申請が承認されました（10/7 18:30〜20:00）',
    '【Leaf Co.,Ltd. 社内ポータル】有給休暇申請が却下されました（10/8 午後半休）',
    '【Leaf Co.,Ltd. 社内ポータル】休日出勤申請が承認されました（10/11 09:00〜17:00）',
  ]);
  assert.match(gas.mails[0].body, /結果：承認\n処理した人：管理太郎/);
  assert.match(gas.mails[1].body, /結果：却下\n処理した人：管理太郎\n却下理由：繁忙期のため別の日にしてください/);
  assert.match(gas.mails[2].body, /現場：堺市○○様邸/);
  // 残業の却下にも理由
  const ot2 = ok(as(gas, STAFF).submitOvertimeRequest({ ...overtime, targetDate: '2026-10-09' })).data.requestId;
  gas.clearMails();
  ok(as(gas, MANAGER).rejectOvertimeRequest(ot2, '翌日に回してください'));
  assert.match(gas.mails[0].body, /却下理由：翌日に回してください/);
});

test('取り下げ・取消申請・取消の承認は今までどおり（メールは送らない）', () => {
  const gas = office();
  const hw = ok(as(gas, STAFF).submitHolidayWorkRequest(holiday)).data.requestId;
  const hw2 = ok(as(gas, STAFF).submitHolidayWorkRequest({ ...holiday, workDate: '2026-10-12' })).data.requestId;
  ok(as(gas, MANAGER).approveHolidayWorkRequest(hw2));
  gas.clearMails();
  ok(as(gas, STAFF).withdrawHolidayWorkRequest(hw));
  ok(as(gas, STAFF).requestHolidayWorkCancellation(hw2, '予定がなくなった'));
  ok(as(gas, MANAGER).approveHolidayWorkCancellation(hw2));
  assert.equal(gas.mails.length, 0);
});

// ============================================================ 稟議

test('稟議：申請・承認・却下・再承認待ち（管理者と本人）・再承認・再承認却下（理由つき）', () => {
  const gas = office();
  const id = ok(as(gas, STAFF).submitRingiRequest(ringi)).data.ringiId;
  assert.deepEqual(gas.mails.map((m) => m.subject.replace('【Leaf Co.,Ltd. 社内ポータル】', '')).sort(), [
    '新しい稟議申請が届きました（中津井祐貴・ダイニングチェア・100,000円）', '新しい稟議申請が届きました（中津井祐貴・ダイニングチェア・100,000円）',
    '稟議申請を受け付けました（ダイニングチェア・100,000円）'].sort());
  assert.match(mailsTo(gas, BOSS)[0].body, /稟議ID：RG-20261006100000-E005[\s\S]*金額の確度：概算\n申請金額（税込）：100,000円/);
  gas.clearMails();
  ok(as(gas, MANAGER).approveRingiRequest(id));
  assert.deepEqual(gas.mails.map((m) => [m.to, m.subject]), [[STAFF, '【Leaf Co.,Ltd. 社内ポータル】稟議申請が承認されました（ダイニングチェア・100,000円）']]);
  // 申請金額以下 → 通知なし
  gas.clearMails();
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '90000'));
  assert.equal(gas.mails.length, 0, '承認済のままなら通知しない');
  // 超過 → 再承認待ち：管理者（在籍・admin、申請者を除く）と申請者本人
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '120000'));
  assert.deepEqual(gas.mails.map((m) => m.to).sort(), [BOSS, MANAGER, STAFF].sort());
  assert.match(mailsTo(gas, MANAGER)[0].subject, /稟議の再承認が必要です（中津井祐貴・ダイニングチェア）/);
  assert.match(mailsTo(gas, MANAGER)[0].body, /確定金額（税込）：120,000円（差額 \+20,000円）/);
  assert.match(mailsTo(gas, STAFF)[0].subject, /稟議が再承認待ちになりました/);
  // 再承認待ちの間の訂正（超過のまま）→ もう一度は送らない
  gas.clearMails();
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '125000'));
  assert.equal(gas.mails.length, 0);
  ok(as(gas, MANAGER).reapproveRingiRequest(id));
  assert.deepEqual(gas.mails.map((m) => [m.to, m.subject]), [[STAFF, '【Leaf Co.,Ltd. 社内ポータル】稟議申請が再承認されました（ダイニングチェア・100,000円）']]);
  // 通常の却下・再承認の却下（理由つき）
  const id2 = ok(as(gas, STAFF).submitRingiRequest(ringi)).data.ringiId;
  const id3 = ok(as(gas, STAFF).submitRingiRequest({ ...ringi, itemName: '照明' })).data.ringiId;
  ok(as(gas, MANAGER).approveRingiRequest(id3));
  ok(as(gas, STAFF).enterRingiFinalAmount(id3, '100001'));
  gas.clearMails();
  ok(as(gas, MANAGER).rejectRingiRequest(id2, '予算外'));
  ok(as(gas, MANAGER).rejectRingiReapproval(id3, '超過分は認められません'));
  assert.deepEqual(gas.mails.map((m) => m.subject.replace('【Leaf Co.,Ltd. 社内ポータル】', '')), ['稟議申請が却下されました（ダイニングチェア・100,000円）', '稟議申請の再承認が却下されました（照明・100,000円）']);
  assert.match(gas.mails[0].body, /結果：却下[\s\S]*却下理由：予算外/);
  assert.match(gas.mails[1].body, /結果：再承認却下[\s\S]*却下理由：超過分は認められません/);
});

// ============================================================ 送るタイミング・失敗

test('送るのは保存の後：メールを送る時点で、申請・承認はシートに保存済み', () => {
  const gas = office();
  gas.eval(`var __seen = []; var __send = MailApp.sendEmail; MailApp.sendEmail = function (m) {
    clearTableCache_();
    const rows = readTable_('残業申請').records;
    __seen.push(rows.length + ':' + (rows[0] ? rows[0]['ステータス'] : ''));
    return __send(m);
  };`);
  const id = ok(as(gas, STAFF).submitOvertimeRequest(overtime)).data.requestId;
  ok(as(gas, MANAGER).approveOvertimeRequest(id));
  assert.deepEqual(gas.eval('__seen'), ['1:承認待ち', '1:承認待ち', '1:承認待ち', '1:承認済み']);
});

test('メール送信に失敗しても、申請・承認は成功のまま（保存される）。エラーはログに残す', () => {
  const gas = office();
  gas.failMails(true);
  const r = ok(as(gas, STAFF).submitRingiRequest(ringi));
  assert.match(r.message, /稟議を申請しました/);
  assert.equal(gas.main.rows('稟議管理').length, 1, '申請は保存されている');
  ok(as(gas, MANAGER).approveRingiRequest(r.data.ringiId));
  assert.equal(gas.main.rows('稟議管理')[0]['申請状態'], '承認済');
  const logs = errors(gas);
  assert.equal(logs.filter((l) => /メール通知の送信に失敗しました/.test(l)).length, 4, '申請3通＋承認1通の失敗をログに');
  assert.match(logs[0], /宛先：.+／件名：【Leaf Co.,Ltd. 社内ポータル】.+）：Service invoked too many times/);
});

test('申請・承認がエラーになったときは送らない（入力の間違い・権限なし・状態の違い）', () => {
  const gas = office();
  assert.equal(as(gas, STAFF).submitOvertimeRequest({ ...overtime, reason: '' }).success, false);
  const id = ok(as(gas, STAFF).submitOvertimeRequest(overtime)).data.requestId;
  gas.clearMails();
  assert.equal(as(gas, STAFF).approveOvertimeRequest(id).success, false, '一般社員は承認できない');
  assert.equal(as(gas, MANAGER).rejectOvertimeRequest(id, '').success, false, '却下理由がない');
  ok(as(gas, MANAGER).approveOvertimeRequest(id));
  gas.clearMails();
  assert.equal(as(gas, MANAGER).approveOvertimeRequest(id).success, false, '処理済み');
  assert.equal(gas.mails.length, 0);
});

// ============================================================ 設定

test('設定「メール通知＝送信しない」なら送らない。「送信先の上書き」はすべてその宛先へ（本来の宛先を本文に）。形式が違えば送らずにログ', () => {
  const gas = office();
  setSetting(gas, 'メール通知', '送信しない');
  ok(as(gas, STAFF).submitOvertimeRequest(overtime));
  assert.equal(gas.mails.length, 0);
  setSetting(gas, 'メール通知', '送信する');
  setSetting(gas, 'メール通知_送信先の上書き', 'Test-Box@example.com');
  ok(as(gas, STAFF).submitPaidLeaveRequest({ date: '2026-10-08', leaveType: '1日有給', reason: '私用' }));
  assert.deepEqual(gas.mails.map((m) => m.to), ['test-box@example.com', 'test-box@example.com', 'test-box@example.com']);
  assert.ok(gas.mails.some((m) => m.body.startsWith('（テスト用の送信先に送っています。本来の宛先：' + MANAGER + '）')));
  gas.clearMails();
  setSetting(gas, 'メール通知_送信先の上書き', 'テスト宛先');
  ok(as(gas, STAFF).submitHolidayWorkRequest(holiday));
  assert.equal(gas.mails.length, 0, '上書きの宛先が正しくないときは、実際の社員に誤って届かないよう送らない');
  assert.ok(errors(gas).some((l) => /メール通知_送信先の上書き」がメールアドレスの形式ではありません/.test(l)));
  assert.equal(gas.main.rows('休日出勤申請').length, 1, '申請は保存されている');
});

test('sendTestNotification（エディタから実行）：管理者だけ。自分宛にテストメールを1通', () => {
  const gas = office();
  const r = ok(as(gas, MANAGER).sendTestNotification());
  assert.match(r.message, /manager@example\.com 宛にテストメールを送りました/);
  assert.deepEqual(gas.mails.map((m) => [m.to, m.subject]), [[MANAGER, '【Leaf Co.,Ltd. 社内ポータル】メール通知のテスト']]);
  gas.clearMails();
  const ng = as(gas, STAFF).sendTestNotification();
  assert.deepEqual([ng.success, /管理者権限がありません/.test(ng.message), gas.mails.length], [false, true, 0]);
});
