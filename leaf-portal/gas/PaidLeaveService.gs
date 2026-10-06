/**
 * PaidLeaveService.gs
 * ------------------------------------------------------------
 * 有給休暇申請です（休日出勤申請と同じ構造・同じ操作）。
 *
 * 【種別】1日有給／午前半休／午後半休（時間単位の有給はない）
 *   有給時間は設定シート「有給_1日時間」「有給_半日時間」。実働とは別に記録し、同じ項目へ足さない。
 *
 * 【流れ】
 *   本人：申請（申請中＝画面は「承認待ち」）→ 承認前なら取り下げ（すぐ取消済み）／承認後は取消申請（未来の日だけ）
 *   管理者：承認・却下（却下理由は必須）・取消承認・取消却下。自分の申請は承認・却下できない
 *
 * 【決まり】
 *   - スタッフマスタ「有給申請対象」が「対象」の人だけ申請できる
 *   - 今の20日締め期間の過去の日は「事後申請」として申請できる（事後申請＝○。管理者画面で要確認）。前の締め期間は不可
 *   - 対象日のシフト：通常勤務＝申請できる／休日・法定休日＝申請不要（受け付けない）／未登録・シフト重複＝受け付けるが承認できない
 *   - 承認は「今の」シフトで判定（通常勤務のときだけ承認できる）
 *   - 同じ社員・同じ日の有効な有給申請は1件まで。同じ日に有効な休日出勤申請があれば受け付けない
 *   - 承認・取消のあと、その日の勤怠記録があれば遅刻・早退などを計算し直す（打刻・実働は変えない）
 */

// ============================================================ 画面から呼ぶ関数（本人）

/** 【画面から呼ぶ】有給を申請する。input = { date, leaveType, reason, note } */
function submitPaidLeaveRequest(input) {
  return runApi_(function () {
    return withLock_(function () { return submitPaidLeaveRequest_(input || {}); });
  });
}

/** 【画面から呼ぶ】自分の有給申請（新しい順）と、申請できるかどうか。対象外の人には一覧も返さない */
function getMyPaidLeaveRequests() {
  return runApi_(function () {
    const staff = getCurrentStaff_();
    const now = getNowInfo_();
    const period = getPayrollPeriodForDate_(now.date);
    const settings = getSettings_();
    const base = {
      eligible: false, today: now.date, periodFrom: period.from, periodText: period.periodText,
      leaveTypes: paidLeaveTypeList_(), requests: [],
      hours: { full: formatMinutes_(settings.paidLeaveDayMinutes), half: formatMinutes_(settings.paidLeaveHalfMinutes) },
      shiftEnabled: isShiftEnabled_(),
    };
    if (!hasPaidLeaveSchema_()) return { message: '有給休暇申請はまだ準備中です', data: Object.assign(base, { setupRequired: true }) };
    if (!canApplyPaidLeave_(staff)) return { message: '有給休暇申請の対象外です', data: base };
    const shiftMap = buildShiftMap_('', '', staff.employeeId);
    const list = findRecords_(SHEET_NAMES.PAID_LEAVE, function (r) { return String(r['社員ID']).trim() === staff.employeeId; })
      .map(function (r) {
        const v = toPaidLeaveView_(r);
        v.currentShift = isShiftEnabled_() ? shiftOf_(shiftMap, staff.employeeId, v.date).type : '';
        return v;
      })
      .sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return a.requestedAt < b.requestedAt ? 1 : -1;
      });
    return { message: '有給休暇申請を取得しました（' + list.length + '件）', data: Object.assign(base, { eligible: true, requests: list }) };
  });
}

