/**
 * DailyReportService.gs
 * ------------------------------------------------------------
 * 日報の保存（下書き・提出・提出後の修正）です。閲覧・確認・コメントは DailyReportShareService.gs にあります。
 *
 * 【決まり】
 *   - 日付はサーバーが決めます（新しく作るときは今日。あとから編集しても日付は変わりません）
 *   - 担当者はログイン中の社員です（画面から送られた氏名・社員IDは使いません）
 *   - 下書き（draft）   … 本人だけが見られる・編集できる。管理者・役員にも見せない
 *   - 提出済み（submitted）… 全社員が見られる。本人は修正できる
 *   - 提出後に修正すると、バージョンが1つ上がり、全員の確認状態が「未確認」に戻ります
 *     （確認の履歴は「日報_確認」に残したまま。確認済みかどうかは「今のバージョンを確認したか」で決める）
 *
 * 【シート】
 *   日報          … 1日報1行（日報ID・日付・社員ID・本文・状態・バージョン・日時）
 *   日報_接客      … 接客記録（1件1行。日報IDでつなぐ。削除しても行は消さず「削除」に1を入れる）
 *   日報_更新履歴  … 保存・提出・修正のたびに1行（その時点の内容を JSON で保存）
 */

/** 日報の本文の項目（画面のキー → シートの列名） */
const REPORT_TEXT_FIELDS = [
  { key: 'workContent', column: '本日の業務内容' },
  { key: 'issues', column: '課題・気づき', legacyColumn: '課題・困りごと' },
  { key: 'handover', column: '申し送り内容' },
  { key: 'consultation', column: '管理者への相談・確認事項' },
];

/** 以前の日報の項目（今の入力画面にはないが、以前のデータは表示する） */
const LEGACY_REPORT_FIELDS = [
  { key: 'progress', column: '成果・進捗' },
  { key: 'tomorrowPlan', column: '明日の予定' },
  { key: 'sharedNotes', column: '共有事項' },
];

/** 以前の画面・テストとの互換用（saveDailyReport / getMyDailyReports が使う） */
const DAILY_REPORT_FIELDS = [
  { key: 'workContent', column: '本日の業務内容' },
  { key: 'progress', column: '成果・進捗' },
  { key: 'issues', column: '課題・困りごと' },
  { key: 'tomorrowPlan', column: '明日の予定' },
  { key: 'sharedNotes', column: '共有事項' },
];

/** 1つの日報に登録できる接客記録の上限 */
const MAX_CUSTOMER_RECORDS = 50;

/** 更新履歴の「内容」に保存できる文字数（スプレッドシートの1セルの上限より少なめ） */
const HISTORY_SNAPSHOT_LIMIT = 45000;

// ============================================================ 画面から呼ぶ関数

/**
 * 【画面から呼ぶ】日報を下書き保存する（本人だけが見られる）。
 * @param {object} input { reportId?, workContent, issues, handover, consultation, customers: [...] }
 */
function saveReportDraft(input) {
  return runApi_(function () {
    return withLock_(function () { return saveReport_(input || {}, REPORT_STATE.DRAFT); });
  });
}

/**
 * 【画面から呼ぶ】日報を提出する（全社員が見られるようになる）。
 * すでに提出済みの日報なら「修正」として保存し、バージョンを1つ上げる。
 */
function submitReport(input) {
  return runApi_(function () {
    return withLock_(function () { return saveReport_(input || {}, REPORT_STATE.SUBMITTED); });
  });
}

/**
 * 【画面から呼ぶ】日報の入力画面に必要な情報。
 * @param {string} [reportId] 編集する自分の日報。省略すると今日の自分の日報（なければ新規）
 */
function getReportEditor(reportId) {
  return runApi_(function () {
    requireReportSchema_();
    const staff = getCurrentStaff_();
    const now = getNowInfo_();
    let record = null;
    if (!isBlank_(reportId)) {
      record = findReportById_(reportId);
      if (!record || String(record['社員ID']).trim() !== staff.employeeId) fail_('編集できる日報が見つかりません');
    } else {
      record = findOwnReportByDate_(staff.employeeId, now.date);
    }
    if (record && isLegacySubmittedReport_(record)) fail_('以前の仕組みで提出された日報のため、修正できません（本人と管理者だけが閲覧できます）');
    return {
      message: record ? '日報を読み込みました' : '新しい日報です',
      data: {
        date: record ? toDateKey_(record['日付']) : now.date,
        employeeName: staff.name,
        report: record ? toReportView_(record, getActiveCustomers_(String(record['日報ID']).trim())) : null,
        choices: reportChoices_(),
      },
    };
  });
}

