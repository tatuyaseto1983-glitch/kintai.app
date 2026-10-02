/**
 * Setup.gs
 * ------------------------------------------------------------
 * 初期セットアップ（シートの自動作成）です。
 *
 * setupSystem() は何度実行しても安全です。
 *   - 同じ名前のシートがあれば、削除も上書きもしません
 *   - 足りないシートだけを新しく作ります
 *   - 見出しが足りないときは、既存の列はそのままで「右端に」足りない列だけを追加します
 *   - 「設定」シートは、まだ無い項目だけを追加します（今の値は変えません）
 */

/**
 * 【最初に1回実行】7つのシートを作成します。
 * Apps Script の画面で関数「setupSystem」を選んで「実行」を押してください。
 */
function setupSystem() {
  requireEditorExecution_('setupSystem');
  const ss = getSpreadsheet_();
  const lines = [];

  if (ss.getSpreadsheetTimeZone() !== APP_TIMEZONE) {
    ss.setSpreadsheetTimeZone(APP_TIMEZONE);
    lines.push('スプレッドシートのタイムゾーンを「' + APP_TIMEZONE + '（日本時間）」に設定しました');
  }

  SHEET_DEFINITIONS.forEach(function (definition) {
    lines.push('・' + definition.name + '：' + ensureSheet_(ss, definition));
  });

  clearTableCache_();
  try {
    const added = ensureDefaultSettings_();
    lines.push(added.length ? '・設定の初期値を登録しました：' + added.join('、') : '・設定：追加する項目はありません（今の値はそのままです）');
  } catch (e) {
    lines.push('・設定の初期値を登録できませんでした：' + e.message);
  }

  const summary = '【セットアップ結果】\n' + lines.join('\n');
  console.log(summary);
  showToast_('セットアップが完了しました。詳しくは Apps Script の実行ログをご覧ください', '勤怠システム');
  return summary;
}

/**
 * シートが無ければ作り、あれば見出しの不足だけを補う。
 * 戻り値は結果の説明（ログ用）。
 */
function ensureSheet_(ss, definition) {
  definition = withAllHeaders_(definition);
  let sheet = ss.getSheetByName(definition.name);

  if (!sheet) {
    sheet = ss.insertSheet(definition.name);
    writeHeaderCells_(sheet, 1, definition.headers);
    prepareNewColumns_(sheet, definition, 1, definition.headers);
    sheet.setFrozenRows(1);
    return '新しく作成しました';
  }

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow === 0) {
    // 同名の空のシートがある → 見出しだけ入れる
    writeHeaderCells_(sheet, 1, definition.headers);
    prepareNewColumns_(sheet, definition, 1, definition.headers);
    sheet.setFrozenRows(1);
    return '空のシートだったので見出しを入れました';
  }

  const current = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (h) { return String(h).trim(); });
  if (current.every(function (h) { return h === ''; })) {
    // 1行目が空なのに2行目以降にデータがある → 勝手に見出しを入れるとデータを壊すおそれがあるので何もしない
    return '⚠ 1行目（見出し）が空ですが、2行目以降にデータがあります。データを守るため自動では変更していません。' +
      '1行目に見出し（' + definition.headers.join('、') + '）を入力してから、もう一度 setupSystem() を実行してください';
  }

  const missing = definition.headers.filter(function (h) { return current.indexOf(h) === -1; });
  if (!missing.length) return 'すでにあります（変更なし）';

  // 足りない見出しを右端に追加する（既存の列・データには触れない）
  const startColumn = lastColumn + 1;
  const needColumns = startColumn + missing.length - 1 - sheet.getMaxColumns();
  if (needColumns > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), needColumns);
  writeHeaderCells_(sheet, startColumn, missing);
  prepareNewColumns_(sheet, definition, startColumn, missing);
  return '足りない列を右端に追加しました（' + missing.join('、') + '）';
}

/** 必須の見出しと任意の見出し（optionalHeaders）をまとめた定義。setupSystem() はどちらも作る */
function withAllHeaders_(definition) {
  const copy = {};
  Object.keys(definition).forEach(function (k) { copy[k] = definition[k]; });
  copy.headers = definition.headers.concat(definition.optionalHeaders || []);
  return copy;
}

/** 見出しを書き込み、太字・色付けする */
function writeHeaderCells_(sheet, startColumn, headers) {
  sheet.getRange(1, startColumn, 1, headers.length)
    .setNumberFormat('@')
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#e6efe1');
}

/**
 * 新しく作った列（まだ空の列）だけに、書式なしテキストの設定とプルダウンを付ける。
 * 既存データがある列には何もしません。
 */
