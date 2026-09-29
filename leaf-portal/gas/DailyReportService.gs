/**
 * DailyReportService.gs
 * ------------------------------------------------------------
 * 日報です。1人1日1件で、同じ日にもう一度保存すると上書きします。
 *   下書き   → 本人が何度でも書き直せる
 *   提出済み → 本人はまだ書き直せる（管理者の確認前まで）
 *   確認済み → 管理者が確認した後は、本人は変更できない
 */

/** 日報の入力項目（画面のキー → シートの列名） */
const DAILY_REPORT_FIELDS = [
  { key: 'workContent', column: '本日の業務内容' },
  { key: 'progress', column: '成果・進捗' },
  { key: 'issues', column: '課題・困りごと' },
  { key: 'tomorrowPlan', column: '明日の予定' },
  { key: 'sharedNotes', column: '共有事項' },
];

/**
 * 【画面から呼ぶ】日報を保存する（下書き／提出）。
 * @param {object} report
 *   date         日付（省略すると今日）
 *   workContent  本日の業務内容（提出時は必須）
 *   progress     成果・進捗
 *   issues       課題・困りごと
 *   tomorrowPlan 明日の予定
 *   sharedNotes  共有事項
 *   status       '下書き' または '提出済み'（省略すると提出済み）
 */
function saveDailyReport(report) {
  return runApi_(function () {
    return withLock_(function () { return saveDailyReport_(report || {}); });
  });
}

/**
 * 【画面から呼ぶ】自分の日報の一覧。
 * @param {string} [month] '2026-09'。省略すると今月。
 */
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

/** 【管理者】日報を「確認済み」にする */
function confirmDailyReport(reportId) {
  return runApi_(function () {
    return withLock_(function () {
      requireAdmin();
      const record = findRecords_(SHEET_NAMES.DAILY_REPORTS, function (r) { return String(r['日報ID']).trim() === String(reportId).trim(); })[0];
      if (!record) fail_('日報が見つかりません（日報ID：' + reportId + '）');
      if (record['ステータス'] !== REPORT_STATUS.SUBMITTED) fail_('提出済みの日報だけ確認済みにできます（今のステータス：' + record['ステータス'] + '）');
      updateRecord_(SHEET_NAMES.DAILY_REPORTS, record, { 'ステータス': REPORT_STATUS.CONFIRMED });
      return { message: '日報を確認済みにしました', data: toDailyReportView_(record) };
    });
  });
}

function saveDailyReport_(report) {
  const staff = getCurrentStaff_();
  const now = getNowInfo_();
  const date = isBlank_(report.date) ? now.date : requireDateKey_(report.date, '日付');
  if (date > now.date) fail_('未来の日付の日報は登録できません');
  const status = isBlank_(report.status) ? REPORT_STATUS.SUBMITTED
    : requireChoice_(report.status, [REPORT_STATUS.DRAFT, REPORT_STATUS.SUBMITTED], 'ステータス');

  const values = {};
  DAILY_REPORT_FIELDS.forEach(function (f) {
    values[f.column] = requireText_(report[f.key], f.column, { required: false, max: TEXT_LIMITS.LONG });
  });
  if (status === REPORT_STATUS.SUBMITTED && !values['本日の業務内容']) fail_('提出するときは「本日の業務内容」を入力してください');

  const attendance = findAttendance_(staff.employeeId, date);
  values['勤務形態'] = attendance ? toPlainText_(attendance['勤務形態']) : '';
  values['ステータス'] = status;
  values['提出日時'] = status === REPORT_STATUS.SUBMITTED ? now.timestamp : '';

  const existing = findRecords_(SHEET_NAMES.DAILY_REPORTS, function (r) {
    return String(r['社員ID']).trim() === staff.employeeId && toDateKey_(r['日付']) === date;
  })[0];

  let record;
  if (existing) {
    if (existing['ステータス'] === REPORT_STATUS.CONFIRMED) fail_('管理者が確認済みの日報は変更できません');
    record = updateRecord_(SHEET_NAMES.DAILY_REPORTS, existing, values);
  } else {
    values['日報ID'] = makeUniqueId_(SHEET_NAMES.DAILY_REPORTS, '日報ID', 'DR-' + date.replace(/-/g, '') + '-' + staff.employeeId);
    values['日付'] = date;
    values['社員ID'] = staff.employeeId;
    values['氏名'] = staff.name;
    record = appendRecord_(SHEET_NAMES.DAILY_REPORTS, values);
  }
  const verb = status === REPORT_STATUS.SUBMITTED ? '提出しました' : '下書き保存しました';
  return { message: date + ' の日報を' + verb, data: toDailyReportView_(record) };
}

function toDailyReportView_(r) {
  const view = {
    reportId: toPlainText_(r['日報ID']),
    date: toDateKey_(r['日付']),
    employeeId: toPlainText_(r['社員ID']),
    name: toPlainText_(r['氏名']),
    workStyle: toPlainText_(r['勤務形態']),
    submittedAt: toPlainText_(r['提出日時']),
    status: toPlainText_(r['ステータス']),
  };
  DAILY_REPORT_FIELDS.forEach(function (f) { view[f.key] = toPlainText_(r[f.column]); });
  return view;
}
