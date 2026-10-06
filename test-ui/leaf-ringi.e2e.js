'use strict';
// 稟議申請の画面（スタッフ画面の申請・一覧・詳細・確定金額、管理者画面の承認・再承認・再承認却下）をブラウザ（Chromium）で操作するテスト。
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


test('稟議申請の画面', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
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
    return p;
  };
  const idle = (p) => p.waitForFunction(() => !document.body.classList.contains('is-busy'));
  const toast = (p) => p.locator('#toasts .toast').last().innerText();
  const shot = async (p, name) => { if (SHOT_DIR) await p.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: true }); };
  const ringiRow = () => gas.main.rows('稟議管理')[0];

  try {
    await post('/__test/now', { now: '2026-10-06 10:00' });
    let sato;
    await t.test('スタッフ：［稟議申請］→ 申請者・申請日・メールは自動表示（入力させない）→ 入力チェック → 申請', async () => {
      sato = await open('sato@example.com');
      await toRequests(sato);
      await sato.waitForSelector('#ringiCard:not([hidden])');
      await toRequests(sato);
      await sato.click('#btnOpenRingi');
      await sato.waitForSelector('#ringiFormModal:not([hidden])');
      assert.equal(await sato.inputValue('#ringiApplicant'), '佐藤 花子（E002）');
      assert.equal(await sato.inputValue('#ringiEmail'), 'sato@example.com');
      assert.match(await sato.inputValue('#ringiRequestDate'), /10\/6/);
      for (const id of ['#ringiApplicant', '#ringiEmail', '#ringiRequestDate']) assert.equal(await sato.getAttribute(id, 'readonly'), '', id + ' は読み取り専用');
      await sato.fill('#ringiItem', 'ショールーム用チェア');
      await sato.fill('#ringiQuantity', '2');
      await sato.selectOption('#ringiExpenseType', '備品購入');
      await sato.fill('#ringiPurpose', '展示替えのため');
      await sato.check('input[name="ringiCertainty"][value="概算"]');
      await sato.fill('#ringiAmount', '120,000');
      assert.match(await sato.innerText('#ringiAmountText'), /数字だけ/);
      await sato.fill('#ringiPlannedDate', '2026-10-20');
      await sato.click('#btnSubmitRingi');
      assert.match(await toast(sato), /見積金額は数字だけ/);
      assert.equal(calls.includes('submitRingiRequest'), false, '画面の確認で止まり、送らない');
      await sato.fill('#ringiAmount', '120000');
      assert.match(await sato.innerText('#ringiAmountText'), /120,000円（税込）/);
      await sato.fill('#ringiUrl', 'https://drive.google.com/file/d/xyz/view');
      await shot(sato, 'ringi-01-form');
      await sato.click('#btnSubmitRingi');
      await idle(sato);
      assert.match(await toast(sato), /稟議を申請しました（RG-20261006100000-E002）/);
      assert.deepEqual([ringiRow()['申請者名'], ringiRow()['社員ID'], ringiRow()['申請者メール'], ringiRow()['申請金額'], ringiRow()['申請状態']],
        ['佐藤 花子', 'E002', 'sato@example.com', 120000, '申請中']);
      assert.match(await sato.innerText('#ringiMiniList'), /ショールーム用チェア\s+120,000円\s+申請中/);
    });

    await t.test('スタッフ：申請状況の一覧（稟議ID・申請日・申請者名・購入品名・申請金額・確度・申請状態）と詳細。承認ボタンはない', async () => {
      await toRequests(sato);
      await sato.click('#btnOpenRingiHistory');
      const card = await sato.locator('#ringiList .ringi-card').first().innerText();
      assert.match(card, /ショールーム用チェア[\s\S]*申請中[\s\S]*RG-20261006100000-E002[\s\S]*10\/6[\s\S]*佐藤 花子[\s\S]*120,000円（概算）/);
      await sato.locator('#ringiList .js-ringi-detail').first().click();
      await sato.waitForSelector('#ringiDetailModal:not([hidden])');
      assert.match(await sato.innerText('#ringiDetailInfo'), /申請状態\s+申請中[\s\S]*購入数量\s+2[\s\S]*見積書・資料\s+https:\/\/drive.google.com/);
      assert.equal(await sato.locator('#ringiFinalSection').isHidden(), true, '承認前は確定金額を入力できない');
      assert.equal(await sato.locator('#ringiDetailModal button', { hasText: '承認' }).count(), 0);
      await sato.click('#btnRingiDetailBack');
      await sato.click('#ringiModal [data-close]');
    });

    let admin;
    await t.test('管理者：申請中の一覧から承認（確認画面のあと）', async () => {
      admin = await open('yamada@example.com', '/?view=admin');
      await admin.waitForSelector('#adminContent:not([hidden])');
      const item = admin.locator('#admRingiPending .request', { hasText: 'ショールーム用チェア' });
      assert.match(await item.innerText(), /佐藤 花子[\s\S]*申請中[\s\S]*120,000円（概算）[\s\S]*RG-20261006100000-E002/);
      assert.match(await admin.innerText('#rgPendingBadge'), /処理待ち 1件/);
      await item.locator('button', { hasText: /^承認$/ }).click();
      await admin.click('#btnAdminConfirmOk');
      await idle(admin);
      assert.match(await toast(admin), /稟議を承認しました/);
      assert.equal(ringiRow()['申請状態'], '承認済');
      assert.equal(ringiRow()['承認者'], '山田 太郎');
    });

    await t.test('スタッフ：概算の確定金額を入力（申請金額以下 → 承認済）→ 訂正で超過（→ 再承認待ち）', async () => {
      await post('/__test/login', { email: 'sato@example.com' }); // テスト用サーバーのログインは1つなので、開き直す前に切り替える
      await sato.reload();
      await toRequests(sato);
      await sato.waitForSelector('#ringiCard:not([hidden])');
      await toRequests(sato);
      await sato.click('#btnOpenRingiHistory');
      await sato.locator('#ringiList .js-ringi-detail', { hasText: '確定金額を入力' }).click();
      await sato.waitForSelector('#ringiFinalSection:not([hidden])');
      await sato.fill('#ringiFinalAmount', '110000');
      assert.match(await sato.innerText('#ringiFinalPreview'), /110,000円・差額 -10,000円　→ 承認済のままです/);
      await sato.click('#btnRingiFinalSave');
      await idle(sato);
      assert.match(await toast(sato), /申請金額以下のため「承認済」/);
      await sato.waitForFunction(() => /確定金額を訂正/.test(document.getElementById('ringiFinalTitle').textContent));
      await sato.fill('#ringiFinalAmount', '125000');
      assert.match(await sato.innerText('#ringiFinalPreview'), /差額 \+5,000円　→ 再承認待ちになります/);
      await sato.fill('#ringiFinalMemo', '送料が追加');
      await sato.click('#btnRingiFinalSave');
      await idle(sato);
      assert.match(await toast(sato), /「再承認待ち」になりました/);
      await sato.waitForFunction(() => /再承認待ち/.test(document.getElementById('ringiDetailInfo').innerText));
      assert.match(await sato.innerText('#ringiHistory'), /確定金額入力[\s\S]*確定金額 110,000円[\s\S]*確定金額訂正[\s\S]*110,000円 → 125,000円[\s\S]*送料が追加/);
      await shot(sato, 'ringi-02-detail');
      assert.deepEqual([ringiRow()['申請金額'], ringiRow()['確定金額'], ringiRow()['概算との差額'], ringiRow()['再承認要否'], ringiRow()['申請状態']], [120000, 125000, 5000, '要', '再承認待ち']);
      await sato.click('#btnRingiDetailBack');
      await sato.click('#ringiModal [data-close]');
    });

    await t.test('管理者：再承認待ちの一覧から再承認 → 再承認済。その後は確定金額を変更できない', async () => {
      await post('/__test/login', { email: 'yamada@example.com' });
      await admin.click('#btnAdminReload');
      await idle(admin);
      const item = admin.locator('#admRingiReapproval .request', { hasText: 'ショールーム用チェア' });
      assert.match(await item.innerText(), /確定金額：125,000円（差額 \+5,000円）/);
      await shot(admin, 'ringi-03-admin');
      await item.locator('button', { hasText: /^再承認$/ }).click();
      assert.match(await admin.innerText('#adminConfirmText'), /申請金額を 5,000円 超過/);
      await admin.click('#btnAdminConfirmOk');
      await idle(admin);
      assert.match(await toast(admin), /再承認しました/);
      assert.equal(ringiRow()['申請状態'], '再承認済');
      await post('/__test/login', { email: 'sato@example.com' }); // テスト用サーバーのログインは1つなので、開き直す前に切り替える
      await sato.reload();
      await toRequests(sato);
      await sato.waitForSelector('#ringiCard:not([hidden])');
      await toRequests(sato);
      await sato.click('#btnOpenRingiHistory');
      await sato.locator('#ringiList .js-ringi-detail').first().click();
      await sato.waitForSelector('#ringiDetailModal:not([hidden])');
      assert.equal(await sato.locator('#ringiFinalSection').isHidden(), true, '再承認済は確定金額の欄を出さない');
      await sato.click('#btnRingiDetailBack');
      await sato.click('#ringiModal [data-close]');
    });

    await t.test('管理者：再承認を却下（理由必須）→ 却下（再承認却下）', async () => {
      // 2件目：申請 → 承認 → 超過
      gas.loginAs('sato@example.com'); gas.setNow('2026-10-06 11:00');
      const id = gas.g.submitRingiRequest({ itemName: '照明', quantity: '1', expenseType: '備品購入', purpose: '交換', certainty: '概算', amount: '30000', plannedDate: '2026-10-10', attachmentUrl: '' }).data.ringiId;
      gas.loginAs('yamada@example.com'); gas.g.approveRingiRequest(id);
      gas.loginAs('sato@example.com'); gas.g.enterRingiFinalAmount(id, '40000', '');
      await post('/__test/login', { email: 'yamada@example.com' });
      await admin.click('#btnAdminReload');
      await idle(admin);
      const item = admin.locator('#admRingiReapproval .request', { hasText: '照明' });
      await item.locator('button', { hasText: '再承認を却下' }).click();
      await admin.click('#btnAdminConfirmOk');
      assert.match(await toast(admin), /却下理由を入力/);
      await admin.fill('#adminConfirmReason', '予算外');
      await admin.click('#btnAdminConfirmOk');
      await idle(admin);
      assert.match(await toast(admin), /再承認を却下しました/);
      const row = gas.main.rows('稟議管理').find((r) => r['稟議ID'] === id);
      assert.deepEqual([row['申請状態'], row['却下区分'], row['却下理由']], ['却下', '再承認却下', '予算外']);
    });

    await t.test('一般スタッフの画面からは承認系の関数を呼ばない。JavaScript のエラーなし', async () => {
      assert.deepEqual(errors, []);
      for (const fn of ['getMyRingiRequests', 'submitRingiRequest', 'getRingiRequestDetail', 'enterRingiFinalAmount', 'approveRingiRequest', 'reapproveRingiRequest', 'rejectRingiReapproval']) {
        assert.ok(calls.includes(fn), fn);
      }
      // 画面を通さず、一般スタッフとして承認の関数を直接呼んでも拒否される（サーバー側の確認）
      await post('/__test/login', { email: 'tanaka@example.com' });
      const before = JSON.stringify(gas.main.rows('稟議管理'));
      for (const fn of ['approveRingiRequest', 'reapproveRingiRequest', 'rejectRingiRequest']) {
        const body = await (await post('/__gas', { fn, args: [gas.main.rows('稟議管理')[1]['稟議ID'], '理由'] })).json();
        const result = body.result || body;
        assert.equal(result.success, false, fn);
        assert.match(result.message, /管理者権限がありません/);
      }
      assert.equal(JSON.stringify(gas.main.rows('稟議管理')), before);
      await sato.close();
      await admin.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
});
