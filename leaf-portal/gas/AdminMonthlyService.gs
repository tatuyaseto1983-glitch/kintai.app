/**
 * AdminMonthlyService.gs
 * ------------------------------------------------------------
 * 段階5：管理者の月次の詳細・集計・出力です（すべて読み取りと集計だけ。シートには書き込みません）。
 *
 *   社内詳細月次（社員1名×20日締め1か月を1日1行）     … getAdminEmployeeMonth / exportAdminEmployeeMonthCsv
 *   月次の集計（接客・日報確認・理由付き要確認一覧）    … getAdminMonthlyAnalysis
 *   月次サマリーCSV（社員ごとの合計）                  … exportAdminMonthlySummaryCsv
 *   社労士確認用の詳細表（CSV）                        … exportSharoushiDetailCsv
 *
 * 【期間】勤怠・社労士用は20日締め（getPayrollPeriodByMonthKey_）。接客・日報は暦月（getReportMonthPeriod_）。
 * 【実働】勤務区間履歴・中断履歴から計算した値（勤怠記録の実働時間は同じ計算で書かれている）を使う。
 *   実働 ＝ 勤務区間 − 中断（私用の中抜け） − 自動休憩（昼休み）。
 * 【まだ計算しないもの】法定時間外・週40時間・深夜・法定休日・割増・フレックスの法定時間外・フレックスの有給算入
 *   （社労士の確認待ち。社労士確認用の詳細表では「未確定」の列として空欄で出す）
 */

/** 社労士確認用の詳細表で、まだ計算しない列（見出しに「未確定」と付けて空欄で出す） */
const SHAROUSHI_UNDECIDED_COLUMNS = ['法定時間外（未確定）', '深夜（未確定）', '法定休日（未確定）'];

/** 要確認の理由の区分 */
const CHECK_CATEGORIES = { PUNCH: '打刻', OVERTIME: '残業', REQUEST: '有給・申請', REPORT: '日報' };

// ============================================================ 画面・出力から呼ぶ関数（管理者だけ）

/**
 * 【管理者】社員1名の20日締め1か月を1日1行で返す（勤務のない日も1行）。勤務区間・中断・交通費の明細つき。
 * @param {string} employeeId 社員ID
 * @param {string} [month] '2026-10'（2026/09/21〜2026/10/20）。省略すると今日を含む期間
 */
function getAdminEmployeeMonth(employeeId, month) {
  return runApi_(function () {
    requireAdmin();
    const env = buildMonthlyEnv_(month);
    const staff = requireStaffForMonthly_(employeeId);
    const result = buildEmployeeMonth_(env, staff);
    return { message: staff.name + ' の ' + env.range.periodText + ' を取得しました', data: result };
  });
}

/** 【管理者】社員1名の詳細CSV（1日1行。勤務のない日も出す） */
function exportAdminEmployeeMonthCsv(employeeId, month) {
  return runApi_(function () {
    requireAdmin();
    const env = buildMonthlyEnv_(month);
    const staff = requireStaffForMonthly_(employeeId);
    const m = buildEmployeeMonth_(env, staff);
    const headers = ['日付', '曜日', '勤務場所', '勤務区間数', '勤務区間', '出勤', '退勤', '中断', '自動休憩', '実働', '会社時間', '在宅時間',
      '遅刻', '早退', '社内超過', '休日出勤', '休日出勤時間', '有給種別', '有給時間', '直行', '直帰', '現場', '出張', '日備考',
      '業務走行距離', '交通費', '残業申請', '日報', '要確認の理由'];
    const lines = [headers.map(csvCell_).join(',')];
    m.days.forEach(function (d) {
      lines.push([d.date, d.weekday, d.workPlace, d.segmentCount || '', segmentsText_(d.segments), d.clockIn, d.clockOut, d.breakTotal, d.autoBreak, d.workTime,
        d.officeTime, d.remoteTime, d.late, d.earlyLeave, d.internalExcess, d.holidayWork ? '○' : '', d.holidayWork ? d.holidayWorkTime : '',
        d.leaveType, d.leaveTime, d.direct ? '○' : '', d.directReturn ? '○' : '', d.sites.join('・'), d.businessTrip ? '○' : '', d.dayNote,
        d.kmText, d.transportAmount ? String(d.transportAmount) : '', d.overtimeRequest, d.reportStatus, reasonsText_(d.reasons)].map(csvCell_).join(','));
    });
    const t = m.totals;
    lines.push(['合計', '', '', '', '', t.workDays + '日', '', t.breakTotal, t.autoBreak, t.workTime, t.officeTime, t.remoteTime, t.late, t.earlyLeave,
      t.internalExcess, t.holidayWorkDays + '日', t.holidayWorkTime, '', t.leaveTime, t.directDays + '日', t.directReturnDays + '日', '',
      t.businessTripDays + '日', '', t.kmText, String(t.transportAmount), '', '提出 ' + t.reportSubmitted + '件', '要確認 ' + t.checkDays + '日'].map(csvCell_).join(','));
    return {
      message: staff.name + ' の詳細CSVを作成しました（' + env.range.periodText + '）',
      data: { fileName: 'kintai_detail_' + staff.employeeId + '_' + env.range.monthKey + '.csv', csv: '﻿' + lines.join('\r\n') },
    };
  });
}