/** 【画面から呼ぶ】承認前の申請を取り下げる → すぐ「取消済み」 */
function withdrawPaidLeaveRequest(requestId) {
  return runApi_(function () {
    return withLock_(function () {
      requirePaidLeaveSchema_();
      const staff = getCurrentStaff_();
      const record = findOwnPaidLeave_(requestId, staff);
      if (String(record['ステータス']).trim() !== HOLIDAY_WORK_STATUS.PENDING) {
        fail_('取り下げできるのは「承認待ち」の申請だけです（今のステータス：' + requestStatusLabel_(record['ステータス']) + '）。承認済みの場合は「取消申請」をしてください');
      }
      const now = getNowInfo_().timestamp;
      updateRecord_(SHEET_NAMES.PAID_LEAVE, record, {
        'ステータス': HOLIDAY_WORK_STATUS.CANCELLED, '取消申請日時': now, '取消承認日時': now,
        '取消理由': '本人が承認前に取り下げ', '取消処理者ID': staff.employeeId, '取消処理者名': staff.name, '更新日時': now,
      });
      return { message: '有給申請を取り下げました（' + toDateKey_(record['対象日']) + '）', data: toPaidLeaveView_(record) };
    });
  });
}

/** 【画面から呼ぶ】承認済みの申請の取消を申請する（未来の日だけ。管理者が承認すると取消済み） */
function requestPaidLeaveCancellation(requestId, reason) {
  return runApi_(function () {
    return withLock_(function () {
      requirePaidLeaveSchema_();
      const staff = getCurrentStaff_();
      const record = findOwnPaidLeave_(requestId, staff);
      if (String(record['ステータス']).trim() !== HOLIDAY_WORK_STATUS.APPROVED) {
        fail_('取消申請できるのは「承認済み」の申請だけです（今のステータス：' + requestStatusLabel_(record['ステータス']) + '）');
      }
      if (toDateKey_(record['対象日']) < getNowInfo_().date) fail_('過去の有給は取消申請できません。管理者に相談してください');
      const now = getNowInfo_().timestamp;
      updateRecord_(SHEET_NAMES.PAID_LEAVE, record, {
        'ステータス': HOLIDAY_WORK_STATUS.CANCEL_REQUESTED, '取消申請日時': now,
        '取消理由': requireText_(reason, '取消理由', { max: TEXT_LIMITS.LONG }), '取消却下理由': '', '更新日時': now,
      });
      return { message: '有給の取消を申請しました（' + toDateKey_(record['対象日']) + '）。管理者の確認をお待ちください', data: toPaidLeaveView_(record) };
    });
  });
}

// ============================================================ 管理者

/** 【管理者】有給申請を承認する（今のシフトが通常勤務のときだけ） */
function approvePaidLeaveRequest(requestId) {
  return runApi_(function () { return withLock_(function () { return decidePaidLeave_(requestId, 'approve'); }); });
}
/** 【管理者】有給申請を却下する（理由は必須） */
function rejectPaidLeaveRequest(requestId, reason) {
  return runApi_(function () { return withLock_(function () { return decidePaidLeave_(requestId, 'reject', reason); }); });
}
/** 【管理者】取消申請を承認する（取消済み） */
function approvePaidLeaveCancellation(requestId) {
  return runApi_(function () { return withLock_(function () { return decidePaidLeave_(requestId, 'approveCancel'); }); });
}
/** 【管理者】取消申請を却下する（承認済みのまま。理由は必須） */
function rejectPaidLeaveCancellation(requestId, reason) {
  return runApi_(function () { return withLock_(function () { return decidePaidLeave_(requestId, 'rejectCancel', reason); }); });
}

// ============================================================ 中身

