'use strict';
// 休日出勤申請の画面（スタッフ画面のカード・フォーム・履歴、管理者画面の承認・却下・取消）をブラウザ（Chromium）で操作するテスト。
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

test('休日出勤申請の画面', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
  const { server, gas } = createServer();
  // 休日出勤申請対象：佐藤・鈴木＝対象、山田（管理者）＝対象外、田中＝空欄（申請できない）
  const sheet = gas.main.getSheetByName('スタッフマスタ');
  const col = sheet.data[0].indexOf('休日出勤申請対象');
  const setTarget = (id, v) => { sheet.data.find((r) => r[0] === id)[col] = v; };
  setTarget('E001', '対象外'); setTarget('E002', '対象'); setTarget('E003', '対象'); setTarget('E004', '');
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
  const idle = (p) => p.waitForFunction(() => !document.body.classList.contains('is-busy'));
  const lastToast = (p) => p.locator('#toasts .toast').last().innerText();
  const shot = async (p, name) => { if (SHOT_DIR) await p.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: true }); };

  try {
    await post('/__test/now', { now: '2026-10-02 10:00' });

    await t.test('対象外・空欄の人にはカードを出さない', async () => {
      for (const email of ['yamada@example.com', 'tanaka@example.com']) {
        const p = await open(email);
        await p.waitForTimeout(400);
        await idle(p);
        assert.equal(await p.locator('#holidayWorkCard').isHidden(), true, email);
        await p.close();
      }
    });

    let sato;
    await t.test('フォーム：申請者は表示のみ・過去日は選べない・予定時間帯と予定拘束時間（休憩を含む）・振替休日予定日は「取得予定」のときだけ', async () => {
      sato = await open('sato@example.com');
      await sato.waitForSelector('#holidayWorkCard:not([hidden])');
      await sato.click('#btnOpenHolidayWork');
      await sato.waitForSelector('#holidayWorkModal:not([hidden])');
      assert.equal(await sato.inputValue('#hwApplicant'), '佐藤 花子（E002）');
      assert.equal(await sato.getAttribute('#hwApplicant', 'readonly'), '');
      assert.equal(await sato.getAttribute('#hwDate', 'min'), '2026-10-02');
      assert.match(await sato.locator('#holidayWorkModal').innerText(), /予定時間帯[\s\S]*予定拘束時間[\s\S]*休憩は差し引いていません/);
      assert.doesNotMatch(await sato.locator('#holidayWorkModal').innerText(), /予定勤務時間/);
      await sato.fill('#hwStart', '09:00');
      await sato.fill('#hwEnd', '17:30');
      assert.equal(await sato.innerText('#hwRangeText'), '09:00 〜 17:30');
      assert.equal(await sato.innerText('#hwSpanText'), '8:30');
      await sato.fill('#hwEnd', '08:00');
      assert.match(await sato.innerText('#hwSpanNote'), /日付をまたぐ休日出勤は申請できません/);
      await sato.fill('#hwEnd', '17:30');
      assert.equal(await sato.locator('#hwSpanNote').isHidden(), true);
      assert.equal(await sato.locator('#hwCompDateRow').isHidden(), true);
      await sato.selectOption('#hwCompType', '取得予定');
      assert.equal(await sato.locator('#hwCompDateRow').isHidden(), false);
      await sato.fill('#hwCompDate', '2026-10-14');
      await sato.selectOption('#hwCompType', '未定');
      assert.equal(await sato.locator('#hwCompDateRow').isHidden(), true);
      await sato.selectOption('#hwCompType', '取得予定');
      assert.equal(await sato.inputValue('#hwCompDate'), '', '別の区分にすると予定日は消える');
    });

    await t.test('申請：必須の確認 → 申請 → カードと履歴に「申請中」（入力した文字はHTMLとして解釈しない）', async () => {
      await sato.fill('#hwDate', '2026-10-10');
      await sato.click('#btnSubmitHolidayWork');
      assert.match(await lastToast(sato), /休日出勤理由を入力してください/);
      await sato.fill('#hwReason', '現場立ち会い');
      await sato.fill('#hwContent', '配筋検査');
      await sato.fill('#hwNote', '<img src=x onerror="window.__xss=1">メモ');
      await sato.click('#btnSubmitHolidayWork');
      await sato.waitForSelector('#holidayWorkModal', { state: 'hidden' });
      assert.match(await lastToast(sato), /休日出勤を申請しました（2026-10-10）/);
      await sato.waitForFunction(() => /10\/10[\s\S]*申請中/.test(document.getElementById('holidayWorkMiniList').innerText));
      await sato.click('#btnOpenHolidayWorkHistory');
      const item = sato.locator('#hwList .hw-item').first();
      assert.match(await item.innerText(), /10\/10（土）　09:00〜17:30（拘束 8:30）[\s\S]*申請中[\s\S]*振替休日：取得予定（日付未定）[\s\S]*<img src=x onerror="window.__xss=1">メモ/);
      assert.equal(await sato.locator('#hwList img').count(), 0);
      assert.equal(await sato.evaluate(() => window.__xss), undefined);
      assert.equal(await item.locator('.js-hw-withdraw').count(), 1, '申請中は取り下げできる');
      await shot(sato, 'holiday-01-form');
      await sato.click('#holidayWorkModal [data-close]');
    });

    await t.test('管理者：件数・却下は理由必須・承認', async () => {
      const yamada = await open('yamada@example.com', '/?view=admin');
      await yamada.waitForSelector('#admHolidayWork .request');
      assert.match(await yamada.locator('#summaryCards').innerText(), /休日出勤申請待ち\s*1\s*件/);
      assert.equal(await yamada.innerText('#hwPendingBadge'), '処理待ち 1件');
      const req = yamada.locator('#admHolidayWork .request').first();
      assert.match(await req.innerText(), /佐藤 花子[\s\S]*申請中[\s\S]*10\/10（土）　09:00〜17:30（予定拘束 8:30）[\s\S]*理由：現場立ち会い[\s\S]*業務内容：配筋検査/);
      await req.locator('button', { hasText: '却下' }).click();
      await yamada.click('#btnAdminConfirmOk');
      assert.match(await lastToast(yamada), /却下理由を入力してください/);
      await yamada.click('#btnAdminConfirmCancel');
      await req.locator('button', { hasText: '承認' }).click();
      assert.match(await yamada.innerText('#adminConfirmText'), /承認しても勤怠記録は変わりません/);
      await yamada.click('#btnAdminConfirmOk');
      await yamada.waitForFunction(() => /承認待ちの申請はありません|申請はありません/.test(document.getElementById('admHolidayWork').innerText));
      await yamada.check('#hwShowDone');
      assert.match(await yamada.locator('#admHolidayWork').innerText(), /承認済み[\s\S]*処理：山田 太郎/);
      await shot(yamada, 'holiday-02-admin');
      await yamada.close();
    });

    await t.test('取消：承認済みは本人が取消申請 → 管理者が取消を承認 → 取消済み', async () => {
      await post('/__test/login', { email: 'sato@example.com' });
      await sato.reload();
      await sato.waitForSelector('#holidayWorkCard:not([hidden])');
      await sato.click('#btnOpenHolidayWorkHistory');
      const item = sato.locator('#hwList .hw-item').first();
      await item.waitFor();
      assert.match(await item.innerText(), /承認済み/);
      assert.equal(await item.locator('.js-hw-withdraw').count(), 0, '承認済みは直接取り下げできない');
      await item.locator('.js-hw-cancel').click();
      await sato.click('#btnHwConfirmOk');
      assert.match(await lastToast(sato), /取消の理由を入力してください/);
      await sato.fill('#hwConfirmReason', '立ち会い不要になった');
      await sato.click('#btnHwConfirmOk');
      await sato.waitForFunction(() => /取消申請中/.test(document.getElementById('hwList').innerText));

      const yamada = await open('yamada@example.com', '/?view=admin');
      const req = yamada.locator('#admHolidayWork .request', { hasText: '取消申請中' });
      await req.waitFor();
      assert.match(await req.innerText(), /取消申請：[\s\S]*理由：立ち会い不要になった/);
      await req.locator('button', { hasText: '取消を承認' }).click();
      await yamada.click('#btnAdminConfirmOk');
      await idle(yamada);
      await yamada.check('#hwShowDone');
      await yamada.waitForFunction(() => /取消済み/.test(document.getElementById('admHolidayWork').innerText));
      await yamada.close();

      await post('/__test/login', { email: 'sato@example.com' });
      await sato.reload();
      await sato.waitForFunction(() => /取消済み/.test(document.getElementById('holidayWorkMiniList').innerText));
      await sato.close();
    });

    await t.test('スマホ：フォームが横にはみ出さない', async () => {
      const phone = await browser.newContext({ viewport: { width: 375, height: 760 }, isMobile: true, hasTouch: true, locale: 'ja-JP' });
      await post('/__test/login', { email: 'suzuki@example.com' });
      const p = await phone.newPage();
      await p.goto(base + '/');
      await p.waitForSelector('#holidayWorkCard:not([hidden])');
      await p.click('#btnOpenHolidayWork');
      await p.selectOption('#hwCompType', '取得予定');
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0);
      await shot(p, 'holiday-03-phone');
      await phone.close();
    });

    assert.deepEqual(errors, [], 'ブラウザで JavaScript のエラーが出ていない');
  } finally {
    await browser.close();
    server.close();
  }
});