// ============================================================ 以前の関数（互換のため残す）

/**
 * 【以前の関数】日報を保存する。新しい画面では saveReportDraft / submitReport を使う。
 *   status '下書き' → 下書き保存、それ以外 → 提出。日付は今日（サーバーが決める）
 */
function saveDailyReport(report) {
  return runApi_(function () {
    return withLock_(function () {
      const r = report || {};
      const status = isBlank_(r.status) ? REPORT_STATUS.SUBMITTED
        : requireChoice_(r.status, [REPORT_STATUS.DRAFT, REPORT_STATUS.SUBMITTED], 'ステータス');
      const result = saveReport_(r, status === REPORT_STATUS.DRAFT ? REPORT_STATE.DRAFT : REPORT_STATE.SUBMITTED, { legacy: true });
      const record = findReportById_(result.data.reportId);
      return { message: result.message, data: toDailyReportView_(record) };
    });
  });
}

/** 【以前の関数】自分の日報の一覧（月ごと） */
function getMyDailyReports(month) {
  return runApi_(function () {
    const staff = getCurrentStaff_();
    const settings = getSettings_();
    const monthKey = isBlank_(month) ? getMonthKeyForDate_(getNowInfo_().date, settings.monthClosingDay) : requireMonthKey_(month, '対象月');
    const range = getMonthRange_(monthKey, settings.monthClosingDay);
    const list = findRecords_(SHEET_NAMES.DAILY_REPORTS, function (r) {
      const date = toDateKey_(r['日付']);
      return String(r['社員ID']).trim() === staff.employeeId && date >= range.from && date <= range.to;
    }).map(toDailyReportView_).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    return { message: '日報を取得しました（' + list.length + '件）', data: { month: monthKey, reports: list } };
  });
}

/** 【以前の関数】日報を確認する。今は「確認しました」（confirmReport）と同じ動き */
function confirmDailyReport(reportId) {
  return confirmReport(reportId);
}

// ============================================================ 保存の中身

/**
 * 日報を保存する。
 * @param {object} input 画面から来た内容（社員ID・氏名・日付は使わない）
 * @param {string} mode  REPORT_STATE.DRAFT（下書き）または REPORT_STATE.SUBMITTED（提出・修正）
 * @param {object} [options] { legacy: true } … 以前の saveDailyReport からの呼び出し
 */