/**
 * 【管理者】月次の集計：接客集計・日報確認集計（どちらも暦月）と、理由付き要確認一覧（20日締め）。
 * @param {string} [month] '2026-10'
 */
function getAdminMonthlyAnalysis(month) {
  return runApi_(function () {
    requireAdmin();
    const env = buildMonthlyEnv_(month);
    const reportRange = getReportMonthPeriod_(env.range.monthKey);
    return {
      message: '月次の集計を取得しました',
      data: {
        month: env.range.monthKey,
        sales: buildSalesSummary_(env, reportRange),
        reports: buildReportSummary_(env, reportRange),
        checks: buildCheckList_(env),
      },
    };
  });
}

/** 【管理者】月次サマリーCSV（社員ごとの合計。20日締め） */
function exportAdminMonthlySummaryCsv(month) {
  return runApi_(function () {
    requireAdmin();
    const env = buildMonthlyEnv_(month);
    const monthly = buildAdminMonthly_(env.ctx, env.range.monthKey);
    const headers = ['社員ID', '氏名', '部署', '勤務区分', '出勤日数', '実働', '遅刻合計', '遅刻回数', '早退合計', '社内超過合計', '打刻漏れ件数',
      '打刻修正申請件数', '残業要確認件数', '休日出勤日数', '休日出勤時間', '1日有給', '午前半休', '午後半休', '有給時間', '在宅日数', '業務走行距離',
      '交通費（通勤以外）', '要確認（申請）件数', 'フレックス月所定', 'フレックス実働', 'フレックス有給', 'フレックス残り', 'フレックス超過', 'フレックス有給算入'];
    const lines = [headers.map(csvCell_).join(',')];
    monthly.rows.forEach(function (r) {
      const d = r.days || {};
      const f = r.flex || {};
      lines.push([r.employeeId, r.name, r.department, r.workType, r.workDays, r.workTime, r.lateTotal, r.lateCount, r.earlyLeaveTotal,
        r.workType === WORK_TYPES.FLEX ? '' : r.internalExcessTotal, r.missingPunchCount, r.correctionCount, r.needsCheckCount,
        d.holidayWorkDays || 0, d.holidayWorkTime || '00:00', d.fullLeaveDays || 0, d.amLeaveDays || 0, d.pmLeaveDays || 0, d.leaveTime || '00:00',
        d.remoteDays || 0, r.mileageText, r.transportAmount, d.checkCount || 0,
        f.scheduled || '', f.worked || '', f.paidLeave || '', f.remaining || '', f.excess || '', r.flex ? f.paidLeaveMode : ''].map(csvCell_).join(','));
    });
    return {
      message: env.range.periodText + ' の月次サマリーCSVを作成しました（' + monthly.rows.length + '名）',
      data: { fileName: 'kintai_summary_' + env.range.monthKey + '.csv', csv: '﻿' + lines.join('\r\n') },
    };
  });
}

/**
 * 【管理者】社労士確認用の詳細表（CSV）。勤怠集計対象の社員×20日締め期間の全日を1日1行、社員ごとに合計行。
 * 確定している項目だけを値で出す（数式なし）。法定時間外・深夜・法定休日は「未確定」の列として空欄。
 */
