'use strict';
// Google Chat 通知（第1段階：管理者用スペースへの Incoming Webhook）と、設定「通知方法」の切り替えのテスト。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createLeafGas } = require('../dev/leaf-gas-mock');

const BOSS = 'boss@example.com';
const MANAGER = 'manager@example.com';
const STAFF = 'staff@example.com';
const NOW = '2026-10-06 10:00';
const WEBHOOK = 'https://chat.googleapis.com/v1/spaces/AAAA1234/messages?key=SECRETKEY&token=SECRETTOKEN';

function office(options) {
  const opts = options || {};
  const gas = createLeafGas({ email: BOSS });
  gas.g.setupSystem();
  const base = { '在籍状況': '在籍', '雇用区分': '正社員', '勤務区分': '固定勤務', '部署': '一般', '休日出勤申請対象': '対象', '有給申請対象': '対象' };
  gas.g.appendRecords_('スタッフマスタ', [
    { ...base, '社員ID': 'E001', '氏名': '光山大樹', 'メールアドレス': BOSS, '権限': 'admin', '自己承認可': 'TRUE' },
    { ...base, '社員ID': 'E002', '氏名': '管理太郎', 'メールアドレス': MANAGER, '権限': 'admin' },
    { ...base, '社員ID': 'E005', '氏名': '中津井祐貴', 'メールアドレス': STAFF, '権限': 'staff' },
  ]);
  if (opts.webhook !== false) gas.setScriptProperty('GOOGLE_CHAT_WEBHOOK_URL', opts.webhook || WEBHOOK);
  gas.g.clearTableCache_();
  gas.setNow(NOW);
  gas.clearMails();
  gas.clearFetches();
  gas.eval('var __errors = []; console.error = function (m) { __errors.push(String(m)); };');
  return gas;
}
const as = (gas, email) => { gas.loginAs(email); gas.setNow(NOW); return gas.g; };
const ok = (r) => { assert.equal(r.success, true, r.message); return r; };
const errors = (gas) => gas.eval('__errors');
const setSetting = (gas, key, value) => { gas.main.getSheetByName('設定').data.find((r) => r[0] === key)[1] = value; gas.g.clearTableCache_(); };
const texts = (gas) => gas.fetches.map((f) => JSON.parse(f.payload).text);
const overtime = { targetDate: '2026-10-07', plannedStart: '18:30', plannedEnd: '20:00', reason: '現場対応' };
const holiday = { workDate: '2026-10-11', plannedStart: '09:00', plannedEnd: '17:00', reason: '立ち会い', content: '配筋検査', compDayType: '未定', compDayDate: '', note: '', site: '' };
const ringi = { itemName: 'ダイニングチェア', quantity: '2', expenseType: '備品購入', purpose: '展示替え', certainty: '概算', amount: '100000', plannedDate: '2026-10-20', attachmentUrl: '' };

test('初期値は「通知方法＝Google Chat」：新規申請で管理者用スペースへ1件（申請種別・申請者・申請日時・内容・状態）。メールは送らない', () => {
  const gas = office();
  assert.equal(gas.main.getSheetByName('設定').data.find((r) => r[0] === '通知方法')[1], 'Google Chat');
  const id = ok(as(gas, STAFF).submitOvertimeRequest(overtime)).data.requestId;
  assert.equal(gas.fetches.length, 1);
  const f = gas.fetches[0];
  assert.equal(f.method, 'post');
  assert.equal(f.contentType, 'application/json; charset=UTF-8');
  assert.equal(f.url, WEBHOOK + '&messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD&threadKey=' + id, '同じ申請は同じスレッドに');
  assert.equal(texts(gas)[0], [
    '*新しい残業申請が届きました*',
    '申請種別：残業申請', '申請者：中津井祐貴（E005）', '申請日時：2026-10-06 10:00:00', '内容：10/7 18:30〜20:00', '状態：承認待ち',
    '申請ID：' + id, '対象日：2026-10-07', '予定：18:30〜20:00（予定残業 01:30）', '申請理由：現場対応',
    '管理者画面で承認・却下してください', '<https://script.google.com/a/macros/example.com/s/TEST/exec?view=admin|管理者画面を開く>'].join('\n'));
  assert.equal(gas.mails.length, 0, 'Google Chat のときはメールを送らない（本人への通知は第2段階）');
});

