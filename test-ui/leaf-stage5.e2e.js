'use strict';
// 段階5の管理者画面（社内詳細月次・区間の展開・社員別CSV・月次の集計・出力）と、スタッフ画面の中断の説明をブラウザ（Chromium）で操作するテスト。
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

test('段階5の画面（社内詳細月次・集計・出力）', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
  const { server, gas, calls } = createServer();
  // 日報の未提出を判定する（設定「日報_未提出判定開始日」。空欄の間は判定しない）
  gas.main.getSheetByName('設定').data.find((r) => r[0] === '日報_未提出判定開始日')[1] = '2026-01-01';
  gas.g.clearTableCache_();
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;
  const post = (p, body) => fetch(base + p, { method: 'POST', body: JSON.stringify(body) });
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'ja-JP', acceptDownloads: true });
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
  const act = (email, date, steps) => {
    gas.loginAs(email);
    for (const [time, fn, arg] of steps) { gas.setNow(date + ' ' + time); const r = arg === undefined ? gas.g[fn]() : gas.g[fn](arg); assert.equal(r.success, true, r.message); }
  };

  try {
    // 佐藤さん：10/1 会社→中断（私用）→在宅で再開→退勤。10/2 は退勤なし（打刻漏れ）。日報は 10/1 に接客1件
    act('sato@example.com', '2026-10-01', [['09:00', 'clockIn', '出社'], ['12:00', 'startBreak', '通院'], ['12:30', 'resumeWork', '在宅'], ['19:00', 'clockOut']]);
    act('sato@example.com', '2026-10-01', [['19:10', 'submitReport', { workContent: '来場対応', customers: [{ customerName: '山田様', role: '主担当', visitTrigger: 'Google検索' }] }]]);
    act('sato@example.com', '2026-10-02', [['09:30', 'clockIn', '出社']]);
    await post('/__test/now', { now: '2026-10-05 10:00' });

    await t.test('スタッフ画面：中断ボタンの下に「私用の中抜け・昼休みは中断にしない」を表示', async () => {
      const sato = await open('sato@example.com');
      assert.match(await sato.innerText('#breakRuleNote'), /［中断］は私用外出・通院など、勤務から離れるときに押します。昼休みは中断にしないでください（昼休みは自動休憩として実働から差し引きます）。/);
      await sato.close();
    });

    let admin;
    await t.test('月別の［詳細］→ 社内詳細月次（20日締め1か月・1日1行・合計）→［区間］で勤務区間・中断を展開', async () => {
      admin = await open('yamada@example.com', '/?view=admin');
      await admin.waitForSelector('#adminContent:not([hidden])');
      await admin.click('#adminView .tab[data-mode="monthly"]');
      await admin.fill('#admMonth', '2026-10');
      await admin.dispatchEvent('#admMonth', 'change');
      await admin.waitForFunction(() => /対象期間/.test(document.getElementById('admTableTitle').textContent));
      await admin.locator('#admTableBody tr', { hasText: '佐藤 花子' }).locator('button[data-emp-month]').click();
      await admin.waitForSelector('#admEmpMonth:not([hidden])');
      assert.match(await admin.innerText('#admEmpMonthTitle'), /社内詳細月次：佐藤 花子（固定勤務）　2026年10月分 対象期間：2026\/09\/21〜2026\/10\/20/);
      assert.equal(await admin.locator('#admEmpMonthBody tr[data-date]').count(), 30);
      const row = await admin.locator('#admEmpMonthBody tr[data-date="2026-10-01"]').innerText();
      assert.match(row, /10\/1（木）\s+会社＋在宅\s+2区間\s+09:00\s+19:00\s+0:30\s+1:00\s+8:30/);
      assert.match(row, /提出済み/);
      assert.match(await admin.locator('#admEmpMonthBody tr[data-date="2026-10-02"]').innerText(), /退勤なし[\s\S]*日報未提出/);
      await admin.locator('#admEmpMonthBody tr[data-date="2026-10-01"] button', { hasText: '2区間' }).click();
      const detail = await admin.locator('#admEmpMonthBody .emp-day-detail').innerText();
      assert.match(detail, /区間1\s+会社\s+09:00〜12:00[\s\S]*区間2\s+在宅\s+12:30〜19:00[\s\S]*中断（私用の中抜け）\s+12:00〜12:30/);
      assert.match(await admin.locator('#admEmpMonthBody .row-total').innerText(), /合計\s+2日/);
      await shot(admin, 's5-01-employee-month');
      const dl = admin.waitForEvent('download');
      await admin.click('#btnEmpMonthCsv');
      assert.equal((await dl).suggestedFilename(), 'kintai_detail_E002_2026-10.csv');
      await idle(admin);
    });

    await t.test('月次の集計：要確認一覧（区分で絞り込み）・接客集計・日報確認集計', async () => {
      await admin.click('#btnLoadAnalysis');
      await admin.waitForSelector('#admAnalysisBody:not([hidden])');
      assert.match(await admin.innerText('#admCheckPeriod'), /2026年10月分 対象期間：2026\/09\/21〜2026\/10\/20（10\/5（月）まで）/);
      assert.match(await admin.innerText('#admCheckBody'), /10\/2（金）\s+佐藤 花子\s+［打刻］退勤なし[\s\S]*［日報］日報未提出/);
      await admin.selectOption('#admCheckFilter', '打刻');
      assert.doesNotMatch(await admin.innerText('#admCheckBody'), /日報未提出/);
      assert.match(await admin.innerText('#admSalesTotal'), /会社の接客件数（主担当だけ） 1件　副担当参加 0件/);
      assert.match(await admin.innerText('#admSalesTriggerBody'), /Google検索\s+1件/);
      assert.match(await admin.innerText('#admReportSumPeriod'), /2026年10月 期間：2026\/10\/01〜2026\/10\/31/);
      assert.match(await admin.innerText('#admReportListBody'), /10\/1（木）\s+佐藤 花子\s+0 \/ 3\s+0件\s+山田 太郎、鈴木 一郎、田中 美咲/);
      await shot(admin, 's5-02-analysis');
    });

    await t.test('出力：月次サマリーCSV・社労士確認用の詳細表（CSV）', async () => {
      let dl = admin.waitForEvent('download');
      await admin.click('#btnCsvSummary');
      assert.equal((await dl).suggestedFilename(), 'kintai_summary_2026-10.csv');
      await idle(admin);
      dl = admin.waitForEvent('download');
      await admin.click('#btnCsvSharoushi');
      const file = await dl;
      assert.equal(file.suggestedFilename(), 'sharoushi_check_2026-10.csv');
      const text = require('node:fs').readFileSync(await file.path(), 'utf8');
      assert.match(text, /法定時間外（未確定）,深夜（未確定）,法定休日（未確定）/);
      await idle(admin);
      assert.match(await toast(admin), /社労士確認用の詳細表を作成しました/);
    });

    await t.test('JavaScript のエラーなし。段階5の関数は管理者画面からだけ呼ぶ', async () => {
      assert.deepEqual(errors, []);
      for (const fn of ['getAdminEmployeeMonth', 'exportAdminEmployeeMonthCsv', 'getAdminMonthlyAnalysis', 'exportAdminMonthlySummaryCsv', 'exportSharoushiDetailCsv']) {
        assert.ok(calls.includes(fn), fn);
      }
      await admin.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
});
