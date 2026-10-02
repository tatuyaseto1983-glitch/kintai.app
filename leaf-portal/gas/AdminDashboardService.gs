/**
 * AdminDashboardService.gs
 * ------------------------------------------------------------
 * 管理者画面の表示に必要な情報をまとめて返します（読み取りのみ）。
 *
 *   getAdminDashboard(params)       … 管理者画面の情報を1回で取得
 *   exportAdminAttendanceCsv(params)… 部署・打刻漏れ入りの勤怠CSV（日別／月別）
 *
 * 【安全のための決まり】
 *   - どちらの関数も、最初に必ず requireAdmin() で管理者か確認します。
 *     管理者でなければ「管理者権限がありません」で止まり、データは一切返しません
 *   - 承認・却下・日報確認・再計算は、既存の関数（approveCorrectionRequest など）を画面から直接呼びます。
 *     それらの関数も、中で requireAdmin() を実行しています
 *
 * 【速さのための工夫】
 *   1回の呼び出しの中では、各シートを1回だけ読み込み（readTable_ のキャッシュ）、
 *   社員ID・日付ごとの一覧（Map のようなオブジェクト）を作ってから集計します。
 */

/** getAdminDashboard() で取得できる情報の種類 */
const ADMIN_DASHBOARD_PARTS = ['admin', 'summary', 'daily', 'monthly', 'corrections', 'overtime', 'holidayWork', 'flex', 'restDays', 'reports'];

/** 申請一覧で返す「処理済み」の件数（承認待ちは全件返す） */
const ADMIN_RECENT_REQUEST_LIMIT = 30;

/** 打刻漏れ・記録の矛盾の種類 */
const PUNCH_ISSUES = {
  NO_CLOCK_OUT: '退勤なし',
  NO_RESUME: '再開なし',
  MISMATCH: '状態と記録が不一致',
};

/**
 * 【管理者】管理者画面の情報をまとめて取得する（読み取りのみ・何も書き込みません）。
 * @param {object} [params]
 *   date  日別表示・日報・完全休日・フレックス週の対象日 '2026-09-29'（省略すると今日）
 *   month 月別表示・フレックス月の対象月 '2026-09'（省略すると date の月）
 *   parts 取得したい情報（省略するとすべて）：
 *         'admin' 'summary' 'daily' 'monthly' 'corrections' 'overtime' 'holidayWork' 'flex' 'restDays' 'reports'
 */
function getAdminDashboard(params) {
  return runApi_(function () {
    const admin = requireAdmin(); // ← 管理者でなければここで止まり、以降のデータは作らない
    const p = params || {};
    const settings = getSettings_();
    const now = getNowInfo_();
    const date = isBlank_(p.date) ? now.date : requireDateKey_(p.date, '日付');
    const month = isBlank_(p.month) ? getMonthKeyForDate_(date, settings.monthClosingDay) : requireMonthKey_(p.month, '対象月');
    const parts = normalizeAdminParts_(p.parts);
    const ctx = buildAdminContext_(settings, now.date);
    const has = function (name) { return parts.indexOf(name) !== -1; };

    const data = { date: date, month: month, today: now.date };
    if (has('admin')) data.admin = { name: admin.name, department: admin.department, employeeId: admin.employeeId };
    if (has('summary')) data.summary = buildAdminSummary_(ctx);
    if (has('daily')) data.daily = buildAdminDaily_(ctx, date);
    if (has('monthly')) data.monthly = buildAdminMonthly_(ctx, month);
    if (has('corrections')) data.corrections = listRequestsForAdmin_(SHEET_NAMES.CORRECTIONS, toCorrectionView_, ctx);
    if (has('overtime')) data.overtime = listRequestsForAdmin_(SHEET_NAMES.OVERTIME, toOvertimeView_, ctx);
    if (has('holidayWork')) data.holidayWork = buildAdminHolidayWork_(ctx);
    if (has('flex')) data.flex = buildAdminFlex_(ctx, date, month);
    if (has('restDays')) data.restDays = buildAdminRestDays_(ctx, date);
    if (has('reports')) data.reports = buildAdminReports_(ctx, date);
    return { message: '管理者画面の情報を取得しました', data: data };
  });
}