function exportSharoushiDetailCsv(month) {
  return runApi_(function () {
    requireAdmin();
    const env = buildMonthlyEnv_(month);
    const headers = ['社員ID', '氏名', '勤務区分', '日付', '曜日', '出勤', '退勤', '勤務区間', '会社時間', '在宅時間', '中断（私用の中抜け）',
      '休憩（自動）', '実働', '休日出勤（承認済み）', '休日出勤時間', '有給種別', '有給時間', '出張', '直行', '直帰', '要確認の理由'].concat(SHAROUSHI_UNDECIDED_COLUMNS);
    const lines = [headers.map(csvCell_).join(',')];
    const blanks = SHAROUSHI_UNDECIDED_COLUMNS.map(function () { return ''; });
    const staffList = visibleStaff_(env.ctx);
    staffList.forEach(function (s) {
      const m = buildEmployeeMonth_(env, s);
      m.days.forEach(function (d) {
        lines.push([s.employeeId, s.name, s.workType, d.date, d.weekday, d.clockIn, d.clockOut, segmentsText_(d.segments), d.officeTime, d.remoteTime,
          d.breakTotal, d.autoBreak, d.workTime, d.holidayWork ? '○' : '', d.holidayWork ? d.holidayWorkTime : '', d.leaveType, d.leaveTime,
          d.businessTrip ? '○' : '', d.direct ? '○' : '', d.directReturn ? '○' : '', reasonsText_(d.reasons)].concat(blanks).map(csvCell_).join(','));
      });
      const t = m.totals;
      lines.push([s.employeeId, s.name, s.workType, '合計', '', t.workDays + '日', '', '', t.officeTime, t.remoteTime, t.breakTotal, t.autoBreak, t.workTime,
        t.holidayWorkDays + '日', t.holidayWorkTime, '', t.leaveTime, t.businessTripDays + '日', t.directDays + '日', t.directReturnDays + '日',
        '要確認 ' + t.checkDays + '日'].concat(blanks).map(csvCell_).join(','));
    });
    return {
      message: env.range.periodText + ' の社労士確認用の詳細表を作成しました（' + staffList.length + '名）',
      data: {
        fileName: 'sharoushi_check_' + env.range.monthKey + '.csv', csv: '﻿' + lines.join('\r\n'),
        notes: [
          '期間：' + env.range.periodText + '（20日締め）。勤怠集計対象の社員だけ',
          '実働 ＝ 勤務区間 − 中断（私用の中抜け） − 休憩（自動。中断を除いた勤務が「自動休憩_適用開始」を超えた日）',
          '休日出勤は承認済みの休日出勤申請がある日。休日と法定休日の区別はしていません',
          '法定時間外・深夜・法定休日は社労士の確認待ちのため空欄（未確定）です',
        ],
      },
    };
  });
}

// ============================================================ 準備

/** 月次の処理で使う情報（20日締めの期間・管理者画面と同じ集計の準備）を1回だけ読む */
function buildMonthlyEnv_(month) {
  const settings = getSettings_();
  const now = getNowInfo_();
  const range = isBlank_(month)
    ? getPayrollPeriodForDate_(now.date, settings.monthClosingDay)
    : getPayrollPeriodByMonthKey_(requireMonthKey_(month, '対象月'), settings.monthClosingDay);
  const ctx = buildAdminContext_(settings, now.date);
  return { settings: settings, now: now, range: range, ctx: ctx, reportByKey: buildReportStateMap_() };
}

function requireStaffForMonthly_(employeeId) {
  const id = requireText_(employeeId, '社員ID', { max: TEXT_LIMITS.SHORT });
  const staff = findStaffById_(id);
  if (!staff) fail_('社員ID「' + id + '」のスタッフが見つかりません');
  return staff;
}

/** 日報シートを1回読む：社員ID|日付 → { submitted: 行, draft: 行 }（シートがなければ空） */
function buildReportStateMap_() {
  const map = {};
  if (!getSpreadsheet_().getSheetByName(SHEET_NAMES.DAILY_REPORTS)) return map;
  readTable_(SHEET_NAMES.DAILY_REPORTS).records.forEach(function (r) {
    const key = String(r['社員ID']).trim() + '|' + toDateKey_(r['日付']);
    const slot = map[key] = map[key] || {};
    if (reportStateOf_(r) === REPORT_STATE.SUBMITTED) slot.submitted = r; else slot.draft = r;
  });
  return map;
}

// ============================================================ 社内詳細月次（1日1行）

