'use strict';
process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = require('node:path').join(require('node:os').tmpdir(), 'kintai-test-' + process.pid);
const test = require('node:test');
const assert = require('node:assert');
const { server, calcDay, statutoryDays } = require('../server');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => server.close());

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: method !== 'GET' ? JSON.stringify(body || {}) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };
}
const day = (segments, override = null) => calcDay({ segments: JSON.stringify(segments), break_override: override });

test('労働時間の計算が今のスプレッドシートと一致する', () => {
  // 09:22-18:33 → 総労働 8:11 / 残業 0:11
  let d = day([{ in: '09:22', out: '18:33' }]);
  assert.equal(d.work_minutes, 8 * 60 + 11); assert.equal(d.overtime_minutes, 11);
  // 6時間以下は休憩を引かない：09:22-14:24 → 5:02
  d = day([{ in: '09:22', out: '14:24' }]);
  assert.equal(d.work_minutes, 5 * 60 + 2); assert.equal(d.overtime_minutes, 0);
  // 中抜けあり：05:39-07:24 + 09:28-17:54 → 9:11 / 残業 1:11
  d = day([{ in: '05:39', out: '07:24' }, { in: '09:28', out: '17:54' }]);
  assert.equal(d.work_minutes, 9 * 60 + 11); assert.equal(d.overtime_minutes, 71);
  // 日付またぎ 22:00-01:00 → 3:00
  assert.equal(day([{ in: '22:00', out: '01:00' }]).work_minutes, 180);
  // 管理者が休憩を0分に修正
  assert.equal(day([{ in: '09:00', out: '18:00' }], 0).work_minutes, 540);
  // 退勤漏れ
  assert.equal(day([{ in: '09:00' }]).open, true);
});

test('有給の法定付与日数', () => {
  assert.equal(statutoryDays('2025-01-01', '2025-06-30'), 0);
  assert.equal(statutoryDays('2025-01-01', '2025-07-01'), 10);
  assert.equal(statutoryDays('2020-01-01', '2026-09-01'), 20);
});

