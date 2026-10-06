'use strict';
// 申請者本人への結果メール（承認・却下・稟議の再承認・再承認却下）のテスト（NotificationService.gs）。
// メールは結果の通知だけ：申請の受付メール・管理者へのメールは送らない（管理者へは Google Chat。leaf-chat-notification.test.js）。
const test = require('node:test');
const assert = require('node:assert');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const BOSS = 'boss@example.com';       // E001 管理者（社長・自己承認可）
const MANAGER = 'manager@example.com'; // E002 管理者
const STAFF = 'staff@example.com';     // E005 一般
const NOW = '2026-10-06 10:00';

function office() {
  const gas = createLeafGas({ email: BOSS });
  gas.g.setupSystem();
  const base = { '在籍状況': '在籍', '雇用区分': '正社員', '勤務区分': '固定勤務', '部署': '一般', '休日出勤申請対象': '対象', '有給申請対象': '対象' };
  gas.g.appendRecords_('スタッフマスタ', [
    { ...base, '社員ID': 'E001', '氏名': '光山大樹', 'メールアドレス': BOSS, '権限': 'admin', '自己承認可': 'TRUE' },
    { ...base, '社員ID': 'E002', '氏名': '管理太郎', 'メールアドレス': MANAGER, '権限': 'admin' },
    { ...base, '社員ID': 'E005', '氏名': '中津井祐貴', 'メールアドレス': STAFF, '権限': 'staff' },
  ]);
  gas.setScriptProperty('GOOGLE_CHAT_WEBHOOK_URL', 'https://chat.googleapis.com/v1/spaces/TEST/messages?key=K&token=T');
  gas.g.clearTableCache_();
  gas.setNow(NOW);
  gas.clearMails();
  // console.error を記録する（送信エラーのログを確かめる）
  gas.eval('var __errors = []; console.error = function (m) { __errors.push(String(m)); };');
  return gas;
}
const as = (gas, email) => { gas.loginAs(email); gas.setNow(NOW); return gas.g; };
const ok = (r) => { assert.equal(r.success, true, r.message); return r; };
const errors = (gas) => gas.eval('__errors');
const setSetting = (gas, key, value) => { gas.main.getSheetByName('設定').data.find((r) => r[0] === key)[1] = value; gas.g.clearTableCache_(); };
const subjects = (gas) => gas.mails.map((m) => m.subject.replace('【Leaf Co.,Ltd. 社内ポータル】', ''));
const overtime = { targetDate: '2026-10-07', plannedStart: '18:30', plannedEnd: '20:00', reason: '現場対応' };
const holiday = { workDate: '2026-10-11', plannedStart: '09:00', plannedEnd: '17:00', reason: '立ち会い', content: '配筋検査', compDayType: '未定', compDayDate: '', note: '', site: '堺市○○様邸' };
const ringi = { itemName: 'ダイニングチェア', quantity: '2', expenseType: '備品購入', purpose: '展示替え', certainty: '概算', amount: '100000', plannedDate: '2026-10-20', attachmentUrl: '' };

test('申請時はメールを送らない（申請者への受付メール・管理者へのメールなし。管理者へは Google Chat）', () => {
  const gas = office();
  ok(as(gas, STAFF).submitOvertimeRequest(overtime));
  ok(as(gas, STAFF).submitPaidLeaveRequest({ date: '2026-10-08', leaveType: '1日有給', reason: '私用' }));
  ok(as(gas, STAFF).submitHolidayWorkRequest(holiday));
  ok(as(gas, STAFF).submitRingiRequest(ringi));
  ok(as(gas, MANAGER).submitHolidayWorkRequest({ ...holiday, workDate: '2026-10-12' })); // 管理者の申請でも同じ
  assert.equal(gas.mails.length, 0);
  assert.equal(gas.fetches.length, 5, '管理者へは Google Chat');
});

