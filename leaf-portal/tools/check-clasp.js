'use strict';
/**
 * clasp push の前に、反映先の設定が安全かを確認するスクリプトです。
 *   npm run check      … 確認だけ
 *   npm run push       … 確認して問題がなければ clasp push
 *   npm run check:test … テスト環境（.clasp.test.json）の確認だけ
 *   npm run push:test  … テスト環境へ clasp push（本番の .clasp.json は使わない）
 *
 * 確認すること
 *   - leaf-portal/.clasp.json があるか、正しい形か
 *   - rootDir が "gas"（leaf-portal/gas の中だけを反映する）になっているか
 *   - スクリプトID に、Webアプリの「デプロイID」などを間違えて入れていないか
 *   - leaf-portal/gas に必要なファイルがそろっているか
 *   - テスト環境と本番のスクリプトIDが同じになっていないか（同じなら止める）
 */
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const path = require('node:path');

const PROJECT_DIR = path.join(__dirname, '..');
const REQUIRED_FILES = [
  'appsscript.json', 'Config.gs', 'Utils.gs', 'SheetService.gs', 'SettingsService.gs', 'Setup.gs', 'UserService.gs',
  'AttendanceService.gs', 'BreakService.gs', 'OvertimeService.gs', 'FlexService.gs', 'CorrectionService.gs',
  'DailyReportService.gs', 'AdminService.gs', 'TestRunner.gs',
  // スタッフ画面（Webアプリ）
  'WebApp.gs', 'Index.html', 'Styles.html', 'Scripts.html',
  // 管理者画面
  'AdminDashboardService.gs', 'AdminView.html', 'AdminStyles.html', 'AdminScripts.html',
  // ロゴ（assets/logo.png から npm run logo で作る）
  'Logo.html',
  // 日報（一覧・閲覧・確認・コメント）
  'DailyReportShareService.gs', 'ReportView.html', 'ReportStyles.html', 'ReportScripts.html',
  // 休日出勤申請
  'HolidayWorkService.gs', 'HolidayWorkView.html', 'HolidayWorkScripts.html',
  'PaidLeaveView.html', 'PaidLeaveScripts.html',
  // 勤務区間（出社⇄在宅の切替・再出勤）
  'WorkSegmentService.gs',
  // 段階2：交通費明細・1日の付帯情報
  'TransportService.gs', 'DayDetailService.gs', 'DetailView.html', 'DetailScripts.html',
  // 段階3：シフト・有給休暇申請
  'ShiftService.gs', 'PaidLeaveService.gs', 'AdminMonthlyService.gs', 'XlsxWriter.gs', 'RingiService.gs', 'RingiView.html', 'RingiScripts.html', 'NotificationService.gs',
];

const PROD_CONFIG = '.clasp.json';
const TEST_CONFIG = '.clasp.test.json';

/** 設定ファイルの scriptId だけを読む（なければ空文字） */
function readScriptId_(file) {
  try { return String(JSON.parse(fs.readFileSync(file, 'utf8')).scriptId || '').trim(); } catch (e) { return ''; }
}

/**
 * @param {string} projectDir leaf-portal フォルダ
 * @param {{test?: boolean}} [options] test: true ならテスト環境（.clasp.test.json）を確認する
 */