test('権限の分離と一連の流れ', async () => {
  const admin = client();
  assert.equal((await admin('/api/login', { method: 'POST', body: { login_id: 'admin', password: 'x' } })).status, 401);
  assert.equal((await admin('/api/login', { method: 'POST', body: { login_id: 'admin', password: 'admin1234' } })).status, 200);
  // 初回はパスワード変更が必須
  assert.equal((await admin('/api/admin/dashboard')).status, 403);
  assert.equal((await admin('/api/me/password', { method: 'POST', body: { current: 'admin1234', next: 'newpass123' } })).status, 200);
  assert.equal((await admin('/api/admin/dashboard')).status, 200);

  // 社員を追加（メールアドレスでログイン）
  const add = await admin('/api/users', { method: 'POST', body: { login_id: 'taro@example.com', name: '山田太郎', role: 'employee', hire_date: '2024-01-10', password: 'initpass1' } });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  const uid = add.data.id;

  const emp = client();
  await emp('/api/login', { method: 'POST', body: { login_id: 'TARO@example.com', password: 'initpass1' } });
  await emp('/api/me/password', { method: 'POST', body: { current: 'initpass1', next: 'taropass1' } });

  // 社員は管理者機能を使えない
  assert.equal((await emp('/api/admin/dashboard')).status, 403);
  assert.equal((await emp('/api/users', { method: 'POST', body: {} })).status, 403);
  assert.equal((await emp('/api/attendance', { method: 'PUT', body: {} })).status, 403);
  assert.equal((await emp('/api/leave/grants', { method: 'POST', body: {} })).status, 403);
  // 他人の勤怠は見られない（user_id を指定しても自分のものが返る）
  const own = await emp('/api/attendance?user_id=1');
  assert.equal(own.data.user.id, uid);

  // 打刻：出勤 → 退勤 → 再開 → 退勤
  assert.equal((await emp('/api/attendance/punch', { method: 'POST', body: { action: 'in' } })).status, 200);
  assert.equal((await emp('/api/attendance/punch', { method: 'POST', body: { action: 'in' } })).status, 400);
  assert.equal((await emp('/api/attendance/punch', { method: 'POST', body: { action: 'out' } })).status, 200);
  assert.equal((await emp('/api/attendance/punch', { method: 'POST', body: { action: 'in' } })).status, 200);
  const t = await emp('/api/attendance/punch', { method: 'POST', body: { action: 'out' } });
  assert.equal(t.data.record.segments.length, 2);

  // 管理者が勤怠を修正
  const fix = await admin('/api/attendance', { method: 'PUT', body: { user_id: uid, work_date: '2026-09-01', segments: [{ in: '09:00', out: '18:30' }], break_override: '', note: '押し忘れ' } });
  assert.equal(fix.status, 200);
  const sep = await admin(`/api/attendance?user_id=${uid}&month=2026-09`);
  const rec = sep.data.records.find((r) => r.work_date === '2026-09-01');
  assert.equal(rec.work_minutes, 510); assert.equal(rec.overtime_minutes, 30);

  // 有給：付与がないと申請できない → 付与 → 申請 → 承認
  assert.equal((await emp('/api/leave/requests', { method: 'POST', body: { kind: 'paid', leave_type: 'full', start_date: '2026-10-01' } })).status, 400);
  // 振替休日は残日数に関係なく申請できる
  assert.equal((await emp('/api/leave/requests', { method: 'POST', body: { kind: 'substitute', leave_type: 'full', start_date: '2026-09-25' } })).status, 200);
  await admin('/api/leave/grants', { method: 'POST', body: { user_id: uid, grant_date: '2026-07-10', days: 11 } });
  const lr = await emp('/api/leave/requests', { method: 'POST', body: { kind: 'paid', leave_type: 'full', start_date: '2026-10-01', end_date: '2026-10-02', handover: '1', handover_note: '見積もりは佐藤さんへ' } });
  assert.equal(lr.status, 200, JSON.stringify(lr.data));
  // 同じ日の重複申請はできない
  assert.equal((await emp('/api/leave/requests', { method: 'POST', body: { kind: 'paid', leave_type: 'am', start_date: '2026-10-02' } })).status, 400);
  await emp('/api/leave/requests', { method: 'POST', body: { kind: 'paid', leave_type: 'am', start_date: '2026-10-05' } });
  let sum = await emp('/api/leave/summary');
  assert.equal(sum.data.remaining, 11); assert.equal(sum.data.pending, 2.5);
  assert.equal((await emp(`/api/leave/requests/${lr.data.id}/decide`, { method: 'POST', body: { decision: 'approved' } })).status, 403);
  assert.equal((await admin(`/api/leave/requests/${lr.data.id}/decide`, { method: 'POST', body: { decision: 'approved' } })).status, 200);
  sum = await emp('/api/leave/summary');
  assert.equal(sum.data.remaining, 9); assert.equal(sum.data.pending, 0.5);
  assert.equal(sum.data.obligation.taken, 2);

  // 休日出勤申請 → 承認
  const hw = await emp('/api/holiday-work', { method: 'POST', body: { work_date: '2026-09-27', start_time: '09:30', end_time: '17:00', reason: '見積もり対応', substitute_date: '2026-10-08' } });
  assert.equal(hw.status, 200);
  assert.equal((await admin(`/api/holiday-work/${hw.data.id}/decide`, { method: 'POST', body: { decision: 'approved' } })).status, 200);

  // 稟議（添付つき）→ 差戻しは理由必須 → 承認
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const rg = await emp('/api/ringi', { method: 'POST', body: { title: 'ホールソー', quantity: '1', category: '備品購入', content: 'タイル穴あけ', amount: '1,760円', certainty: '確定', expense_date: '2026-09-24', attachment: { name: '見積.png', type: 'image/png', data: png } } });
  assert.equal(rg.status, 200, JSON.stringify(rg.data));
  const detail = await emp(`/api/ringi/${rg.data.id}`);
  assert.equal(detail.data.ringi.amount, 1760);
  assert.equal(detail.data.ringi.attachment_file, undefined);
  assert.equal((await emp(`/api/ringi/${rg.data.id}/attachment`)).status, 200);
  assert.equal((await admin(`/api/ringi/${rg.data.id}/decide`, { method: 'POST', body: { decision: 'rejected' } })).status, 400);
  assert.equal((await admin(`/api/ringi/${rg.data.id}/decide`, { method: 'POST', body: { decision: 'approved', comment: 'OK' } })).status, 200);
  // 危険な形式の添付は拒否
  assert.equal((await emp('/api/ringi', { method: 'POST', body: { title: 'x', category: '備品購入', content: 'x', attachment: { name: 'a.html', type: 'text/html', data: 'PGI+' } } })).status, 400);

  // 月次集計・CSV
  const monthly = await admin('/api/admin/monthly?month=2026-09');
  const row = monthly.data.rows.find((r) => r.user.id === uid);
  assert.ok(row.days >= 1); assert.equal(row.holiday_work, 1);
  const csv = await admin('/api/attendance/export?month=2026-09');
  assert.match(csv.data, /再開2/); assert.match(csv.data, /山田太郎/);

  // 最後の管理者は降格できない
  assert.equal((await admin('/api/users/1', { method: 'PUT', body: { role: 'employee' } })).status, 400);
  // 利用停止にするとログインできない
  await admin(`/api/users/${uid}`, { method: 'PUT', body: { active: false } });
  assert.equal((await emp('/api/me')).status, 401);
});

test('JSON以外の送信（他サイトからのフォーム送信）は拒否', async () => {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'login_id=admin' });
  assert.equal(res.status, 415);
});