test('4種類とも新規申請で Chat に通知（状態：承認待ち／稟議は申請中）。承認・却下では Chat に送らない（管理者向けだけ）', () => {
  const gas = office();
  const ot = ok(as(gas, STAFF).submitOvertimeRequest(overtime)).data.requestId;
  ok(as(gas, STAFF).submitPaidLeaveRequest({ date: '2026-10-08', leaveType: '午後半休', reason: '通院' }));
  const hw = ok(as(gas, STAFF).submitHolidayWorkRequest(holiday)).data.requestId;
  ok(as(gas, STAFF).submitRingiRequest(ringi));
  assert.deepEqual(texts(gas).map((t) => [t.split('\n')[0], t.match(/状態：(.+)/)[1]]), [
    ['*新しい残業申請が届きました*', '承認待ち'], ['*新しい有給休暇申請が届きました*', '承認待ち'],
    ['*新しい休日出勤申請が届きました*', '承認待ち'], ['*新しい稟議申請が届きました*', '申請中']]);
  assert.match(texts(gas)[3], /内容：ダイニングチェア・100,000円\n状態：申請中\n稟議ID：RG-20261006100000-E005\n購入品名：ダイニングチェア[\s\S]*申請金額（税込）：100,000円/);
  gas.clearFetches();
  ok(as(gas, MANAGER).approveOvertimeRequest(ot));
  ok(as(gas, MANAGER).rejectHolidayWorkRequest(hw, '不要'));
  assert.equal(gas.fetches.length, 0);
});

test('稟議の再承認待ち：申請のときと同じスレッドに「再承認が必要です」（確定金額・差額・状態＝再承認待ち）', () => {
  const gas = office();
  const id = ok(as(gas, STAFF).submitRingiRequest(ringi)).data.ringiId;
  ok(as(gas, MANAGER).approveRingiRequest(id));
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '90000'));
  gas.clearFetches();
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '120000'));
  assert.equal(gas.fetches.length, 1);
  assert.match(gas.fetches[0].url, new RegExp('&threadKey=' + id + '$'));
  const t = texts(gas)[0];
  assert.match(t, /^\*稟議の再承認が必要です\*\n申請種別：稟議申請\n申請者：中津井祐貴（E005）\n申請日時：2026-10-06 10:00:00\n内容：ダイニングチェア・確定金額 120,000円（申請金額 100,000円・差額 \+20,000円）\n状態：再承認待ち/);
  assert.match(t, /確定金額を入力した人：中津井祐貴/);
  gas.clearFetches();
  ok(as(gas, STAFF).enterRingiFinalAmount(id, '125000'));
  ok(as(gas, MANAGER).reapproveRingiRequest(id));
  assert.equal(gas.fetches.length, 0, '再承認待ちのままの訂正・再承認では送らない');
});

test('送るのは保存の後：Chat に送る時点で申請はシートに保存済み', () => {
  const gas = office();
  gas.eval(`var __seen = []; var __fetch = UrlFetchApp.fetch; UrlFetchApp.fetch = function (u, p) {
    clearTableCache_(); __seen.push(readTable_('休日出勤申請').records.length); return __fetch(u, p); };`);
  ok(as(gas, STAFF).submitHolidayWorkRequest(holiday));
  assert.deepEqual(gas.eval('__seen'), [1]);
});

test('Chat の送信に失敗しても申請は成功（保存される）。失敗はログに残し、Webhook の鍵はログに書かない', () => {
  for (const mode of ['http500', 'throw']) {
    const gas = office();
    gas.fetchMode(mode);
    const r = ok(as(gas, STAFF).submitRingiRequest(ringi));
    assert.match(r.message, /稟議を申請しました/);
    assert.equal(gas.main.rows('稟議管理').length, 1);
    const logs = errors(gas);
    assert.equal(logs.length, 1, mode);
    assert.match(logs[0], mode === 'http500' ? /Google Chat 通知の送信に失敗しました（HTTP 500／\*新しい稟議申請が届きました\*）/ : /Google Chat 通知の送信に失敗しました（\*新しい稟議申請が届きました\*）/);
    assert.ok(!logs.join('').includes('SECRETTOKEN') && !logs.join('').includes('SECRETKEY'), 'URL の鍵を書かない');
  }
});

