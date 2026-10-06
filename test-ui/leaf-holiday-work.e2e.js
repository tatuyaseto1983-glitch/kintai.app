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
// ホームの「各種申請」から申請メニューを開く（残業・有給・休日出勤・稟議のカードはこの画面にある）
const toRequests = async (p) => {
  if (await p.locator('#requestView').isHidden()) {
    await p.click('#btnOpenRequests');
    await p.waitForSelector('#requestView:not([hidden])');
  }
};


test('休日出勤申請の画面（新規申請・申請中／承認済み・過去の申請・取り下げ／取消申請を分ける）', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
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
        await toRequests(p);
        assert.equal(await p.locator('#holidayWorkCard').isHidden(), true, email);
        await p.close();
      }
    });

    let sato;
    const hubCard = (p, area, text) => p.locator('#' + area + ' .hw-card', { hasText: text });
    const openHub = async (p) => {
      await toRequests(p);
      await p.click('#btnOpenHolidayWorkHistory');
      await p.waitForSelector('#holidayWorkModal:not([hidden])');
    };

    await t.test('新規申請フォーム：カードの［休日出勤を申請する］から開く。取消の項目は出さない。申請者は表示のみ・予定時間帯／予定拘束時間・振替休日予定日の条件', async () => {
      sato = await open('sato@example.com');
      await toRequests(sato);
      await sato.waitForSelector('#holidayWorkCard:not([hidden])');
      await toRequests(sato);
      assert.deepEqual(await sato.locator('#holidayWorkCard button').allInnerTexts(), ['休日出勤を申請する', '申請状況を見る']);
      await toRequests(sato);
      await sato.click('#btnOpenHolidayWork');
      await sato.waitForSelector('#hwFormModal:not([hidden])');
      assert.equal(await sato.innerText('#hwFormTitle'), '休日出勤を申請する');
      const formText = await sato.locator('#hwFormModal').innerText();
      assert.doesNotMatch(formText, /取消|取り下げ|申請中・承認済み|過去の申請/, '新規申請フォームに既存申請の取消項目を出さない');
      assert.equal(await sato.locator('#holidayWorkModal').isHidden(), true);
      assert.equal(await sato.inputValue('#hwApplicant'), '佐藤 花子（E002）');
      assert.equal(await sato.getAttribute('#hwApplicant', 'readonly'), '');
      assert.equal(await sato.getAttribute('#hwDate', 'min'), '2026-10-02');
      assert.match(formText, /予定時間帯[\s\S]*予定拘束時間[\s\S]*休憩は差し引いていません/);
      assert.doesNotMatch(formText, /予定勤務時間/);
      await sato.fill('#hwStart', '09:00');
      await sato.fill('#hwEnd', '17:30');
      assert.equal(await sato.innerText('#hwRangeText'), '09:00 〜 17:30');
      assert.equal(await sato.innerText('#hwSpanText'), '8:30');
      await sato.fill('#hwEnd', '08:00');
      assert.match(await sato.innerText('#hwSpanNote'), /日付をまたぐ休日出勤は申請できません/);
      await sato.fill('#hwEnd', '17:30');
      assert.equal(await sato.locator('#hwCompDateRow').isHidden(), true);
      await sato.selectOption('#hwCompType', '取得予定');
      assert.equal(await sato.locator('#hwCompDateRow').isHidden(), false);
      await sato.fill('#hwCompDate', '2026-10-14');
      await sato.selectOption('#hwCompType', '未定');
      assert.equal(await sato.locator('#hwCompDateRow').isHidden(), true);
      await sato.selectOption('#hwCompType', '取得予定');
      assert.equal(await sato.inputValue('#hwCompDate'), '', '別の区分にすると予定日は消える');
    });

    await t.test('申請 → 申請状況の「申請中・承認済み」に、休日出勤日・予定時間帯・ステータス・振替休日と［申請を取り下げる］', async () => {
      await sato.fill('#hwDate', '2026-10-10');
      await sato.dispatchEvent('#hwDate', 'change');
      assert.equal(await sato.innerText('#hwShiftText'), '', 'シフト管理を使わない間はシフトを表示しない');
      await sato.fill('#hwSite', '堺市○○様邸');
      await sato.click('#btnSubmitHolidayWork');
      assert.match(await lastToast(sato), /休日出勤理由を入力してください/);
      await sato.fill('#hwReason', '<img src=x onerror="window.__xss=1">現場立ち会い');
      await sato.fill('#hwContent', '配筋検査');
      await sato.click('#btnSubmitHolidayWork');
      await sato.waitForSelector('#hwFormModal', { state: 'hidden' });
      assert.match(await lastToast(sato), /休日出勤を申請しました（2026-10-10）/);
      await sato.waitForFunction(() => /10\/10[\s\S]*承認待ち/.test(document.getElementById('holidayWorkMiniList').innerText));
      await openHub(sato);
      assert.deepEqual(await sato.locator('#holidayWorkModal .hw-section-title').allInnerTexts(), ['新しく申請する', '承認待ち・承認済み', '過去の申請']);
      assert.equal(await sato.innerText('#btnHwNew'), '＋休日出勤を申請');
      const card = hubCard(sato, 'hwActiveList', '10/10');
      assert.match(await card.innerText(), /10\/10（土）[\s\S]*承認待ち[\s\S]*予定時間帯\s+09:00〜17:30（予定拘束 8:30）[\s\S]*振替休日\s+取得予定（日付未定）[\s\S]*<img src=x onerror="window.__xss=1">現場立ち会い/);
      assert.deepEqual(await card.locator('button').allInnerTexts(), ['申請を取り下げる'], '申請中は取り下げだけ');
      assert.equal(await sato.locator('#holidayWorkModal img').count(), 0);
      assert.equal(await sato.evaluate(() => window.__xss), undefined, '入力した文字はHTMLとして解釈しない');
      assert.match(await sato.innerText('#hwPastList'), /過去の申請はありません/);
      await shot(sato, 'holiday-01-hub');
    });

    await t.test('申請状況の［＋休日出勤を申請］→ フォーム（申請状況は閉じる）→［戻る］で申請状況へ。申請後も申請状況へ戻る', async () => {
      await sato.click('#btnHwNew');
      await sato.waitForSelector('#hwFormModal:not([hidden])');
      assert.equal(await sato.locator('#holidayWorkModal').isHidden(), true, '新規申請と既存の一覧を同時に出さない');
      await sato.click('#btnHwFormBack');
      await sato.waitForSelector('#holidayWorkModal:not([hidden])');
      assert.equal(await sato.locator('#hwFormModal').isHidden(), true);
      await sato.click('#btnHwNew');
      await sato.fill('#hwDate', '2026-10-11');
      await sato.fill('#hwStart', '10:00');
      await sato.fill('#hwEnd', '15:00');
      await sato.fill('#hwReason', '展示会の準備');
      await sato.fill('#hwContent', 'ショールームの設営');
      await sato.selectOption('#hwCompType', '取得予定なし');
      await sato.click('#btnSubmitHolidayWork');
      await sato.waitForSelector('#holidayWorkModal:not([hidden])');
      await sato.waitForFunction(() => document.querySelectorAll('#hwActiveList .hw-card').length === 2);
      assert.match(await hubCard(sato, 'hwActiveList', '10/11').innerText(), /振替休日\s+取得予定なし/);
    });

    await t.test('［申請を取り下げる］：専用の確認（対象の申請を表示）→ すぐ取消済みになり「過去の申請」へ', async () => {
      await hubCard(sato, 'hwActiveList', '10/11').locator('button', { hasText: '申請を取り下げる' }).click();
      await sato.waitForSelector('#hwWithdrawModal:not([hidden])');
      assert.match(await sato.innerText('#hwWithdrawTarget'), /休日出勤日\s+10\/11（日）[\s\S]*予定時間帯\s+10:00〜15:00[\s\S]*休日出勤理由\s+展示会の準備/);
      assert.equal(await sato.locator('#hwFormModal').isHidden(), true, '新規申請フォームは使わない');
      await sato.keyboard.press('Escape');
      assert.equal(await sato.locator('#hwWithdrawModal').isHidden(), true, 'Esc は上の確認だけ閉じる');
      assert.equal(await sato.locator('#holidayWorkModal').isHidden(), false);
      await hubCard(sato, 'hwActiveList', '10/11').locator('button', { hasText: '申請を取り下げる' }).click();
      await sato.click('#btnHwWithdrawBack');
      assert.equal(await sato.locator('#hwWithdrawModal').isHidden(), true);
      await hubCard(sato, 'hwActiveList', '10/11').locator('button', { hasText: '申請を取り下げる' }).click();
      await sato.click('#btnHwWithdrawOk');
      await sato.waitForFunction(() => /10\/11[\s\S]*取消済み/.test(document.getElementById('hwPastList').innerText));
      assert.equal(await hubCard(sato, 'hwPastList', '10/11').locator('button').count(), 0, '過去の申請には操作ボタンなし');
      await sato.click('#holidayWorkModal [data-close]');
    });

    await t.test('管理者：件数・却下は理由必須・承認', async () => {
      const yamada = await open('yamada@example.com', '/?view=admin');
      await yamada.waitForSelector('#admHolidayWork .request');
      assert.match(await yamada.locator('#summaryCards').innerText(), /休日出勤申請待ち\s*1\s*件/);
      assert.equal(await yamada.innerText('#hwPendingBadge'), '処理待ち 1件');
      const req = yamada.locator('#admHolidayWork .request').first();
      assert.match(await req.innerText(), /佐藤 花子[\s\S]*承認待ち[\s\S]*10\/10（土）　09:00〜17:30（予定拘束 8:30）[\s\S]*業務内容：配筋検査/);
      await req.locator('button', { hasText: '却下' }).click();
      await yamada.click('#btnAdminConfirmOk');
      assert.match(await lastToast(yamada), /却下理由を入力してください/);
      await yamada.click('#btnAdminConfirmCancel');
      await req.locator('button', { hasText: '承認' }).click();
      assert.match(await yamada.innerText('#adminConfirmText'), /遅刻・早退・社内超過を付けない計算に直します（打刻・実働は変わりません）/);
      await yamada.click('#btnAdminConfirmOk');
      await yamada.waitForFunction(() => /承認待ちの申請はありません|申請はありません/.test(document.getElementById('admHolidayWork').innerText));
      await yamada.check('#hwShowDone');
      assert.match(await yamada.locator('#admHolidayWork').innerText(), /承認済み[\s\S]*処理：山田 太郎/);
      await shot(yamada, 'holiday-02-admin');
      await yamada.close();
    });

    await t.test('［取消申請］（承認済み）：専用の取消画面（休日出勤日・予定時間帯・元の理由・取消理由は必須）→ 取消申請中 → 管理者が承認 → 過去の申請', async () => {
      await post('/__test/login', { email: 'sato@example.com' });
      await sato.reload();
      await toRequests(sato);
      await sato.waitForSelector('#holidayWorkCard:not([hidden])');
      await openHub(sato);
      const card = hubCard(sato, 'hwActiveList', '10/10');
      await card.waitFor();
      assert.match(await card.innerText(), /承認済み/);
      assert.deepEqual(await card.locator('button').allInnerTexts(), ['取消申請'], '承認済みは取消申請だけ（取り下げはできない）');
      await card.locator('button', { hasText: '取消申請' }).click();
      await sato.waitForSelector('#hwCancelModal:not([hidden])');
      assert.equal(await sato.locator('#hwFormModal').isHidden(), true, '新規申請フォームは使わない');
      assert.match(await sato.innerText('#hwCancelTarget'), /休日出勤日\s+10\/10（土）[\s\S]*予定時間帯\s+09:00〜17:30[\s\S]*休日出勤理由\s+<img src=x onerror="window.__xss=1">現場立ち会い/);
      assert.deepEqual(await sato.locator('#hwCancelModal button').allInnerTexts(), ['戻る', '取消を申請する']);
      await sato.click('#btnHwCancelOk');
      assert.match(await lastToast(sato), /取消理由を入力してください/);
      assert.equal(await sato.locator('#hwCancelModal').isHidden(), false);
      await sato.click('#btnHwCancelBack');
      assert.equal(await sato.locator('#hwCancelModal').isHidden(), true);
      await card.locator('button', { hasText: '取消申請' }).click();
      await sato.fill('#hwCancelReason', '立ち会い不要になった');
      await shot(sato, 'holiday-03-cancel');
      await sato.click('#btnHwCancelOk');
      await sato.waitForFunction(() => /取消申請中[\s\S]*取消理由\s+立ち会い不要になった[\s\S]*管理者の確認待ち/.test(document.getElementById('hwActiveList').innerText));
      assert.equal(await hubCard(sato, 'hwActiveList', '10/10').locator('button').count(), 0, '取消申請中はボタンなし');

      const yamada = await open('yamada@example.com', '/?view=admin');
      const req = yamada.locator('#admHolidayWork .request', { hasText: '取消申請中' });
      await req.waitFor();
      await req.locator('button', { hasText: '取消を承認' }).click();
      await yamada.click('#btnAdminConfirmOk');
      await idle(yamada);
      await yamada.check('#hwShowDone');
      await yamada.waitForFunction(() => /取消済み/.test(document.getElementById('admHolidayWork').innerText));
      await yamada.close();

      await post('/__test/login', { email: 'sato@example.com' });
      await sato.reload();
      await toRequests(sato);
      await sato.waitForSelector('#holidayWorkCard:not([hidden])');
      await openHub(sato);
      await sato.waitForFunction(() => /10\/10[\s\S]*取消済み/.test(document.getElementById('hwPastList').innerText));
      assert.match(await sato.innerText('#hwActiveList'), /承認待ち・承認済みの申請はありません/);
      await sato.close();
    });

    await t.test('スマホ：フォームが横にはみ出さない', async () => {
      const phone = await browser.newContext({ viewport: { width: 375, height: 760 }, isMobile: true, hasTouch: true, locale: 'ja-JP' });
      await post('/__test/login', { email: 'suzuki@example.com' });
      const p = await phone.newPage();
      await p.goto(base + '/');
      await toRequests(p);
      await p.waitForSelector('#holidayWorkCard:not([hidden])');
      await toRequests(p);
      await p.click('#btnOpenHolidayWorkHistory');
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, '申請状況');
      await p.click('#btnHwNew');
      await p.selectOption('#hwCompType', '取得予定');
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, '新規申請');
      await shot(p, 'holiday-04-phone');
      await phone.close();
    });

    assert.deepEqual(errors, [], 'ブラウザで JavaScript のエラーが出ていない');
  } finally {
    await browser.close();
    server.close();
  }
});
