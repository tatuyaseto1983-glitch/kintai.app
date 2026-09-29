/**
 * CorrectionService.gs
 * ------------------------------------------------------------
 * 打刻修正申請です。
 *
 * スタッフ本人は勤怠記録を直接書き換えられません。
 * 必ず「申請 → 管理者が承認」の流れで、承認されたときにだけ勤怠記録が修正されます。
 *
 * 修正項目ごとの「修正前」「修正後」の意味
 *   出勤・退勤 : 修正後に正しい時刻（09:30）。修正前は自動で今の記録が入ります
 *   勤務形態   : 修正後に「出社」か「在宅」
 *   中断       : 修正前＝直したい中断の開始時刻。空欄なら「中断の打刻忘れ」として新しい中断を追加
 *   再開       : 修正前＝直したい再開時刻。空欄なら「再開の押し忘れ」として未完了の中断に再開時刻を入れる
 */

/**
 * 【画面から呼ぶ】打刻修正を申請する。
 * @param {object} request
 *   targetDate 対象日 '2026-09-29'
 *   item       修正項目（出勤／退勤／中断／再開／勤務形態）
 *   before     修正前（中断・再開のときだけ使用。それ以外は自動）
 *   after      修正後
 *   reason     申請理由
 */
function submitCorrectionRequest(request) {
  return runApi_(function () {
    return withLock_(function () { return submitCorrectionRequest_(request || {}); });
  });
}

/** 【画面から呼ぶ】自分の打刻修正申請の一覧（新しい順） */
function getMyCorrectionRequests() {
  return runApi_(function () {
    const staff = getCurrentStaff_();
    const list = findRecords_(SHEET_NAMES.CORRECTIONS, function (r) { return String(r['社員ID']).trim() === staff.employeeId; })
      .map(toCorrectionView_)
      .sort(function (a, b) { return a.requestedAt < b.requestedAt ? 1 : -1; });
    return { message: '打刻修正申請を取得しました（' + list.length + '件）', data: list };
  });
}

/** 【管理者】打刻修正申請を承認し、勤怠記録へ反映する */
function approveCorrectionRequest(requestId) {
  return runApi_(function () {
    return withLock_(function () { return approveCorrectionRequest_(requestId); });
  });
}

/** 【管理者】打刻修正申請を却下する */
function rejectCorrectionRequest(requestId, reason) {
  return runApi_(function () {
    return withLock_(function () { return rejectCorrectionRequest_(requestId, reason); });
  });
}

// ============================================================ 申請

function submitCorrectionRequest_(request) {
  const staff = getCurrentStaff_();
  const now = getNowInfo_();
  const targetDate = requireDateKey_(request.targetDate, '対象日');
  if (targetDate > now.date) fail_('未来の日付は修正申請できません');
  const item = requireChoice_(request.item, objectValues_(CORRECTION_ITEMS), '修正項目');
  const reason = requireText_(request.reason, '申請理由', { max: TEXT_LIMITS.LONG });
  const record = findAttendance_(staff.employeeId, targetDate);

  let before = '';
  let after;
  if (item === CORRECTION_ITEMS.WORK_STYLE) {
    after = requireChoice_(request.after, [WORK_STYLES.OFFICE, WORK_STYLES.REMOTE], '修正後の勤務形態');
    before = record ? toPlainText_(record['勤務形態']) : '';
  } else {
    after = minutesToClock_(requireClockMinutes_(request.after, '修正後の時刻'));
    if (item === CORRECTION_ITEMS.CLOCK_IN) before = record ? toClockText_(record['出勤']) : '';
    if (item === CORRECTION_ITEMS.CLOCK_OUT) before = record ? toClockText_(record['退勤']) : '';
    if (item === CORRECTION_ITEMS.BREAK_START || item === CORRECTION_ITEMS.BREAK_END) {
      before = isBlank_(request.before) ? '' : minutesToClock_(requireClockMinutes_(request.before, '修正前の時刻'));
    }
  }

  // 出勤の記録がない日は、先に「出勤」の修正申請が必要
  if (item !== CORRECTION_ITEMS.CLOCK_IN && (!record || isBlank_(record['出勤'])) && !hasPendingClockInRequest_(staff.employeeId, targetDate)) {
    fail_(targetDate + ' の出勤記録がありません。先に「出勤」の修正申請をしてください');
  }
  // 直したい中断・再開が本当にあるか確認
  if (record && before && (item === CORRECTION_ITEMS.BREAK_START || item === CORRECTION_ITEMS.BREAK_END)) {
    if (!findBreakByTime_(String(record['勤怠ID']).trim(), item, before)) {
      fail_('修正前の時刻（' + before + '）に一致する' + item + 'の記録が見つかりません');
    }
  }

  const created = appendRecord_(SHEET_NAMES.CORRECTIONS, {
    '申請ID': makeUniqueId_(SHEET_NAMES.CORRECTIONS, '申請ID', 'CR-' + compactTimestamp_() + '-' + staff.employeeId),
    '申請日時': now.timestamp,
    '社員ID': staff.employeeId,
    '氏名': staff.name,
    '対象日': targetDate,
    '修正項目': item,
    '修正前': before,
    '修正後': after,
    '申請理由': reason,
    'ステータス': REQUEST_STATUS.PENDING,
  });
  refreshCorrectionState_(staff.employeeId, targetDate);
  return { message: '打刻修正を申請しました（' + targetDate + '・' + item + '）。管理者の承認をお待ちください', data: toCorrectionView_(created) };
}

