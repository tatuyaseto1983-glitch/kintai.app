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
 *   区間開始・区間終了・区間勤務形態 : 「対象区間」（区間番号）の開始・終了・勤務形態を直す（勤務区間がある日だけ）
 *
 * 勤務区間がある日は、出勤＝区間1の開始、退勤＝最後の区間の終了、勤務形態＝区間1の勤務形態 として直します。
 * 承認すると勤務区間を書き換えてから、勤怠記録（1日の合計）を計算し直します。
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
  let segmentNo = '';
  if (isSegmentCorrectionItem_(item)) {
    if (!hasColumn_(SHEET_NAMES.CORRECTIONS, '対象区間') || !hasWorkSegmentSchema_()) {
      fail_('区間ごとの修正の準備ができていません。管理者が setupSystem() を実行してから申請してください');
    }
    const no = Number(String(request.segmentNo === undefined ? '' : request.segmentNo).trim());
    if (!isFinite(no) || Math.floor(no) !== no || no < 1) fail_('対象区間は 1 以上の区間番号で選んでください');
    const rows = record ? getSegmentRowsOfAttendance_(String(record['勤怠ID']).trim()) : [];
    if (!rows.length) fail_(targetDate + ' は勤務区間の記録がありません。「出勤」「退勤」「勤務形態」の修正を使ってください');
    const target = rows.filter(function (r) { return Number(r['区間番号']) === no; })[0];
    if (!target) fail_(targetDate + ' に区間' + no + 'はありません（区間は ' + rows.length + 'つです）');
    segmentNo = String(no);
    if (item === CORRECTION_ITEMS.SEGMENT_STYLE) {
      after = requireChoice_(request.after, punchWorkStyles_(), '修正後の勤務形態');
      before = toPlainText_(target['勤務形態']);
    } else {
      after = minutesToClock_(requireClockMinutes_(request.after, '修正後の時刻'));
      before = toClockText_(target[item === CORRECTION_ITEMS.SEGMENT_START ? '開始時刻' : '終了時刻']);
    }
  } else if (item === CORRECTION_ITEMS.WORK_STYLE) {
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

  const created = appendRecord_(SHEET_NAMES.CORRECTIONS, onlyExistingColumns_(SHEET_NAMES.CORRECTIONS, {
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
    '対象区間': segmentNo,
  }));
  refreshCorrectionState_(staff.employeeId, targetDate);
  return { message: '打刻修正を申請しました（' + targetDate + '・' + (segmentNo ? '区間' + segmentNo + 'の' : '') + item + '）。管理者の承認をお待ちください', data: toCorrectionView_(created) };
}

