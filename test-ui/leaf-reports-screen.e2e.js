'use strict';
// 日報の画面（入力・一覧・閲覧・確認・コメント・修正）をブラウザ（Chromium）で操作するテスト。
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

test('日報の画面', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
  const { server, gas, calls } = createServer();
  // 役員（勤怠集計対象外）を1名追加
  gas.g.appendRecords_('スタッフマスタ', [{ '社員ID': 'E009', '氏名': '猪倉 厚', 'メールアドレス': 'inokura@example.com', '権限': 'staff', '勤務区分': '固定勤務', '在籍状況': '在籍', '部署': '管理', '勤怠集計対象': '対象外' }]);
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

  try {
    await post('/__test/now', { now: '2026-10-02 18:00' });
    // 鈴木は下書きだけ（他の人には見えないはず）
    await post('/__test/login', { email: 'suzuki@example.com' });
    await fetch(base + '/__gas', { method: 'POST', body: JSON.stringify({ fn: 'saveReportDraft', args: [{ workContent: '鈴木の下書きメモ' }] }) });

    const sato = await open('sato@example.com');

    await t.test('入力画面：日付・担当者は自動（編集不可）、接客記録カードの追加・削除・条件つきの入力', async () => {
      await sato.click('#btnOpenReport');
      await sato.waitForFunction(() => /新しい日報/.test(document.getElementById('reportEditorState').innerText));
      assert.equal(await sato.inputValue('#reportDateText'), '2026年10月2日（金）');
      assert.equal(await sato.inputValue('#reportAuthorText'), '佐藤 花子');
      assert.equal(await sato.getAttribute('#reportDateText', 'readonly'), '');
      assert.equal(await sato.getAttribute('#reportAuthorText', 'readonly'), '');
      for (let i = 0; i < 3; i++) await sato.click('#btnAddCustomer');
      assert.deepEqual(await sato.locator('.customer-title').allInnerTexts(), ['接客1', '接客2', '接客3']);
      assert.equal(await sato.locator('#customerCountBadge').innerText(), '接客 3件');
      await sato.locator('.customer-card').nth(1).locator('button', { hasText: '削除' }).click();
      assert.deepEqual(await sato.locator('.customer-title').allInnerTexts(), ['接客1', '接客2'], '番号は付け直す');
      assert.equal(await sato.locator('#customerCountBadge').innerText(), '接客 2件');

      const c1 = sato.locator('.customer-card').nth(0);
      await c1.locator('.js-unknown').check();
      assert.equal(await c1.locator('.js-name').isDisabled(), true, '未確認なら顧客名は入力できない');
      await c1.locator('.js-trigger').selectOption('その他');
      assert.equal(await c1.locator('.js-other').isVisible(), true, '「その他」のときだけ「その他の内容」');
      await c1.locator('.js-other').fill('知人のSNS');
      await c1.locator('.js-content').fill('平屋の相談\n土地は未定');
      await c1.locator('.js-result').selectOption('次回予約');
      assert.equal(await c1.locator('.js-next-detail').isVisible(), false);
      await c1.locator('label', { hasText: '必要' }).click();
      assert.equal(await c1.locator('.js-next-detail').isVisible(), true, '「必要」のときだけ「次回対応内容」');
      await c1.locator('.js-next-detail').fill('再来店');

      const c2 = sato.locator('.customer-card').nth(1);
      await c2.locator('.js-name').fill('山田様');
      await c2.locator('.js-trigger').selectOption('Instagram');
      assert.equal(await c2.locator('.js-other').isVisible(), false);
      await c2.locator('.js-result').selectOption('見積提出');
      await c2.locator('label', { hasText: '不要' }).click();
      await sato.fill('#repWorkContent', '現場打合せ・ショールーム接客');
      await sato.fill('#repConsultation', '見積の値引き幅について');
      await shot(sato, 'report-01-editor');
    });

    await t.test('提出：確認ダイアログ（キャンセルなら提出しない）→ 提出 → 閲覧画面', async () => {
      await sato.click('#btnReportSubmit');
      assert.equal(await sato.locator('#reportConfirmTitle').innerText(), '日報を提出しますか？');
      assert.equal(await sato.locator('#reportConfirmText').innerText(), '提出後は全社員が閲覧できます。');
      await sato.click('#btnReportConfirmCancel');
      assert.equal(calls.includes('submitReport'), false);
      await post('/__test/delay', { ms: 300 });
      await sato.click('#btnReportSubmit');
      await sato.click('#btnReportConfirmOk');
      await sato.evaluate(() => { document.getElementById('btnReportSubmit').click(); });
      await sato.waitForSelector('#reportDetailPane:not([hidden]) .report-head');
      await post('/__test/delay', { ms: 0 });
      assert.equal(calls.filter((c) => c === 'submitReport').length, 1, '連打しても1回');
      const body = await sato.locator('#reportDetailBody').innerText();
      assert.match(body, /接客記録（2件）[\s\S]*接客1[\s\S]*顧客名\s+未確認[\s\S]*その他（知人のSNS）[\s\S]*次回対応\s+必要：再来店[\s\S]*接客2[\s\S]*山田様/);
      assert.match(body, /0人 \/ 4人確認済み/, '分母は在籍5名−本人（役員を含む）');
      assert.match(body, /あなたの日報（確認の対象外）/);
      const row = gas.main.rows('日報_接客').filter((r) => r['削除'] !== '1')[0];
      assert.deepEqual([row['顧客名'], row['顧客名未確認']], ['', '1']);
    });

    await t.test('一覧：他人の下書きは出ない。提出済みは全員が見られる', async () => {
      const yamada = await open('yamada@example.com', '/?view=reports');
      await yamada.waitForSelector('#reportListPane:not([hidden]) .report-card');
      const list = await yamada.locator('#reportListPane').innerText();
      assert.match(list, /2026年10月2日（金）\s+佐藤 花子\s+接客 2件\s+0 \/ 4人 確認済み[\s\S]*未確認/);
      assert.doesNotMatch(list, /鈴木/, '鈴木の下書きは管理者にも見えない');
      assert.equal(await yamada.locator('#reportMyDrafts').isHidden(), true);
      await yamada.close();
    });

    let inokura;
    await t.test('役員も確認・コメントできる（コメントはHTMLとして解釈しない）', async () => {
      inokura = await open('inokura@example.com', '/?view=reports');
      await inokura.locator('.report-card', { hasText: '佐藤 花子' }).locator('button', { hasText: '日報を見る' }).click();
      await inokura.waitForSelector('#btnConfirmReport');
      await inokura.click('#btnConfirmReport');
      await inokura.waitForFunction(() => /1人 \/ 4人確認済み/.test(document.getElementById('reportDetailBody').innerText));
      assert.match(await inokura.locator('.confirm-lists').innerText(), /確認済み（1人）\s+猪倉 厚[\s\S]*未確認（3人）/);
      await inokura.fill('#reportCommentText', '<img src=x onerror="window.__xss=1"> お疲れさまです');
      await inokura.click('#btnPostComment');
      await inokura.waitForSelector('.comment-item');
      assert.match(await inokura.locator('.comment-text').innerText(), /<img src=x onerror="window.__xss=1"> お疲れさまです/);
      assert.equal(await inokura.evaluate(() => window.__xss), undefined, 'コメントの中のHTMLは実行されない');
      assert.equal(await inokura.locator('.comment-item img').count(), 0);
      await shot(inokura, 'report-02-detail');
    });

    await t.test('提出者が修正 → 全員「未確認」・「更新あり」、再確認で解除', async () => {
      // 開発用サーバーのログインは1人分だけなので、操作する人に切り替える（本番はブラウザごとに別ログイン）
      await post('/__test/login', { email: 'sato@example.com' });
      await sato.click('#btnReportEdit');
      await sato.waitForFunction(() => /提出済み（バージョン1）/.test(document.getElementById('reportEditorState').innerText));
      assert.equal(await sato.locator('#btnReportDraft').isHidden(), true, '提出済みは下書きに戻せない');
      assert.equal(await sato.locator('#btnReportSubmit').innerText(), '修正を提出');
      await sato.fill('#repHandover', '明日の朝に見積を送付');
      await sato.click('#btnReportSubmit');
      assert.match(await sato.locator('#reportConfirmText').innerText(), /未確認」に戻り/);
      await sato.click('#btnReportConfirmOk');
      await sato.waitForFunction(() => /バージョン 2/.test(document.getElementById('reportDetailBody').innerText));

      await post('/__test/login', { email: 'inokura@example.com' });
      await inokura.click('#btnReportBackToList');
      await inokura.waitForSelector('.report-card .badge-updated');
      assert.match(await inokura.locator('.report-card', { hasText: '佐藤 花子' }).innerText(), /0 \/ 4人 確認済み[\s\S]*更新あり/);
      await inokura.locator('.report-card', { hasText: '佐藤 花子' }).locator('button', { hasText: '日報を見る' }).click();
      await inokura.waitForSelector('#btnConfirmReport');
      assert.match(await inokura.locator('#reportDetailBody').innerText(), /更新あり：この日報は提出後に修正されています/);
      assert.match(await inokura.locator('.confirm-lists').innerText(), /猪倉 厚\s+修正前の版を確認/);
      await inokura.click('#btnConfirmReport');
      await inokura.waitForFunction(() => /1人 \/ 4人確認済み/.test(document.getElementById('reportDetailBody').innerText));
      assert.doesNotMatch(await inokura.locator('#reportDetailBody').innerText(), /更新あり：/);
      await inokura.locator('.history-box summary').click();
      assert.match(await inokura.locator('.history-box').innerText(), /佐藤 花子　提出[\s\S]*猪倉 厚　確認（バージョン1）[\s\S]*日報を修正（バージョン2）[\s\S]*猪倉 厚　確認（バージョン2）/);
      await inokura.close();
    });

    await t.test('自分の下書きは本人の一覧にだけ出て、続きから編集できる', async () => {
      const suzuki = await open('suzuki@example.com', '/?view=reports');
      await suzuki.waitForSelector('#reportMyDrafts:not([hidden]) .report-card');
      await suzuki.locator('#reportDraftCards button', { hasText: '下書きを編集' }).click();
      await suzuki.waitForFunction(() => document.getElementById('repWorkContent').value === '鈴木の下書きメモ');
      assert.equal(await suzuki.locator('#btnReportDraft').isVisible(), true);
      await suzuki.close();
    });

    await t.test('スマホ：横にはみ出さず、保存・提出のボタンが画面の下に見える', async () => {
      const phone = await browser.newContext({ viewport: { width: 375, height: 760 }, isMobile: true, hasTouch: true, locale: 'ja-JP' });
      await post('/__test/login', { email: 'tanaka@example.com' });
      const p = await phone.newPage();
      await p.goto(base + '/');
      await p.waitForSelector('#app:not([hidden])');
      await p.click('#btnOpenReport');
      await p.waitForFunction(() => /新しい日報/.test(document.getElementById('reportEditorState').innerText));
      await p.click('#btnAddCustomer');
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0);
      const bar = await p.locator('#btnReportSubmit').boundingBox();
      assert.ok(bar.y + bar.height <= 760 && bar.height >= 52, '提出ボタンが画面内に固定され、押しやすい大きさ（' + JSON.stringify(bar) + '）');
      await shot(p, 'report-03-phone');
      await phone.close();
    });

    await t.test('旧日報は公開しない：一般社員の一覧に出ず、管理者は閲覧だけできる', async () => {
      gas.g.appendRecords_('日報', [{ '日報ID': 'DR-20260929-E001', '日付': '2026-09-29', '社員ID': 'E001', '氏名': '山田 太郎', '本日の業務内容': '旧日報の本文',
        '成果・進捗': 'つくった', '明日の予定': '熊本', '提出日時': '2026-09-29 21:39:36', 'ステータス': '提出済み' }]);
      const tanaka = await open('tanaka@example.com', '/?view=reports');
      await tanaka.waitForSelector('#reportCards');
      await tanaka.click('#btnReportPrevMonth');
      // 日報は暦月（20日締めにしない）：前の月＝2026年9月（9/1〜9/30）
      await tanaka.waitForFunction(() => document.getElementById('reportMonthLabel').innerText === '2026年9月');
      await idle(tanaka);
      assert.doesNotMatch(await tanaka.locator('#reportListPane').innerText(), /山田 太郎|旧日報の本文/, '一般社員には出ない');
      await tanaka.close();

      const yamada = await open('yamada@example.com', '/?view=reports');
      await yamada.click('#btnReportPrevMonth');
      await yamada.waitForSelector('.report-card:has-text("以前の日報（本人・管理者のみ閲覧）")');
      await yamada.locator('.report-card', { hasText: '以前の日報' }).locator('button', { hasText: '日報を見る' }).click();
      await yamada.waitForFunction(() => /旧日報の本文/.test(document.getElementById('reportDetailBody').innerText));
      const body = await yamada.locator('#reportDetailBody').innerText();
      assert.match(body, /以前の日報（本人・管理者のみ閲覧）/, '詳細にも一覧と同じ表示');
      assert.match(body, /以前の仕組みで提出された日報です。本人と管理者だけが閲覧できます/);
      assert.match(body, /明日の予定（以前の項目）\s+熊本/);
      assert.equal(await yamada.locator('#btnConfirmReport').count(), 0, '確認ボタンなし');
      assert.equal(await yamada.locator('#reportCommentText').count(), 0, 'コメント欄なし');
      assert.equal(await yamada.locator('#btnReportEdit').isHidden(), true, '修正ボタンなし');
      await yamada.close();
    });

    assert.deepEqual(errors, [], 'ブラウザで JavaScript のエラーが出ていない');
  } finally {
    await browser.close();
    server.close();
  }
});