test('残業・有給・休日出勤：承認は本人へ「承認されました」、却下は本人へ却下理由つき。ほかの人には送らない', () => {
  const gas = office();
  const ot = ok(as(gas, STAFF).submitOvertimeRequest(overtime)).data.requestId;
  const pl = ok(as(gas, STAFF).submitPaidLeaveRequest({ date: '2026-10-08', leaveType: '午後半休', reason: '通院' })).data.requestId;
  const hw = ok(as(gas, STAFF).submitHolidayWorkRequest(holiday)).data.requestId;
  ok(as(gas, MANAGER).approveOvertimeRequest(ot));
  ok(as(gas, MANAGER).rejectPaidLeaveRequest(pl, '繁忙期のため別の日にしてください'));
  ok(as(gas, BOSS).approveHolidayWorkRequest(hw));
  assert.deepEqual(gas.mails.map((m) => m.to), [STAFF, STAFF, STAFF], '結果は申請者本人だけ');
  assert.deepEqual(subjects(gas), ['残業申請が承認されました（10/7 18:30〜20:00）', '有給休暇申請が却下されました（10/8 午後半休）', '休日出勤申請が承認されました（10/11 09:00〜17:00）']);
  assert.match(gas.mails[0].body, /^中津井祐貴 さん\n\n残業申請が承認されました。\n\n申請ID：OT-20261006100000-E005\n結果：承認\n処理した人：管理太郎\n対象日：2026-10-07/);
  assert.match(gas.mails[1].body, /結果：却下\n処理した人：管理太郎\n却下理由：繁忙期のため別の日にしてください/);
  assert.match(gas.mails[2].body, /現場：堺市○○様邸/);
  assert.match(gas.mails[0].body, /ポータルを開く：https:\/\/script\.google\.com\/.+\/exec/);
  assert.equal(gas.mails[0].name, 'Leaf Co.,Ltd. 社内ポータル');
  const ot2 = ok(as(gas, STAFF).submitOvertimeRequest({ ...overtime, targetDate: '2026-10-09' })).data.requestId;
  gas.clearMails();
  ok(as(gas, MANAGER).rejectOvertimeRequest(ot2, '翌日に回してください'));
  assert.match(gas.mails[0].body, /却下理由：翌日に回してください/);
});

test('稟議：承認・却下・再承認・再承認却下は本人へメール（却下は理由つき）。再承認待ちは本人にメールしない（管理者へ Chat）', () => {
  const gas = office();
  const id = ok(as(gas, STAFF).submitRingiRequest(ringi)).data.ringiId;
  ok(as(gas, MANAGER).approveRingiRequest(id));
  assert.deepEqual(gas.mails.map((m) => [m.to, m.subject]), [[STAFF, '【Leaf Co.,Ltd. 社内ポータル】稟議申請が承認されました（ダイニングチェア・100,000円）']]);
  assert.match(gas.mails[0].body, /稟議ID：RG-20261006100000-E005\n結果：承認[\s\S]*金額の確度：概算\n申請金額（税込）：100,000円/);
  gas.clearMails();
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '90000'));
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '120000')); // 再承認待ち
  assert.equal(gas.mails.length, 0, '確定金額の入力・再承認待ちではメールしない');
  ok(as(gas, MANAGER).reapproveRingiRequest(id));
  assert.deepEqual(subjects(gas), ['稟議申請が再承認されました（ダイニングチェア・100,000円）']);
  assert.match(gas.mails[0].body, /確定金額（税込）：120,000円（差額 \+20,000円）/);
  const id2 = ok(as(gas, STAFF).submitRingiRequest(ringi)).data.ringiId;
  const id3 = ok(as(gas, STAFF).submitRingiRequest({ ...ringi, itemName: '照明' })).data.ringiId;
  ok(as(gas, MANAGER).approveRingiRequest(id3));
  ok(as(gas, STAFF).enterRingiFinalAmount(id3, '100001'));
  gas.clearMails();
  ok(as(gas, MANAGER).rejectRingiRequest(id2, '予算外'));
  ok(as(gas, MANAGER).rejectRingiReapproval(id3, '超過分は認められません'));
  assert.deepEqual(subjects(gas), ['稟議申請が却下されました（ダイニングチェア・100,000円）', '稟議申請の再承認が却下されました（照明・100,000円）']);
  assert.match(gas.mails[0].body, /結果：却下[\s\S]*却下理由：予算外/);
  assert.match(gas.mails[1].body, /結果：再承認却下[\s\S]*却下理由：超過分は認められません/);
});

test('宛先はスタッフマスタの今のメールアドレス（社員IDで引く）。退職した人には送らない', () => {
  const gas = office();
  const a = ok(as(gas, STAFF).submitOvertimeRequest(overtime)).data.requestId;
  const b = ok(as(gas, STAFF).submitOvertimeRequest({ ...overtime, targetDate: '2026-10-09' })).data.requestId;
  const sheet = gas.main.getSheetByName('スタッフマスタ');
  const h = sheet.data[0];
  const row = sheet.data.find((r) => r[0] === 'E005');
  row[h.indexOf('メールアドレス')] = 'staff-new@example.com';
  gas.g.clearTableCache_();
  ok(as(gas, MANAGER).approveOvertimeRequest(a));
  assert.deepEqual(gas.mails.map((m) => m.to), ['staff-new@example.com']);
  row[h.indexOf('在籍状況')] = '退職';
  gas.g.clearTableCache_();
  gas.clearMails();
  ok(as(gas, MANAGER).approveOvertimeRequest(b));
  assert.equal(gas.mails.length, 0);
});

test('取り下げ・取消申請・取消の承認は今までどおり（通知しない）', () => {
  const gas = office();
  const hw = ok(as(gas, STAFF).submitHolidayWorkRequest(holiday)).data.requestId;
  const hw2 = ok(as(gas, STAFF).submitHolidayWorkRequest({ ...holiday, workDate: '2026-10-12' })).data.requestId;
  ok(as(gas, MANAGER).approveHolidayWorkRequest(hw2));
  gas.clearMails(); gas.clearFetches();
  ok(as(gas, STAFF).withdrawHolidayWorkRequest(hw));
  ok(as(gas, STAFF).requestHolidayWorkCancellation(hw2, '予定がなくなった'));
  ok(as(gas, MANAGER).approveHolidayWorkCancellation(hw2));
  assert.deepEqual([gas.mails.length, gas.fetches.length], [0, 0]);
});

