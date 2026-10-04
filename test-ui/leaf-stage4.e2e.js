'use strict';
// 段階4の日報の画面（書き忘れた日・担当区分／主担当者・来場きっかけ・一覧の未確認者とコメント件数・管理者のコメント削除・日報の月別）
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

test('段階4の日報の画面', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
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
    p.on('dialog', (d) => d.accept());
    await p.goto(base + (url || '/'));
    await p.waitForSelector('#app:not([hidden])');
    return p;
  };
  const idle = (p) => p.waitForFunction(() => !document.body.classList.contains('is-busy'));
  const toast = (p) => p.locator('#toasts .toast').last().innerText();
  const shot = async (p, name) => { if (SHOT_DIR) await p.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: true }); };

  try {
    // 佐藤さんは 10/1 に勤務（日報を書き忘れ）
    gas.loginAs('sato@example.com');
    gas.setNow('2026-10-01 09:30'); gas.g.clockIn('出社');
    gas.setNow('2026-10-01 18:30'); gas.g.clockOut();
    await post('/__test/now', { now: '2026-10-05 18:00' });
    let sato;

    await t.test('書き忘れた日：一覧に「10/1 の日報を書く」→ 入力画面の日付は 10/1（編集不可）', async () => {
      sato = await open('sato@example.com', '/?view=reports');
      await sato.waitForSelector('#reportMissing:not([hidden])');
      assert.match(await sato.innerText('#reportMissingList'), /2026年10月1日（木）の日報を書く/);
      await sato.click('#reportMissingList button');
      await sato.waitForFunction(() => /新しい日報/.test(document.getElementById('reportEditorState').innerText));
      assert.equal(await sato.inputValue('#reportDateText'), '2026年10月1日（木）');
      assert.equal(await sato.getAttribute('#reportDateText', 'readonly'), '');
    });

    await t.test('接客：担当区分（主担当が既定）。副担当を選ぶと主担当者を選ぶ欄が出て、未選択では提出できない。来場きっかけは新しい選択肢', async () => {
      await sato.click('#btnAddCustomer');
      const card = sato.locator('.customer-card').first();
      assert.equal(await card.locator('.js-role[value="主担当"]').isChecked(), true);
      assert.equal(await card.locator('.js-main').isHidden(), true, '主担当のときは主担当者の欄を出さない');
      const triggers = await card.locator('.js-trigger option').allInnerTexts();
      assert.deepEqual(triggers, ['選択してください', 'Google検索', 'Yahoo!検索', '検索（不明）', 'Googleマップ', 'Instagram', 'LINE', '紹介', '既存顧客', '看板', '通りがかり',
        'チラシ', 'イベント（見学会など）', 'その他', '未確認']);
      assert.match(await card.innerText(), /対応結果（任意）[\s\S]*備考（任意）[\s\S]*次回対応（任意）/);
      await card.locator('.js-name').fill('<b>高橋様</b>');
      await card.locator('.js-role[value="副担当"]').check();
      assert.equal(await card.locator('.js-main').isVisible(), true);
      assert.deepEqual(await card.locator('.js-main option').allInnerTexts(), ['選択してください', '山田 太郎', '鈴木 一郎', '田中 美咲'], '自分以外の在籍者');
      await card.locator('.js-trigger').selectOption('Yahoo!検索');
      await sato.fill('#repWorkContent', '来場対応');
      await sato.click('#btnReportSubmit');
      assert.match(await toast(sato), /副担当のときは主担当者を選んでください/);
      await card.locator('.js-main').selectOption({ label: '鈴木 一郎' });
      await card.locator('.js-note').fill('駐車場の確認');
      await sato.click('#btnReportSubmit');
      await sato.click('#btnReportConfirmOk');
      await sato.waitForSelector('#reportDetailPane:not([hidden]) .report-head');
      const body = await sato.innerText('#reportDetailBody');
      assert.match(body, /2026年10月1日（木）[\s\S]*顧客名\s+<b>高橋様<\/b>[\s\S]*担当区分\s+副担当（主担当：鈴木 一郎）[\s\S]*来場のきっかけ\s+Yahoo!検索[\s\S]*備考\s+駐車場の確認/);
      const row = gas.main.rows('日報_接客')[0];
      assert.deepEqual([row['日付'], row['担当区分'], row['主担当者ID'], row['主担当者名'], row['補足コメント']], ['2026-10-01', '副担当', 'E003', '鈴木 一郎', '駐車場の確認']);
      await shot(sato, 's4-01-detail');
      await sato.click('#btnReportBackToList');
      await sato.waitForSelector('#reportListPane:not([hidden]) .report-card');
      assert.equal(await sato.locator('#reportMissing').isHidden(), true, '書いた日は書き忘れた日の一覧から消える');
    });

    await t.test('他社員：一覧に コメント件数・未確認者。コメントを投稿（連打しても1件）', async () => {
      const suzuki = await open('suzuki@example.com', '/?view=reports');
      await suzuki.waitForSelector('#reportListPane:not([hidden]) .report-card');
      assert.match(await suzuki.locator('.report-card').first().innerText(), /0 \/ 3人 確認済み\s+コメント 0件\s+未確認：山田 太郎、鈴木 一郎、田中 美咲/);
      await suzuki.click('.report-card button');
      await suzuki.waitForSelector('#btnConfirmReport');
      await suzuki.click('#btnConfirmReport');
      await suzuki.waitForFunction(() => /1人 \/ 3人確認済み/.test(document.getElementById('reportDetailBody').innerText));
      await suzuki.fill('#reportCommentText', '主担当として確認しました');
      await suzuki.dblclick('#btnPostComment');
      await suzuki.waitForSelector('.comment-item');
      await idle(suzuki);
      assert.equal(gas.main.rows('日報_コメント').length, 1, '連打しても1件');
      assert.equal(await suzuki.locator('.comment-item button').count(), 0, '一般社員には削除ボタンを出さない');
      assert.match(await suzuki.innerText('#reportDetailBody'), /コメントは投稿後に編集できません/);
      await suzuki.click('#btnReportBackToList');
      await suzuki.waitForFunction(() => /コメント 1件\s+未確認：山田 太郎、田中 美咲/.test(document.getElementById('reportCards').innerText));
      await suzuki.close();
    });

    await t.test('管理者：コメントを削除できる（画面から消え、行は残る）。日報の月別に勤務日数・提出数', async () => {
      const yamada = await open('yamada@example.com', '/?view=admin');
      await yamada.waitForSelector('#adminContent:not([hidden])');
      await yamada.fill('#admDate', '2026-10-01');
      await yamada.dispatchEvent('#admDate', 'change');
      await yamada.waitForFunction(() => /10\/1/.test(document.getElementById('admReportDate').textContent));
      assert.match(await yamada.innerText('#admReports'), /佐藤 花子[\s\S]*コメント 1件[\s\S]*1 \/ 3人 確認済み[\s\S]*未確認：山田 太郎、田中 美咲[\s\S]*提出済み/);
      assert.match(await yamada.innerText('#admReportMonthTitle'), /日報の月別（2026年10月 期間：2026\/10\/01〜2026\/10\/31）/);
      assert.match(await yamada.locator('#admReportMonthBody tr', { hasText: '佐藤 花子' }).innerText(), /佐藤 花子\s+1日\s+1件\s+—\s+—/);
      await yamada.locator('#admReports button', { hasText: '日報を見る' }).click();
      await yamada.waitForSelector('#reportDetailPane:not([hidden]) .comment-item');
      await yamada.locator('.comment-item button', { hasText: '削除（管理者）' }).click();
      await yamada.waitForFunction(() => /コメントはまだありません/.test(document.getElementById('reportDetailBody').innerText));
      const c = gas.main.rows('日報_コメント')[0];
      assert.deepEqual([c['削除'], c['削除者ID']], ['1', 'E001']);
      await shot(yamada, 's4-02-admin');
      await yamada.close();
    });

    await t.test('JavaScript のエラーなし。スタッフは管理者用の関数を呼んでいない', async () => {
      assert.deepEqual(errors, []);
      const staffCalls = calls.slice(0, calls.indexOf('getAdminDashboard'));
      assert.ok(!staffCalls.includes('deleteReportComment'));
      assert.ok(calls.includes('deleteReportComment') && calls.includes('addReportComment'));
    });
  } finally {
    await browser.close();
    server.close();
  }
});