/** 社員1名の期間の日別の行と合計 */
function buildEmployeeMonth_(env, staff) {
  const ctx = env.ctx;
  const range = env.range;
  const transportsByDate = {};
  listTransportRows_(staff.employeeId, range.from, range.to).forEach(function (r) {
    const v = toTransportView_(r);
    (transportsByDate[v.date] = transportsByDate[v.date] || []).push(v);
  });
  const days = listDates_(range.from, range.to).map(function (date) {
    return buildEmployeeDay_(env, staff, date, transportsByDate[date] || []);
  });
  return {
    employee: { employeeId: staff.employeeId, name: staff.name, department: staff.department, workType: staff.workType },
    month: range.monthKey, from: range.from, to: range.to, periodText: range.periodText,
    days: days,
    totals: totalEmployeeDays_(days),
  };
}

/** 1日分（勤怠記録がない日も、有給・交通費・日報があれば出す） */
function buildEmployeeDay_(env, staff, date, transports) {
  const ctx = env.ctx;
  const record = ctx.attendanceByKey[staff.employeeId + '|' + date] || null;
  const view = record ? toAdminAttendanceRow_(record, ctx) : null;
  const st = buildDayStatus_(staff.employeeId, date, record, ctx.day);
  const attendanceId = record ? String(record['勤怠ID']).trim() : '';
  const segments = record ? getDaySegments_(record, ctx.calc.segmentsByAttendance[attendanceId] || []) : [];
  const interruptions = record ? (ctx.calc.breakIntervalsByAttendance[attendanceId] || []) : [];
  const tsum = summarizeTransportItems_(transports);
  const worked = !!record && !isBlank_(record['出勤']);
  const report = reportStatusOfDay_(env, staff, date, worked);
  const day = {
    date: date,
    weekday: WEEKDAY_LABELS[weekdayOf_(date)],
    hasAttendance: !!record,
    worked: worked,
    workPlace: view ? view.workPlace : '',
    segmentCount: view ? Number(view.segmentCount) || segments.length : 0,
    segments: segments.map(function (s) {
      return {
        place: workPlaceLabel_(s.style), start: minutesToClock_(s.startMinutes), end: s.endMinutes === null ? '' : minutesToClock_(s.endMinutes),
        direct: !!s.direct, directReturn: !!s.directReturn, site: s.site || '', note: s.note || '',
      };
    }),
    interruptions: interruptions.map(function (b) { return { start: minutesToClock_(b.startMinutes), end: minutesToClock_(b.endMinutes) }; }),
    clockIn: view ? view.clockIn : '',
    clockOut: view ? view.clockOut : '',
    breakTotal: view ? view.breakTotal : '',
    autoBreak: view ? view.autoBreak : '',
    workTime: view ? view.workTime : '',
    officeTime: view ? view.officeTime : '',
    remoteTime: view ? view.remoteTime : '',
    late: view ? view.late : '',
    earlyLeave: view ? view.earlyLeave : '',
    internalExcess: view ? view.internalExcess : '',
    holidayWork: st.kind === '休日出勤' || st.kind === '法定休日出勤',
    holidayWorkTime: st.holidayWork ? formatMinutes_(st.holidayWork.minutes) : '',
    leaveType: st.leave ? st.leave.type : '',
    leaveTime: st.leave ? formatMinutes_(st.leave.minutes) : '',
    direct: view ? !!view.direct : false,
    directReturn: view ? !!view.directReturn : false,
    sites: view ? view.sites : [],
    businessTrip: view ? !!view.businessTrip : false,
    dayNote: view ? view.dayNote : '',
    km: tsum.km,
    kmText: tsum.km ? tsum.kmText : '',
    transportAmount: tsum.amount,
    transportCount: tsum.count,
    transports: transports,
    overtimeRequest: view ? view.preOvertimeRequest : '',
    reportStatus: report.label,
    reportState: report.state,
    reasons: collectDayReasons_(view, st, report),
  };
  return day;
}

/**
 * その日の日報の状態（暦月とは関係なく、その日の日報）。
 *   提出済み／未提出（下書きあり）／未提出（出勤ありの日報提出対象者で、前日まで）／空欄（対象外・今日）
 */
function reportStatusOfDay_(env, staff, date, worked) {
  const slot = env.reportByKey[staff.employeeId + '|' + date] || {};
  if (slot.submitted) return { state: 'submitted', label: '提出済み' };
  if (!worked || !staff.reportSubmitTarget) return { state: slot.draft ? 'draft-only' : 'none', label: slot.draft ? '下書き' : '' };
  if (date > env.now.date) return { state: 'future', label: slot.draft ? '下書き' : '' }; // 先の日（まだ判定しない）
  if (date === env.now.date) return { state: 'today', label: slot.draft ? '下書き' : '未提出（今日）' };
  return slot.draft ? { state: 'draft', label: '未提出（下書きあり）' } : { state: 'missing', label: '未提出' };
}

