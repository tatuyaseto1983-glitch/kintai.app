'use strict';
/**
 * clasp push の前に、反映先の設定が安全かを確認するスクリプトです。
 *   npm run check      … 確認だけ
 *   npm run push       … 確認して問題がなければ clasp push
 *
 * 確認すること
 *   - leaf-portal/.clasp.json があるか、正しい形か
 *   - rootDir が "gas"（leaf-portal/gas の中だけを反映する）になっているか
 *   - スクリプトID に、Webアプリの「デプロイID」などを間違えて入れていないか
 *   - leaf-portal/gas に必要なファイルがそろっているか
 */
const fs = require('node:fs');
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
];

function checkClaspProject(projectDir) {
  const errors = [];
  const warnings = [];
  const configPath = path.join(projectDir, '.clasp.json');
  let scriptId = '';

  if (!fs.existsSync(configPath)) {
    errors.push('leaf-portal/.clasp.json がありません。README「B-6」の手順で .clasp.json.example をコピーして作ってください');
  } else {
    let config = null;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      errors.push('.clasp.json の書き方が正しくありません（" や , や { } を確認してください）：' + e.message);
    }
    if (config) {
      scriptId = String(config.scriptId || '').trim();
      if (!scriptId || scriptId.includes('ここに')) {
        errors.push('.clasp.json の scriptId にスクリプトIDが入っていません');
      } else if (/^AKfy/.test(scriptId)) {
        errors.push('scriptId に入っているのは Webアプリの「デプロイID」です。Apps Script の ⚙「プロジェクトの設定」にある「スクリプト ID」を入れてください');
      } else if (!/^[A-Za-z0-9_-]+$/.test(scriptId)) {
        errors.push('scriptId に使えない文字（空白・URLの一部など）が入っています。スクリプトIDだけを貼り付けてください');
      } else if (scriptId.length < 50) {
        warnings.push('scriptId が短めです（' + scriptId.length + '文字）。スプレッドシートのIDを入れていないか、Apps Script の「スクリプト ID」と見比べてください');
      }
      if (config.rootDir !== 'gas' || config.srcDir) {
        errors.push('.clasp.json の rootDir は "gas" にしてください（leaf-portal/gas の中だけを反映するため）');
      }
    }
  }

  const gasDir = path.join(projectDir, 'gas');
  const missing = REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(gasDir, f)));
  if (missing.length) errors.push('leaf-portal/gas に次のファイルがありません：' + missing.join('、'));
  const files = fs.existsSync(gasDir) ? fs.readdirSync(gasDir).filter((f) => /\.(gs|js|html)$|^appsscript\.json$/.test(f)).sort() : [];
  const extra = files.filter((f) => !REQUIRED_FILES.includes(f));
  if (extra.length) warnings.push('次のファイルも一緒に反映されます：' + extra.join('、'));

  return { ok: errors.length === 0, errors, warnings, scriptId, files };
}

if (require.main === module) {
  const result = checkClaspProject(PROJECT_DIR);
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
}

module.exports = { checkClaspProject, REQUIRED_FILES };