test('Webhook URL がない・Google Chat の URL でないときは送らずにログ（申請は成功）。URL はコードに書いていない', () => {
  const gas = office({ webhook: false });
  ok(as(gas, STAFF).submitOvertimeRequest(overtime));
  assert.equal(gas.fetches.length, 0);
  assert.match(errors(gas)[0], /スクリプトプロパティ GOOGLE_CHAT_WEBHOOK_URL に Webhook URL が設定されていません/);
  const gas2 = office({ webhook: 'https://example.com/hook?token=SECRETTOKEN' });
  ok(as(gas2, STAFF).submitOvertimeRequest(overtime));
  assert.equal(gas2.fetches.length, 0, 'Google Chat 以外の宛先には申請内容を送らない');
  assert.match(errors(gas2)[0], /Google Chat の Webhook URL（https:\/\/chat\.googleapis\.com\/v1\/spaces\/…）ではありません/);
  assert.ok(!errors(gas2).join('').includes('SECRETTOKEN'));
  const src = fs.readdirSync(path.join(__dirname, '../leaf-portal/gas')).map((f) => fs.readFileSync(path.join(__dirname, '../leaf-portal/gas', f), 'utf8')).join('\n');
  assert.ok(!/chat\.googleapis\.com\/v1\/spaces\/[A-Za-z0-9]/.test(src), 'Webhook URL を直書きしていない');
});

test('申請がエラーになったときは Chat に送らない', () => {
  const gas = office();
  assert.equal(as(gas, STAFF).submitRingiRequest({ ...ringi, amount: '1,000' }).success, false);
  assert.equal(as(gas, STAFF).submitOvertimeRequest({ ...overtime, targetDate: '2026-10-01' }).success, false);
  assert.equal(gas.fetches.length, 0);
});

test('通知方法の切り替え：メール（Chatなし）／両方（Chat＋メール）／通知なし（何も送らない）／正しくない値（送らずにログ）', () => {
  const gas = office();
  setSetting(gas, '通知方法', 'メール');
  ok(as(gas, STAFF).submitOvertimeRequest(overtime));
  assert.deepEqual([gas.fetches.length, gas.mails.map((m) => m.to).sort()], [0, [BOSS, MANAGER, STAFF].sort()]);
  gas.clearMails();
  setSetting(gas, '通知方法', '両方');
  const id = ok(as(gas, STAFF).submitRingiRequest(ringi)).data.ringiId;
  assert.deepEqual([gas.fetches.length, gas.mails.length], [1, 3]);
  ok(as(gas, MANAGER).approveRingiRequest(id));
  assert.deepEqual([gas.fetches.length, gas.mails.length], [1, 4], '承認の結果は本人へのメールだけ');
  gas.clearMails(); gas.clearFetches();
  setSetting(gas, '通知方法', '通知なし');
  ok(as(gas, STAFF).submitHolidayWorkRequest(holiday));
  assert.deepEqual([gas.fetches.length, gas.mails.length], [0, 0]);
  setSetting(gas, '通知方法', 'Slack');
  ok(as(gas, STAFF).submitPaidLeaveRequest({ date: '2026-10-09', leaveType: '1日有給', reason: '私用' }));
  assert.deepEqual([gas.fetches.length, gas.mails.length], [0, 0]);
  assert.ok(errors(gas).some((l) => /設定「通知方法」は「メール」「Google Chat」「両方」「通知なし」のどれか/.test(l)));
  // 「両方」でも「メール通知＝送信しない」ならメールは止まる（Chat は送る）
  setSetting(gas, '通知方法', '両方');
  setSetting(gas, 'メール通知', '送信しない');
  ok(as(gas, STAFF).submitOvertimeRequest({ ...overtime, targetDate: '2026-10-09' }));
  assert.deepEqual([gas.fetches.length, gas.mails.length], [1, 0]);
});

test('sendTestChatNotification（エディタから実行）：管理者だけ。通知方法に関係なく管理者用スペースへ1件', () => {
  const gas = office();
  setSetting(gas, '通知方法', '通知なし');
  const r = ok(as(gas, MANAGER).sendTestChatNotification());
  assert.match(r.message, /管理者用スペースにテストメッセージを送りました/);
  assert.equal(gas.fetches.length, 1);
  assert.match(texts(gas)[0], /^\*Google Chat 通知のテスト\*\n社内ポータルから 管理太郎 さんが送りました/);
  gas.clearFetches();
  const ng = as(gas, STAFF).sendTestChatNotification();
  assert.deepEqual([ng.success, /管理者権限がありません/.test(ng.message), gas.fetches.length], [false, true, 0]);
  // メールのテストも通知方法に関係なく送る
  ok(as(gas, MANAGER).sendTestNotification());
  assert.deepEqual(gas.mails.map((m) => m.to), [MANAGER]);
});
