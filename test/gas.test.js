'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGas } = require('../dev/gas-mock');

function client(gas) {
  let token = null;
  return (method, p, body) => {
    const r = gas.call({ method, path: p, body, token });
    if (r.ok && r.data && r.data.token) token = r.data.token;
    return r;
  };
}
function loginFresh(gas, id, pw, next) {
  const c = client(gas);
  assert.equal(c('POST', '/api/login', { login_id: id, password: pw }).status, 200);
  assert.equal(c('POST', '/api/me/password', { current: pw, next }).status, 200);
  return c;
}

test('労働時間の計算が今のスプレッドシートと一致する', () => {
  const { context: g } = createGas();
  const day = (segments, bo = null) => g.calcDay_({ segments, break_override: bo });
  let d = day([{ in: '09:22', out: '18:33' }]);
  assert.equal(d.work_minutes, 491); assert.equal(d.overtime_minutes, 11); // 8:11 / 0:11
  assert.equal(day([{ in: '09:22', out: '14:24' }]).work_minutes, 302); // 6時間以下は休憩なし 5:02
  d = day([{ in: '05:39', out: '07:24' }, { in: '09:28', out: '17:54' }]);
  assert.equal(d.work_minutes, 551); assert.equal(d.overtime_minutes, 71); // 9:11 / 1:11
  assert.equal(day([{ in: '22:00', out: '01:00' }]).work_minutes, 180);
  assert.equal(day([{ in: '09:00', out: '18:00' }], 0).work_minutes, 540);
  assert.equal(day([{ in: '09:00' }]).open, true);
});

test('20日締め（21日始まり）の期間', () => {
  const { context: g } = createGas();
  assert.deepEqual({ ...g.periodRange_('2026-10') }, { from: '2026-09-21', to: '2026-10-20' });
  assert.deepEqual({ ...g.periodRange_('2026-01') }, { from: '2025-12-21', to: '2026-01-20' });
  assert.equal(g.periodOf_('2026-09-20'), '2026-09');
  assert.equal(g.periodOf_('2026-09-21'), '2026-10');
  assert.equal(g.periodOf_('2026-12-25'), '2027-01');
});

