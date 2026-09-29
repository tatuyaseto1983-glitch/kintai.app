/**
 * BreakService.gs
 * ------------------------------------------------------------
 * 「中断」と「再開」です。
 *
 * 中断は、自動休憩（1時間）とは別のものです。
 * 私用外出など、業務から一時的に離れる時間として「中断履歴」シートに1回ずつ記録します。
 * 1日に何回でも中断できます（ただし中断中にもう一度中断はできません）。
 *
 * 中断時間 = 再開時刻 − 中断開始時刻
 */

/**
 * 【画面から呼ぶ】中断する。
 * @param {string} [reason] 理由（任意）
 */
function startBreak(reason) {
  return runApi_(function () {
    return withLock_(function () { return startBreak_(reason); });
  });
}

/** 【画面から呼ぶ】中断から再開する。 */
function resumeWork() {
  return runApi_(function () {
    return withLock_(function () { return resumeWork_(); });
  });
}

function startBreak_(reason) {
  const reasonText = requireText_(reason, '中断の理由', { required: false });
  const staff = getCurrentStaff_();
  requireActiveStaff_(staff);
  const now = getNowInfo_();
  const record = findCurrentAttendance_(staff.employeeId, now.date);

  if (!record) fail_('本日はまだ出勤していません。先に「出勤」を押してください');
  const status = String(record['状態']);
  if (status === ATTENDANCE_STATUS.ON_BREAK) fail_('すでに中断中です。業務に戻るときは「再開」を押してください');
  if (status === ATTENDANCE_STATUS.FINISHED) fail_('本日はすでに退勤済みのため中断できません');
  if (status !== ATTENDANCE_STATUS.WORKING) fail_('勤務中ではないため中断できません（今の状態：' + status + '）');

  const attendanceId = String(record['勤怠ID']).trim();
  const count = getBreaksOfAttendance_(attendanceId).length;
  appendRecord_(SHEET_NAMES.BREAKS, {
    '中断ID': makeUniqueId_(SHEET_NAMES.BREAKS, '中断ID', 'BR-' + attendanceId.replace(/^AT-/, '') + '-' + pad2_(count + 1)),
    '勤怠ID': attendanceId,
    '日付': toDateKey_(record['日付']),
    '社員ID': staff.employeeId,
    '氏名': staff.name,
    '中断開始': now.time,
    '理由': reasonText,
  });
  updateRecord_(SHEET_NAMES.ATTENDANCE, record, {
    '状態': ATTENDANCE_STATUS.ON_BREAK,
    '更新日時': now.timestamp,
  });

  return {
    message: '中断しました（' + now.time + '）。戻ったら「再開」を押してください',
    data: toAttendanceView_(record),
  };
}

function resumeWork_() {
  const staff = getCurrentStaff_();
  requireActiveStaff_(staff);
  const now = getNowInfo_();
  const record = findCurrentAttendance_(staff.employeeId, now.date);

  if (!record) fail_('本日はまだ出勤していません');
  if (String(record['状態']) !== ATTENDANCE_STATUS.ON_BREAK) fail_('中断していないため再開できません');

  const attendanceId = String(record['勤怠ID']).trim();
  const openBreaks = getBreaksOfAttendance_(attendanceId).filter(function (b) { return isBlank_(b['再開']); });
  if (!openBreaks.length) fail_('再開されていない中断の記録が見つかりません。管理者に連絡してください');

  const latest = openBreaks[openBreaks.length - 1]; // 最新の未完了の中断
  const minutes = durationBetween_(toMinutes_(latest['中断開始']), now.minutes);
  updateRecord_(SHEET_NAMES.BREAKS, latest, {
    '再開': now.time,
    '中断時間': formatMinutes_(minutes),
  });

  const total = sumCompletedBreakMinutes_(attendanceId);
  updateRecord_(SHEET_NAMES.ATTENDANCE, record, {
    '中断合計': formatMinutes_(total),
    '状態': ATTENDANCE_STATUS.WORKING,
    '更新日時': now.timestamp,
  });

  return {
    message: '再開しました（中断 ' + formatMinutes_(minutes) + '／本日の中断合計 ' + formatMinutes_(total) + '）',
    data: toAttendanceView_(record),
  };
}

/** 勤怠IDに紐づく中断履歴（シートの上から順） */
function getBreaksOfAttendance_(attendanceId) {
  return findRecords_(SHEET_NAMES.BREAKS, function (b) { return String(b['勤怠ID']).trim() === attendanceId; });
}

/** 再開済みの中断の合計（分）。中断開始と再開から毎回計算し直す */
function sumCompletedBreakMinutes_(attendanceId) {
  return getBreaksOfAttendance_(attendanceId).reduce(function (sum, b) {
    const start = toMinutes_(b['中断開始']);
    const end = toMinutes_(b['再開']);
    return start === null || end === null ? sum : sum + durationBetween_(start, end);
  }, 0);
}
