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
 *
 * 再開するときに勤務形態を選べます（出社で再開／在宅で再開）。
 *   同じ勤務形態 … 今の勤務区間のまま続ける（中断は区間の中にあるので、区間の実働から引く）
 *   違う勤務形態 … 今の区間を「中断開始」で終え、新しい区間を「再開」から始める
 *                 （例：12:00 出社を中断 → 12:30 在宅で再開 → 出社 〜12:00／在宅 12:30〜。中断は区間の外なので二重に引かない）
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

/**
 * 【画面から呼ぶ】中断から再開する。
 * @param {string} [workStyle] 再開する勤務形態（出社・在宅・現場・外出）。省略すると中断前と同じ
 * @param {object} [options] { site: '現場名' }（違う勤務形態で再開するとき、新しい区間に入れる）
 */
function resumeWork(workStyle, options) {
  return runApi_(function () {
    return withLock_(function () { return resumeWork_(workStyle, options); });
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
  let segmentId = '';
  if (hasWorkSegmentSchema_()) {
    const open = findOpenSegmentRow_(ensureSegmentsForCurrent_(record, now.timestamp));
    if (open) segmentId = String(open['勤務区間ID']);
  }
  const count = getBreaksOfAttendance_(attendanceId).length;
  const breakRow = appendRecord_(SHEET_NAMES.BREAKS, {
    '中断ID': makeUniqueId_(SHEET_NAMES.BREAKS, '中断ID', 'BR-' + attendanceId.replace(/^AT-/, '') + '-' + pad2_(count + 1)),
    '勤怠ID': attendanceId,
    '日付': toDateKey_(record['日付']),
    '社員ID': staff.employeeId,
    '氏名': staff.name,
    '中断開始': now.time,
    '理由': reasonText,
  });
  updateRecord_(SHEET_NAMES.BREAKS, breakRow, onlyExistingColumns_(SHEET_NAMES.BREAKS, { '勤務区間ID': segmentId, '中断打刻日時': now.timestamp }));
  updateRecord_(SHEET_NAMES.ATTENDANCE, record, {
    '状態': ATTENDANCE_STATUS.ON_BREAK,
    '更新日時': now.timestamp,
  });

  return {
    message: '中断しました（' + now.time + '）。戻ったら「再開」を押してください',
    data: toAttendanceView_(record),
  };
}

function resumeWork_(workStyle, options) {
  const requestedStyle = isBlank_(workStyle) ? '' : requireChoice_(workStyle, punchWorkStyles_(), '再開する勤務形態');
  const extras = normalizeSegmentExtras_(options, {});
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

  // 違う勤務形態で再開するときは、勤務区間を区切る
  let switched = '';
  if (requestedStyle) {
    const segRows = hasWorkSegmentSchema_() ? ensureSegmentsForCurrent_(record, now.timestamp) : [];
    const open = findOpenSegmentRow_(segRows);
    const currentStyle = open ? toPlainText_(open['勤務形態']) : toPlainText_(record['勤務形態']);
    if (requestedStyle !== currentStyle) {
      requireWorkSegmentSchema_();
      if (!open) fail_('今の勤務区間が見つかりません。管理者に連絡してください');
      closeAndStartSegment_(record, open, toClockText_(latest['中断開始']), requestedStyle, now.time, now.timestamp,
        toPlainText_(latest['中断打刻日時']), now.timestamp, extras);
      switched = workPlaceLabel_(currentStyle) + 'から' + workPlaceLabel_(requestedStyle) + 'に切り替え';
    }
  }

  updateRecord_(SHEET_NAMES.BREAKS, latest, onlyExistingColumns_(SHEET_NAMES.BREAKS, {
    '再開': now.time,
    '中断時間': formatMinutes_(minutes),
    '再開打刻日時': now.timestamp,
  }));

  const total = sumCompletedBreakMinutes_(attendanceId);
  updateRecord_(SHEET_NAMES.ATTENDANCE, record, {
    '中断合計': formatMinutes_(total),
    '状態': ATTENDANCE_STATUS.WORKING,
    '更新日時': now.timestamp,
  });
  if (switched) recalculateAttendanceRecord_(record, now.timestamp, { segmentsWin: true });

  return {
    message: (switched ? workPlaceLabel_(requestedStyle) + '勤務で再開しました（' + switched + '／' : '再開しました（' + (requestedStyle ? workPlaceLabel_(requestedStyle) + '勤務・' : '')) +
      '中断 ' + formatMinutes_(minutes) + '／本日の中断合計 ' + formatMinutes_(total) + '）',
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
