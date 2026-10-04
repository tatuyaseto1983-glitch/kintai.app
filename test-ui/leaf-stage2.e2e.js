'use strict';
// 段階2の画面（現場・外出の打刻と直行／直帰・1日の詳細・交通費・管理者の明細と月次）をブラウザ（Chromium）で操作するテスト。
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

test('段階2の画面（直行・直帰・現場・1日の詳細・交通費・管理者）', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
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

  try {
    await post('/__test/now', { now: '2026-10-05 09:30' });
    const p = await open('sato@example.com');

    await t.test('4. 出勤のときに直行・現場名を入れる（勤務場所は会社のまま。現場は付帯情報）', async () => {
      assert.equal(await p.locator('#punchExtras').isVisible(), true, '未出勤のときは直行・現場名を入れられる');
      await p.click('.style-option[data-style="出社"]');
      assert.equal(await p.locator('#btnClockIn').innerText(), '出勤する');
      await p.check('#punchDirect');
      await p.fill('#punchSite', '堺市○○様邸');
      await p.click('#btnClockIn');
      await idle(p);
      assert.match(await lastToast(p), /出勤しました（会社・09:30）/);
      assert.equal(await p.inputValue('#punchSite'), '', '出勤したら入力欄は空に戻る');
      assert.match(await p.locator('#todayBody .timeline').innerText(), /09:30\s+会社で出勤・直行（堺市○○様邸）/);
      assert.equal(await p.locator('#punchExtras').isHidden(), true, '勤務中は直行・現場名の欄は出ない（詳細・交通費から直す）');
      const seg = gas.main.rows('勤務区間履歴')[0];
      assert.deepEqual([seg['勤務形態'], seg['直行'], seg['現場名']], ['出社', '○', '堺市○○様邸']);
    });

    await t.test('在宅を選んで［勤務場所を切替］→ 退勤（直帰なし）', async () => {
      await p.click('.style-option[data-style="在宅"]');
      assert.equal(await p.locator('#btnSwitchStyle').innerText(), '勤務場所を切替');
      await post('/__test/now', { now: '2026-10-05 14:00' });
      await p.click('#btnSwitchStyle');
      await idle(p);
      assert.match(await lastToast(p), /勤務場所を会社から在宅に切り替えました/);
      await post('/__test/now', { now: '2026-10-05 18:30' });
      await p.click('#btnClockOut');
      assert.equal(await p.locator('#confirmDirectReturn').isChecked(), false);
      await p.click('#btnConfirmOk');
      await idle(p);
      const body = await p.locator('#todayBody').innerText();
      assert.match(body, /日の属性\s+直行/);
      assert.match(body, /勤務場所\s+会社＋在宅/);
    });

    await t.test('1日の詳細：区間の現場名・直帰、日備考・出張、自家用車の距離を保存', async () => {
      await p.click('#btnOpenDayDetail');
      await p.waitForSelector('#ddSite1');
      assert.equal(await p.inputValue('#ddSite1'), '堺市○○様邸');
      assert.equal(await p.locator('#ddDirect1').isChecked(), true);
      await p.check('#ddReturn2');
      await p.fill('#ddSegNote2', '見積の打合せ');
      await p.check('#ddTrip');
      await p.fill('#ddNote', '午前は現場、午後は会社');
      await p.check('#ddCarUse');
      await p.fill('#ddCarKm', '32.5');
      await shot(p, 's2-01-detail');
      await p.click('#btnSaveDayDetail');
      await p.waitForFunction(() => /保存しました/.test(document.getElementById('toasts').innerText));
      const row = gas.main.rows('交通費明細')[0];
      assert.deepEqual([row['交通手段'], row['自家用車使用'], row['業務走行距離'], row['金額'], row['目的・現場']], ['自家用車', '○', '32.5', '', '堺市○○様邸']);
      const a = gas.main.rows('勤怠記録').find((r) => r['勤怠ID'] === 'AT-20261005-E002');
      assert.deepEqual([a['日備考'], a['出張'], a['直行'], a['直帰']], ['午前は現場、午後は会社', '○', '○', '○']);
      await p.click('#dayDetailModal [data-detail-close]');
      await idle(p);
      assert.match(await p.locator('#todayBody').innerText(), /日の属性\s+出張・直行・直帰/);
      assert.match(await p.locator('#todayBody').innerText(), /日備考\s+午前は現場、午後は会社/);
    });

    await t.test('交通費：追加（電車・高速）→ 修正 → 削除。カードと合計が変わる', async () => {
      await p.click('#btnOpenTransport');
      await p.waitForFunction(() => /2026年10月分 対象期間：2026\/09\/21〜2026\/10\/20/.test(document.getElementById('trPeriod').innerText));
      assert.match(await p.locator('#trList').innerText(), /自家用車\s+堺市○○様邸\s+32.5km/);
      await p.selectOption('#trMode', '電車');
      await p.fill('#trFrom', '堺');
      await p.fill('#trTo', '難波');
      await p.fill('#trPurpose', '<b>打合せ</b>');
      await p.fill('#trAmount', '450');
      await p.click('#btnSaveTransport');
      await p.waitForFunction(() => document.querySelectorAll('#trList li[data-expense]').length === 2);
      assert.match(await p.locator('#trList').innerText(), /電車\s+堺→難波\s+<b>打合せ<\/b>\s+450円/, 'HTMLは文字のまま表示');
      await p.selectOption('#trMode', '高速道路');
      assert.equal(await p.locator('#trKmRow').isHidden(), true);
      await p.check('#trPrivateCar');
      await p.fill('#trPurpose', '堺市○○様邸');
      await p.fill('#trAmount', '1320');
      await p.click('#btnSaveTransport');
      await p.waitForFunction(() => document.querySelectorAll('#trList li[data-expense]').length === 3);
      assert.match(await p.locator('#trTotals').innerText(), /合計 3件\s+交通費 1,770円\s+業務走行距離 32.5km/);
      // 修正
      await p.locator('#trList li', { hasText: '電車' }).locator('button', { hasText: '修正' }).click();
      assert.match(await p.locator('#trFormTitle').innerText(), /交通費を修正する/);
      await p.fill('#trAmount', '470');
      await p.click('#btnSaveTransport');
      await p.waitForFunction(() => /470円/.test(document.getElementById('trList').innerText));
      // 削除
      await p.locator('#trList li', { hasText: '電車' }).locator('button', { hasText: '削除' }).click();
      await p.click('#btnTrDeleteOk');
      await p.waitForFunction(() => document.querySelectorAll('#trList li[data-expense]').length === 2);
      assert.match(await p.locator('#trTotals').innerText(), /交通費 1,320円/);
      assert.equal(gas.main.rows('交通費明細').find((r) => r['交通手段'] === '電車')['削除フラグ'], '○', '行は残して削除フラグ');
      await shot(p, 's2-02-transport');
      await p.click('#transportModal [data-detail-close]');
      await p.waitForFunction(() => /2件・交通費 1,320円・業務走行距離 32.5km/.test(document.getElementById('transportCardText').innerText));
      await p.close();
    });

    await t.test('他の人には佐藤さんの交通費が出ない', async () => {
      const s = await open('suzuki@example.com');
      await s.click('#btnOpenTransport');
      await s.waitForFunction(() => /まだありません/.test(document.getElementById('trList').innerText));
      assert.doesNotMatch(await s.locator('#transportModal').innerText(), /堺市|1,320/);
      await s.close();
    });

    await t.test('管理者：日別の［開く］に直行・直帰・現場・日備考・出張・距離・交通費。月次に合計', async () => {
      const a = await open('yamada@example.com', '/?view=admin');
      await a.waitForSelector('#adminContent:not([hidden])');
      await a.fill('#admDate', '2026-10-05');
      await a.dispatchEvent('#admDate', 'change');
      await a.waitForFunction(() => /10\/5/.test(document.getElementById('admTableTitle').textContent));
      await a.locator('#admTableBody tr', { hasText: '佐藤 花子' }).locator('button[data-detail]').click();
      await a.waitForSelector('.segment-detail');
      const detail = await a.locator('.segment-detail').innerText();
      assert.match(detail, /区間1\s+会社\s+09:30〜14:00.*直行／現場：堺市○○様邸/);
      assert.match(detail, /区間2\s+在宅\s+14:00〜18:30.*直帰／備考：見積の打合せ/);
      // 勤務場所と、直行・直帰・現場・出張は分けて表示する
      assert.match(detail, /勤務場所\s+会社＋在宅\s+直行\s+あり\s+直帰\s+あり\s+現場\s+堺市○○様邸\s+出張\s+あり\s+日備考\s+午前は現場、午後は会社\s+自家用車の業務走行距離\s+32.5km/);
      assert.match(await a.locator('#admTableBody tr', { hasText: '佐藤 花子' }).innerText(), /会社＋在宅\s+直行／直帰／現場：堺市○○様邸/);
      assert.match(detail, /交通費（2件・1,320円・32.5km）/);
      assert.doesNotMatch(detail, /打合せ<\/b>/, '削除済みは出さない');
      await shot(a, 's2-03-admin-detail');
      await a.click('#adminView .tab[data-mode="monthly"]');
      await a.fill('#admMonth', '2026-10');
      await a.dispatchEvent('#admMonth', 'change');
      await a.waitForFunction(() => /対象期間/.test(document.getElementById('admTableTitle').textContent));
      const row = await a.locator('#admTableBody tr', { hasText: '佐藤 花子' }).innerText();
      assert.match(row, /32.5km\s+1,320円/);
      assert.match(await a.locator('#admTableHead').innerText(), /業務走行距離\s+交通費（通勤以外）/);
      await a.close();
    });

    await t.test('画面から呼んだ関数に管理者用のものがなく、JavaScript のエラーが出ていない', async () => {
      assert.deepEqual(errors, []);
      assert.ok(calls.includes('saveMyDayDetail') && calls.includes('addTransportExpense') && calls.includes('getAdminDayDetail'));
    });
  } finally {
    await browser.close();
    server.close();
  }
});
