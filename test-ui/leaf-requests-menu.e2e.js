'use strict';
// ホームの「各種申請」カード → 申請メニュー（残業・有給休暇・休日出勤・稟議の4カード）→ 各申請 → ホームへ戻る、をブラウザ（Chromium）で操作するテスト。
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
const REQUEST_CARDS = ['#overtimeCard', '#paidLeaveCard', '#holidayWorkCard', '#ringiCard'];

test('各種申請（申請メニュー）の導線', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
  const { server, gas, calls } = createServer();
  // 佐藤・鈴木は有給休暇申請・休日出勤申請の対象（田中は空欄＝対象外のまま）
  const staff = gas.main.getSheetByName('スタッフマスタ');
  for (const column of ['有給申請対象', '休日出勤申請対象']) {
    const col = staff.data[0].indexOf(column);
    staff.data.forEach((row, i) => { if (i > 0 && ['佐藤 花子', '鈴木 一郎'].includes(row[1])) row[col] = '対象'; });
  }
  gas.g.clearTableCache_();
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
    return p;
  };
  const shot = async (p, name) => { if (SHOT_DIR) await p.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: true }); };
  /** 4枚の申請カードが「使える」状態で出るまで待つ（読み込みは各申請のもの） */
  const waitCards = (p, ids) => p.waitForFunction((list) => list.every((id) => !document.querySelector(id).hidden), ids || REQUEST_CARDS);

  try {
    await post('/__test/now', { now: '2026-10-06 10:00' });
    let sato;
    await t.test('ホーム：個別の4申請カードは出さず、「各種申請」カードが1枚だけ', async () => {
      sato = await open('sato@example.com');
      await sato.waitForSelector('#requestsCard');
      assert.equal(await sato.locator('#staffView .card-title', { hasText: '各種申請' }).count(), 1);
      for (const id of REQUEST_CARDS) {
        assert.equal(await sato.locator('#staffView ' + id).count(), 0, id + ' はホームにない');
        assert.equal(await sato.locator(id).isVisible(), false, id + ' はホームで見えない');
      }
      assert.equal(await sato.locator('#requestView').isHidden(), true);
      // ホームのほかのカード（打刻修正申請・交通費・日報）はそのまま
      for (const title of ['打刻修正申請', '交通費', '日報']) assert.equal(await sato.locator('#staffView .link-card .card-title', { hasText: title }).first().isVisible(), true, title);
      await shot(sato, 'requests-01-home');
    });

    await t.test('「各種申請」→ 申請メニューに 残業・有給休暇・休日出勤・稟議 の4カード（この順）。ホームへ戻れる', async () => {
      await sato.click('#btnOpenRequests');
      await sato.waitForSelector('#requestView:not([hidden])');
      assert.equal(await sato.locator('#staffView').isHidden(), true);
      assert.equal(await sato.innerText('#brandSub'), '勤怠管理｜各種申請');
      await waitCards(sato);
      const titles = await sato.locator('#requestView .request-menu > .link-card:not([hidden]) .card-title').allInnerTexts();
      assert.deepEqual(titles, ['残業申請', '有給休暇申請', '休日出勤申請', '稟議申請']);
      assert.equal(await sato.locator('#requestView .request-unavailable:not([hidden])').count(), 0, '使えない理由のカードは出ない');
      await shot(sato, 'requests-02-menu');
      await sato.click('#btnRequestsHome');
      await sato.waitForSelector('#staffView:not([hidden])');
      assert.equal(await sato.locator('#requestView').isHidden(), true);
      assert.equal(await sato.innerText('#brandSub'), '勤怠管理');
      await sato.click('#btnOpenRequests');
      await sato.click('#btnRequestsHomeBottom');
      await sato.waitForSelector('#staffView:not([hidden])');
    });

    await t.test('各申請は今までどおり開ける（残業・有給・休日出勤・稟議の画面）', async () => {
      await sato.click('#btnOpenRequests');
      await waitCards(sato);
      const cases = [
        ['#btnOpenOvertime', '#overtimeModal', '#overtimeModal .modal-close'],
        ['#btnOpenPaidLeave', '#plFormModal', '#btnPlFormBack'],
        ['#btnOpenHolidayWork', '#hwFormModal', '#btnHwFormBack'],
        ['#btnOpenRingi', '#ringiFormModal', '#btnRingiFormBack'],
        ['#btnOpenPaidLeaveHistory', '#paidLeaveModal', '#paidLeaveModal .modal-close'],
        ['#btnOpenHolidayWorkHistory', '#holidayWorkModal', '#holidayWorkModal .modal-close'],
        ['#btnOpenRingiHistory', '#ringiModal', '#ringiModal .modal-close'],
      ];
      for (const [button, modal, close] of cases) {
        await sato.click(button);
        await sato.waitForSelector(modal + ':not([hidden])');
        await sato.click(close);
        await sato.waitForSelector(modal, { state: 'hidden' });
      }
      // 稟議を1件申請（画面・処理は稟議申請のまま）→ ホームの「各種申請」に処理待ちの件数
      await sato.click('#btnOpenRingi');
      await sato.fill('#ringiItem', 'ショールーム用チェア');
      await sato.fill('#ringiQuantity', '1');
      await sato.selectOption('#ringiExpenseType', '備品購入');
      await sato.fill('#ringiPurpose', '展示替え');
      await sato.check('input[name="ringiCertainty"][value="確定"]');
      await sato.fill('#ringiAmount', '30000');
      await sato.fill('#ringiPlannedDate', '2026-10-20');
      await sato.click('#btnSubmitRingi');
      await sato.waitForSelector('#ringiFormModal', { state: 'hidden' });
      assert.equal(gas.main.rows('稟議管理').length, 1);
      await sato.click('#btnRequestsHome');
      await sato.waitForFunction(() => /処理待ちの申請 1件/.test(document.getElementById('requestsSummary').textContent));
    });

    await t.test('使えない申請は、カードの代わりに理由を出す（フレックスの残業申請・稟議の準備中）', async () => {
      // 稟議のシートがまだない（setupSystem 前）状態を作る
      const ringiSheet = gas.main.getSheetByName('稟議管理');
      gas.main.sheets = gas.main.sheets.filter((s) => s !== ringiSheet);
      gas.g.clearTableCache_();
      const suzuki = await open('suzuki@example.com'); // フレックス
      await suzuki.click('#btnOpenRequests');
      await waitCards(suzuki, ['#paidLeaveCard', '#holidayWorkCard']);
      await suzuki.waitForSelector('#overtimeCardOff:not([hidden])');
      await suzuki.waitForSelector('#ringiCardOff:not([hidden])');
      assert.match(await suzuki.innerText('#overtimeCardOff'), /残業申請は固定勤務の人だけが対象/);
      assert.match(await suzuki.innerText('#ringiCardOff'), /稟議申請はまだ準備中です/);
      assert.equal(await suzuki.locator('#overtimeCard').isHidden(), true);
      assert.equal(await suzuki.locator('#ringiCard').isHidden(), true);
      await shot(suzuki, 'requests-03-unavailable');
      gas.main.sheets.push(ringiSheet);
      gas.g.clearTableCache_();
      await suzuki.close();
    });

    await t.test('各種申請の画面で再読み込みしても各種申請が開く（?view=requests）。JavaScript のエラーなし', async () => {
      const p = await open('sato@example.com', '/?view=requests');
      await p.waitForSelector('#requestView:not([hidden])');
      await waitCards(p);
      await p.close();
      await sato.close();
      assert.deepEqual(errors, []);
      for (const fn of ['getMyPaidLeaveRequests', 'getMyHolidayWorkRequests', 'getMyRingiRequests', 'submitRingiRequest']) assert.ok(calls.includes(fn), fn);
    });
  } finally {
    await browser.close();
    server.close();
  }
});