function submitPaidLeaveRequest_(input) {
  requirePaidLeaveSchema_();
  const staff = getCurrentStaff_();
  if (!canApplyPaidLeave_(staff)) fail_('有給休暇申請の対象外です。必要な場合は管理者に相談してください');
  const now = getNowInfo_();
  const date = requireDateKey_(input.date, '対象日');
  const current = getPayrollPeriodForDate_(now.date);
  if (date < current.from) {
    fail_(date + ' は締めた後の期間（' + getPayrollPeriodForDate_(date).label + '）のため申請できません。管理者に相談してください（今の期間：' + current.periodText + '）');
  }
  const leaveType = requireChoice_(input.leaveType, paidLeaveTypeList_(), '有給種別');
  const reason = requireText_(input.reason, '理由', { max: TEXT_LIMITS.LONG });
  const note = requireText_(input.note, '備考', { required: false, max: TEXT_LIMITS.LONG });

  const dup = findActivePaidLeave_(staff.employeeId, date);
  if (dup) fail_(date + ' の有給申請はすでにあります（' + toPlainText_(dup['有給種別']) + '・' + requestStatusLabel_(dup['ステータス']) + '）');
  const hw = findActiveHolidayWork_(staff.employeeId, date);
  if (hw) fail_(date + ' には休日出勤の申請があります（' + requestStatusLabel_(hw['ステータス']) + '）。有給申請はできません');

  // 対象日のシフト（シフト管理を使うときだけ）：休日・法定休日は有給不要。未登録・シフト重複は受け付けるが、シフトが通常勤務に決まるまで承認できない
  const useShift = isShiftEnabled_();
  const shiftType = useShift ? getShiftType_(staff.employeeId, date) : '';
  if (useShift && isHolidayShift_(shiftType)) fail_('休日のため有給申請は不要です（' + date + ' のシフト：' + shiftType + '）');
  const late = date < now.date;

  const record = appendRecord_(SHEET_NAMES.PAID_LEAVE, {
    '申請ID': makeUniqueId_(SHEET_NAMES.PAID_LEAVE, '申請ID', 'PL-' + compactTimestamp_() + '-' + staff.employeeId),
    '申請日時': now.timestamp,
    '社員ID': staff.employeeId,
    '氏名': staff.name,
    '対象日': date,
    '有給種別': leaveType,
    '理由': reason,
    '備考': note,
    '申請時シフト区分': shiftType,
    '事後申請': late ? MARKS.YES : '',
    'ステータス': HOLIDAY_WORK_STATUS.PENDING,
    '更新日時': now.timestamp,
  });
  // 保存の後で管理者への Google Chat 通知を予約（送るのは runApi_ の最後。失敗しても申請は取り消さない）
  notifyRequestSubmitted_('有給休暇申請', staff, toPlainText_(record['申請ID']), shortDateLabel_(date) + ' ' + leaveType, paidLeaveMailDetails_(record), record);
  let message = '有給を申請しました（' + date + '・' + leaveType + (late ? '・事後申請' : '') + '）。管理者の承認をお待ちください';
  if (useShift && shiftType !== SHIFT_TYPES.NORMAL) message += '\n※ ' + date + ' は' + shiftType + 'のため、シフトが通常勤務に決まるまで承認されません';
  return { message: message, data: toPaidLeaveView_(record) };
}