function saveReport_(input, mode, options) {
  const opts = options || {};
  requireReportSchema_();
  const staff = getCurrentStaff_();
  const now = getNowInfo_();
  const strict = mode === REPORT_STATE.SUBMITTED;

  // どの日報を保存するか（本人の日報だけ）
  let record = null;
  if (!isBlank_(input.reportId)) {
    record = findReportById_(input.reportId);
    if (!record) fail_('日報が見つかりません');
    if (String(record['社員ID']).trim() !== staff.employeeId) fail_('他の社員の日報は編集できません');
  } else {
    record = findOwnReportByDate_(staff.employeeId, now.date);
  }
  if (record && isLegacySubmittedReport_(record)) fail_('以前の仕組みで提出された日報のため、修正できません（本人と管理者だけが閲覧できます）');
  const previousState = record ? reportStateOf_(record) : null;
  if (previousState === REPORT_STATE.SUBMITTED && mode === REPORT_STATE.DRAFT) {
    fail_('提出済みの日報は下書きに戻せません。修正するときは「修正を提出」を押してください');
  }

  // 内容のチェック
  const texts = {};
  REPORT_TEXT_FIELDS.forEach(function (f) {
    texts[f.key] = requireText_(input[f.key], f.column, { required: false, max: TEXT_LIMITS.LONG });
  });
  if (strict && !texts.workContent) fail_('提出するときは「本日の業務内容」を入力してください');
  const legacyTexts = {};
  if (opts.legacy) {
    LEGACY_REPORT_FIELDS.forEach(function (f) {
      legacyTexts[f.key] = requireText_(input[f.key], f.column, { required: false, max: TEXT_LIMITS.LONG });
    });
  }
  const customers = opts.legacy && input.customers === undefined && record
    ? getActiveCustomers_(String(record['日報ID']).trim()).map(customerRecordToInput_)
    : normalizeCustomers_(input.customers, strict);

  // 提出済みの修正で、内容が何も変わっていなければ保存しない（バージョンも上げない）
  if (previousState === REPORT_STATE.SUBMITTED) {
    const before = reportSnapshot_(record, getActiveCustomers_(String(record['日報ID']).trim()).map(customerRecordToInput_));
    const after = { texts: texts, customers: customers.map(stripCustomerId_) };
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return { message: '変更がないため、保存しませんでした', data: toReportView_(record, getActiveCustomers_(String(record['日報ID']).trim())) };
    }
  }

  // 日報の行（新規 or 更新）
  const version = mode === REPORT_STATE.DRAFT ? 0
    : previousState === REPORT_STATE.SUBMITTED ? reportVersionOf_(record) + 1 : 1;
  const values = {
    '日報ステータス': mode,
    'ステータス': mode === REPORT_STATE.SUBMITTED ? REPORT_STATUS.SUBMITTED : REPORT_STATUS.DRAFT,
    'バージョン': version,
    '接客件数': customers.length,
    '最終更新日時': now.timestamp,
  };
  REPORT_TEXT_FIELDS.forEach(function (f) { values[f.column] = texts[f.key]; });
  LEGACY_REPORT_FIELDS.forEach(function (f) { if (opts.legacy) values[f.column] = legacyTexts[f.key]; });
  if (mode === REPORT_STATE.SUBMITTED && !(record && !isBlank_(record['提出日時']) && previousState === REPORT_STATE.SUBMITTED)) {
    values['提出日時'] = now.timestamp; // 最初に提出した日時（修正しても変えない）
  }

  if (record) {
    updateRecord_(SHEET_NAMES.DAILY_REPORTS, record, values);
  } else {
    const attendance = findAttendance_(staff.employeeId, now.date);
    values['日報ID'] = makeUniqueId_(SHEET_NAMES.DAILY_REPORTS, '日報ID', 'DR-' + now.date.replace(/-/g, '') + '-' + staff.employeeId);
    values['日付'] = now.date;
    values['社員ID'] = staff.employeeId;
    values['氏名'] = staff.name;
    values['勤務形態'] = attendance ? toPlainText_(attendance['勤務形態']) : '';
    values['作成日時'] = now.timestamp;
    record = appendRecord_(SHEET_NAMES.DAILY_REPORTS, values);
  }
  const reportId = String(record['日報ID']).trim();
  syncCustomers_(reportId, staff.employeeId, customers, now.timestamp);

  const action = mode === REPORT_STATE.DRAFT ? '下書き保存' : previousState === REPORT_STATE.SUBMITTED ? '修正' : '提出';
  appendReportHistory_(record, action, staff, now.timestamp);

  const messages = {
    '下書き保存': '日報を下書き保存しました（あなただけが見られます）',
    '提出': '日報を提出しました。全社員が閲覧できます',
    '修正': '日報を修正しました（バージョン ' + version + '）。確認済みだった人も「未確認」に戻ります',
  };
  return { message: messages[action], data: toReportView_(record, getActiveCustomers_(reportId)) };
}

// ============================================================ 接客記録

/**
 * 画面から来た接客記録をチェックして整える。
 * @param {boolean} strict 提出のとき true（必須項目をチェック）。下書きのときは途中でも保存できる
 */
