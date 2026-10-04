'use strict';
// 段階3の画面（有給休暇申請・管理者の有給承認・日別/月次の有給）をブラウザ（Chromium）で操作するテスト。
// 今回はシフト管理を使わない（シフトのカード・シフトの表示は出さない）。
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

test('段階3の画面（有給休暇申請・管理者の承認・有給のバッジ）', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
  const { server, gas, calls } = createServer();
  // 有給申請対象：佐藤・鈴木＝対象、山田（管理者）＝対象外、田中＝空欄（申請できない）
  const sheet = gas.main.getSheetByName('スタッフマスタ');
  const col = sheet.data[0].indexOf('有給申請対象');
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
    await p.waitForFunction(() => !document.body.classList.contains('is-busy') && document.getElementById('statusLabel').textContent !== '');
    return p;
  };
  const idle = (p) => p.waitForFunction(() => !document.body.classList.contains('is-busy'));
  const lastToast = (p) => p.locator('#toasts .toast').last().innerText();
  const shot = async (p, name) => { if (SHOT_DIR) await p.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: true }); };
  const card = (p, list, text) => p.locator('#' + list + ' .hw-card', { hasText: text });

  try {
    await post('/__test/now', { now: '2026-10-02 10:00' });
    let sato;

    await t.test('対象外・空欄の人には有給のカードを出さない。シフトのカードは誰にも出さない', async () => {
      const tanaka = await open('tanaka@example.com');
      await idle(tanaka);
      assert.equal(await tanaka.locator('#paidLeaveCard').isHidden(), true);
      assert.equal(await tanaka.locator('#shiftCard').isHidden(), true);
      await tanaka.close();
    });

    await t.test('シフト管理を使わない：シフトのカード・シフトの表示は出さない', async () => {
      sato = await open('sato@example.com');
      await sato.waitForSelector('#paidLeaveCard:not([hidden])');
      assert.equal(await sato.locator('#shiftCard').isHidden(), true);
    });

    await t.test('有給の申請：シフトがなくても申請できる。1日有給・午前半休（事後申請）→ カードに承認待ち → 取り下げ', async () => {
      assert.deepEqual(await sato.locator('#paidLeaveCard button').allInnerTexts(), ['有給を申請する', '申請状況を見る']);
      await sato.click('#btnOpenPaidLeave');
      await sato.waitForSelector('#plFormModal:not([hidden])');
      assert.equal(await sato.inputValue('#plApplicant'), '佐藤 花子（E002）');
      assert.equal(await sato.getAttribute('#plDate', 'min'), '2026-09-21', '今の締め期間の初日から選べる');
      assert.match(await sato.innerText('#plTypeHelp'), /1日有給 8:00／半休 4:00/);
      await sato.fill('#plDate', '2026-10-07');
      await sato.dispatchEvent('#plDate', 'change');
      await sato.check('input[name="plType"][value="1日有給"]');
      await sato.fill('#plReason', '私用のため');
      assert.equal(await sato.innerText('#plShiftText'), '', 'シフトは表示しない');
      await sato.click('#btnSubmitPaidLeave');
      await sato.waitForSelector('#plFormModal', { state: 'hidden' });
      assert.match(await lastToast(sato), /有給を申請しました（2026-10-07・1日有給）/);
      // 事後申請（今の期間の過去日）
      await sato.click('#btnOpenPaidLeave');
      await sato.fill('#plDate', '2026-10-01');
      await sato.dispatchEvent('#plDate', 'change');
      assert.equal(await sato.locator('#plLateText').isVisible(), true, '過去の日は事後申請の案内');
      await sato.check('input[name="plType"][value="午前半休"]');
      await sato.fill('#plReason', '<b>通院</b>');
      await sato.click('#btnSubmitPaidLeave');
      await sato.waitForSelector('#plFormModal', { state: 'hidden' });
      await sato.waitForFunction(() => /10\/7[\s\S]*承認待ち/.test(document.getElementById('paidLeaveMiniList').innerText));
      await sato.click('#btnOpenPaidLeaveHistory');
      await sato.waitForSelector('#paidLeaveModal:not([hidden])');
      const c = card(sato, 'plActiveList', '10/1');
      assert.match(await c.innerText(), /午前半休[\s\S]*事後申請[\s\S]*承認待ち[\s\S]*<b>通院<\/b>/);
      assert.doesNotMatch(await sato.innerText('#paidLeaveModal'), /シフト|未登録/, '申請状況にシフトを出さない');
      assert.equal(await sato.locator('#paidLeaveModal b').count(), 0, '入力はHTMLとして解釈しない');
      assert.deepEqual(await c.locator('button').allInnerTexts(), ['申請を取り下げる']);
      await shot(sato, 's3-02-paid-leave');
      // 取り下げ
      await c.locator('button', { hasText: '申請を取り下げる' }).click();
      await sato.waitForSelector('#plWithdrawModal:not([hidden])');
      await sato.click('#btnPlWithdrawOk');
      await sato.waitForFunction(() => /10\/1[\s\S]*取消済み/.test(document.getElementById('plPastList').innerText));
      await sato.click('#paidLeaveModal [data-pl-close]');
    });

    await t.test('管理者：有給申請の件数・却下は理由必須・承認。日別に「有給」のバッジ', async () => {
      const yamada = await open('yamada@example.com', '/?view=admin');
      await yamada.waitForSelector('#admPaidLeave .request');
      assert.match(await yamada.locator('#summaryCards').innerText(), /有給申請待ち\s*1\s*件/);
      const req = yamada.locator('#admPaidLeave .request').first();
      assert.match(await req.innerText(), /佐藤 花子[\s\S]*承認待ち[\s\S]*10\/7（水）　1日有給/);
      assert.doesNotMatch(await req.innerText(), /シフト|未登録|承認できません/, 'シフト未登録でも承認できる・シフトの表示なし');
      await req.locator('button', { hasText: '却下' }).click();
      await yamada.click('#btnAdminConfirmOk');
      assert.match(await lastToast(yamada), /却下理由を入力してください/);
      await yamada.click('#btnAdminConfirmCancel');
      await req.locator('button', { hasText: '承認' }).click();
      await yamada.click('#btnAdminConfirmOk');
      await yamada.waitForFunction(() => /承認待ちの申請はありません|申請はありません/.test(document.getElementById('admPaidLeave').innerText));
      await yamada.check('#plShowDone');
      assert.match(await yamada.locator('#admPaidLeave').innerText(), /承認済み[\s\S]*処理：山田 太郎/);
      // 日別：勤怠記録がない日も「有給」
      await yamada.fill('#admDate', '2026-10-07');
      await yamada.dispatchEvent('#admDate', 'change');
      await yamada.waitForFunction(() => /10\/7/.test(document.getElementById('admTableTitle').textContent));
      assert.match(await yamada.locator('#admTableBody tr', { hasText: '佐藤 花子' }).innerText(), /有給/);
      assert.equal(await yamada.locator('#admTableBody tr', { hasText: '佐藤 花子' }).locator('.badge-leave').count(), 1);
      // 月次：有給の回数・時間
      await yamada.click('#adminView .tab[data-mode="monthly"]');
      await yamada.fill('#admMonth', '2026-10');
      await yamada.dispatchEvent('#admMonth', 'change');
      await yamada.waitForFunction(() => /対象期間/.test(document.getElementById('admTableTitle').textContent));
      assert.match(await yamada.locator('#admTableHead').innerText(), /休日出勤\s+有給（1日\/午前\/午後）\s+有給時間\s+在宅日数\s+要確認（申請）/);
      assert.doesNotMatch(await yamada.locator('#admTableHead').innerText(), /法定休日出勤|シフト/, '法定休日出勤・シフトの列は出さない');
      assert.match(await yamada.locator('#admTableBody tr', { hasText: '佐藤 花子' }).innerText(), /8:00/);
      await shot(yamada, 's3-03-admin');
      await yamada.close();
    });

    await t.test('承認済みは［取消申請］（取消理由は必須）→ 取消申請中', async () => {
      await post('/__test/login', { email: 'sato@example.com' });
      await sato.reload();
      await sato.waitForSelector('#paidLeaveCard:not([hidden])');
      await sato.click('#btnOpenPaidLeaveHistory');
      const c = card(sato, 'plActiveList', '10/7');
      await c.waitFor();
      assert.deepEqual(await c.locator('button').allInnerTexts(), ['取消申請']);
      await c.locator('button', { hasText: '取消申請' }).click();
      await sato.waitForSelector('#plCancelModal:not([hidden])');
      await sato.click('#btnPlCancelOk');
      assert.match(await lastToast(sato), /取消理由を入力してください/);
      await sato.fill('#plCancelReason', '予定が変わった');
      await sato.click('#btnPlCancelOk');
      await sato.waitForFunction(() => /取消申請中[\s\S]*予定が変わった/.test(document.getElementById('plActiveList').innerText));
      await sato.close();
    });

    await t.test('他の人の画面には佐藤さんの有給が出ない。管理者用の関数を呼んでいない。JavaScript のエラーなし', async () => {
      const s = await open('suzuki@example.com');
      await s.waitForSelector('#paidLeaveCard:not([hidden])');
      await s.click('#btnOpenPaidLeaveHistory');
      await s.waitForFunction(() => /承認待ち・承認済みの申請はありません/.test(document.getElementById('plActiveList').innerText));
      assert.doesNotMatch(await s.locator('#paidLeaveModal').innerText(), /予定が変わった|通院/);
      await s.close();
      assert.deepEqual(errors, []);
      assert.ok(calls.includes('submitPaidLeaveRequest') && calls.includes('approvePaidLeaveRequest'));
      assert.ok(!calls.includes('getMyShifts') && !calls.includes('getMyShiftOn'), 'シフトの関数は呼ばない');
    });
  } finally {
    await browser.close();
    server.close();
  }
});