/**
 * 【管理者】勤怠CSV（部署・打刻漏れ入り）。
 * @param {object} params { type: 'daily' | 'monthly', date: '2026-09-29', month: '2026-09' }
 * 戻り値の data.csv を画面側でファイルとして保存します（Excel で文字化けしないよう先頭に BOM 付き）。
 */
function exportAdminAttendanceCsv(params) {
  return runApi_(function () {
    requireAdmin();
    const p = params || {};
    const settings = getSettings_();
    const now = getNowInfo_();
    const ctx = buildAdminContext_(settings, now.date);
    let range;
    let label;
    if (p.type === 'daily') {
      const date = isBlank_(p.date) ? now.date : requireDateKey_(p.date, '日付');
      range = { from: date, to: date };
      label = date;
    } else {
      const month = isBlank_(p.month) ? getMonthKeyForDate_(now.date, settings.monthClosingDay) : requireMonthKey_(p.month, '対象月');
      range = getMonthRange_(month, settings.monthClosingDay);
      label = month;
    }
    const headers = ['日付', '社員ID', '氏名', '部署', '勤務区分', '勤務形態', '出勤', '退勤', '自動休憩', '中断合計', '実働',
      '遅刻', '早退', '社内超過', '事前残業申請', '要確認', '打刻漏れ', '打刻修正状況', '状態'];
    const lines = [headers.map(csvCell_).join(',')];
    getAttendanceInRange_(range.from, range.to).forEach(function (record) {
      if (ctx.excludedIds[String(record['社員ID']).trim()]) return; // 勤怠集計の対象外（役員など）は出さない
      const row = toAdminAttendanceRow_(record, ctx);
      lines.push([row.date, row.employeeId, row.name, row.department, row.workType, row.workStyle, row.clockIn, row.clockOut,
        row.autoBreak, row.breakTotal, row.workTime, row.late, row.earlyLeave, row.internalExcess, row.preOvertimeRequest,
        row.needsCheck, row.issues.join('・'), row.correctionStatus, row.status].map(csvCell_).join(','));
    });
    return {
      message: label + ' の勤怠CSVを作成しました（' + (lines.length - 1) + '件）',
      // ファイル名は英数字だけにする（日本語のファイル名は、ブラウザによって「download」という名前になってしまうため）
      data: { fileName: 'kintai_' + (p.type === 'daily' ? 'daily_' : 'monthly_') + label + '.csv', csv: '\uFEFF' + lines.join('\r\n') },
    };
  });
}

// ============================================================ 集計の準備（シートは1回ずつ読む）

function normalizeAdminParts_(parts) {
  if (!Array.isArray(parts) || !parts.length) return ADMIN_DASHBOARD_PARTS.slice();
  const wanted = parts.map(String).filter(function (x) { return ADMIN_DASHBOARD_PARTS.indexOf(x) !== -1; });
  return wanted.length ? wanted : ADMIN_DASHBOARD_PARTS.slice();
}

/** 集計に使う情報をまとめる：スタッフ・勤怠（社員ごと）・中断・申請 */
function buildAdminContext_(settings, today) {
  const calc = buildCalcContext_(); // スタッフ・中断履歴・残業申請の状況（既存の再計算と同じ情報）
  const attendanceByEmployee = {};
  const attendanceByKey = {};
  readTable_(SHEET_NAMES.ATTENDANCE).records.forEach(function (r) {
    const id = String(r['社員ID']).trim();
    const date = toDateKey_(r['日付']);
    if (!id || !date) return;
    (attendanceByEmployee[id] = attendanceByEmployee[id] || []).push(r);
    if (!attendanceByKey[id + '|' + date]) attendanceByKey[id + '|' + date] = r;
  });
  const staffList = getAllStaff_();
  // 勤怠集計の対象外（役員など）の社員ID。勤怠の一覧・集計・CSVから除く
  const excludedIds = {};
  staffList.forEach(function (s) { if (s.attendanceTarget === false) excludedIds[s.employeeId] = true; });
  return {
    excludedIds: excludedIds,
    settings: settings,
    today: today,
    calc: calc,
    staffList: staffList,
    staffById: calc.staffById,
    attendanceByEmployee: attendanceByEmployee,
    attendanceByKey: attendanceByKey,
  };
}