/**
 * 理由付きの要確認（1日分）。勤怠記録の1列の「要確認」（残業の事前申請）とは別に、理由ごとに返す。
 * 戻り値：[{ category: 打刻|残業|有給・申請|日報, text }]
 */
function collectDayReasons_(view, st, report) {
  const reasons = [];
  if (view) {
    (view.issues || []).forEach(function (t) { reasons.push({ category: CHECK_CATEGORIES.PUNCH, text: t }); });
    if (view.needsCheck === MARKS.NEEDS_CHECK) reasons.push({ category: CHECK_CATEGORIES.OVERTIME, text: '残業：30分以上で承認済みの事前申請なし' });
  }
  (st.checks || []).forEach(function (t) { reasons.push({ category: CHECK_CATEGORIES.REQUEST, text: t }); });
  if (report.state === 'missing') reasons.push({ category: CHECK_CATEGORIES.REPORT, text: '日報未提出' });
  if (report.state === 'draft') reasons.push({ category: CHECK_CATEGORIES.REPORT, text: '日報未提出（下書きあり）' });
  return reasons;
}

function totalEmployeeDays_(days) {
  const sumTime = function (key) { return days.reduce(function (t, d) { return t + (toMinutes_(d[key]) || 0); }, 0); };
  const count = function (fn) { return days.filter(fn).length; };
  const km = Math.round(days.reduce(function (t, d) { return t + d.km * 10; }, 0)) / 10;
  return {
    workDays: count(function (d) { return d.worked; }),
    breakTotal: formatMinutes_(sumTime('breakTotal')),
    autoBreak: formatMinutes_(sumTime('autoBreak')),
    workTime: formatMinutes_(sumTime('workTime')),
    officeTime: formatMinutes_(sumTime('officeTime')),
    remoteTime: formatMinutes_(sumTime('remoteTime')),
    late: formatMinutes_(sumTime('late')),
    earlyLeave: formatMinutes_(sumTime('earlyLeave')),
    internalExcess: formatMinutes_(sumTime('internalExcess')),
    holidayWorkDays: count(function (d) { return d.holidayWork; }),
    holidayWorkTime: formatMinutes_(sumTime('holidayWorkTime')),
    leaveDays: count(function (d) { return !!d.leaveType; }),
    leaveTime: formatMinutes_(sumTime('leaveTime')),
    directDays: count(function (d) { return d.direct; }),
    directReturnDays: count(function (d) { return d.directReturn; }),
    businessTripDays: count(function (d) { return d.businessTrip; }),
    km: km,
    kmText: formatKm_(km),
    transportAmount: days.reduce(function (t, d) { return t + d.transportAmount; }, 0),
    reportSubmitted: count(function (d) { return d.reportState === 'submitted'; }),
    reportMissing: count(function (d) { return d.reportState === 'missing'; }),
    reportDraftOnly: count(function (d) { return d.reportState === 'draft'; }),
    checkDays: count(function (d) { return d.reasons.length > 0; }),
  };
}

/** 「会社 09:00〜12:00（直行・現場：〇〇）／在宅 13:00〜18:00」 */
function segmentsText_(segments) {
  return (segments || []).map(function (s) {
    const extra = [s.direct ? '直行' : '', s.directReturn ? '直帰' : '', s.site ? '現場：' + s.site : ''].filter(function (x) { return x; });
    return s.place + ' ' + s.start + '〜' + (s.end || '（勤務中）') + (extra.length ? '（' + extra.join('・') + '）' : '');
  }).join('／');
}

function reasonsText_(reasons) {
  return (reasons || []).map(function (r) { return r.text; }).join('・');
}

// ============================================================ 理由付き要確認一覧（20日締め）