function prepareNewColumns_(sheet, definition, startColumn, headers) {
  const dataRows = sheet.getMaxRows() - 1;
  if (dataRows < 1) return;
  sheet.getRange(2, startColumn, dataRows, headers.length).setNumberFormat('@');

  headers.forEach(function (header, i) {
    const strict = definition.choices && definition.choices[header];
    const loose = definition.freeChoices && definition.freeChoices[header];
    const list = strict || loose;
    if (!list) return;
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(list, true)
      .setAllowInvalid(!strict)
      .build();
    sheet.getRange(2, startColumn + i, dataRows, 1).setDataValidation(rule);
  });
}

/** 「設定」シートに、まだ無い項目だけを追加する。追加した項目名の一覧を返す */
function ensureDefaultSettings_() {
  const existing = {};
  readTable_(SHEET_NAMES.SETTINGS).records.forEach(function (r) { existing[String(r['項目']).trim()] = true; });
  const toAdd = DEFAULT_SETTINGS.filter(function (d) { return !existing[d.key]; });
  appendRecords_(SHEET_NAMES.SETTINGS, toAdd.map(function (d) {
    return { '項目': d.key, '値': d.value, '説明': d.note };
  }));
  return toAdd.map(function (d) { return d.key; });
}

/**
 * スタッフマスタにテスト用のスタッフ3名を追加します（同じ社員IDがあれば追加しません）。
 * 追加後、メールアドレスをご自身の Google アカウントに書き換えてテストしてください。
 */
function addSampleStaff() {
  requireEditorExecution_('addSampleStaff');
  return withLock_(function () {
    const samples = [
      ['E001', '山田 太郎', 'yamada.test@example.com', ROLES.ADMIN, '正社員', WORK_TYPES.FIXED, '09:30', '18:30', '08:00', '', '', EMPLOYMENT_STATUS.ACTIVE, '2020-04-01', '管理部', 'テスト用（管理者・固定勤務）'],
      ['E002', '佐藤 花子', 'sato.test@example.com', ROLES.STAFF, '正社員', WORK_TYPES.FIXED, '09:30', '18:30', '08:00', '', '', EMPLOYMENT_STATUS.ACTIVE, '2022-04-01', '設計部', 'テスト用（固定勤務）'],
      ['E003', '鈴木 一郎', 'suzuki.test@example.com', ROLES.STAFF, '契約社員', WORK_TYPES.FLEX, '', '', '08:00', '32:00', '138:00', EMPLOYMENT_STATUS.ACTIVE, '2024-10-01', '施工管理部', 'テスト用（フレックス）'],
    ];
    const headers = getSheetDefinition_(SHEET_NAMES.STAFF).headers;
    const existingIds = {};
    readTable_(SHEET_NAMES.STAFF).records.forEach(function (r) { existingIds[String(r['社員ID']).trim()] = true; });

    const toAdd = samples
      .filter(function (row) { return !existingIds[row[0]]; })
      .map(function (row) {
        const obj = {};
        headers.forEach(function (h, i) { obj[h] = row[i]; });
        return obj;
      });
    appendRecords_(SHEET_NAMES.STAFF, toAdd);

    const message = toAdd.length
      ? 'テスト用スタッフを' + toAdd.length + '名追加しました。メールアドレスをご自身のものに書き換えてください'
      : 'テスト用スタッフ（E001〜E003）はすでに登録されています';
    console.log(message);
    return message;
  });
}

/**
 * エディタ・スプレッドシートのメニューから「本人として」実行されているかを確認する。
 * Webアプリ（「自分として実行」）経由だと、操作している人（getActiveUser）と
 * 実行権限の持ち主（getEffectiveUser＝所有者）が別人になるので、そのときは止める。
 * → スタッフがブラウザの開発者ツールから setupSystem などを呼んでも実行されません。
 */
function requireEditorExecution_(functionName) {
  let active = '';
  let effective = '';
  try { active = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { active = ''; }
  try { effective = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) { effective = ''; }
  if (!active || active !== effective) {
    fail_(functionName + ' は Apps Script のエディタ、またはスプレッドシートのメニューから実行してください（Webアプリからは実行できません）');
  }
}

/** 右下に小さな通知を出す（エディタから実行したときなど、出せない場合は何もしない） */
function showToast_(message, title) {
  try {
    getSpreadsheet_().toast(message, title, 5);
  } catch (e) {
    // 表示できなくても処理には影響しない
  }
}

/**
 * スプレッドシートを開いたときに、上部メニューに「勤怠システム」を追加します。
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('勤怠システム')
      .addItem('初期セットアップ（setupSystem）', 'setupSystem')
      .addItem('テスト用スタッフを追加', 'addSampleStaff')
      .addSeparator()
      .addItem('今月の勤怠を再計算（管理者）', 'recalculateThisMonth')
      .addItem('自動テストを実行（テスト用ファイルで実行）', 'runAllScenarioTests')
      .addToUi();
  } catch (e) {
    // メニューを出せない環境では何もしない
  }
}
