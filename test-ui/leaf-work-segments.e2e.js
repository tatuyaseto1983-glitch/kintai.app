'use strict';
// 勤務区間の画面（勤務場所 会社／在宅の2択・［勤務場所を切替］［再開］［再出勤］が各1つ・時系列・管理者の明細）をブラウザ（Chromium）で操作するテスト。
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

test('勤務区間の画面（勤務場所2択・切替・再開・再出勤・時系列・管理者の明細）', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
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
  /** 押せる（表示されていて有効な）打刻ボタンの名前 */
  const buttons = (p) => p.evaluate(() => ['btnClockIn', 'btnBreak', 'btnSwitchStyle', 'btnResume', 'btnClockOut']
    .map((id) => document.getElementById(id))
    .filter((b) => b && !b.disabled && b.offsetParent !== null)
    .map((b) => b.textContent.trim()));
  const segRows = () => gas.main.rows('勤務区間履歴').filter((r) => r['勤怠ID'] === 'AT-20260901-E002').map((r) => r['勤務形態'] + ' ' + r['開始時刻'] + '-' + r['終了時刻']);

  try {
    await post('/__test/now', { now: '2026-09-01 09:30' });
    const p = await open('sato@example.com');

    await t.test('1〜3. 勤務場所は「会社」「在宅」の2択だけ（現場・外出のボタンはない）。未出勤は［出勤する］1つ', async () => {
      assert.equal(await p.locator('.style-select-label').innerText(), '勤務場所');
      assert.deepEqual(await p.locator('.style-option').allInnerTexts(), ['会社', '在宅']);
      assert.equal(await p.locator('.style-option[data-style="現場"]').count(), 0);
      assert.equal(await p.locator('.style-option[data-style="外出"]').count(), 0);
      assert.equal(await p.locator('#btnResumeOther').count(), 0, '「在宅で再開」などの別ボタンはない');
      assert.equal(await visible(p, 'btnSwitchStyle'), false);
      await p.click('.style-option[data-style="出社"]');
      assert.deepEqual(await buttons(p), ['出勤する']);
      await p.click('#btnClockIn');
      await idle(p);
      assert.match(await lastToast(p), /出勤しました（会社・09:30）/);
      assert.equal(await p.locator('#statusLabel').innerText(), '会社勤務中');
    });

    await t.test('12・13. 勤務中のボタンは［中断］［勤務場所を切替］［退勤］。今と同じ勤務場所では切替できない（区間を作らない）', async () => {
      assert.deepEqual(await buttons(p), ['中断', '退勤'], '会社のまま会社を選んでいるので切替は押せない');
      assert.equal(await p.locator('#btnSwitchStyle').innerText(), '勤務場所を切替');
      assert.equal(await p.locator('#btnSwitchStyle').isDisabled(), true);
      await p.evaluate(() => { const b = document.getElementById('btnSwitchStyle'); b.disabled = false; b.click(); }); // 無理やり押しても
      await idle(p);
      assert.match(await lastToast(p), /現在と同じ勤務場所です/);
      assert.equal(calls.filter((c) => c === 'switchWorkStyle').length, 0, 'サーバーに送らない');
      assert.deepEqual(segRows(), ['出社 09:30-']);
    });

    await t.test('14. 会社→在宅の切替（連打しても1回だけ）', async () => {
      await p.click('.style-option[data-style="在宅"]');
      assert.deepEqual(await buttons(p), ['中断', '勤務場所を切替', '退勤']);
      await post('/__test/now', { now: '2026-09-01 12:00' });
      await post('/__test/delay', { ms: 400 });
      await p.locator('#btnSwitchStyle').click();
      await p.evaluate(() => { document.getElementById('btnSwitchStyle').click(); document.getElementById('btnSwitchStyle').click(); });
      await idle(p);
      await post('/__test/delay', { ms: 0 });
      assert.equal(calls.filter((c) => c === 'switchWorkStyle').length, 1, '連打しても1回だけ');
      assert.match(await lastToast(p), /勤務場所を会社から在宅に切り替えました（12:00）/);
      assert.equal(await p.locator('#statusLabel').innerText(), '在宅勤務中');
      assert.equal(await p.locator('#btnSwitchStyle').isDisabled(), true, '在宅のまま在宅を選んでいるので押せない');
      assert.match(await p.locator('#todayBody .timeline').innerText(), /09:30\s+会社で出勤\s+12:00\s+勤務場所を在宅へ切替\s+（在宅で勤務中）/);
      assert.match(await p.locator('#staffList').innerText(), /佐藤 花子（あなた）\s*在宅勤務中/);
    });

    await t.test('9・17. 中断中は［再開］1つだけ。在宅で中断 → 会社を選んで再開 → 会社勤務で再開', async () => {
      await post('/__test/now', { now: '2026-09-01 15:00' });
      await p.click('#btnBreak');
      await idle(p);
      assert.equal(await p.locator('#statusLabel').innerText(), '中断中（在宅）');
      assert.deepEqual(await buttons(p), ['再開'], '中断中は［再開］だけ（退勤はこれまでどおりできない）');
      await shot(p, 'seg-01-break');
      await p.click('.style-option[data-style="出社"]');
      await post('/__test/now', { now: '2026-09-01 15:30' });
      await p.click('#btnResume');
      await idle(p);
      assert.match(await lastToast(p), /会社勤務で再開しました（在宅から会社に切り替え／中断 00:30/);
      assert.equal(await p.locator('#statusLabel').innerText(), '会社勤務中');
      assert.match(await p.locator('#todayBody .timeline').innerText(), /12:00\s+勤務場所を在宅へ切替\s+15:00\s+中断\s+15:30\s+再開（会社）\s+（会社で勤務中）/);
      assert.deepEqual(segRows(), ['出社 09:30-12:00', '在宅 12:00-15:00', '出社 15:30-']);
    });

    await t.test('10. 同じ勤務場所（会社）を選んだまま再開 → 区間は増えない', async () => {
      await post('/__test/now', { now: '2026-09-01 16:00' });
      await p.click('#btnBreak');
      await idle(p);
      await post('/__test/now', { now: '2026-09-01 16:10' });
      await p.click('#btnResume');
      await idle(p);
      assert.match(await lastToast(p), /再開しました（会社勤務・中断 00:10/);
      assert.deepEqual(segRows(), ['出社 09:30-12:00', '在宅 12:00-15:00', '出社 15:30-']);
    });

    await t.test('18・19. 退勤 → ［再出勤］1つ。在宅を選んで再出勤 → 在宅の区間。21. 本日の記録は会社／在宅表記', async () => {
      await post('/__test/now', { now: '2026-09-01 17:00' });
      await p.click('#btnClockOut');
      await p.click('#btnConfirmOk');
      await idle(p);
      assert.equal(await p.locator('#statusLabel').innerText(), '退勤済み');
      assert.deepEqual(await buttons(p), ['再出勤']);
      await p.click('.style-option[data-style="在宅"]');
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
      assert.match(body, /09:30\s+会社で出勤\s+12:00\s+勤務場所を在宅へ切替\s+15:00\s+中断\s+15:30\s+再開（会社）\s+16:00\s+中断\s+16:10\s+再開（会社）\s+17:00\s+退勤\s+19:00\s+在宅で再出勤\s+20:00\s+退勤/);
      assert.match(body, /勤務場所\s+会社＋在宅/);
      assert.match(body, /出勤\s+09:30/, '再出勤しても出勤は最初の開始のまま');
      assert.match(body, /会社\s+03:50/);
      assert.match(body, /在宅\s+04:00/);
      assert.doesNotMatch(body, /出社/, '画面には「出社」と出さない');
      assert.match(await p.locator('#monthRows tr').first().innerText(), /会社＋在宅\s+09:30\s+20:00/);
      assert.match(await p.locator('#monthTotals').innerText(), /2026年9月分 対象期間：2026\/08\/21〜2026\/09\/20/);
      await shot(p, 'seg-02-finished');
    });

    await t.test('打刻修正申請：区間を選んで申請できる（勤務場所の選択肢は会社・在宅）', async () => {
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
      assert.deepEqual(await p.locator('#corAfterStyle option').allInnerTexts(), ['会社', '在宅']);
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

    await t.test('7・22. 管理者：勤務場所（会社＋在宅）と直行直帰・現場を分けて表示。操作履歴も同じ表記', async () => {
      const a = await open('yamada@example.com', '/?view=admin');
      await a.waitForSelector('#adminContent:not([hidden])');
      await a.fill('#admDate', '2026-09-01');
      await a.dispatchEvent('#admDate', 'change');
      await a.waitForFunction(() => /9\/1/.test(document.getElementById('admTableTitle').textContent));
      assert.match(await a.locator('#admTableHead').innerText(), /勤務場所\s+直行・直帰・現場\s+勤務区間/);
      const row = a.locator('#admTableBody tr', { hasText: '佐藤 花子' });
      assert.match(await row.innerText(), /会社＋在宅\s+—\s+4区間/);
      await row.locator('button[data-detail]').click();
      await a.waitForSelector('.segment-detail');
      const detail = await a.locator('.segment-detail').innerText();
      assert.match(detail, /09:30\s+会社で出勤\s+12:00\s+勤務場所を在宅へ切替\s+15:00\s+中断\s+15:30\s+再開（会社）/);
      assert.match(detail, /区間1\s+会社\s+09:30〜12:00（区間の実働 2:30）/);
      assert.match(detail, /勤務場所\s+会社＋在宅\s+直行\s+なし\s+直帰\s+なし\s+現場\s+なし/);
      assert.match(detail, /会社 3:50／在宅 4:00／自動休憩 1:00／実働 6:50/);
      assert.doesNotMatch(detail, /出社|現場・外出/);
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