/** 画面に出すスタッフ（退職者以外） */
function visibleStaff_(ctx) {
  // 勤怠の一覧・集計に出すのは、退職者以外で「勤怠集計対象」の人（役員など対象外の人は除く）
  return ctx.staffList.filter(function (s) { return s.status !== EMPLOYMENT_STATUS.RETIRED && s.attendanceTarget !== false; });
}

/** 今操作中の勤怠（今日の記録。なければ前日のまだ終わっていない記録） */
function currentAttendanceFromContext_(ctx, employeeId) {
  const today = ctx.attendanceByKey[employeeId + '|' + ctx.today];
  if (today) return today;
  const yesterday = ctx.attendanceByKey[employeeId + '|' + addDays_(ctx.today, -1)];
  return yesterday && isOpenStatus_(String(yesterday['状態'])) ? yesterday : null;
}

/**
 * 打刻漏れ・記録の矛盾を調べる。問題がなければ空の配列。
 *   退勤なし       … 前日以前の記録が「勤務中・中断中」のまま
 *   再開なし       … 再開されていない中断がある（前日以前、または退勤済みなのに）
 *   状態と記録が不一致 … 退勤があるのに退勤済みでない、中断中なのに未完了の中断がない など
 * 日付をまたいで今も勤務中の前日の記録（今日の記録がない場合）は、打刻漏れにしません。
 */
function detectPunchIssues_(record, ctx) {
  const issues = [];
  const date = toDateKey_(record['日付']);
  const status = String(record['状態']);
  const employeeId = String(record['社員ID']).trim();
  const hasClockOut = !isBlank_(record['退勤']);
  const hasOpenBreak = !!ctx.calc.openBreakByAttendance[String(record['勤怠ID']).trim()];
  const isOngoingOvernight = date === addDays_(ctx.today, -1) && !ctx.attendanceByKey[employeeId + '|' + ctx.today];
  const isPast = date < ctx.today && !isOngoingOvernight;

  if (isOpenStatus_(status) && !hasClockOut && isPast) issues.push(PUNCH_ISSUES.NO_CLOCK_OUT);
  if (hasOpenBreak && (isPast || hasClockOut)) issues.push(PUNCH_ISSUES.NO_RESUME);
  const mismatch = (hasClockOut && status !== ATTENDANCE_STATUS.FINISHED) ||
    (!hasClockOut && status === ATTENDANCE_STATUS.FINISHED) ||
    (status === ATTENDANCE_STATUS.ON_BREAK && !hasOpenBreak) ||
    (status === ATTENDANCE_STATUS.WORKING && hasOpenBreak);
  if (mismatch) issues.push(PUNCH_ISSUES.MISMATCH);
  return issues;
}

/** 勤怠1件を管理者画面の行にする（部署・打刻漏れを追加） */
function toAdminAttendanceRow_(record, ctx) {
  const view = toAttendanceView_(record);
  const staff = ctx.staffById[view.employeeId] || null;
  view.department = staff ? staff.department : '';
  view.issues = detectPunchIssues_(record, ctx);
  return view;
}

// ============================================================ サマリー（今日）