function decidePaidLeave_(requestId, action, reason) {
  requirePaidLeaveSchema_();
  const admin = requireAdmin();
  const record = findPaidLeaveById_(requestId);
  if (!record) fail_('有給申請が見つかりません（申請ID：' + requestId + '）');
  const employeeId = String(record['社員ID']).trim();
  const date = toDateKey_(record['対象日']);
  if (employeeId === admin.employeeId) fail_('自分の有給申請は承認・却下できません');
  const status = String(record['ステータス']).trim();
  const isCancel = action === 'approveCancel' || action === 'rejectCancel';
  const expected = isCancel ? HOLIDAY_WORK_STATUS.CANCEL_REQUESTED : HOLIDAY_WORK_STATUS.PENDING;
  if (status !== expected) fail_('この申請は「' + requestStatusLabel_(expected) + '」ではないため処理できません（今のステータス：' + requestStatusLabel_(status) + '）');

  if (action === 'approve' && isShiftEnabled_()) {
    const shiftType = getShiftType_(employeeId, date);
    if (shiftType !== SHIFT_TYPES.NORMAL) {
      fail_(shiftType === SHIFT_STATE.UNREGISTERED ? 'シフト未登録のため承認できません。先にシフトシートで通常勤務を登録してください'
        : isHolidayShift_(shiftType) ? '対象日のシフトが' + shiftType + 'のため、有給として承認できません'
          : '対象日のシフトが「' + shiftType + '」のため承認できません。シフトシートを確認してください');
    }
  }

  const now = getNowInfo_().timestamp;
  let changes;
  let message;
  if (action === 'approve') {
    changes = { 'ステータス': HOLIDAY_WORK_STATUS.APPROVED, '承認者ID': admin.employeeId, '承認者名': admin.name, '承認日時': now, '却下理由': '' };
    message = '有給申請を承認しました';
  } else if (action === 'reject') {
    changes = { 'ステータス': HOLIDAY_WORK_STATUS.REJECTED, '承認者ID': admin.employeeId, '承認者名': admin.name, '承認日時': now,
      '却下理由': requireText_(reason, '却下理由', { max: TEXT_LIMITS.LONG }) };
    message = '有給申請を却下しました';
  } else if (action === 'approveCancel') {
    changes = { 'ステータス': HOLIDAY_WORK_STATUS.CANCELLED, '取消承認日時': now, '取消処理者ID': admin.employeeId, '取消処理者名': admin.name };
    message = '取消申請を承認しました（取消済み）';
  } else {
    changes = { 'ステータス': HOLIDAY_WORK_STATUS.APPROVED, '取消処理者ID': admin.employeeId, '取消処理者名': admin.name,
      '取消却下理由': requireText_(reason, '取消を却下する理由', { max: TEXT_LIMITS.LONG }) };
    message = '取消申請を却下しました（承認済みのまま）';
  }
  changes['更新日時'] = now;
  updateRecord_(SHEET_NAMES.PAID_LEAVE, record, changes);
  // 承認・却下は申請者本人へメールで通知（予約。却下は却下理由を入れる）。取消の処理は通知しない
  if (action === 'approve' || action === 'reject') {
    notifyRequestDecided_('有給休暇申請', action === 'approve' ? '承認' : '却下', { employeeId: employeeId, name: toPlainText_(record['氏名']) }, admin,
      toPlainText_(record['申請ID']), shortDateLabel_(date) + ' ' + toPlainText_(record['有給種別']), paidLeaveMailDetails_(record),
      action === 'reject' ? changes['却下理由'] : '');
  }

  // 有給の有無が変わったら、その日の勤怠記録の遅刻・早退などを計算し直す（打刻・実働は変えない）
  if (action === 'approve' || action === 'approveCancel') {
    const att = findAttendance_(employeeId, date);
    if (att) {
      recalculateAttendanceRecord_(att, now);
      message += '（' + date + ' の勤怠の遅刻・早退を計算し直しました）';
    }
  }
  return { message: message + '（' + date + '・' + toPlainText_(record['有給種別']) + '）', data: toPaidLeaveView_(record) };
}

/** 通知に書く有給申請の内容 */
function paidLeaveMailDetails_(r) {
  return [['対象日', toDateKey_(r['対象日'])], ['有給種別', toPlainText_(r['有給種別'])], ['理由', toPlainText_(r['理由'])],
    ['備考', toPlainText_(r['備考'])], ['事後申請', r['事後申請'] ? 'あり' : '']].filter(function (row) { return row[0] !== '事後申請' || row[1]; });
}

// ============================================================ 権限・準備

/** 有給申請ができる人：在籍中で、スタッフマスタ「有給申請対象」が「対象」 */
function canApplyPaidLeave_(staff) {
  return staff.status === EMPLOYMENT_STATUS.ACTIVE && staff.paidLeaveTarget === true;
}

function hasPaidLeaveSchema_() {
  if (!getSpreadsheet_().getSheetByName(SHEET_NAMES.PAID_LEAVE)) return false;
  try {
    readTable_(SHEET_NAMES.PAID_LEAVE);
    return readTable_(SHEET_NAMES.STAFF).columnIndex['有給申請対象'] !== undefined;
  } catch (e) {
    return false;
  }
}

