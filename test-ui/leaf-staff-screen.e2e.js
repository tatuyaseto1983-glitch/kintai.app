'use strict';
// スタッフ画面（leaf-portal/gas/Index.html）を本物のブラウザ（Chromium）で操作するテスト。
//   npm run test:ui
// Playwright が必要です（入っていない環境では、このテストは飛ばされます）。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { createServer } = require('../dev/leaf-portal-server');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* グローバルを探す */ }
  try { return require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { return null; }
}
const playwright = loadPlaywright();
const SHOT_DIR = process.env.SCREENSHOT_DIR || '';

test('スタッフ画面をブラウザで操作する', { skip: !playwright && 'Playwright がないため省略' }, async (t) => {
  const { server, gas, calls } = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;
  const post = (p, body) => fetch(base + p, { method: 'POST', body: JSON.stringify(body) });
  const launch = { headless: true };
  if (fs.existsSync('/opt/pw-browsers/chromium')) launch.executablePath = undefined;
  const browser = await playwright.chromium.launch(launch);
  const shot = async (page, name) => { if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: true }); };

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP', timezoneId: 'America/New_York' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const toastText = () => page.locator('#toasts .toast').last().innerText();
    const status = () => page.locator('#statusLabel').innerText();
    const enabled = async () => ({
      clockIn: await page.locator('#btnClockIn').isEnabled(),
      break: await page.locator('#btnBreak').isEnabled(),
      resume: await page.locator('#btnResume').isEnabled(),
      clockOut: await page.locator('#btnClockOut').isEnabled(),
    });
    const waitIdle = () => page.waitForFunction(() => !document.body.classList.contains('is-busy'));

    await post('/__test/now', { now: '2026-06-01 09:25' });

    await t.test('1-2. 初回表示とログインユーザー', async () => {
      await page.goto(base);
      await page.waitForSelector('#app:not([hidden])');
      assert.equal(await page.locator('#userName').innerText(), '佐藤 花子');
      assert.equal(await page.locator('#userDept').innerText(), '設計部');
      assert.equal(await page.locator('#userWorkType').innerText(), '固定勤務');
      assert.equal(await status(), '未出勤');
      assert.deepEqual(await enabled(), { clockIn: false, break: false, resume: false, clockOut: false }, '勤務形態を選ぶまで出勤は押せない');
      assert.match(await page.locator('#clockDate').innerText(), /^\d{4}年\d{1,2}月\d{1,2}日（[日月火水木金土]）$/);
      // ブラウザのタイムゾーンがニューヨークでも、日本時間で表示する
      const jst = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
      assert.equal(await page.locator('#clockTime').innerText(), jst);
      assert.equal(await page.locator('#flexCard').isHidden(), true, '固定勤務ではフレックス欄を出さない');
      await shot(page, '01-initial');
    });

    await t.test('3・5・20. 出社で出勤（連打しても1回だけ送信）', async () => {
      await page.click('.style-option[data-style="出社"]');
      assert.equal(await page.locator('#btnClockIn').innerText(), '出社で出勤する');
      await post('/__test/delay', { ms: 400 });
      const before = calls.filter((c) => c === 'clockIn').length;
      await page.locator('#btnClockIn').click();
      assert.match(await page.locator('#btnClockIn').innerText(), /処理中/);
      assert.equal(await page.locator('#btnClockIn').isDisabled(), true);
      await page.locator('#btnClockIn').click({ force: true }).catch(() => {});
      await page.evaluate(() => { document.getElementById('btnClockIn').click(); document.getElementById('btnClockIn').click(); });
      await waitIdle();
      await post('/__test/delay', { ms: 0 });
      assert.equal(calls.filter((c) => c === 'clockIn').length - before, 1, '連打しても clockIn は1回だけ');
      assert.match(await toastText(), /出勤しました（出社・09:25）/);
      assert.equal(await status(), '出社勤務中');
      assert.deepEqual(await enabled(), { clockIn: false, break: true, resume: false, clockOut: true });
      assert.match(await page.locator('#todayBody').innerText(), /出勤\s+09:25/);
      assert.match(await page.locator('#staffList').innerText(), /佐藤 花子（あなた）\s*出社・勤務中/);
    });

    await t.test('5. 二重出勤：画面が古くてもサーバー側で止まり、エラーが表示される', async () => {
      await page.evaluate(() => {
        const b = document.getElementById('btnClockIn');
        b.disabled = false; b.click(); // 無効化されたボタンを無理やり押した場合
      });
      await waitIdle();
      assert.match(await toastText(), /本日はすでに出勤済みです/);
      assert.equal(await page.locator('#toasts .toast-error').count() > 0, true);
      assert.equal(await status(), '出社勤務中');
    });

    await t.test('6・9. 中断すると退勤できない', async () => {
      await post('/__test/now', { now: '2026-06-01 12:00' });
      await page.fill('#breakReason', '銀行');
      await page.click('#btnBreak');
      await waitIdle();
      assert.match(await toastText(), /中断しました/);
      assert.equal(await status(), '中断中');
      assert.equal(await page.locator('#statusCard').getAttribute('class'), 'card status-card status-break');
      assert.deepEqual(await enabled(), { clockIn: false, break: false, resume: true, clockOut: false });
      assert.match(await page.locator('#actionHint').innerText(), /中断中は退勤できません/);
      assert.equal(gas.main.rows('中断履歴')[0]['理由'], '銀行');
      await shot(page, '02-break');
    });

    await t.test('7. 再開', async () => {
      await post('/__test/now', { now: '2026-06-01 12:20' });
      await page.click('#btnResume');
      await waitIdle();
      assert.match(await toastText(), /再開しました（中断 00:20/);
      assert.equal(await status(), '出社勤務中');
      assert.match(await page.locator('#todayBody').innerText(), /中断合計\s+00:20/);
    });

    await t.test('8・10・11・12. 退勤（確認あり）→ 記録と一覧が更新、再操作できない', async () => {
      await post('/__test/now', { now: '2026-06-01 19:00' });
      await page.click('#btnClockOut');
      assert.equal(await page.locator('#confirmModal').isVisible(), true);
      await page.click('#btnConfirmCancel');
      assert.equal(await status(), '出社勤務中', 'キャンセルなら何も起きない');
      await page.click('#btnClockOut');
      await page.click('#btnConfirmOk');
      await waitIdle();
      assert.match(await page.locator('#toasts').innerText(), /退勤しました（退勤 19:00／実働 08:15）/);
      assert.equal(await page.locator('#toasts .toast-warn').count() > 0, true, '要確認はオレンジで通知');
      assert.equal(await status(), '退勤済み');
      assert.deepEqual(await enabled(), { clockIn: false, break: false, resume: false, clockOut: false });
      assert.equal(await page.locator('.style-option[data-style="出社"]').isDisabled(), true);
      const today = await page.locator('#todayBody').innerText();
      assert.match(today, /実働時間\s+08:15/);
      assert.match(today, /社内超過時間\s+00:30/);
      assert.match(today, /要確認：社内超過時間が30分以上ですが/, '要確認の説明は設定値（30分）で表示');
      const row = await page.locator('#monthRows tr').first().innerText();
      assert.match(row, /6\/1（月）\s+出社\s+09:25\s+19:00\s+00:20\s+08:15/);
      assert.match(await page.locator('#staffList').innerText(), /佐藤 花子（あなた）\s*退勤済み/);
      await shot(page, '03-finished');
    });

    await t.test('15. 全スタッフの勤務状況：他人の時刻・実働は表示しない', async () => {
      await post('/__test/login', { email: 'suzuki@example.com' });
      await post('/__test/now', { now: '2026-06-01 10:00' });
      const other = await context.newPage();
      await other.goto(base);
      await other.waitForSelector('#app:not([hidden])');
      const staffText = await other.locator('#staffList').innerText();
      assert.match(staffText, /佐藤 花子\s*退勤済み/);
      assert.match(staffText, /田中 美咲\s*未出勤/);
      assert.doesNotMatch(staffText, /\d{1,2}:\d{2}/, '時刻・時間は1つも出ない');
      await other.close();
    });

    await t.test('4・13. フレックス：在宅で出勤、累計を表示', async () => {
      const flex = await context.newPage();
      await flex.goto(base);
      await flex.waitForSelector('#app:not([hidden])');
      assert.equal(await flex.locator('#userWorkType').innerText(), 'フレックス');
      assert.equal(await flex.locator('#flexCard').isVisible(), true);
      assert.match(await flex.locator('#flexBody').innerText(), /今週[\s\S]*所定\s*32:00[\s\S]*今月[\s\S]*所定\s*138:00[\s\S]*残り\s*138:00/);
      await flex.click('.style-option[data-style="在宅"]');
      await flex.click('#btnClockIn');
      await flex.waitForFunction(() => !document.body.classList.contains('is-busy'));
      assert.equal(await flex.locator('#statusLabel').innerText(), '在宅勤務中');
      assert.match(await flex.locator('#flexBody').innerText(), /勤務中の本日分は、退勤すると実働に加算されます/);
      await post('/__test/now', { now: '2026-06-01 19:00' });
      await flex.click('#btnClockOut');
      await flex.click('#btnConfirmOk');
      await flex.waitForFunction(() => !document.body.classList.contains('is-busy'));
      assert.match(await flex.locator('#flexBody').innerText(), /今月[\s\S]*実働\s*8:00[\s\S]*残り\s*130:00/);
      await shot(flex, '04-flex');
      await flex.close();
      await post('/__test/login', { email: 'sato@example.com' });
    });

    await t.test('16. 打刻修正申請', async () => {
      await post('/__test/now', { now: '2026-06-01 20:00' });
      await page.reload();
      await page.waitForSelector('#app:not([hidden])');
      await page.click('#btnOpenCorrection');
      assert.equal(await page.locator('#correctionModal').isVisible(), true);
      assert.equal(await page.inputValue('#corDate'), '2026-06-01');
      await page.selectOption('#corItem', '退勤');
      assert.match(await page.locator('#corBeforeHelp').innerText(), /現在の記録：19:00/);
      await page.click('#btnSubmitCorrection');
      assert.match(await toastText(), /修正後の時刻を入力してください/);
      await page.fill('#corAfterTime', '18:30');
      await page.fill('#corReason', '退勤ボタンを押すのが遅れました');
      await page.click('#btnSubmitCorrection');
      await waitIdle();
      assert.match(await toastText(), /打刻修正を申請しました/);
      assert.equal(await page.locator('#correctionModal').isHidden(), true);
      assert.match(await page.locator('#monthRows tr').first().innerText(), /申請中/);
      assert.equal(gas.main.rows('勤怠記録').find((r) => r['社員ID'] === 'E002')['退勤'], '19:00', '勤怠は承認まで変わらない');
      await page.click('#btnOpenCorrection');
      await page.waitForFunction(() => /承認待ち/.test(document.getElementById('correctionList').innerText));
      await page.click('#correctionModal [data-close]');
    });

    await t.test('17. 日報提出（下書き → 提出。詳しくは leaf-reports-screen.e2e.js）', async () => {
      await page.click('#btnOpenReport');
      await page.waitForFunction(() => /新しい日報/.test(document.getElementById('reportEditorState').innerText));
      assert.equal(await page.inputValue('#reportAuthorText'), '佐藤 花子');
      await page.click('#btnReportSubmit');
      assert.match(await toastText(), /本日の業務内容/);
      await page.fill('#repWorkContent', '現場打合せ');
      await page.click('#btnReportDraft');
      await waitIdle();
      assert.match(await toastText(), /下書き保存しました/);
      await page.fill('#repHandover', '見積作成');
      await page.click('#btnReportSubmit');
      await page.click('#btnReportConfirmOk');
      await page.waitForSelector('#reportDetailPane:not([hidden]) .report-head');
      assert.match(await toastText(), /日報を提出しました/);
      const row = gas.main.rows('日報')[0];
      assert.deepEqual([row['ステータス'], row['日報ステータス'], row['申し送り内容']], ['提出済み', 'submitted', '見積作成']);
      await page.click('#btnToStaff');
      assert.equal(await page.locator('#staffView').isVisible(), true);
    });

    await t.test('18. スマホ表示：横にはみ出さず、ボタンが大きい', async () => {
      const phone = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true, locale: 'ja-JP' });
      const p = await phone.newPage();
      await p.goto(base);
      await p.waitForSelector('#app:not([hidden])');
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, '横スクロールが出ない（' + overflow + 'px）');
      const box = await p.locator('#btnClockIn').boundingBox();
      assert.ok(box.height >= 60, 'ボタンの高さ ' + box.height);
      const wrap = await p.evaluate(() => { const w = document.getElementById('monthTableWrap'); return getComputedStyle(w).overflowX; });
      assert.equal(wrap, 'auto', '表は横スクロール');
      await shot(p, '05-phone');
      await phone.close();
    });

    await t.test('19. ログインできない場合の表示', async () => {
      await post('/__test/login', { email: '' });
      const p = await context.newPage();
      await p.goto(base);
      await p.waitForSelector('#app:not([hidden])');
      assert.equal(await p.locator('#loginErrorTitle').innerText(), 'ログインユーザーを確認できません。会社アカウントでログインしているか確認してください。');
      assert.equal(await p.locator('#mainContent').isHidden(), true, '打刻ボタンは表示しない');
      await post('/__test/login', { email: 'nobody@example.com' });
      await p.reload();
      await p.waitForSelector('#app:not([hidden])');
      assert.match(await p.locator('#loginErrorDetail').innerText(), /スタッフマスタに登録されていないアカウント/);
      await shot(p, '06-login-error');
      await p.close();
      await post('/__test/login', { email: 'sato@example.com' });
    });

    await t.test('画面から管理者用の関数・社員IDの指定を使っていない', async () => {
      const used = [...new Set(calls)].sort();
      assert.deepEqual(used, ['clockIn', 'clockOut', 'getMyCorrectionRequests', 'getReportDetail', 'getReportEditor', 'getStaffDashboard', 'resumeWork', 'saveReportDraft', 'startBreak', 'submitCorrectionRequest', 'submitReport']);
      assert.deepEqual(errors, [], 'ブラウザで JavaScript のエラーが出ていない');
    });
  } finally {
    await browser.close();
    server.close();
  }
});