function normalizeCustomers_(list, strict) {
  if (list === undefined || list === null) list = [];
  if (!Array.isArray(list)) fail_('接客記録の形式が正しくありません');
  if (list.length > MAX_CUSTOMER_RECORDS) fail_('接客記録は' + MAX_CUSTOMER_RECORDS + '件までです');
  return list.map(function (raw, i) {
    const c = raw || {};
    const label = '接客' + (i + 1) + '：';
    const unknown = c.customerNameUnknown === true || c.customerNameUnknown === 'true';
    const name = unknown ? '' : requireText_(c.customerName, label + '顧客名', { required: false, max: TEXT_LIMITS.SHORT });
    const trigger = optionalChoice_(c.visitTrigger, VISIT_TRIGGERS, label + '来場のきっかけ');
    const result = optionalChoice_(c.result, CUSTOMER_RESULTS, label + '対応結果');
    const nextAction = optionalChoice_(c.nextAction, [NEXT_ACTION.REQUIRED, NEXT_ACTION.NOT_REQUIRED], label + '次回対応');
    const item = {
      customerRecordId: isBlank_(c.customerRecordId) ? '' : String(c.customerRecordId).trim(),
      customerName: name,
      customerNameUnknown: unknown,
      visitTrigger: trigger,
      visitTriggerOther: trigger === VISIT_TRIGGER_OTHER ? requireText_(c.visitTriggerOther, label + 'その他の内容', { required: false, max: TEXT_LIMITS.SHORT }) : '',
      content: requireText_(c.content, label + '接客内容', { required: false, max: TEXT_LIMITS.LONG }),
      result: result,
      resultNote: requireText_(c.resultNote, label + '補足コメント', { required: false, max: TEXT_LIMITS.LONG }),
      nextAction: nextAction,
      nextActionDetail: nextAction === NEXT_ACTION.REQUIRED ? requireText_(c.nextActionDetail, label + '次回対応内容', { required: false, max: TEXT_LIMITS.SHORT }) : '',
    };
    if (strict) {
      if (!item.customerNameUnknown && !item.customerName) fail_(label + '顧客名を入力するか、「未確認」にチェックしてください');
      if (!item.visitTrigger) fail_(label + '来場のきっかけを選んでください');
      if (item.visitTrigger === VISIT_TRIGGER_OTHER && !item.visitTriggerOther) fail_(label + '「その他の内容」を入力してください');
      if (!item.result) fail_(label + '対応結果を選んでください');
      if (!item.nextAction) fail_(label + '次回対応（必要／不要）を選んでください');
      if (item.nextAction === NEXT_ACTION.REQUIRED && !item.nextActionDetail) fail_(label + '次回対応内容を入力してください');
    }
    return item;
  });
}

/** 選択肢のチェック（空欄は空欄のまま） */
function optionalChoice_(value, choices, label) {
  const text = isBlank_(value) ? '' : String(value).trim();
  if (text && choices.indexOf(text) === -1) fail_(label + 'は「' + choices.join('」「') + '」から選んでください');
  return text;
}

/** 日報の接客記録（削除されていないもの、並び順） */
function getActiveCustomers_(reportId) {
  return findRecords_(SHEET_NAMES.REPORT_CUSTOMERS, function (r) {
    return String(r['日報ID']).trim() === reportId && String(r['削除']).trim() !== '1';
  }).sort(function (a, b) { return Number(a['並び順']) - Number(b['並び順']); });
}

/** 接客記録の行 → 画面・比較用の形 */
function customerRecordToInput_(r) {
  return {
    customerRecordId: toPlainText_(r['接客ID']),
    customerName: toPlainText_(r['顧客名']),
    customerNameUnknown: String(r['顧客名未確認']).trim() === '1',
    visitTrigger: toPlainText_(r['来場のきっかけ']),
    visitTriggerOther: toPlainText_(r['その他の内容']),
    content: toPlainText_(r['接客内容']),
    result: toPlainText_(r['対応結果']),
    resultNote: toPlainText_(r['補足コメント']),
    nextAction: toPlainText_(r['次回対応']),
    nextActionDetail: toPlainText_(r['次回対応内容']),
  };
}

function stripCustomerId_(c) {
  const copy = {};
  Object.keys(c).forEach(function (k) { if (k !== 'customerRecordId') copy[k] = c[k]; });
  return copy;
}

function customerToCells_(c, order, timestamp) {
  return {
    '並び順': order,
    '顧客名': c.customerName,
    '顧客名未確認': c.customerNameUnknown ? '1' : '',
    '来場のきっかけ': c.visitTrigger,
    'その他の内容': c.visitTriggerOther,
    '接客内容': c.content,
    '対応結果': c.result,
    '補足コメント': c.resultNote,
    '次回対応': c.nextAction,
    '次回対応内容': c.nextActionDetail,
    '更新日時': timestamp,
  };
}

/**
 * 接客記録をシートに反映する。
 *   画面にある記録 … 既存なら更新、新しければ追加
 *   画面から消えた記録 … 行は残して「削除」に 1 を入れる（データを消さない）
 */