function checkClaspProject(projectDir, options) {
  const test = !!(options && options.test);
  const configName = test ? TEST_CONFIG : PROD_CONFIG;
  const errors = [];
  const warnings = [];
  const configPath = path.join(projectDir, configName);
  let scriptId = '';

  if (!fs.existsSync(configPath)) {
    errors.push(test
      ? 'leaf-portal/.clasp.test.json がありません。README「Q-3」の手順で、テスト用 Apps Script のスクリプトIDを入れて作ってください'
      : 'leaf-portal/.clasp.json がありません。README「B-6」の手順で .clasp.json.example をコピーして作ってください');
  } else {
    let config = null;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      errors.push(configName + ' の書き方が正しくありません（" や , や { } を確認してください）：' + e.message);
    }
    if (config) {
      scriptId = String(config.scriptId || '').trim();
      if (!scriptId || scriptId.includes('ここに')) {
        errors.push(configName + ' の scriptId にスクリプトIDが入っていません');
      } else if (/^AKfy/.test(scriptId)) {
        errors.push('scriptId に入っているのは Webアプリの「デプロイID」です。Apps Script の ⚙「プロジェクトの設定」にある「スクリプト ID」を入れてください');
      } else if (!/^[A-Za-z0-9_-]+$/.test(scriptId)) {
        errors.push('scriptId に使えない文字（空白・URLの一部など）が入っています。スクリプトIDだけを貼り付けてください');
      } else if (scriptId.length < 50) {
        warnings.push('scriptId が短めです（' + scriptId.length + '文字）。スプレッドシートのIDを入れていないか、Apps Script の「スクリプト ID」と見比べてください');
      }
      if (config.rootDir !== 'gas' || config.srcDir) {
        errors.push(configName + ' の rootDir は "gas" にしてください（leaf-portal/gas の中だけを反映するため）');
      }
    }
  }

  // テスト環境と本番が同じスクリプトIDなら、どちらへの反映も止める（本番を上書きしないため）
  const otherId = readScriptId_(path.join(projectDir, test ? PROD_CONFIG : TEST_CONFIG));
  if (scriptId && otherId && scriptId === otherId) {
    errors.push('.clasp.json（本番）と .clasp.test.json（テスト）のスクリプトIDが同じです。テスト用スプレッドシートの Apps Script の「スクリプト ID」を .clasp.test.json に入れてください');
  }

  const gasDir = path.join(projectDir, 'gas');
  const missing = REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(gasDir, f)));
  if (missing.length) errors.push('leaf-portal/gas に次のファイルがありません：' + missing.join('、'));
  const files = fs.existsSync(gasDir) ? fs.readdirSync(gasDir).filter((f) => /\.(gs|js|html)$|^appsscript\.json$/.test(f)).sort() : [];
  const extra = files.filter((f) => !REQUIRED_FILES.includes(f));
  if (extra.length) warnings.push('次のファイルも一緒に反映されます：' + extra.join('、'));

  return { ok: errors.length === 0, errors, warnings, scriptId, files, configName, test };
}

if (require.main === module) {
  const result = checkClaspProject(PROJECT_DIR, { test: process.argv.includes('--test') });
  console.log(result.test
    ? '■ 反映先：テスト環境（' + TEST_CONFIG + '）'
    : '■ 反映先：本番環境（' + PROD_CONFIG + '）');
  result.warnings.forEach((w) => console.log('⚠ ' + w));
  if (!result.ok) {
    result.errors.forEach((e) => console.error('✖ ' + e));
    console.error('\n反映（clasp push）は行っていません。上の ✖ を直してから、もう一度実行してください。');
    process.exit(1);
  }
  console.log('✔ 反映先のスクリプトID：' + result.scriptId);
  console.log('  → Apps Script の ⚙「プロジェクトの設定」の「スクリプト ID」と同じか確認してください');
  console.log('  → 既存の勤怠アプリ（gas/）のプロジェクトではないことも確認してください');
  console.log('✔ 反映するファイル（' + result.files.length + '個）：' + result.files.join('、'));
  const commit = readGitCommit(PROJECT_DIR);
  console.log('✔ 反映するコードの版：' + (readAppBuild(PROJECT_DIR) || '（不明）') + (commit ? '（Git：' + commit + '）' : ''));
  console.log('  → 反映とデプロイ更新のあと、Webアプリの画面の一番下に同じ「版」が出ていれば、新しいコードが動いています');
}

/** gas/WebApp.gs の APP_BUILD（画面の一番下に出る「版」）を読む */
function readAppBuild(projectDir) {
  try {
    const m = fs.readFileSync(path.join(projectDir, 'gas', 'WebApp.gs'), 'utf8').match(/const APP_BUILD = '([^']+)'/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

/** 今のフォルダの Git のコミット（git pull 済みかの確認用）。Git がなければ空文字 */
function readGitCommit(projectDir) {
  try {
    return execSync('git log -1 --format="%h %s"', { cwd: projectDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) { return ''; }
}

module.exports = { readAppBuild, readGitCommit, checkClaspProject, REQUIRED_FILES, PROD_CONFIG, TEST_CONFIG };