function buildAdminSummary_(ctx) {
  const settings = ctx.settings;
  const range = getMonthRange_(getMonthKeyForDate_(ctx.today, settings.monthClosingDay), settings.monthClosingDay);
  const summary = {
    date: ctx.today, monthFrom: range.from, monthTo: range.to,
    present: 0, remote: 0, working: 0, onBreak: 0, finished: 0, notStarted: 0,
    missingPunchStaff: 0, missingPunchRecords: 0, overtimeNeedsCheck: 0,
    pendingCorrections: 0, pendingOvertime: 0, pendingHolidayWork: 0,
  };
  ctx.staffList.filter(isAttendanceTarget_).forEach(function (s) {
    const record = currentAttendanceFromContext_(ctx, s.employeeId);
    if (!record || isBlank_(record['出勤'])) { summary.notStarted += 1; return; }
    summary.present += 1;
    if (String(record['勤務形態']) === WORK_STYLES.REMOTE) summary.remote += 1;
    const status = String(record['状態']);
    if (status === ATTENDANCE_STATUS.WORKING) summary.working += 1;
    else if (status === ATTENDANCE_STATUS.ON_BREAK) summary.onBreak += 1;
    else if (status === ATTENDANCE_STATUS.FINISHED) summary.finished += 1;
  });

  // 今月（今日まで）の打刻漏れと残業要確認
  const staffWithIssues = {};
  Object.keys(ctx.attendanceByEmployee).forEach(function (id) {
    if (ctx.excludedIds[id]) return;
    ctx.attendanceByEmployee[id].forEach(function (r) {
      const date = toDateKey_(r['日付']);
      if (date < range.from || date > ctx.today) return;
      if (detectPunchIssues_(r, ctx).length) { summary.missingPunchRecords += 1; staffWithIssues[id] = true; }
      if (r['要確認'] === MARKS.NEEDS_CHECK) summary.overtimeNeedsCheck += 1;
    });
  });
  summary.missingPunchStaff = Object.keys(staffWithIssues).length;
  summary.pendingCorrections = findRecords_(SHEET_NAMES.CORRECTIONS, function (r) { return r['ステータス'] === REQUEST_STATUS.PENDING; }).length;
  summary.pendingOvertime = findRecords_(SHEET_NAMES.OVERTIME, function (r) { return r['ステータス'] === REQUEST_STATUS.PENDING; }).length;
  // 休日出勤：申請中＋取消申請中（シートがまだなければ 0）
  if (getSpreadsheet_().getSheetByName(SHEET_NAMES.HOLIDAY_WORK)) {
    summary.pendingHolidayWork = findRecords_(SHEET_NAMES.HOLIDAY_WORK, function (r) {
      const s = String(r['ステータス']).trim();
      return s === HOLIDAY_WORK_STATUS.PENDING || s === HOLIDAY_WORK_STATUS.CANCEL_REQUESTED;
    }).length;
  }
  return summary;
}

// ============================================================ 日別・月別

/** 日別：その日の全スタッフ（出勤していない人は「未出勤」の行） */
function buildAdminDaily_(ctx, date) {
  const rows = [];
  const listed = {};
  visibleStaff_(ctx).forEach(function (s) {
    const record = ctx.attendanceByKey[s.employeeId + '|' + date];
    listed[s.employeeId] = true;
    if (record) { rows.push(toAdminAttendanceRow_(record, ctx)); return; }
    if (s.status !== EMPLOYMENT_STATUS.ACTIVE) return; // 休職中の人は、記録がある日だけ出す
    rows.push({
      date: date, employeeId: s.employeeId, name: s.name, department: s.department, workType: s.workType,
      workStyle: '', clockIn: '', clockOut: '', autoBreak: '', breakTotal: '', workTime: '', late: '', earlyLeave: '',
      internalExcess: '', preOvertimeRequest: '', needsCheck: '', correctionStatus: '', status: ATTENDANCE_STATUS.NOT_STARTED, issues: [],
    });
  });
  // スタッフマスタから外れた人の記録も、その日にあれば表示する
  Object.keys(ctx.attendanceByKey).forEach(function (key) {
    const parts = key.split('|');
    if (parts[1] === date && !listed[parts[0]] && !ctx.excludedIds[parts[0]]) rows.push(toAdminAttendanceRow_(ctx.attendanceByKey[key], ctx));
  });
  return { date: date, rows: rows };
}