function syncCustomers_(reportId, employeeId, customers, timestamp) {
  const existing = getActiveCustomers_(reportId);
  const byId = {};
  existing.forEach(function (r) { byId[String(r['接客ID']).trim()] = r; });
  const kept = {};
  const toAppend = [];
  customers.forEach(function (c, i) {
    const cells = customerToCells_(c, i + 1, timestamp);
    const record = c.customerRecordId && byId[c.customerRecordId];
    if (record) {
      kept[c.customerRecordId] = true;
      const changed = Object.keys(cells).some(function (k) { return k !== '更新日時' && String(record[k]) !== String(cells[k]); });
      if (changed) updateRecord_(SHEET_NAMES.REPORT_CUSTOMERS, record, cells);
      return;
    }
    cells['接客ID'] = makeUniqueId_(SHEET_NAMES.REPORT_CUSTOMERS, '接客ID', 'CU-' + reportId.replace(/^DR-/, '') + '-' + compactTimestamp_() + '-' + pad2_(i + 1));
    cells['日報ID'] = reportId;
    cells['社員ID'] = employeeId;
    cells['作成日時'] = timestamp;
    toAppend.push(cells);
  });
  existing.forEach(function (r) {
    if (!kept[String(r['接客ID']).trim()]) updateRecord_(SHEET_NAMES.REPORT_CUSTOMERS, r, { '削除': '1', '更新日時': timestamp });
  });
  appendRecords_(SHEET_NAMES.REPORT_CUSTOMERS, toAppend);
}

// ============================================================ 更新履歴

/** その時点の日報の内容（比較・履歴用） */
function reportSnapshot_(record, customers) {
  const texts = {};
  REPORT_TEXT_FIELDS.forEach(function (f) { texts[f.key] = toPlainText_(record[f.column]); });
  return { texts: texts, customers: customers.map(stripCustomerId_) };
}

function appendReportHistory_(record, action, staff, timestamp) {
  const reportId = String(record['日報ID']).trim();
  let content = JSON.stringify(reportSnapshot_(record, getActiveCustomers_(reportId).map(customerRecordToInput_)));
  if (content.length > HISTORY_SNAPSHOT_LIMIT) content = content.slice(0, HISTORY_SNAPSHOT_LIMIT) + '…（長いため省略）';
  appendRecord_(SHEET_NAMES.REPORT_HISTORY, {
    '履歴ID': makeUniqueId_(SHEET_NAMES.REPORT_HISTORY, '履歴ID', 'RH-' + compactTimestamp_() + '-' + staff.employeeId),
    '日報ID': reportId,
    'バージョン': reportVersionOf_(record),
    '操作': action,
    '社員ID': staff.employeeId,
    '社員名': staff.name,
    '日時': timestamp,
    '内容': content,
  });
}

// ============================================================ 日報の行の読み取り

/** 日報の機能に必要な列・シートがあるか（なければ setupSystem の実行を案内） */
function requireReportSchema_() {
  const missing = [];
  const reportColumns = readTable_(SHEET_NAMES.DAILY_REPORTS).columnIndex;
  getSheetDefinition_(SHEET_NAMES.DAILY_REPORTS).optionalHeaders.forEach(function (h) {
    if (reportColumns[h] === undefined) missing.push('日報シートの「' + h + '」列');
  });
  [SHEET_NAMES.REPORT_CUSTOMERS, SHEET_NAMES.REPORT_CONFIRMATIONS, SHEET_NAMES.REPORT_COMMENTS, SHEET_NAMES.REPORT_HISTORY].forEach(function (name) {
    if (!getSpreadsheet_().getSheetByName(name)) missing.push('「' + name + '」シート');
  });
  if (missing.length) {
    fail_('日報の新しい機能に必要な ' + missing.slice(0, 3).join('・') + (missing.length > 3 ? ' など' : '') +
      ' がありません。管理者が Apps Script で setupSystem() を実行してください');
  }
}

function findReportById_(reportId) {
  const id = String(reportId).trim();
  return findRecords_(SHEET_NAMES.DAILY_REPORTS, function (r) { return String(r['日報ID']).trim() === id; })[0] || null;
}