function hasPendingClockInRequest_(employeeId, dateKey) {
  return findRecords_(SHEET_NAMES.CORRECTIONS, function (r) {
    return String(r['社員ID']).trim() === employeeId && toDateKey_(r['対象日']) === dateKey &&
      r['修正項目'] === CORRECTION_ITEMS.CLOCK_IN && r['ステータス'] === REQUEST_STATUS.PENDING;
  }).length > 0;
}

// ============================================================ 承認・却下

function findCorrectionRequest_(requestId) {
  const request = findRecords_(SHEET_NAMES.CORRECTIONS, function (r) { return String(r['申請ID']).trim() === String(requestId).trim(); })[0];
  if (!request) fail_('打刻修正申請が見つかりません（申請ID：' + requestId + '）');
  if (request['ステータス'] !== REQUEST_STATUS.PENDING) fail_('この申請はすでに処理済みです（ステータス：' + request['ステータス'] + '）');
  return request;
}

function approveCorrectionRequest_(requestId) {
  const admin = requireAdmin();
  const request = findCorrectionRequest_(requestId);
  const now = getNowInfo_();
  const employeeId = String(request['社員ID']).trim();
  const dateKey = toDateKey_(request['対象日']);
  const item = String(request['修正項目']).trim();
  const before = toPlainText_(request['修正前']).trim();
  const after = toPlainText_(request['修正後']).trim();
  let record = findAttendance_(employeeId, dateKey);

  if (item === CORRECTION_ITEMS.CLOCK_IN) {
    if (record) {
      updateRecord_(SHEET_NAMES.ATTENDANCE, record, { '出勤': toClockText_(after) });
    } else {
      // 出勤の打刻忘れ → 勤怠記録を新しく作る（勤務形態は「出社」。違う場合は勤務形態の修正申請で直す）
      const staff = findStaffById_(employeeId);
      if (!staff) fail_('社員ID「' + employeeId + '」のスタッフがスタッフマスタに見つかりません');
      record = appendRecord_(SHEET_NAMES.ATTENDANCE, {
        '勤怠ID': makeAttendanceId_(dateKey, employeeId),
        '日付': dateKey,
        '社員ID': employeeId,
        '氏名': staff.name,
        '勤務区分': getWorkRule_(staff, getSettings_()).workType,
        '勤務形態': WORK_STYLES.OFFICE,
        '出勤': toClockText_(after),
        '備考': '打刻修正申請により作成',
      });
    }
  } else {
    if (!record || isBlank_(record['出勤'])) fail_(dateKey + ' の出勤記録がありません。先に「出勤」の修正申請を承認してください');
    applyCorrectionToRecord_(record, item, before, after);
  }

  updateRecord_(SHEET_NAMES.CORRECTIONS, request, {
    'ステータス': REQUEST_STATUS.APPROVED,
    '承認者': admin.name,
    '承認日時': now.timestamp,
  });
  recalculateAttendanceRecord_(record, now.timestamp);
  syncOvertimeActual_(record);
  refreshCorrectionState_(employeeId, dateKey);
  return { message: '打刻修正を承認し、勤怠記録に反映しました（' + dateKey + '・' + item + '：' + (before || '空欄') + ' → ' + after + '）', data: toCorrectionView_(request) };
}