/** 区間番号を指定する修正項目か */
function isSegmentCorrectionItem_(item) {
  return item === CORRECTION_ITEMS.SEGMENT_START || item === CORRECTION_ITEMS.SEGMENT_END || item === CORRECTION_ITEMS.SEGMENT_STYLE;
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
  const segmentNo = Number(toPlainText_(request['対象区間']).trim()) || 0;
  let record = findAttendance_(employeeId, dateKey);
  const segmentRows = record ? getSegmentRowsOfAttendance_(String(record['勤怠ID']).trim()) : [];

  if (isSegmentCorrectionItem_(item) || (segmentRows.length && item !== CORRECTION_ITEMS.BREAK_START && item !== CORRECTION_ITEMS.BREAK_END)) {
    // 勤務区間がある日：区間を書き換える（出勤・退勤・勤務形態も区間の値として直す）
    if (!segmentRows.length) fail_(dateKey + ' は勤務区間の記録がありません。区間ごとの修正は承認できません');
    applyCorrectionToSegments_(segmentRows, item, segmentNo, after, now.timestamp);
  } else if (item === CORRECTION_ITEMS.CLOCK_IN) {
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
  // 勤務区間を直した日は勤務区間の値を正とし、勤怠記録（出勤・退勤・勤務形態）を合わせる
  recalculateAttendanceRecord_(record, now.timestamp, { segmentsWin: segmentRows.length > 0 });
  syncOvertimeActual_(record);
  refreshCorrectionState_(employeeId, dateKey);
  return { message: '打刻修正を承認し、勤怠記録に反映しました（' + dateKey + '・' + (segmentNo && isSegmentCorrectionItem_(item) ? '区間' + segmentNo + 'の' : '') + item + '：' + (before || '空欄') + ' → ' + after + '）', data: toCorrectionView_(request) };
}

/**
 * 勤務区間がある日の修正を、勤務区間の行に反映する。
 *   出勤 → 区間1の開始／退勤 → 最後の区間の終了／勤務形態 → 区間1の勤務形態
 *   区間開始・区間終了・区間勤務形態 → 指定の区間
 * 書き込む前に、区間の順番と重なりを確認する（おかしければ何も書かずにエラー）。
 */
function applyCorrectionToSegments_(rows, item, segmentNo, after, timestamp) {
  let target;
  let column;
  if (item === CORRECTION_ITEMS.CLOCK_IN) { target = rows[0]; column = '開始時刻'; }
  else if (item === CORRECTION_ITEMS.CLOCK_OUT) { target = rows[rows.length - 1]; column = '終了時刻'; }
  else if (item === CORRECTION_ITEMS.WORK_STYLE) { target = rows[0]; column = '勤務形態'; }
  else {
    target = rows.filter(function (r) { return Number(r['区間番号']) === segmentNo; })[0];
    column = item === CORRECTION_ITEMS.SEGMENT_START ? '開始時刻' : item === CORRECTION_ITEMS.SEGMENT_END ? '終了時刻' : '勤務形態';
  }
  if (!target) fail_('修正する勤務区間（区間' + segmentNo + '）が見つかりません');
  const value = column === '勤務形態' ? after : toClockText_(after);

  // 書き換えた後の区間で、順番と重なりを確認する
  const planned = rows.map(function (r) {
    return {
      number: Number(r['区間番号']) || 0,
      startMinutes: toMinutes_(r === target && column === '開始時刻' ? value : r['開始時刻']),
      endMinutes: toMinutes_(r === target && column === '終了時刻' ? value : r['終了時刻']),
    };
  });
  validateSegmentOrder_(planned);
  const changes = { [column]: value, '更新日時': timestamp };
  // 直した時刻は打刻した時刻ではないので、秒までの打刻日時は空にする
  if (column === '開始時刻') Object.assign(changes, stampClear_('開始打刻日時'));
  if (column === '終了時刻') Object.assign(changes, stampClear_('終了打刻日時'));
  updateRecord_(SHEET_NAMES.WORK_SEGMENTS, target, changes);
}

/**
 * 区間の順番と重なりの確認（区間番号の順）。最初の開始を基準に、日付をまたぐ時刻は翌日として扱う。
 * 終了がない区間（勤務中）は最後の区間だけ認める。
 */
function validateSegmentOrder_(segments) {
  if (!segments.length) return;
  if (segments.some(function (s) { return s.startMinutes === null; })) fail_('開始時刻がない勤務区間があります');
  const dayStart = segments[0].startMinutes;
  const abs = function (m) { return m < dayStart ? m + 1440 : m; };
  let cursor = -1;
  segments.forEach(function (s, i) {
    const start = abs(s.startMinutes);
    if (start < cursor) fail_('区間' + s.number + 'の開始が、前の区間の終了より前になります。時刻を確認してください');
    if (s.endMinutes === null) {
      if (i !== segments.length - 1) fail_('区間' + s.number + 'の終了時刻がありません（終了がないのは最後の区間だけにしてください）');
      cursor = start;
      return;
    }
    // 同じ分の中で始まって終わった区間（0分）もそのまま認める
    const length = durationBetween_(s.startMinutes, s.endMinutes);
    cursor = start + length;
    if (cursor > dayStart + 1440) fail_('勤務区間が24時間を超えます。時刻を確認してください');
  });
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
  const changes = {
    '中断開始': startText,
    '再開': endText,
    '中断時間': start !== null && end !== null ? formatMinutes_(durationBetween_(start, end)) : '',
  };
  // 時刻を直した側の打刻日時（秒まで）は空にする（直した時刻が正）
  if (toClockText_(breakRecord['中断開始']) !== startText) changes['中断打刻日時'] = '';
  if (toClockText_(breakRecord['再開']) !== endText) changes['再開打刻日時'] = '';
  updateRecord_(SHEET_NAMES.BREAKS, breakRecord, onlyExistingColumns_(SHEET_NAMES.BREAKS, changes));
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
    segmentNo: toPlainText_(r['対象区間']),
  };
}

/** オブジェクトの値の一覧 */
function objectValues_(obj) {
  return Object.keys(obj).map(function (k) { return obj[k]; });
}