function findOwnReportByDate_(employeeId, dateKey) {
  return findRecords_(SHEET_NAMES.DAILY_REPORTS, function (r) {
    return String(r['社員ID']).trim() === employeeId && toDateKey_(r['日付']) === dateKey;
  })[0] || null;
}

/** 日報の状態（draft / submitted）。以前のデータは「ステータス」列から判断する（確認済み → 提出済み） */
function reportStateOf_(r) {
  const state = String(r['日報ステータス'] === undefined ? '' : r['日報ステータス']).trim();
  if (state === REPORT_STATE.DRAFT || state === REPORT_STATE.SUBMITTED) return state;
  const label = String(r['ステータス']).trim();
  return label === REPORT_STATUS.SUBMITTED || label === REPORT_STATUS.CONFIRMED ? REPORT_STATE.SUBMITTED : REPORT_STATE.DRAFT;
}

/**
 * 旧日報：新しい日報の仕組みより前に提出された日報（「日報ステータス」が空のまま提出済み）。
 * 全社員には公開せず、本人と管理者だけが閲覧できる。修正・確認・コメントはできない
 * （修正を許すと新しい形式になり、全社員に公開されてしまうため）。
 */
function isLegacySubmittedReport_(r) {
  const code = String(r['日報ステータス'] === undefined ? '' : r['日報ステータス']).trim();
  return !code && reportStateOf_(r) === REPORT_STATE.SUBMITTED;
}

/** 日報のバージョン（提出1回目＝1、修正するたびに +1。下書き＝0。以前の提出済みデータは1） */
function reportVersionOf_(r) {
  const v = Number(r['バージョン']);
  if (isFinite(v) && v > 0) return v;
  return reportStateOf_(r) === REPORT_STATE.SUBMITTED ? 1 : 0;
}

/** 日報1件を画面用の形にする（接客記録は別に渡す） */
function toReportView_(r, customerRecords) {
  const customers = (customerRecords || []).map(customerRecordToInput_);
  const state = reportStateOf_(r);
  const view = {
    reportId: toPlainText_(r['日報ID']),
    date: toDateKey_(r['日付']),
    employeeId: toPlainText_(r['社員ID']),
    name: toPlainText_(r['氏名']),
    workStyle: toPlainText_(r['勤務形態']),
    status: state,
    statusLabel: state === REPORT_STATE.SUBMITTED ? REPORT_STATUS.SUBMITTED : REPORT_STATUS.DRAFT,
    version: reportVersionOf_(r),
    customerCount: customers.length,
    customers: customers,
    submittedAt: toPlainText_(r['提出日時']),
    updatedAt: toPlainText_(r['最終更新日時']) || toPlainText_(r['提出日時']),
    legacy: {},
  };
  REPORT_TEXT_FIELDS.forEach(function (f) {
    view[f.key] = toPlainText_(r[f.column]) || (f.legacyColumn ? toPlainText_(r[f.legacyColumn]) : '');
  });
  LEGACY_REPORT_FIELDS.forEach(function (f) {
    const v = toPlainText_(r[f.column]);
    if (v) view.legacy[f.key] = v;
  });
  return view;
}

/** 以前の形（saveDailyReport / getMyDailyReports の戻り値） */
function toDailyReportView_(r) {
  const view = {
    reportId: toPlainText_(r['日報ID']),
    date: toDateKey_(r['日付']),
    employeeId: toPlainText_(r['社員ID']),
    name: toPlainText_(r['氏名']),
    workStyle: toPlainText_(r['勤務形態']),
    submittedAt: toPlainText_(r['提出日時']),
    status: reportStateOf_(r) === REPORT_STATE.SUBMITTED ? REPORT_STATUS.SUBMITTED : REPORT_STATUS.DRAFT,
  };
  DAILY_REPORT_FIELDS.forEach(function (f) { view[f.key] = toPlainText_(r[f.column]); });
  return view;
}

/** 入力画面の選択肢 */
function reportChoices_() {
  return {
    visitTriggers: VISIT_TRIGGERS.slice(),
    visitTriggerOther: VISIT_TRIGGER_OTHER,
    results: CUSTOMER_RESULTS.slice(),
    nextActions: [NEXT_ACTION.REQUIRED, NEXT_ACTION.NOT_REQUIRED],
    nextActionRequired: NEXT_ACTION.REQUIRED,
  };
}