/** 勤怠集計対象の社員の、期間内で要確認の理由がある日（今日まで）。理由ごとの件数つき */
function buildCheckList_(env) {
  const items = [];
  const byCategory = {};
  const byReason = {};
  Object.keys(CHECK_CATEGORIES).forEach(function (k) { byCategory[CHECK_CATEGORIES[k]] = 0; });
  const last = env.range.to < env.now.date ? env.range.to : env.now.date;
  visibleStaff_(env.ctx).forEach(function (s) {
    const m = buildEmployeeMonth_(env, s);
    m.days.forEach(function (d) {
      if (d.date > last || !d.reasons.length) return;
      items.push({ date: d.date, weekday: d.weekday, employeeId: s.employeeId, name: s.name, reasons: d.reasons });
      d.reasons.forEach(function (r) {
        byCategory[r.category] = (byCategory[r.category] || 0) + 1;
        byReason[r.text] = (byReason[r.text] || 0) + 1;
      });
    });
  });
  items.sort(function (a, b) { return a.date !== b.date ? (a.date < b.date ? -1 : 1) : (a.employeeId < b.employeeId ? -1 : 1); });
  return {
    from: env.range.from, to: env.range.to, periodText: env.range.periodText, until: last,
    items: items, byCategory: byCategory,
    byReason: Object.keys(byReason).sort().map(function (k) { return { reason: k, count: byReason[k] }; }),
  };
}

// ============================================================ 接客集計（暦月）

/** 来場きっかけの小計（以前の値は書き換えず、表示用に「（旧）」を付けて小計に含める） */
const VISIT_TRIGGER_GROUPS = [
  { name: '検索（合計）', members: ['Google検索', 'Yahoo!検索', '検索（不明）', 'Web検索'] },
  { name: 'イベント（合計）', members: ['イベント（見学会など）', 'イベント'] },
];

/**
 * 接客の集計（提出済みの日報の接客記録だけ。下書きは数えない）。
 *   会社の接客件数 ＝ 主担当の件数だけ（担当区分が空欄の以前の記録は主担当）
 *   副担当参加件数 ＝ 副担当の件数（会社の件数には足さない）
 *   来場きっかけ別 ＝ 主担当の記録で数える（同じ接客を副担当の分まで数えない）
 */
function buildSalesSummary_(env, reportRange) {
  const ss = getSpreadsheet_();
  const empty = { from: reportRange.from, to: reportRange.to, periodText: reportRange.periodText, companyMainCount: 0, subCount: 0, employees: [], triggers: [], groups: [], warnings: [] };
  if (!ss.getSheetByName(SHEET_NAMES.DAILY_REPORTS) || !ss.getSheetByName(SHEET_NAMES.REPORT_CUSTOMERS)) return empty;
  const reports = {};
  readTable_(SHEET_NAMES.DAILY_REPORTS).records.forEach(function (r) {
    const date = toDateKey_(r['日付']);
    if (date < reportRange.from || date > reportRange.to || reportStateOf_(r) !== REPORT_STATE.SUBMITTED) return;
    reports[String(r['日報ID']).trim()] = { date: date, employeeId: String(r['社員ID']).trim(), name: toPlainText_(r['氏名']) };
  });
  const rows = [];
  readTable_(SHEET_NAMES.REPORT_CUSTOMERS).records.forEach(function (r) {
    if (String(r['削除']).trim() === '1') return;
    const rep = reports[String(r['日報ID']).trim()];
    if (!rep) return;
    rows.push({
      date: rep.date, employeeId: rep.employeeId, name: rep.name,
      role: toPlainText_(r['担当区分']).trim() || CUSTOMER_ROLES.MAIN,
      mainStaffId: toPlainText_(r['主担当者ID']).trim(), mainStaffName: toPlainText_(r['主担当者名']),
      customerName: toPlainText_(r['顧客名']), unknown: String(r['顧客名未確認']).trim() === '1',
      trigger: toPlainText_(r['来場のきっかけ']).trim(),
    });
  });

  const byEmployee = {};
  const staffName = {};
  env.ctx.staffList.forEach(function (s) { staffName[s.employeeId] = s.name; });
  rows.forEach(function (x) {
    const e = byEmployee[x.employeeId] = byEmployee[x.employeeId] || { employeeId: x.employeeId, name: staffName[x.employeeId] || x.name, mainCount: 0, subCount: 0 };
    if (x.role === CUSTOMER_ROLES.SUB) e.subCount += 1; else e.mainCount += 1;
  });
  const mains = rows.filter(function (x) { return x.role !== CUSTOMER_ROLES.SUB; });
  const triggerCount = {};
  mains.forEach(function (x) { const k = x.trigger || '（未入力）'; triggerCount[k] = (triggerCount[k] || 0) + 1; });
  const order = VISIT_TRIGGERS.concat(LEGACY_VISIT_TRIGGERS, ['（未入力）']);
  const triggers = Object.keys(triggerCount).sort(function (a, b) {
    const ia = order.indexOf(a) === -1 ? 999 : order.indexOf(a);
    const ib = order.indexOf(b) === -1 ? 999 : order.indexOf(b);
    return ia - ib;
  }).map(function (k) {
    const legacy = LEGACY_VISIT_TRIGGERS.indexOf(k) !== -1;
    return { trigger: k, label: legacy ? k + '（旧）' : k, legacy: legacy, count: triggerCount[k] };
  });
  const groups = VISIT_TRIGGER_GROUPS.map(function (g) {
    return { name: g.name, members: g.members, count: g.members.reduce(function (t, k) { return t + (triggerCount[k] || 0); }, 0) };
  });

  return {
    from: reportRange.from, to: reportRange.to, periodText: reportRange.periodText,
    companyMainCount: mains.length,
    subCount: rows.length - mains.length,
    employees: Object.keys(byEmployee).map(function (k) { return byEmployee[k]; }).sort(function (a, b) { return a.employeeId < b.employeeId ? -1 : 1; }),
    triggers: triggers,
    groups: groups,
    warnings: findSalesDuplicateWarnings_(rows),
  };
}

