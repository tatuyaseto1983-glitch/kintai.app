'use strict';
// 勤務区間（出社⇄在宅の切替・別の勤務形態で再開・再出勤・タイムライン・管理者の明細）をブラウザ（Chromium）で操作するテスト。
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

test('勤務区間の画面（切替・別の勤務形態で再開・再出勤・タイムライン・管理者の明細）', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
  const { server, gas, calls } = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;
  const post = (p, body) => fetch(base + p, { method: 'POST', body: JSON.stringify(body) });
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' });
  context.setDefaultTimeout(10000);
  const errors = [];
  const open = async (email, url) => {
    await post('/__test/login', { email });
    const p = await context.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base + (url || '/'));
    await p.waitForSelector('#app:not([hidden])');
    await p.waitForFunction(() => !document.body.classList.contains('is-busy') && document.getElementById('statusLabel').textContent !== '');
    return p;
  };
  const idle = (p) => p.waitForFunction(() => !document.body.classList.contains('is-busy'));
  const lastToast = (p) => p.locator('#toasts .toast').last().innerText();
  const shot = async (p, name) => { if (SHOT_DIR) await p.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: true }); };
  const visible = async (p, id) => p.locator('#' + id).isVisible();

  try {
    await post('/__test/now', { now: '2026-09-01 09:30' });
    const p = await open('sato@example.com');

    await t.test('未出勤：切替・別の勤務形態で再開のボタンは出ない', async () => {
      assert.equal(await visible(p, 'btnSwitchStyle'), false);
      assert.equal(await visible(p, 'btnResumeOther'), false);
      await p.click('.style-option[data-style="出社"]');
      await p.click('#btnClockIn');
      await idle(p);
      assert.match(await lastToast(p), /出勤しました（出社・09:30）/);
    });

    await t.test('出社勤務中：「在宅勤務へ切替」（連打しても1回だけ）', async () => {
      assert.equal(await p.locator('#statusLabel').innerText(), '出社勤務中');
      assert.equal(await p.locator('#btnSwitchStyle').innerText(), '在宅勤務へ切替');
      await post('/__test/now', { now: '2026-09-01 12:00' });
      await post('/__test/delay', { ms: 400 });
      const before = calls.filter((c) => c === 'switchWorkStyle').length;
      await p.locator('#btnSwitchStyle').click();
      await p.evaluate(() => { document.getElementById('btnSwitchStyle').click(); document.getElementById('btnSwitchStyle').click(); });
      await idle(p);
      await post('/__test/delay', { ms: 0 });
      assert.equal(calls.filter((c) => c === 'switchWorkStyle').length - before, 1, '連打しても1回だけ');
      assert.match(await lastToast(p), /出社から在宅に切り替えました（12:00）/);
      assert.equal(await p.locator('#statusLabel').innerText(), '在宅勤務中');
      assert.equal(await p.locator('#btnSwitchStyle').innerText(), '出社勤務へ切替');
      assert.match(await p.locator('#statusSub').innerText(), /本日の勤務区間 2つ/);
      const tl = await p.locator('#todayBody .timeline').innerText();
      assert.match(tl, /09:30\s+出社で出勤\s+12:00\s+在宅へ切替\s+（在宅で勤務中）/, '操作の順番で表示');
      assert.match(await p.locator('#staffList').innerText(), /佐藤 花子（あなた）\s*勤務中（在宅）/);
    });

    await t.test('在宅勤務中に中断 →「在宅で再開」「出社で再開」が出る → 出社で再開', async () => {
      await post('/__test/now', { now: '2026-09-01 15:00' });
      await p.click('#btnBreak');
      await idle(p);
      assert.equal(await p.locator('#statusLabel').innerText(), '中断中');
      assert.equal(await p.locator('#btnResume').innerText(), '在宅で再開');
      assert.equal(await p.locator('#btnResumeOther').innerText(), '出社で再開');
      assert.equal(await visible(p, 'btnSwitchStyle'), false);
      assert.equal(await p.locator('#btnClockOut').isDisabled(), true);
      await shot(p, 'seg-01-break');
      await post('/__test/now', { now: '2026-09-01 15:30' });
      await p.click('#btnResumeOther');
      await idle(p);
      assert.match(await lastToast(p), /出社で再開しました（在宅から出社に切り替え／中断 00:30/);
      assert.equal(await p.locator('#statusLabel').innerText(), '出社勤務中');
      assert.match(await p.locator('#todayBody .timeline').innerText(), /09:30\s+出社で出勤\s+12:00\s+在宅へ切替\s+15:00\s+中断\s+15:30\s+再開（出社）\s+（出社で勤務中）/);
    });

    await t.test('退勤 →「出社で再出勤」「在宅で再出勤」→ 在宅で再出勤 → 退勤（タイムラインと内訳）', async () => {
      await post('/__test/now', { now: '2026-09-01 17:00' });
      await p.click('#btnClockOut');
      await p.click('#btnConfirmOk');
      await idle(p);
      assert.equal(await p.locator('#statusLabel').innerText(), '退勤済み');
      await p.click('.style-option[data-style="在宅"]');
      assert.equal(await p.locator('#btnClockIn').innerText(), '在宅で再出勤する');
      await post('/__test/now', { now: '2026-09-01 19:00' });
      await p.click('#btnClockIn');
      await idle(p);
      assert.match(await lastToast(p), /再出勤しました（在宅・19:00）/);
      assert.equal(await p.locator('#statusLabel').innerText(), '在宅勤務中');
      await post('/__test/now', { now: '2026-09-01 20:00' });
      await p.click('#btnClockOut');
      await p.click('#btnConfirmOk');
      await idle(p);
      const body = await p.locator('#todayBody').innerText();
      assert.match(body, /09:30\s+出社で出勤\s+12:00\s+在宅へ切替\s+15:00\s+中断\s+15:30\s+再開（出社）\s+17:00\s+退勤\s+19:00\s+在宅で再出勤\s+20:00\s+退勤/);
      assert.match(body, /出勤\s+09:30/, '再出勤しても出勤は最初の開始のまま');
      assert.match(body, /退勤\s+20:00/);
      assert.match(body, /勤務形態\s+出社＋在宅/);
      assert.match(body, /区間数\s+4つ/);
      assert.match(body, /出社\s+04:00/);
      assert.match(body, /在宅\s+04:00/);
      assert.match(body, /自動休憩\s+01:00/);
      assert.match(body, /実働時間\s+07:00/);
      assert.match(body, /合計から自動休憩（1日1回）を引いたものが実働時間/);
      assert.match(await p.locator('#monthRows tr').first().innerText(), /出社＋在宅\s+09:30\s+20:00/);
      assert.match(await p.locator('#monthTotals').innerText(), /2026年9月分 対象期間：2026\/08\/21〜2026\/09\/20/);
      assert.equal(await p.locator('#monthLabel').innerText(), '2026年9月分');
      await shot(p, 'seg-02-finished');
    });

    await t.test('打刻修正申請：区間を選んで申請できる', async () => {
      await post('/__test/now', { now: '2026-09-02 09:00' });
      await p.reload();
      await p.waitForSelector('#app:not([hidden])');
      await idle(p);
      await p.click('#btnOpenCorrection');
      await p.fill('#corDate', '2026-09-01');
      await p.dispatchEvent('#corDate', 'change');
      await p.selectOption('#corItem', '区間終了');
      assert.equal(await visible(p, 'corSegmentRow'), true);
      assert.deepEqual(await p.locator('#corSegment option').allInnerTexts(), ['区間1', '区間2', '区間3', '区間4']);
      await p.selectOption('#corSegment', '4');
      await p.fill('#corAfterTime', '20:15');
      await p.fill('#corReason', '退勤の押し遅れ');
      await p.click('#btnSubmitCorrection');
      await idle(p);
      assert.match(await lastToast(p), /打刻修正を申請しました（2026-09-01・区間4の区間終了）/);
      const req = gas.main.rows('打刻修正申請').pop();
      assert.deepEqual([req['対象区間'], req['修正前'], req['修正後']], ['4', '20:00', '20:15']);
      await p.close();
    });

    await t.test('管理者：日別一覧に勤務区間の数・勤務形態区分。「開く」で区間と中断の明細', async () => {
      const a = await open('yamada@example.com', '/?view=admin');
      await a.waitForSelector('#adminContent:not([hidden])');
      await a.fill('#admDate', '2026-09-01');
      await a.dispatchEvent('#admDate', 'change');
      await a.waitForFunction(() => /9\/1/.test(document.getElementById('admTableTitle').textContent));
      const row = a.locator('#admTableBody tr', { hasText: '佐藤 花子' });
      assert.match(await row.innerText(), /出社＋在宅\s+4区間/);
      await row.locator('button[data-detail]').click();
      await a.waitForSelector('.segment-detail');
      const detail = await a.locator('.segment-detail').innerText();
      assert.match(detail, /区間1\s+出社\s+09:30〜12:00（区間の実働 2:30）/);
      assert.match(detail, /区間4\s+在宅\s+19:00〜20:00/);
      assert.match(detail, /15:00〜15:30（0:30）/);
      assert.match(detail, /出社 4:00／在宅 4:00／自動休憩 1:00／実働 7:00/);
      await shot(a, 'seg-03-admin');
      await a.locator('#admTableBody tr', { hasText: '佐藤 花子' }).locator('button[data-detail]').click();
      assert.equal(await a.locator('.segment-detail').count(), 0, 'もう一度押すと閉じる');
      await a.click('#adminView .tab[data-mode="monthly"]');
      await a.fill('#admMonth', '2026-09');
      await a.dispatchEvent('#admMonth', 'change');
      await a.waitForFunction(() => /対象期間/.test(document.getElementById('admTableTitle').textContent));
      assert.match(await a.locator('#admTableTitle').innerText(), /2026年9月分 対象期間：2026\/08\/21〜2026\/09\/20/);
      await a.close();
    });

    await t.test('ブラウザで JavaScript のエラーが出ていない', async () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
    server.close();
  }
});