/** 月別：スタッフごとの合計 */
function buildAdminMonthly_(ctx, month) {
  const settings = ctx.settings;
  const range = getMonthRange_(month, settings.monthClosingDay);
  const correctionCount = {};
  readTable_(SHEET_NAMES.CORRECTIONS).records.forEach(function (r) {
    const date = toDateKey_(r['対象日']);
    if (date < range.from || date > range.to) return;
    const id = String(r['社員ID']).trim();
    correctionCount[id] = (correctionCount[id] || 0) + 1;
  });

  const rows = visibleStaff_(ctx).map(function (s) {
    const records = (ctx.attendanceByEmployee[s.employeeId] || []).filter(function (r) {
      const date = toDateKey_(r['日付']);
      return date >= range.from && date <= range.to;
    });
    const sum = function (column) { return records.reduce(function (t, r) { return t + (toMinutes_(r[column]) || 0); }, 0); };
    const worked = sum('実働時間');
    const row = {
      employeeId: s.employeeId, name: s.name, department: s.department, workType: s.workType,
      workDays: records.filter(function (r) { return !isBlank_(r['出勤']); }).length,
      workTime: formatMinutes_(worked),
      lateTotal: formatMinutes_(sum('遅刻')),
      lateCount: records.filter(function (r) { return (toMinutes_(r['遅刻']) || 0) > 0; }).length,
      earlyLeaveTotal: formatMinutes_(sum('早退')),
      internalExcessTotal: formatMinutes_(sum('社内超過時間')),
      missingPunchCount: records.filter(function (r) { return detectPunchIssues_(r, ctx).length > 0; }).length,
      correctionCount: correctionCount[s.employeeId] || 0,
      needsCheckCount: records.filter(function (r) { return r['要確認'] === MARKS.NEEDS_CHECK; }).length,
      flex: null,
    };
    if (s.workType === WORK_TYPES.FLEX) {
      const balance = calculateFlexBalance_(buildWorkRule_(s.workType, s, settings).monthlyMinutes, worked);
      row.flex = {
        scheduled: formatMinutes_(balance.scheduledMinutes), worked: formatMinutes_(balance.workedMinutes),
        remaining: formatMinutes_(balance.remainingMinutes), excess: formatMinutes_(balance.excessMinutes),
      };
    }
    return row;
  });
  return { month: month, from: range.from, to: range.to, rows: rows };
}

// ============================================================ 申請

/** 申請一覧：承認待ちは全件（古い順）、処理済みは新しい順に一定件数 */
function listRequestsForAdmin_(sheetName, toView, ctx) {
  const all = readTable_(sheetName).records.map(function (r) {
    const view = toView(r);
    const staff = ctx.staffById[view.employeeId];
    view.department = staff ? staff.department : '';
    return view;
  });
  const pending = all.filter(function (v) { return v.status === REQUEST_STATUS.PENDING; })
    .sort(function (a, b) { return a.requestedAt < b.requestedAt ? -1 : 1; });
  const processed = all.filter(function (v) { return v.status !== REQUEST_STATUS.PENDING; })
    .sort(function (a, b) { return (a.approvedAt || a.requestedAt) < (b.approvedAt || b.requestedAt) ? 1 : -1; })
    .slice(0, ADMIN_RECENT_REQUEST_LIMIT);
  return { pending: pending, processed: processed, pendingCount: pending.length };
}

// ============================================================ フレックス・完全休日・日報

/** フレックス社員の週（date を含む週）と月（month）の集計 */
function buildAdminFlex_(ctx, date, month) {
  const settings = ctx.settings;
  const week = getWeekRange_(date, settings.weekStartDay);
  const monthRange = getMonthRange_(month, settings.monthClosingDay);
  const rows = ctx.staffList
    .filter(function (s) { return isAttendanceTarget_(s) && s.workType === WORK_TYPES.FLEX; })
    .map(function (s) {
      const rule = buildWorkRule_(s.workType, s, settings);
      const records = ctx.attendanceByEmployee[s.employeeId] || [];
      return {
        employeeId: s.employeeId, name: s.name, department: s.department,
        week: summarizeFlexPeriod_(records, week.from, week.to, rule.weeklyMinutes),
        month: summarizeFlexPeriod_(records, monthRange.from, monthRange.to, rule.monthlyMinutes),
      };
    });
  return { weekFrom: week.from, weekTo: week.to, month: month, monthFrom: monthRange.from, monthTo: monthRange.to, rows: rows };
}

/**
 * 週1日完全休日。判定そのものは既存の checkWeeklyRest_ をそのまま使い、表示の分け方だけをここで決める。
 *   rows     … date を含む週で「不足」が確定した人（警告として表示）
 *   pending  … date を含む週がまだ途中で、完全休日が「未確定」の人（警告ではなく軽い表示）
 *   previous … date を含む週がまだ途中のときは、その前の週（確定済み）の「不足」の人も警告に出す
 */