function requirePaidLeaveSchema_() {
  if (!hasPaidLeaveSchema_()) {
    fail_('有給休暇申請に必要な「有給休暇申請」シートまたはスタッフマスタの「有給申請対象」列がありません。管理者が Apps Script で setupSystem() を実行してください');
  }
}

/**
 * スタッフマスタに「有給申請対象」列を新しく作ったときの初期値（setupSystem から呼ばれる）。
 * 勤怠集計対象が「対象外」の人（役員など）→「対象外」、それ以外 →「対象」。列を作るときだけ。
 */
function initPaidLeaveTargetColumn_(sheet, addedHeaders) {
  if (addedHeaders.indexOf('有給申請対象') === -1) return '';
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';
  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (h) { return String(h).trim(); });
  const idCol = headers.indexOf('社員ID');
  const targetCol = headers.indexOf('勤怠集計対象');
  const leaveCol = headers.indexOf('有給申請対象');
  if (idCol === -1 || leaveCol === -1) return '';
  const rows = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  const values = rows.map(function (row) {
    if (isBlank_(row[idCol])) return [''];
    const excluded = targetCol !== -1 && String(row[targetCol]).trim() === ATTENDANCE_TARGET.NO;
    return [excluded ? PAID_LEAVE_TARGET.NO : PAID_LEAVE_TARGET.YES];
  });
  sheet.getRange(2, leaveCol + 1, values.length, 1).setValues(values);
  const off = values.filter(function (v) { return v[0] === PAID_LEAVE_TARGET.NO; }).length;
  const on = values.filter(function (v) { return v[0] === PAID_LEAVE_TARGET.YES; }).length;
  return '有給申請対象の初期値を入れました（対象 ' + on + '名・対象外 ' + off + '名。勤怠集計対象が「対象外」の人を対象外にしています）';
}

// ============================================================ 読み取り

function paidLeaveTypeList_() {
  return [PAID_LEAVE_TYPES.FULL, PAID_LEAVE_TYPES.AM, PAID_LEAVE_TYPES.PM];
}

/** 有効な申請（申請中・承認済み・取消申請中）。却下・取消済みは含めない */
function isActiveRequestStatus_(status) {
  return holidayWorkActiveStatuses_().indexOf(String(status).trim()) !== -1;
}

function findPaidLeaveById_(requestId) {
  const id = String(requestId === undefined || requestId === null ? '' : requestId).trim();
  if (!id) return null;
  return findRecords_(SHEET_NAMES.PAID_LEAVE, function (r) { return String(r['申請ID']).trim() === id; })[0] || null;
}

/** 本人の申請だけ（他の人の申請IDを送っても「見つかりません」） */
function findOwnPaidLeave_(requestId, staff) {
  const record = findPaidLeaveById_(requestId);
  if (!record || String(record['社員ID']).trim() !== staff.employeeId) fail_('有給申請が見つかりません');
  return record;
}

/** その社員・その日の有効な有給申請（なければ null） */
function findActivePaidLeave_(employeeId, dateKey) {
  if (!hasPaidLeaveSchema_()) return null;
  const id = String(employeeId).trim();
  return findRecords_(SHEET_NAMES.PAID_LEAVE, function (r) {
    return String(r['社員ID']).trim() === id && toDateKey_(r['対象日']) === dateKey && isActiveRequestStatus_(r['ステータス']);
  })[0] || null;
}

/** その社員・その日の有効な休日出勤申請（なければ null） */
function findActiveHolidayWork_(employeeId, dateKey) {
  if (!getSpreadsheet_().getSheetByName(SHEET_NAMES.HOLIDAY_WORK)) return null;
  const id = String(employeeId).trim();
  return findRecords_(SHEET_NAMES.HOLIDAY_WORK, function (r) {
    return String(r['社員ID']).trim() === id && toDateKey_(r['休日出勤日']) === dateKey && isActiveRequestStatus_(r['ステータス']);
  })[0] || null;
}

/**
 * 承認済みの有給（社員ID|日付 → 申請の表示用）。「取消申請中」は取消が承認されるまで有効なので含める。
 */