/** 顧客名の比較用（空白と末尾の「様」「さん」を除く） */
function normalizeCustomerName_(name) {
  return String(name || '').replace(/[\s　]/g, '').replace(/(様|さん)$/, '');
}

/**
 * 同じ接客の重複の候補（データは書き換えない。警告だけ）。
 *   主担当側の記録なし … 副担当の記録の主担当者が、同じ日に主担当の接客を記録していない（同じ顧客名、名前が未確認ならどれでも）
 *   主担当の重複の候補 … 同じ日・同じ顧客名で、別の社員がそれぞれ主担当として記録している
 */
function findSalesDuplicateWarnings_(rows) {
  const warnings = [];
  const mains = rows.filter(function (x) { return x.role !== CUSTOMER_ROLES.SUB; });
  rows.filter(function (x) { return x.role === CUSTOMER_ROLES.SUB && x.mainStaffId; }).forEach(function (x) {
    const name = normalizeCustomerName_(x.customerName);
    const found = mains.some(function (m) {
      if (m.date !== x.date || m.employeeId !== x.mainStaffId) return false;
      return x.unknown || !name || m.unknown || normalizeCustomerName_(m.customerName) === name;
    });
    if (!found) {
      warnings.push({ type: '主担当側の記録なし', date: x.date, text: x.name + '（副担当）の「' + (x.unknown ? '顧客名未確認' : x.customerName) + '」：主担当 ' +
        (x.mainStaffName || x.mainStaffId) + ' の同じ日の日報に、主担当の接客記録がありません' });
    }
  });
  const seen = {};
  mains.forEach(function (m) {
    const name = normalizeCustomerName_(m.customerName);
    if (m.unknown || !name) return;
    const key = m.date + '|' + name;
    (seen[key] = seen[key] || []).push(m);
  });
  Object.keys(seen).forEach(function (key) {
    const list = seen[key];
    const people = list.map(function (m) { return m.employeeId; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (people.length < 2) return;
    warnings.push({ type: '主担当の重複の候補', date: list[0].date, text: '「' + list[0].customerName + '」を ' + list.map(function (m) { return m.name; }).join('・') +
      ' がそれぞれ主担当として記録しています（同じ接客なら、どちらかを副担当にしてください）' });
  });
  return warnings.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}

// ============================================================ 日報確認集計（暦月）

/**
 * 日報の提出と確認の集計（暦月）。
 *   提出側（日報提出対象者）：勤務日数・提出数・未提出（前日まで）・下書きのみ・自分の日報の確認率
 *   確認側（日報確認対象者）：確認すべき日報の数・確認した数・確認率（他の人の提出済みの日報の最新版）
 */
function buildReportSummary_(env, reportRange) {
  const ctx = env.ctx;
  const ss = getSpreadsheet_();
  const base = { from: reportRange.from, to: reportRange.to, periodText: reportRange.periodText, authors: [], readers: [], totals: null, reports: [] };
  if (![SHEET_NAMES.DAILY_REPORTS, SHEET_NAMES.REPORT_CONFIRMATIONS, SHEET_NAMES.REPORT_CUSTOMERS, SHEET_NAMES.REPORT_COMMENTS]
    .every(function (n) { return !!ss.getSheetByName(n); })) return base;
  const share = buildReportShareContext_();
  const last = reportRange.to < env.now.date ? reportRange.to : env.now.date;
  const dates = reportRange.from <= last ? listDates_(reportRange.from, last) : [];
  const active = ctx.staffList.filter(function (s) { return s.status === EMPLOYMENT_STATUS.ACTIVE; });

  // 期間内の提出済みの日報（旧日報は確認の対象外なので除く）と、その確認状況
  const reports = [];
  readTable_(SHEET_NAMES.DAILY_REPORTS).records.forEach(function (r) {
    const date = toDateKey_(r['日付']);
    if (date < reportRange.from || date > reportRange.to || reportStateOf_(r) !== REPORT_STATE.SUBMITTED || isLegacySubmittedReport_(r)) return;
    const c = confirmationStatus_(r, share);
    const id = String(r['日報ID']).trim();
    reports.push({
      reportId: id, date: date, employeeId: String(r['社員ID']).trim(), name: toPlainText_(r['氏名']),
      targetCount: c.targetCount, confirmedCount: c.confirmedCount,
      confirmedIds: c.confirmed.map(function (x) { return x.employeeId; }),
      pendingNames: c.pending.map(function (x) { return x.name; }),
      commentCount: share.commentCounts[id] || 0,
    });
  });
  const rate = function (done, all) { return all ? Math.round(done / all * 1000) / 10 : null; };

  const authors = active.filter(function (s) { return s.reportSubmitTarget || reports.some(function (r) { return r.employeeId === s.employeeId; }); }).map(function (s) {
    const row = { employeeId: s.employeeId, name: s.name, submitTarget: s.reportSubmitTarget, workDays: 0, submitted: 0, missing: 0, draftOnly: 0, confirmed: 0, targets: 0 };
    dates.forEach(function (d) {
      const a = ctx.attendanceByKey[s.employeeId + '|' + d];
      const worked = !!a && !isBlank_(a['出勤']);
      const slot = env.reportByKey[s.employeeId + '|' + d] || {};
      if (worked) row.workDays += 1;
      if (slot.submitted || !worked || !s.reportSubmitTarget || d >= env.now.date) return;
      if (slot.draft) row.draftOnly += 1; else row.missing += 1;
    });
    reports.filter(function (r) { return r.employeeId === s.employeeId; }).forEach(function (r) {
      row.submitted += 1;
      row.confirmed += r.confirmedCount;
      row.targets += r.targetCount;
    });
    row.submitRate = rate(row.submitted, row.submitted + row.missing + row.draftOnly);
    row.confirmRate = rate(row.confirmed, row.targets);
    return row;
  });

  const readers = active.filter(isReportConfirmTarget_).map(function (s) {
    const mine = reports.filter(function (r) { return r.employeeId !== s.employeeId; });
    const done = mine.filter(function (r) { return r.confirmedIds.indexOf(s.employeeId) !== -1; }).length;
    return { employeeId: s.employeeId, name: s.name, required: mine.length, confirmed: done, rate: rate(done, mine.length) };
  });

  const totalTargets = reports.reduce(function (t, r) { return t + r.targetCount; }, 0);
  const totalConfirmed = reports.reduce(function (t, r) { return t + r.confirmedCount; }, 0);
  const submitted = authors.reduce(function (t, a) { return t + a.submitted; }, 0);
  const missing = authors.reduce(function (t, a) { return t + a.missing; }, 0);
  const draftOnly = authors.reduce(function (t, a) { return t + a.draftOnly; }, 0);
  return {
    from: reportRange.from, to: reportRange.to, periodText: reportRange.periodText, until: last,
    authors: authors, readers: readers,
    reports: reports.map(function (r) { return { reportId: r.reportId, date: r.date, name: r.name, confirmedCount: r.confirmedCount, targetCount: r.targetCount, pendingNames: r.pendingNames, commentCount: r.commentCount }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }),
    totals: {
      submitted: submitted, missing: missing, draftOnly: draftOnly, submitRate: rate(submitted, submitted + missing + draftOnly),
      confirmations: totalConfirmed, confirmationTargets: totalTargets, confirmRate: rate(totalConfirmed, totalTargets),
    },
  };
}
