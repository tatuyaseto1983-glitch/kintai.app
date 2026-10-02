'use strict';
// 管理者画面をブラウザ（Chromium）で操作するテスト。
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

test('管理者画面をブラウザで操作する', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
  const { server, gas, calls } = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;
  const post = (p, body) => fetch(base + p, { method: 'POST', body: JSON.stringify(body) });
  const as = async (email, now, fn, ...args) => {
    await post('/__test/login', { email });
    if (now) await post('/__test/now', { now });
    const r = await (await fetch(base + '/__gas', { method: 'POST', body: JSON.stringify({ fn, args }) })).json();
    return r.result;
  };
  const browser = await playwright.chromium.launch({ headless: true });
  const shot = async (page, name) => { if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: true }); };

  // テストデータ：6/1 佐藤（固定）が 19:12 まで勤務（要確認）、鈴木（フレックス）が中断のまま、田中は申請だけ
  await as('sato@example.com', '2026-06-01 09:30', 'clockIn', '出社');
  await as('sato@example.com', '2026-06-01 19:12', 'clockOut');
  await as('suzuki@example.com', '2026-06-01 10:00', 'clockIn', '在宅');
  await as('suzuki@example.com', '2026-06-01 12:00', 'startBreak', '');
  const cor1 = (await as('sato@example.com', '2026-06-01 20:00', 'submitCorrectionRequest', { targetDate: '2026-06-01', item: '退勤', after: '18:40', reason: '押し忘れ' })).data.requestId;
  await as('sato@example.com', null, 'submitCorrectionRequest', { targetDate: '2026-06-01', item: '勤務形態', after: '在宅', reason: '誤選択' });
  await as('tanaka@example.com', '2026-06-01 20:00', 'submitOvertimeRequest', { targetDate: '2026-06-02', plannedStart: '18:30', plannedEnd: '20:00', reason: '見積作成' });
  await as('sato@example.com', '2026-06-01 20:05', 'saveDailyReport', { workContent: '現場打合せ', progress: '図面確認' });
  await post('/__test/now', { now: '2026-06-01 20:30' });

  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'ja-JP', acceptDownloads: true });
    context.setDefaultTimeout(10000);
    const errors = [];
    const newPage = async (url) => {
      const p = await context.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(url);
      await p.waitForSelector('#app:not([hidden])');
      return p;
    };
    const idle = (p) => p.waitForFunction(() => !document.body.classList.contains('is-busy'));

    await t.test('一般スタッフ：ボタンは出ない・URLで開いても「管理者権限がありません」・データは表示されない', async () => {
      await post('/__test/login', { email: 'sato@example.com' });
      let p = await newPage(base);
      assert.equal(await p.locator('#btnToAdmin').isHidden(), true);
      await p.close();

      const before = calls.filter((c) => c === 'getAdminDashboard').length;
      p = await newPage(base + '/?view=admin');
      await p.waitForSelector('#adminDenied:not([hidden])');
      assert.equal(await p.locator('#adminDeniedTitle').innerText(), '管理者権限がありません');
      assert.equal(await p.locator('#adminContent').isHidden(), true);
      assert.equal(await p.locator('#admTableBody tr').count(), 0, '一覧に何も入っていない');
      assert.equal(calls.filter((c) => c === 'getAdminDashboard').length - before, 1, 'サーバーに確認した上で拒否された');
      // 開発者ツールから直接呼んでも拒否される
      const forced = await p.evaluate(() => new Promise((resolve) => {
        google.script.run.withSuccessHandler(resolve).getAdminDashboard({});
      }));
      assert.equal(forced.success, false);
      assert.equal(forced.data, null);
      await p.click('#adminDenied [data-go-staff]');
      assert.equal(await p.locator('#staffView').isVisible(), true);
      await shot(p, 'admin-00-denied');
      await p.close();
    });

    await post('/__test/login', { email: 'yamada@example.com' });
    const page = await newPage(base);

    await t.test('管理者：スタッフ画面に「管理者画面」ボタン → サマリーと日別一覧', async () => {
      assert.equal(await page.locator('#btnToAdmin').isVisible(), true);
      await page.click('#btnToAdmin');
      await page.waitForSelector('#adminContent:not([hidden])');
      assert.equal(await page.locator('#brandSub').innerText(), '勤怠管理｜管理者画面');
      assert.equal(await page.locator('#adminName').innerText(), '山田 太郎');
      assert.equal(await page.locator('#btnToStaff').isVisible(), true);
      const cards = await page.locator('#summaryCards').innerText();
      for (const re of [/本日出勤\s*2\s*名/, /在宅\s*1\s*名/, /中断中\s*1\s*名/, /打刻漏れ\s*0\s*名/, /残業要確認\s*1\s*件/, /修正申請待ち\s*2\s*件/, /残業申請待ち\s*1\s*件/]) {
        assert.match(cards, re);
      }
      const sato = await page.locator('#admTableBody tr', { hasText: '佐藤 花子' }).innerText();
      assert.match(sato, /設計部\s+固定勤務\s+出社\s+09:30\s+19:12\s+00:00\s+01:00\s+08:42/);
      assert.match(sato, /00:42\s*30分以上・事前申請なし/);
      assert.match(sato, /要確認/);
      assert.equal(await page.locator('#admTableBody tr', { hasText: '佐藤 花子' }).getAttribute('class'), 'row-alert');
      assert.match(await page.locator('#admTableBody tr', { hasText: '鈴木 一郎' }).innerText(), /中断中/);
      assert.equal(await page.locator('#admTableCount').innerText(), '4名 / 4名');
      await shot(page, 'admin-01-daily');
    });

    await t.test('絞り込み（ブラウザ内だけで処理）', async () => {
      const n = calls.length;
      await page.fill('#admSearch', '設計');
      assert.equal(await page.locator('#admTableCount').innerText(), '1名 / 4名');
      await page.fill('#admSearch', '');
      await page.check('#admNeedsCheck');
      assert.equal(await page.locator('#admTableCount').innerText(), '1名 / 4名');
      await page.uncheck('#admNeedsCheck');
      await page.selectOption('#admWorkStyle', '在宅');
      assert.match(await page.locator('#admTableBody').innerText(), /鈴木 一郎/);
      await page.selectOption('#admWorkStyle', '');
      await page.selectOption('#admStatus', '未出勤');
      assert.equal(await page.locator('#admTableCount').innerText(), '2名 / 4名');
      await page.selectOption('#admStatus', '');
      assert.equal(calls.length, n, '絞り込みではサーバーに問い合わせない');
    });

    await t.test('月別表示・フレックス管理・日付の変更', async () => {
      await page.click('.tab[data-mode="monthly"]');
      assert.equal(await page.locator('#admMonth').isVisible(), true);
      const flexRow = await page.locator('#admTableBody tr', { hasText: '鈴木 一郎' }).innerText();
      assert.match(flexRow, /フレックス[\s\S]*138:00/);
      assert.match(await page.locator('#admTableBody tr', { hasText: '佐藤 花子' }).innerText(), /1日\s+8:42\s+—\s+—\s+0:42\s+—\s+2件\s+1件/);
      assert.match(await page.locator('#admFlexBody').innerText(), /鈴木 一郎\s+施工管理部\s+32:00/);
      await page.click('.tab[data-mode="daily"]');
      await page.fill('#admDate', '2026-06-02');
      await page.dispatchEvent('#admDate', 'change');
      await page.waitForFunction(() => /6\/2/.test(document.getElementById('admTableTitle').innerText));
      assert.match(await page.locator('#admTableBody').innerText(), /未出勤/);
      await page.fill('#admDate', '2026-06-01');
      await page.dispatchEvent('#admDate', 'change');
      await page.waitForFunction(() => /6\/1/.test(document.getElementById('admTableTitle').innerText));
    });

    await t.test('打刻修正申請の承認（確認あり・連打しても1回）→ 勤怠に反映・再計算', async () => {
      const box = page.locator('#admCorrections .request', { hasText: '18:40' });
      await box.locator('button', { hasText: '承認' }).click();
      assert.match(await page.locator('#adminConfirmText').innerText(), /退勤：19:12 → 18:40[\s\S]*再計算/);
      await post('/__test/delay', { ms: 300 });
      const before = calls.filter((c) => c === 'approveCorrectionRequest').length;
      await page.click('#btnAdminConfirmOk');
      await page.evaluate(() => { document.querySelectorAll('#admCorrections button').forEach((b) => b.click()); });
      await idle(page);
      await post('/__test/delay', { ms: 0 });
      assert.equal(calls.filter((c) => c === 'approveCorrectionRequest').length - before, 1, '承認は1回だけ');
      assert.match(await page.locator('#toasts').innerText(), /打刻修正を承認し、勤怠記録に反映しました/);
      const sato = await page.locator('#admTableBody tr', { hasText: '佐藤 花子' }).innerText();
      assert.match(sato, /18:40[\s\S]*00:10/);
      assert.doesNotMatch(sato, /要確認/, '社内超過が30分未満になったので要確認が消える');
      assert.equal(gas.main.rows('勤怠記録').find((r) => r['社員ID'] === 'E002')['退勤'], '18:40');
      assert.equal(cor1.length > 0, true);
    });

    await t.test('打刻修正申請の却下（理由が必須）', async () => {
      const box = page.locator('#admCorrections .request', { hasText: '勤務形態' });
      await box.locator('button', { hasText: '却下' }).click();
      await page.click('#btnAdminConfirmOk');
      assert.match(await page.locator('#toasts .toast').last().innerText(), /却下理由を入力してください/);
      await page.fill('#adminConfirmReason', '出社を確認済みです');
      await page.click('#btnAdminConfirmOk');
      await idle(page);
      assert.match(await page.locator('#toasts').innerText(), /却下しました/);
      assert.match(await page.locator('#admCorrections').innerText(), /承認待ちの申請はありません/);
      await page.check('#corShowDone');
      assert.match(await page.locator('#admCorrections').innerText(), /却下理由：出社を確認済みです/);
      const rec = gas.main.rows('打刻修正申請').find((r) => r['修正項目'] === '勤務形態');
      assert.deepEqual([rec['ステータス'], rec['承認者'], rec['却下理由']], ['却下', '山田 太郎', '出社を確認済みです']);
    });

    await t.test('残業申請の承認', async () => {
      await page.locator('#admOvertime .request', { hasText: '田中 美咲' }).locator('button', { hasText: '承認' }).click();
      await page.click('#btnAdminConfirmOk');
      await idle(page);
      assert.match(await page.locator('#toasts').innerText(), /残業申請を「承認済み」にしました/);
      assert.equal(gas.main.rows('残業申請')[0]['ステータス'], '承認済み');
      assert.match(await page.locator('#summaryCards').innerText(), /残業申請待ち\s*0\s*件/);
    });

    await t.test('CSV出力（月別・BOM付き）', async () => {
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btnCsvMonthly')]);
      assert.equal(download.suggestedFilename(), 'kintai_monthly_2026-06.csv');
      const file = await download.path();
      const text = require('node:fs').readFileSync(file, 'utf8');
      assert.ok(text.startsWith('﻿日付,社員ID,氏名,部署'));
      assert.match(text, /2026-06-01,E002,佐藤 花子,設計部,固定勤務/);
      await idle(page);
      assert.match(await page.locator('#toasts').innerText(), /CSVを作成しました/);
    });

    await t.test('週1日完全休日・日報確認', async () => {
      assert.match(await page.locator('#admRestRange').innerText(), /6\/1（月）〜6\/7（日）/);
      assert.match(await page.locator('#admReportCount').innerText(), /提出済み 1名／未提出 3名/);
      await page.selectOption('#admReportFilter', 'notSubmitted');
      assert.equal(await page.locator('#admReports .report').count(), 3);
      await page.selectOption('#admReportFilter', 'submitted');
      assert.doesNotMatch(await page.locator('#admReports').innerText(), /現場打合せ/, '一覧には本文を出さない');
      assert.match(await page.locator('#admReports').innerText(), /佐藤 花子[\s\S]*0 \/ 3人 確認済み/);
      await page.locator('#admReports button', { hasText: '日報を見る' }).click();
      await page.waitForSelector('#reportDetailPane:not([hidden]) .report-head');
      assert.match(await page.locator('#reportDetailBody').innerText(), /現場打合せ/);
      await page.click('#btnConfirmReport');
      await page.waitForFunction(() => /1人 \/ 3人確認済み/.test(document.getElementById('reportDetailBody').innerText));
      await page.click('#btnToAdmin');
      await page.waitForSelector('#adminContent:not([hidden])');
      await page.waitForFunction(() => /1 \/ 3人 確認済み/.test(document.getElementById('admReports').innerText));
    });

    await t.test('今月の勤怠を再計算（確認あり）', async () => {
      const sheet = gas.main.getSheetByName('勤怠記録');
      sheet.data[1][sheet.data[0].indexOf('退勤')] = '19:30'; // シートを直接直した想定
      await page.click('#btnRecalc');
      assert.match(await page.locator('#adminConfirmText').innerText(), /出勤・退勤の時刻は変わりません/);
      await page.click('#btnAdminConfirmCancel');
      assert.equal(calls.includes('recalculateThisMonth'), false, 'キャンセルなら実行しない');
      await page.click('#btnRecalc');
      await page.click('#btnAdminConfirmOk');
      await idle(page);
      assert.match(await page.locator('#toasts').innerText(), /件を再計算しました/);
      assert.match(await page.locator('#admTableBody tr', { hasText: '佐藤 花子' }).innerText(), /19:30[\s\S]*01:00/);
      await shot(page, 'admin-02-after');
    });

    await t.test('スタッフ画面へ戻る（スタッフ機能はそのまま）', async () => {
      await page.click('#btnToStaff');
      assert.equal(await page.locator('#staffView').isVisible(), true);
      assert.equal(await page.locator('#adminView').isHidden(), true);
      assert.equal(await page.locator('#btnToAdmin').isVisible(), true);
      await page.click('.style-option[data-style="出社"]');
      await page.click('#btnClockIn');
      await idle(page);
      assert.equal(await page.locator('#statusLabel').innerText(), '出社勤務中');
    });

    await t.test('スマホ幅でも横にはみ出さない（表は横スクロール）', async () => {
      const phone = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, locale: 'ja-JP' });
      const p = await phone.newPage();
      await p.goto(base + '/?view=admin');
      await p.waitForSelector('#adminContent:not([hidden])');
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0);
      await shot(p, 'admin-03-phone');
      await phone.close();
      assert.deepEqual(errors, [], 'ブラウザで JavaScript のエラーが出ていない');
    });
  } finally {
    await browser.close();
    server.close();
  }
});
