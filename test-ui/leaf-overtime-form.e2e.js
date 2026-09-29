'use strict';
// スタッフ画面の「残業申請」フォームをブラウザ（Chromium）で操作するテスト。
//   npm run test:ui
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createServer } = require('../dev/leaf-portal-server');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* グローバルを探す */ }
  try { return require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { return null; }
}
const playwright = loadPlaywright();
const SHOT_DIR = process.env.SCREENSHOT_DIR || '';

test('スタッフ画面の残業申請フォーム', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
  const { server, gas, calls } = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;
  const post = (p, body) => fetch(base + p, { method: 'POST', body: JSON.stringify(body) });
  const as = async (email, fn, ...args) => {
    await post('/__test/login', { email });
    return (await (await fetch(base + '/__gas', { method: 'POST', body: JSON.stringify({ fn, args }) })).json()).result;
  };
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' });
  context.setDefaultTimeout(10000);
  const errors = [];
  const open = async (email, url) => {
    await post('/__test/login', { email });
    const p = await context.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(url || base);
    await p.waitForSelector('#app:not([hidden])');
    return p;
  };
  const idle = (p) => p.waitForFunction(() => !document.body.classList.contains('is-busy'));
  const shot = async (p, name) => { if (SHOT_DIR) await p.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: true }); };

  try {
    await post('/__test/now', { now: '2026-06-01 10:00' });
    let page = await open('sato@example.com');

    await t.test('固定勤務には残業申請カードが出る・フレックスには出ない', async () => {
      assert.equal(await page.locator('#overtimeCard').isVisible(), true);
      assert.match(await page.locator('#overtimeCard').innerText(), /30分以上の残業を予定している場合は、事前に申請してください。/);
      const flex = await open('suzuki@example.com');
      assert.equal(await flex.locator('#overtimeCard').isHidden(), true);
      await flex.close();
      await post('/__test/login', { email: 'sato@example.com' });
    });

    await t.test('予定残業時間の自動計算と、申請できない場合の表示', async () => {
      await page.click('#btnOpenOvertime');
      assert.equal(await page.inputValue('#otDate'), '2026-06-01');
      assert.equal(await page.getAttribute('#otDate', 'min'), '2026-06-01');
      assert.equal(await page.inputValue('#otStart'), '18:30');
      await page.fill('#otEnd', '19:15');
      assert.equal(await page.locator('#otPlanned').innerText(), '00:45');
      assert.equal(await page.locator('#btnSubmitOvertime').isEnabled(), true);
      await page.fill('#otEnd', '18:50');
      assert.equal(await page.locator('#otPlanned').innerText(), '00:20');
      assert.equal(await page.locator('#otPlannedNote').innerText(), '30分未満の残業は事前申請不要です。');
      assert.equal(await page.locator('#btnSubmitOvertime').isDisabled(), true, '30分未満は申請ボタンを押せない');
      await page.fill('#otEnd', '19:00');
      assert.equal(await page.locator('#otPlannedNote').isHidden(), true, '30分ちょうどは申請できる');
      await page.fill('#otEnd', '18:00');
      assert.match(await page.locator('#otPlannedNote').innerText(), /予定開始時刻より後/);
      assert.equal(await page.locator('#btnSubmitOvertime').isDisabled(), true);
      await page.fill('#otEnd', '19:15');
      await page.click('#btnSubmitOvertime');
      assert.match(await page.locator('#toasts .toast').last().innerText(), /申請理由を入力してください/);
      assert.equal(gas.main.rows('残業申請').length, 0);
    });

    await t.test('申請（「申請中...」表示・連打しても1件）→ 承認待ち（オレンジ）', async () => {
      await page.fill('#otReason', '図面の修正対応');
      await post('/__test/delay', { ms: 400 });
      await page.click('#btnSubmitOvertime');
      assert.match(await page.locator('#btnSubmitOvertime').innerText(), /申請中\.\.\./);
      assert.equal(await page.locator('#btnSubmitOvertime').isDisabled(), true);
      await page.evaluate(() => { const b = document.getElementById('btnSubmitOvertime'); b.click(); b.click(); });
      await idle(page);
      await post('/__test/delay', { ms: 0 });
      assert.equal(calls.filter((c) => c === 'submitOvertimeRequest').length, 1, '送信は1回だけ');
      assert.equal(gas.main.rows('残業申請').length, 1);
      assert.match(await page.locator('#toasts').innerText(), /残業申請を提出しました/);
      assert.equal(await page.locator('#overtimeModal').isHidden(), true);
      const mini = page.locator('#overtimeMiniList li').first();
      assert.match(await mini.innerText(), /6\/1（月）\s+18:30〜19:15\s+承認待ち/);
      assert.equal(await mini.locator('.badge').getAttribute('class'), 'badge badge-warn');
      await shot(page, 'ot-01-pending');
    });

    await t.test('同じ日にもう一度申請するとエラー（保存しない）', async () => {
      await page.click('#btnOpenOvertime');
      await page.fill('#otEnd', '20:00');
      await page.fill('#otReason', '二重');
      await page.click('#btnSubmitOvertime');
      await idle(page);
      assert.match(await page.locator('#toasts .toast-error').last().innerText(), /すでに提出されています/);
      assert.equal(await page.locator('#overtimeModal').isVisible(), true, 'エラーのときはフォームを閉じない');
      assert.match(await page.locator('#overtimeList').innerText(), /18:30〜19:15（0:45）[\s\S]*理由：図面の修正対応/);
      await page.click('#overtimeModal [data-close]');
    });

    await t.test('管理者が承認 → 再取得で承認済み（緑）→ 19:12退勤で要確認が付かない', async () => {
      const id = gas.main.rows('残業申請')[0]['申請ID'];
      assert.equal((await as('yamada@example.com', 'approveOvertimeRequest', id)).success, true);
      await post('/__test/login', { email: 'sato@example.com' });
      await page.reload();
      await page.waitForSelector('#app:not([hidden])');
      const mini = page.locator('#overtimeMiniList li').first();
      assert.match(await mini.innerText(), /承認済み/);
      assert.equal(await mini.locator('.badge').getAttribute('class'), 'badge badge-ok');

      await post('/__test/now', { now: '2026-06-01 09:30' });
      await page.click('.style-option[data-style="出社"]');
      await page.click('#btnClockIn');
      await idle(page);
      await post('/__test/now', { now: '2026-06-01 19:12' });
      await page.click('#btnClockOut');
      await page.click('#btnConfirmOk');
      await idle(page);
      const today = await page.locator('#todayBody').innerText();
      assert.match(today, /社内超過時間\s+00:42/);
      assert.doesNotMatch(today, /要確認/);
      assert.equal(gas.main.rows('勤怠記録')[0]['要確認'], '');
      await page.click('#btnOpenOvertime');
      assert.match(await page.locator('#overtimeList').innerText(), /実績（社内超過）：0:42/);
      await page.click('#overtimeModal [data-close]');
    });

    await t.test('却下されたら本人に却下理由が見える（赤）', async () => {
      await post('/__test/now', { now: '2026-06-01 20:00' });
      const r = await as('sato@example.com', 'submitOvertimeRequest', { targetDate: '2026-06-02', plannedStart: '18:30', plannedEnd: '19:30', reason: '見積' });
      await as('yamada@example.com', 'rejectOvertimeRequest', r.data.requestId, '翌日の対応で問題ありません');
      await post('/__test/login', { email: 'sato@example.com' });
      await page.reload();
      await page.waitForSelector('#app:not([hidden])');
      assert.equal(await page.locator('#overtimeMiniList li').first().locator('.badge').getAttribute('class'), 'badge badge-ng');
      await page.click('#btnOpenOvertime');
      assert.match(await page.locator('#overtimeList').innerText(), /却下[\s\S]*却下理由：翌日の対応で問題ありません/);
      await shot(page, 'ot-02-modal');
      await page.click('#overtimeModal [data-close]');
    });

    await t.test('管理者画面：申請が表示され、月の集計は「今月の」と表示', async () => {
      const admin = await open('yamada@example.com', base + '/?view=admin');
      await admin.waitForSelector('#adminContent:not([hidden])');
      await admin.check('#otShowDone');
      assert.match(await admin.locator('#admOvertime').innerText(), /佐藤 花子[\s\S]*18:30〜19:15/);
      const cards = await admin.locator('#summaryCards').innerText();
      assert.match(cards, /今月の打刻漏れ/);
      assert.match(cards, /今月の残業要確認/);
      await admin.close();
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
    server.close();
  }
});