function buildAdminRestDays_(ctx, date) {
  const settings = ctx.settings;
  const week = getWeekRange_(date, settings.weekStartDay);
  const current = checkRestDaysForWeek_(ctx, week);
  const result = {
    from: week.from, to: week.to, required: settings.weeklyFullRestDays, weekFinished: week.to < ctx.today,
    rows: current.filter(function (x) { return x.status === '不足'; }),
    pending: current.filter(function (x) { return x.status === '未確定'; }),
    previous: null,
  };
  if (!result.weekFinished) {
    const prevWeek = getWeekRange_(addDays_(week.from, -1), settings.weekStartDay);
    result.previous = {
      from: prevWeek.from, to: prevWeek.to,
      rows: checkRestDaysForWeek_(ctx, prevWeek).filter(function (x) { return x.status === '不足'; }),
    };
  }
  return result;
}

/** 1週間分の判定（在籍スタッフ全員。確保済みの人は除く） */
function checkRestDaysForWeek_(ctx, week) {
  const judgeDate = week.to < ctx.today ? addDays_(week.to, 1) : ctx.today; // 既存の checkWeeklyRestDays と同じ判定
  const rows = [];
  ctx.staffList.filter(isAttendanceTarget_).forEach(function (s) {
    const check = checkWeeklyRest_(ctx.attendanceByEmployee[s.employeeId] || [], week.from, judgeDate, ctx.settings.weeklyFullRestDays);
    if (check.status === '確保済み') return;
    rows.push({
      employeeId: s.employeeId, name: s.name, department: s.department, workType: s.workType,
      status: check.status, restDays: check.confirmedRestDays, required: check.required, message: check.message,
      weekFrom: week.from, weekTo: week.to,
    });
  });
  return rows;
}

/**
 * 日報：その日の在籍スタッフ全員の提出状況（未提出の人も含む）。
 * 下書きは本人以外に見せないため、管理者にも「未提出」として返し、内容は返さない。
 * 提出済みの内容は、日報画面（getReportDetail）で見る。
 */
function buildAdminReports_(ctx, date) {
  const byEmployee = {};
  readTable_(SHEET_NAMES.DAILY_REPORTS).records.forEach(function (r) {
    if (toDateKey_(r['日付']) === date && reportStateOf_(r) === REPORT_STATE.SUBMITTED) byEmployee[String(r['社員ID']).trim()] = r;
  });
  const hasShareSheets = !!getSpreadsheet_().getSheetByName(SHEET_NAMES.REPORT_CONFIRMATIONS) && !!getSpreadsheet_().getSheetByName(SHEET_NAMES.REPORT_CUSTOMERS);
  const share = hasShareSheets && Object.keys(byEmployee).length ? buildReportShareContext_() : null;
  const rows = ctx.staffList.filter(function (s) { return s.status === EMPLOYMENT_STATUS.ACTIVE; }).map(function (s) {
    const record = byEmployee[s.employeeId];
    const attendance = ctx.attendanceByKey[s.employeeId + '|' + date];
    const row = {
      reportId: '', date: date, employeeId: s.employeeId, name: s.name, department: s.department,
      workStyle: attendance ? toPlainText_(attendance['勤務形態']) : '', status: '未提出', submitted: false, submittedAt: '',
    };
    if (!record) return row;
    row.reportId = toPlainText_(record['日報ID']);
    row.status = REPORT_STATUS.SUBMITTED;
    row.submitted = true;
    row.submittedAt = toPlainText_(record['提出日時']);
    row.version = reportVersionOf_(record);
    if (isLegacySubmittedReport_(record)) { row.legacy = true; return row; } // 旧日報：確認の対象外
    if (share) {
      const c = confirmationStatus_(record, share);
      row.customerCount = share.customerCounts[row.reportId] || 0;
      row.confirmedCount = c.confirmedCount;
      row.targetCount = c.targetCount;
    }
    return row;
  });
  return {
    date: date, rows: rows,
    submittedCount: rows.filter(function (r) { return r.submitted; }).length,
    notSubmittedCount: rows.filter(function (r) { return !r.submitted; }).length,
  };
}

// ============================================================ CSV

/** CSV の1セル。Excel で式として実行されないよう、= + - @ で始まる文字には ' を付ける */
function csvCell_(value) {
  let text = String(value === null || value === undefined ? '' : value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return csvEscape_(text);
}