test('送るのは保存の後：結果メールを送る時点で、承認はシートに保存済み', () => {
  const gas = office();
  gas.eval(`var __seen = []; var __send = MailApp.sendEmail; MailApp.sendEmail = function (m) {
    clearTableCache_(); __seen.push(readTable_('残業申請').records[0]['ステータス']); return __send(m); };`);
  const id = ok(as(gas, STAFF).submitOvertimeRequest(overtime)).data.requestId;
  ok(as(gas, MANAGER).approveOvertimeRequest(id));
  assert.deepEqual(gas.eval('__seen'), ['承認済み']);
});

test('メール送信に失敗しても承認・却下は成功のまま（保存される）。エラーはログに残す', () => {
  const gas = office();
  gas.failMails(true);
  const id = ok(as(gas, STAFF).submitRingiRequest(ringi)).data.ringiId;
  const r = ok(as(gas, MANAGER).approveRingiRequest(id));
  assert.match(r.message, /稟議を承認しました/);
  assert.equal(gas.main.rows('稟議管理')[0]['申請状態'], '承認済');
  const logs = errors(gas).filter((l) => /メール通知の送信に失敗しました/.test(l));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /宛先：staff@example\.com／件名：【Leaf Co.,Ltd. 社内ポータル】稟議申請が承認されました.+）：Service invoked too many times/);
});

test('承認・却下がエラーになったときは送らない（権限なし・却下理由なし・処理済み）', () => {
  const gas = office();
  const id = ok(as(gas, STAFF).submitOvertimeRequest(overtime)).data.requestId;
  assert.equal(as(gas, STAFF).approveOvertimeRequest(id).success, false, '一般社員は承認できない');
  assert.equal(as(gas, MANAGER).rejectOvertimeRequest(id, '').success, false, '却下理由がない');
  assert.equal(gas.mails.length, 0);
  ok(as(gas, MANAGER).approveOvertimeRequest(id));
  gas.clearMails();
  assert.equal(as(gas, MANAGER).approveOvertimeRequest(id).success, false, '処理済み');
  assert.equal(gas.mails.length, 0);
});

test('設定「メール通知＝送信しない」なら結果メールを止める。「送信先の上書き」はその宛先へ（本来の宛先を本文に）。形式が違えば送らずにログ', () => {
  const gas = office();
  const [a, b, c] = ['2026-10-07', '2026-10-08', '2026-10-09'].map((d) => ok(as(gas, STAFF).submitOvertimeRequest({ ...overtime, targetDate: d })).data.requestId);
  setSetting(gas, 'メール通知', '送信しない');
  ok(as(gas, MANAGER).approveOvertimeRequest(a));
  assert.equal(gas.mails.length, 0);
  setSetting(gas, 'メール通知', '送信する');
  setSetting(gas, 'メール通知_送信先の上書き', 'Test-Box@example.com');
  ok(as(gas, MANAGER).approveOvertimeRequest(b));
  assert.deepEqual(gas.mails.map((m) => m.to), ['test-box@example.com']);
  assert.ok(gas.mails[0].body.startsWith('（テスト用の送信先に送っています。本来の宛先：' + STAFF + '）'));
  gas.clearMails();
  setSetting(gas, 'メール通知_送信先の上書き', 'テスト宛先');
  ok(as(gas, MANAGER).rejectOvertimeRequest(c, '不要'));
  assert.equal(gas.mails.length, 0, '上書きの宛先が正しくないときは、実際の社員に誤って届かないよう送らない');
  assert.ok(errors(gas).some((l) => /メール通知_送信先の上書き」がメールアドレスの形式ではありません/.test(l)));
  assert.equal(gas.main.rows('残業申請')[2]['ステータス'], '却下', '却下は保存されている');
});

test('sendTestNotification（エディタから実行）：管理者だけ。自分宛にテストメールを1通（「メール通知」の設定に関係なく）', () => {
  const gas = office();
  setSetting(gas, 'メール通知', '送信しない');
  const r = ok(as(gas, MANAGER).sendTestNotification());
  assert.match(r.message, /manager@example\.com 宛にテストメールを送りました/);
  assert.deepEqual(gas.mails.map((m) => [m.to, m.subject]), [[MANAGER, '【Leaf Co.,Ltd. 社内ポータル】メール通知のテスト']]);
  gas.clearMails();
  const ng = as(gas, STAFF).sendTestNotification();
  assert.deepEqual([ng.success, /管理者権限がありません/.test(ng.message), gas.mails.length], [false, true, 0]);
});