function buildPaidLeaveMap_() {
  const map = {};
  if (!hasPaidLeaveSchema_()) return map;
  readTable_(SHEET_NAMES.PAID_LEAVE).records.forEach(function (r) {
    const status = String(r['ステータス']).trim();
    if (status !== HOLIDAY_WORK_STATUS.APPROVED && status !== HOLIDAY_WORK_STATUS.CANCEL_REQUESTED) return;
    map[String(r['社員ID']).trim() + '|' + toDateKey_(r['対象日'])] = toPaidLeaveView_(r);
  });
  return map;
}

/** 有給の時間（分）。設定が読めなければ null（設定不備） */
function paidLeaveMinutesOf_(leaveType, settings) {
  if (leaveType === PAID_LEAVE_TYPES.FULL) return settings.paidLeaveDayMinutes;
  if (leaveType === PAID_LEAVE_TYPES.AM || leaveType === PAID_LEAVE_TYPES.PM) return settings.paidLeaveHalfMinutes;
  return null;
}

function toPaidLeaveView_(r) {
  return {
    requestId: toPlainText_(r['申請ID']),
    requestedAt: toPlainText_(r['申請日時']),
    employeeId: toPlainText_(r['社員ID']),
    name: toPlainText_(r['氏名']),
    date: toDateKey_(r['対象日']),
    leaveType: toPlainText_(r['有給種別']),
    reason: toPlainText_(r['理由']),
    note: toPlainText_(r['備考']),
    shiftAtRequest: toPlainText_(r['申請時シフト区分']),
    late: !isBlank_(r['事後申請']),
    status: toPlainText_(r['ステータス']),
    statusLabel: requestStatusLabel_(toPlainText_(r['ステータス'])),
    approverId: toPlainText_(r['承認者ID']),
    approverName: toPlainText_(r['承認者名']),
    approvedAt: toPlainText_(r['承認日時']),
    rejectReason: toPlainText_(r['却下理由']),
    cancelRequestedAt: toPlainText_(r['取消申請日時']),
    cancelApprovedAt: toPlainText_(r['取消承認日時']),
    cancelReason: toPlainText_(r['取消理由']),
    cancelHandlerName: toPlainText_(r['取消処理者名']),
    cancelRejectReason: toPlainText_(r['取消却下理由']),
    updatedAt: toPlainText_(r['更新日時']),
  };
}

/** 管理者画面用：処理待ち（申請中・取消申請中）と処理済み。今のシフトと承認できるかを付ける */
function buildAdminPaidLeave_(ctx) {
  if (!hasPaidLeaveSchema_()) return { setupRequired: true, pending: [], processed: [], pendingCount: 0 };
  const all = readTable_(SHEET_NAMES.PAID_LEAVE).records.map(function (r) {
    const view = toPaidLeaveView_(r);
    const staff = ctx.staffById[view.employeeId];
    view.department = staff ? staff.department : '';
    view.currentShift = isShiftEnabled_() ? shiftOf_(ctx.shiftMap || {}, view.employeeId, view.date).type : '';
    view.approvable = isShiftEnabled_() ? view.currentShift === SHIFT_TYPES.NORMAL : true;
    const att = ctx.attendanceByKey[view.employeeId + '|' + view.date];
    view.actualWorkTime = att ? toDurationText_(att['実働時間']) : '';
    view.hasAttendance = !!att;
    return view;
  });
  const waiting = function (v) { return v.status === HOLIDAY_WORK_STATUS.PENDING || v.status === HOLIDAY_WORK_STATUS.CANCEL_REQUESTED; };
  const pending = all.filter(waiting).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  const processed = all.filter(function (v) { return !waiting(v); })
    .sort(function (a, b) { return (a.updatedAt || a.requestedAt) < (b.updatedAt || b.requestedAt) ? 1 : -1; })
    .slice(0, ADMIN_RECENT_REQUEST_LIMIT);
  return { setupRequired: false, pending: pending, processed: processed, pendingCount: pending.length };
}