/** 出勤以外の修正を勤怠記録・中断履歴に反映する */
function applyCorrectionToRecord_(record, item, before, after) {
  const attendanceId = String(record['勤怠ID']).trim();
  if (item === CORRECTION_ITEMS.CLOCK_OUT) {
    updateRecord_(SHEET_NAMES.ATTENDANCE, record, { '退勤': toClockText_(after) });
  } else if (item === CORRECTION_ITEMS.WORK_STYLE) {
    updateRecord_(SHEET_NAMES.ATTENDANCE, record, { '勤務形態': after });
  } else if (item === CORRECTION_ITEMS.BREAK_START) {
    if (before) {
      const target = findBreakByTime_(attendanceId, item, before);
      if (!target) fail_('修正前の時刻（' + before + '）に一致する中断の記録が見つかりません');
      updateBreakTimes_(target, toClockText_(after), toClockText_(target['再開']));
    } else {
      const count = getBreaksOfAttendance_(attendanceId).length;
      appendRecord_(SHEET_NAMES.BREAKS, {
        '中断ID': makeUniqueId_(SHEET_NAMES.BREAKS, '中断ID', 'BR-' + attendanceId.replace(/^AT-/, '') + '-' + pad2_(count + 1)),
        '勤怠ID': attendanceId,
        '日付': toDateKey_(record['日付']),
        '社員ID': toPlainText_(record['社員ID']),
        '氏名': toPlainText_(record['氏名']),
        '中断開始': toClockText_(after),
        '理由': '打刻修正申請により追加',
      });
    }
  } else if (item === CORRECTION_ITEMS.BREAK_END) {
    let target;
    if (before) {
      target = findBreakByTime_(attendanceId, item, before);
    } else {
      const open = getBreaksOfAttendance_(attendanceId).filter(function (b) { return isBlank_(b['再開']); });
      target = open[open.length - 1];
    }
    if (!target) fail_('再開時刻を入れる中断の記録が見つかりません。先に「中断」の修正申請を承認してください');
    updateBreakTimes_(target, toClockText_(target['中断開始']), toClockText_(after));
  }
}

/** 中断履歴1件の開始・再開を書き換え、中断時間を計算し直す */
function updateBreakTimes_(breakRecord, startText, endText) {
  const start = toMinutes_(startText);
  const end = toMinutes_(endText);
  updateRecord_(SHEET_NAMES.BREAKS, breakRecord, {
    '中断開始': startText,
    '再開': endText,
    '中断時間': start !== null && end !== null ? formatMinutes_(durationBetween_(start, end)) : '',
  });
}

/** 中断開始（item=中断）または再開（item=再開）の時刻で中断履歴を探す */
function findBreakByTime_(attendanceId, item, timeText) {
  const column = item === CORRECTION_ITEMS.BREAK_START ? '中断開始' : '再開';
  return getBreaksOfAttendance_(attendanceId).filter(function (b) { return toClockText_(b[column]) === timeText; })[0] || null;
}

function rejectCorrectionRequest_(requestId, reason) {
  const admin = requireAdmin();
  const request = findCorrectionRequest_(requestId);
  const reasonText = requireText_(reason, '却下理由', { max: TEXT_LIMITS.LONG });
  updateRecord_(SHEET_NAMES.CORRECTIONS, request, {
    'ステータス': REQUEST_STATUS.REJECTED,
    '承認者': admin.name,
    '承認日時': getNowInfo_().timestamp,
    '却下理由': reasonText,
  });
  refreshCorrectionState_(String(request['社員ID']).trim(), toDateKey_(request['対象日']));
  return { message: '打刻修正申請を却下しました', data: toCorrectionView_(request) };
}

/**
 * 勤怠記録の「打刻修正状況」を申請の状況に合わせる。
 *   承認待ちが1件でもある → 申請中
 *   承認済みがある        → 修正済み
 *   却下だけ              → 却下
 */
function refreshCorrectionState_(employeeId, dateKey) {
  const record = findAttendance_(employeeId, dateKey);
  if (!record) return;
  const statuses = findRecords_(SHEET_NAMES.CORRECTIONS, function (r) {
    return String(r['社員ID']).trim() === employeeId && toDateKey_(r['対象日']) === dateKey;
  }).map(function (r) { return r['ステータス']; });

  let state = '';
  if (statuses.indexOf(REQUEST_STATUS.PENDING) !== -1) state = CORRECTION_STATE.PENDING;
  else if (statuses.indexOf(REQUEST_STATUS.APPROVED) !== -1) state = CORRECTION_STATE.APPROVED;
  else if (statuses.indexOf(REQUEST_STATUS.REJECTED) !== -1) state = CORRECTION_STATE.REJECTED;
  if (record['打刻修正状況'] !== state) updateRecord_(SHEET_NAMES.ATTENDANCE, record, { '打刻修正状況': state });
}

function toCorrectionView_(r) {
  return {
    requestId: toPlainText_(r['申請ID']),
    requestedAt: toPlainText_(r['申請日時']),
    employeeId: toPlainText_(r['社員ID']),
    name: toPlainText_(r['氏名']),
    targetDate: toDateKey_(r['対象日']),
    item: toPlainText_(r['修正項目']),
    before: toPlainText_(r['修正前']),
    after: toPlainText_(r['修正後']),
    reason: toPlainText_(r['申請理由']),
    status: toPlainText_(r['ステータス']),
    approver: toPlainText_(r['承認者']),
    approvedAt: toPlainText_(r['承認日時']),
    rejectReason: toPlainText_(r['却下理由']),
    note: toPlainText_(r['備考']),
  };
}

/** オブジェクトの値の一覧 */
function objectValues_(obj) {
  return Object.keys(obj).map(function (k) { return obj[k]; });
}