test('権限の分離・打刻（再開）・申請の一連の流れ', () => {
  const gas = createGas();
  const admin = loginFresh(gas, 'admin', 'admin1234', 'adminpass1');
  const add = admin('POST', '/api/users', { login_id: 'taro@example.com', name: '山田太郎', role: 'employee', hire_date: '2024-01-10', password: 'initpass1' });
  assert.equal(add.status, 200, add.error);
  const uid = add.data.id;
  const emp = loginFresh(gas, 'TARO@example.com', 'initpass1', 'taropass1');

  // 社員は管理者機能を使えない
  for (const [m, p] of [['GET', '/api/admin/dashboard'], ['POST', '/api/users'], ['PUT', '/api/attendance'], ['POST', '/api/leave/grants'], ['POST', '/api/admin/import']]) {
    assert.equal(emp(m, p, {}).status, 403, p);
  }
  assert.equal(emp('GET', '/api/attendance?user_id=1').data.user.id, uid);
  assert.equal(client(gas)('GET', '/api/me').status, 401);

  // 打刻：出勤 → 退勤 → 再開 → 退勤
  assert.equal(emp('POST', '/api/attendance/punch', { action: 'resume' }).status, 400);
  assert.equal(emp('POST', '/api/attendance/punch', { action: 'in' }).status, 200);
  assert.equal(emp('POST', '/api/attendance/punch', { action: 'resume' }).status, 400); // 勤務中
  assert.equal(emp('POST', '/api/attendance/punch', { action: 'out' }).status, 200);
  assert.equal(emp('POST', '/api/attendance/punch', { action: 'in' }).status, 400); // 2回目は「再開」
  assert.equal(emp('POST', '/api/attendance/punch', { action: 'resume' }).status, 200);
  const t = emp('POST', '/api/attendance/punch', { action: 'out' });
  assert.equal(t.data.record.segments.length, 2);

  // 管理者の修正と、20日締めの期間
  assert.equal(admin('PUT', '/api/attendance', { user_id: uid, work_date: '2026-09-21', segments: [{ in: '09:00', out: '18:30' }], break_override: '', note: '' }).status, 200);
  assert.equal(admin('PUT', '/api/attendance', { user_id: uid, work_date: '2026-09-20', segments: [{ in: '09:00', out: '18:00' }], break_override: '', note: '' }).status, 200);
  const oct = admin('GET', `/api/attendance?user_id=${uid}&month=2026-10`).data;
  assert.equal(oct.from, '2026-09-21'); assert.equal(oct.to, '2026-10-20');
  assert.ok(oct.records.some((r) => r.work_date === '2026-09-21'));
  assert.ok(!oct.records.some((r) => r.work_date === '2026-09-20'));
  const sep = admin('GET', `/api/attendance?user_id=${uid}&month=2026-09`).data;
  assert.equal(sep.records.find((r) => r.work_date === '2026-09-20').work_minutes, 480);

  // 有給
  assert.equal(emp('POST', '/api/leave/requests', { kind: 'paid', leave_type: 'full', start_date: '2026-10-01' }).status, 400);
  assert.equal(emp('POST', '/api/leave/requests', { kind: 'substitute', leave_type: 'full', start_date: '2026-10-09' }).status, 200);
  admin('POST', '/api/leave/grants', { user_id: uid, grant_date: '2026-07-10', days: 11 });
  const lr = emp('POST', '/api/leave/requests', { kind: 'paid', leave_type: 'full', start_date: '2026-10-01', end_date: '2026-10-02', handover: '1', handover_note: '見積もりは佐藤さんへ' });
  assert.equal(lr.status, 200, lr.error);
  assert.equal(emp('POST', '/api/leave/requests', { kind: 'paid', leave_type: 'am', start_date: '2026-10-02' }).status, 400);
  assert.equal(emp('POST', `/api/leave/requests/${lr.data.id}/decide`, { decision: 'approved' }).status, 403);
  assert.equal(admin('POST', `/api/leave/requests/${lr.data.id}/decide`, { decision: 'approved' }).status, 200);
  const sum = emp('GET', '/api/leave/summary').data;
  assert.equal(sum.remaining, 9); assert.equal(sum.obligation.taken, 2);

  // 休日出勤
  const hw = emp('POST', '/api/holiday-work', { work_date: '2026-09-27', start_time: '09:30', end_time: '17:00', reason: '見積もり対応', substitute_date: '2026-10-08' });
  assert.equal(admin('POST', `/api/holiday-work/${hw.data.id}/decide`, { decision: 'approved' }).status, 200);

  // 稟議（添付つき）
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const rg = emp('POST', '/api/ringi', { title: 'ホールソー', quantity: '1', category: '備品購入', content: 'タイル穴あけ', amount: '1,760円', certainty: '確定', expense_date: '2026-09-24', attachment: { name: '見積.png', type: 'image/png', data: png } });
  assert.equal(rg.status, 200, rg.error);
  const detail = emp('GET', `/api/ringi/${rg.data.id}`).data.ringi;
  assert.equal(detail.amount, 1760); assert.equal(detail.has_attachment, true); assert.equal(detail.attachment_file, undefined);
  assert.equal(emp('GET', `/api/ringi/${rg.data.id}/attachment`).data.data, png);
  assert.equal(admin('POST', `/api/ringi/${rg.data.id}/decide`, { decision: 'rejected' }).status, 400); // 差戻しは理由が必須
  assert.equal(admin('POST', `/api/ringi/${rg.data.id}/decide`, { decision: 'rejected', comment: '型番を確認してください' }).status, 200);
  assert.equal(emp('POST', '/api/ringi', { title: 'x', category: '備品購入', content: 'x', attachment: { name: 'a.html', type: 'text/html', data: 'PGI+' } }).status, 400);

  // 月次集計・CSV
  const row = admin('GET', '/api/admin/monthly?month=2026-10').data.rows.find((r) => r.user.id === uid);
  assert.equal(row.holiday_work, 1); assert.equal(row.leave_days, 2); // 承認済みの有給2日（振替休日は未承認）
  assert.match(admin('GET', '/api/attendance/export?month=2026-10').data.csv, /再開2/);

  // 最後の管理者は降格できない／利用停止でログアウト
  assert.equal(admin('PUT', '/api/users/1', { role: 'employee' }).status, 400);
  admin('PUT', `/api/users/${uid}`, { active: false });
  assert.equal(emp('GET', '/api/me').status, 401);
});

test('日付をまたいだ勤務は、前日の記録として退勤できる', async () => {
  const now = Date.now();
  const jst = new Date(now + 9 * 3600e3);
  const toJst2330 = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), 23, 30) - 9 * 3600e3 - now;
  const file = path.join(os.tmpdir(), `kintai-night-${process.pid}.json`);
  const g1 = createGas({ clockOffsetMs: toJst2330, file });
  const a = loginFresh(g1, 'admin', 'admin1234', 'adminpass1');
  assert.equal(a('POST', '/api/attendance/punch', { action: 'in' }).status, 200);
  await new Promise((r) => setTimeout(r, 150)); // 保存を待つ
  const g2 = createGas({ clockOffsetMs: toJst2330 + 90 * 60e3, file }); // 翌日 01:00
  const c = client(g2);
  c('POST', '/api/login', { login_id: 'admin', password: 'adminpass1' });
  assert.ok(c('GET', '/api/attendance/today').data.carry, '前日の勤務が続いている');
  const out = c('POST', '/api/attendance/punch', { action: 'out' }).data;
  assert.equal(out.carry, null);
  await new Promise((r) => setTimeout(r, 150));
  fs.unlinkSync(file);
});

test('旧スプレッドシートからの取り込み', () => {
  const gas = createGas();
  const admin = loginFresh(gas, 'admin', 'admin1234', 'adminpass1');
  gas.addSpreadsheet('OLD_SHEET_ID_1234567890abcdef', {
    'メンバー': [['氏名', 'メールアドレス'], ['山本一郎', 'boss@example.com'], ['佐藤花子', 'hanako@example.com'], ['鈴木美咲', 'misaki@example.com']],
    '打刻': [
      ['日付', '名前', '出勤', '退勤', '再開2', '終了2', '再開3', '終了3', '再開4', '終了4', '再開5', '終了5', '総労働時間', '残業時間'],
      ['2026/08/22', '佐藤花子', '05:39', '07:24', '09:28', '17:54:', '', '', '', '', '', '', '09:11', '01:11'],
      ['2026/08/29', '佐藤花子', '05:13', '18:34', '09:14', '', '', '', '', '', '', '', '12:21', '04:21'],
      ['2026/09/04', '佐藤花子', '2026/09/04 9:30:25', '2026/09/04 15:41:05', '', '', '', '', '', '', '', '', '05:10', '00:00'],
      ['2026/09/06', '佐藤花子', '05:54', '', '', '', '', '', '', '', '', '', '00:00', '00:00'],
      ['2026/08/31', '鈴木美咲', '9:30:00', '18:37:00', '', '', '', '', '', '', '', '', '08:07', '00:07'],
      ['2026/08/31', '知らない人', '9:30', '18:00', '', '', '', '', '', '', '', '', '', ''],
    ],
    '経費': [
      ['タイムスタンプ', 'メールアドレス', '購入品名', '購入数量', '経費種別', '支出理由・目的', '見積金額(税込・数字のみ) ', '支出日', '見積書または関連資料アップロード', '金額の確度', '承認ステータス'],
      ['2026/08/25 17:27:41', 'misaki@example.com', 'アスクル(ゴミ袋等）', '4点', '備品購入', '来客飲料他', '7,382円', '2026/08/25', '', '', '✅ 承認済み (boss@example.com)'],
      ['2026/09/09 9:16:54', 'hanako@example.com', '両面テープ', '各1個', '備品購入', '打ち合わせ室の設え', '7000円くらい', '2026/09/09', '', '', ''],
      ['2026/09/10 21:14:36', 'boss@example.com', 'テスト', '１', '備品購入', 'テスト', '１', '2026/09/10', '', '❌ 差戻し (boss@example.com)', ''],
    ],
    '休日出勤': [
      ['タイムスタンプ', '休日出勤予定日', '休日出勤開始予定時間', '休日出勤の理由', '振替休日取得予定日', '休日出勤終了予定時間', 'メールアドレス', '承認ステータス'],
      ['2026/09/13 16:36:53', '2026/09/14', '9:30:00', 'キッチンの見積もり急ぎ', '2026/09/25', '✅ 承認済み (boss@example.com)', 'misaki@example.com', ''],
    ],
  });
  const r = admin('POST', '/api/admin/import', { url: 'https://docs.google.com/spreadsheets/d/OLD_SHEET_ID_1234567890abcdef/edit#gid=0' });
  assert.equal(r.status, 200, r.error);
  assert.equal(r.data.users_created.length, 3);
  assert.equal(r.data.users_created.find((u) => u.login_id === 'boss@example.com').role, 'admin'); // 承認していた人は管理者に
  assert.equal(r.data.users_created.find((u) => u.login_id === 'misaki@example.com').role, 'employee');
  assert.equal(r.data.attendance, 5);
  assert.equal(r.data.attendance_skipped, 1);
  assert.equal(r.data.ringi, 3);
  assert.equal(r.data.holiday, 1);

  const users = admin('GET', '/api/users').data.users;
  const hanako = users.find((u) => u.login_id === 'hanako@example.com');
  const sep = admin('GET', `/api/attendance?user_id=${hanako.id}&month=2026-09`).data; // 8/21〜9/20
  const byDate = Object.fromEntries(sep.records.map((x) => [x.work_date, x]));
  assert.equal(byDate['2026-08-22'].work_minutes, 551);
  assert.equal(byDate['2026-08-29'].work_minutes, 741); // 12:21（重なった「再開 09:14」は除外）
  assert.match(byDate['2026-08-29'].note, /除外/);
  assert.deepEqual(byDate['2026-09-04'].segments, [{ in: '09:30', out: '15:41' }]);
  assert.equal(byDate['2026-09-06'].open, true);

  const ringi = admin('GET', '/api/ringi').data.ringi;
  const askul = ringi.find((x) => x.title.startsWith('アスクル'));
  assert.equal(askul.status, 'approved'); assert.equal(askul.amount, 7382); assert.equal(askul.approver_name, '山本一郎');
  const tape = ringi.find((x) => x.title === '両面テープ');
  assert.equal(tape.status, 'pending'); assert.equal(tape.certainty, '概算'); assert.equal(tape.amount, 7000);
  assert.equal(ringi.find((x) => x.title === 'テスト').status, 'rejected');
  const hw = admin('GET', '/api/holiday-work').data.requests[0];
  assert.equal(hw.status, 'approved'); assert.equal(hw.start_time, '09:30'); assert.equal(hw.substitute_date, '2026-09-25');

  // 取り込んだ社員は、表示された初期パスワードでログインできる
  const aInfo = r.data.users_created.find((u) => u.login_id === 'misaki@example.com');
  loginFresh(gas, 'misaki@example.com', aInfo.password, 'misakipass1');

  // もう一度取り込んでも重複しない
  const again = admin('POST', '/api/admin/import', { url: 'OLD_SHEET_ID_1234567890abcdef' }).data;
  assert.equal(again.users_created.length, 0); assert.equal(again.attendance, 0); assert.equal(again.ringi, 0); assert.equal(again.holiday, 0);
});
