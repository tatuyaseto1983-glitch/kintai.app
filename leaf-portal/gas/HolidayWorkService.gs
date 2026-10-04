/**
 * HolidayWorkService.gs
 * ------------------------------------------------------------
 * 休日出勤申請です（休日出勤の前に申請し、管理者が承認する）。
 *
 *   申請中 ──承認──→ 承認済み ──本人の取消申請──→ 取消申請中 ──取消を承認──→ 取消済み
 *     │  └──却下（理由必須）──→ 却下                         └──取消を却下──→ 承認済み
 *     └──本人の取り下げ（承認前）──→ 取消済み
 *
 * ・申請できるのは、スタッフマスタ「休日出勤申請対象」が「対象」で、在籍中の人だけ
 *   （画面のカードを出さないだけでなく、ここでも必ず確認する）
 * ・申請者はログイン中のGoogleアカウントとスタッフマスタで決める。画面から送られた社員ID・氏名は使わない
 * ・承認・却下は管理者だけ（requireAdmin）。自分の申請は承認できない
 * ・その日が本当に休日かはシステムでは判定しない（申請者が日付を選ぶ）。
 *   将来シフト・会社カレンダーを作ったときは validateHolidayWorkPlan_ で確認を足す
 * ・申請は「予定」。勤怠記録（実績）には書き込まない。
 *   照合は 社員ID＋休日出勤日 ↔ 勤怠記録の 社員ID＋日付（buildHolidayWorkPlanMap_ / attachHolidayWorkActual_）
 */

/**
 * 二重申請とみなすステータス（同じ人・同じ日にこれがあれば新しく申請できない）。
 * ファイルの読み込み順に左右されないよう、定数ではなく関数にしている（Config.gs より先に読まれても動く）
 */
function holidayWorkActiveStatuses_() {
  return [HOLIDAY_WORK_STATUS.PENDING, HOLIDAY_WORK_STATUS.APPROVED, HOLIDAY_WORK_STATUS.CANCEL_REQUESTED];
}

// ============================================================ 社員が使う関数

/**
 * 【画面から呼ぶ】休日出勤を申請する。
 * @param {object} input
 *   workDate      休日出勤日 '2026-10-10'（今日以降）
 *   plannedStart  開始予定時刻 '09:00'
 *   plannedEnd    終了予定時刻 '17:00'
 *   reason        休日出勤理由（必須）
 *   content       業務内容（必須）
 *   compDayType   振替休日区分 取得予定／取得予定なし／未定
 *   compDayDate   振替休日予定日（取得予定のときだけ。空欄＝未定でも可）
 *   note          備考（任意）
 */
function submitHolidayWorkRequest(input) {
  return runApi_(function () {
    return withLock_(function () { return submitHolidayWorkRequest_(input || {}); });
  });
}

/**
 * 【画面から呼ぶ】自分の休日出勤申請（新しい順）と、申請できるかどうか。
 * 対象外の人には申請の一覧も返さない（画面はカードを出さない）。
 */
function getMyHolidayWorkRequests() {
  return runApi_(function () {
    const staff = getCurrentStaff_();
    const base = { eligible: false, today: getNowInfo_().date, requests: [], compDayTypes: holidayCompDayTypeList_(), shiftEnabled: isShiftEnabled_() };
    if (!hasHolidayWorkSchema_()) return { message: '休日出勤申請はまだ準備中です', data: Object.assign(base, { setupRequired: true }) };
    if (!canApplyHolidayWork_(staff)) return { message: '休日出勤申請の対象外です', data: base };
    const shiftMap = buildShiftMap_('', '', staff.employeeId); // 自分のシフトだけ
    const list = findRecords_(SHEET_NAMES.HOLIDAY_WORK, function (r) { return String(r['社員ID']).trim() === staff.employeeId; })
      .map(function (r) {
        const v = toHolidayWorkView_(r);
        v.currentShift = isShiftEnabled_() ? shiftOf_(shiftMap, staff.employeeId, v.workDate).type : '';
        return v;
      })
      .sort(function (a, b) {
        if (a.workDate !== b.workDate) return a.workDate < b.workDate ? 1 : -1;
        return a.requestedAt < b.requestedAt ? 1 : -1;
      });
    return { message: '休日出勤申請を取得しました（' + list.length + '件）', data: Object.assign(base, { eligible: true, requests: list }) };
  });
}

/** 【画面から呼ぶ】申請中（承認前）の申請を取り下げる → すぐ「取消済み」（管理者の承認は不要） */
function withdrawHolidayWorkRequest(requestId) {
  return runApi_(function () {
    return withLock_(function () {
      const staff = getCurrentStaff_();
      const record = findOwnHolidayWork_(requestId, staff);
      if (record['ステータス'] !== HOLIDAY_WORK_STATUS.PENDING) {
        fail_('取り下げできるのは「申請中」の申請だけです（今のステータス：' + record['ステータス'] + '）。承認済みの場合は「取消申請」をしてください');
      }
      const now = getNowInfo_().timestamp;
      updateRecord_(SHEET_NAMES.HOLIDAY_WORK, record, {
        'ステータス': HOLIDAY_WORK_STATUS.CANCELLED,
        '取消申請日時': now,
        '取消承認日時': now,
        '取消理由': '本人が承認前に取り下げ',
        '取消処理者ID': staff.employeeId,
        '取消処理者名': staff.name,
        '更新日時': now,
      });
      return { message: '休日出勤申請を取り下げました（' + toDateKey_(record['休日出勤日']) + '）', data: toHolidayWorkView_(record) };
    });
  });
}

/** 【画面から呼ぶ】承認済みの申請の取消を申請する → 「取消申請中」（管理者が承認すると取消済み） */
function requestHolidayWorkCancellation(requestId, reason) {
  return runApi_(function () {
    return withLock_(function () {
      const staff = getCurrentStaff_();
      const record = findOwnHolidayWork_(requestId, staff);
      if (record['ステータス'] !== HOLIDAY_WORK_STATUS.APPROVED) {
        fail_('取消申請できるのは「承認済み」の申請だけです（今のステータス：' + record['ステータス'] + '）');
      }
      if (toDateKey_(record['休日出勤日']) < getNowInfo_().date) fail_('過去の休日出勤は取消申請できません。管理者に相談してください');
      const text = requireText_(reason, '取消の理由', { max: TEXT_LIMITS.LONG });
      const now = getNowInfo_().timestamp;
      updateRecord_(SHEET_NAMES.HOLIDAY_WORK, record, {
        'ステータス': HOLIDAY_WORK_STATUS.CANCEL_REQUESTED,
        '取消申請日時': now,
        '取消理由': text,
        '取消却下理由': '',
        '更新日時': now,
      });
      return { message: '取消申請を提出しました。管理者の承認をお待ちください', data: toHolidayWorkView_(record) };
    });
  });
}

// ============================================================ 管理者が使う関数

/** 【管理者】休日出勤申請を承認する */
function approveHolidayWorkRequest(requestId) {
  return runApi_(function () {
    return withLock_(function () { return decideHolidayWork_(requestId, 'approve', ''); });
  });
}

/** 【管理者】休日出勤申請を却下する（却下理由は必須） */
function rejectHolidayWorkRequest(requestId, reason) {
  return runApi_(function () {
    return withLock_(function () { return decideHolidayWork_(requestId, 'reject', reason); });
  });
}

/** 【管理者】取消申請を承認する → 取消済み */
function approveHolidayWorkCancellation(requestId) {
  return runApi_(function () {
    return withLock_(function () { return decideHolidayWork_(requestId, 'approveCancel', ''); });
  });
}

/** 【管理者】取消申請を却下する → 承認済みに戻す（理由は必須） */
function rejectHolidayWorkCancellation(requestId, reason) {
  return runApi_(function () {
    return withLock_(function () { return decideHolidayWork_(requestId, 'rejectCancel', reason); });
  });
}

// ============================================================ 中身

function submitHolidayWorkRequest_(input) {
  requireHolidayWorkSchema_();
  const staff = getCurrentStaff_();
  if (!canApplyHolidayWork_(staff)) fail_('休日出勤申請の対象外です。必要な場合は管理者に相談してください');
  const now = getNowInfo_();
  const plan = validateHolidayWorkPlan_(input, now.date);

  const duplicate = findRecords_(SHEET_NAMES.HOLIDAY_WORK, function (r) {
    return String(r['社員ID']).trim() === staff.employeeId && toDateKey_(r['休日出勤日']) === plan.workDate &&
      holidayWorkActiveStatuses_().indexOf(String(r['ステータス']).trim()) !== -1;
  })[0];
  if (duplicate) fail_(plan.workDate + ' の休日出勤申請はすでにあります（ステータス：' + requestStatusLabel_(duplicate['ステータス']) + '）');
  // 同じ日に有効な有給申請があれば、矛盾するので受け付けない
  const leave = findActivePaidLeave_(staff.employeeId, plan.workDate);
  if (leave) fail_(plan.workDate + ' には有給休暇の申請があります（' + toPlainText_(leave['有給種別']) + '・' + requestStatusLabel_(leave['ステータス']) + '）。休日出勤申請はできません');
  // 対象日のシフトを確認（シフト管理を使うときだけ）：通常勤務の日は申請不要。未登録・シフト重複は受け付けるが、シフトが決まるまで承認できない
  const useShift = isShiftEnabled_();
  const shiftType = useShift ? getShiftType_(staff.employeeId, plan.workDate) : '';
  if (useShift && shiftType === SHIFT_TYPES.NORMAL) fail_('通常勤務日のため休日出勤申請は不要です（' + plan.workDate + '）');

  const record = appendRecord_(SHEET_NAMES.HOLIDAY_WORK, {
    '申請ID': makeUniqueId_(SHEET_NAMES.HOLIDAY_WORK, '申請ID', 'HW-' + compactTimestamp_() + '-' + staff.employeeId),
    '申請日時': now.timestamp,
    '社員ID': staff.employeeId,
    '氏名': staff.name,
    '休日出勤日': plan.workDate,
    '開始予定時刻': minutesToClock_(plan.start),
    '終了予定時刻': minutesToClock_(plan.end),
    '予定勤務時間': formatMinutes_(plan.span),
    '休日出勤理由': plan.reason,
    '業務内容': plan.content,
    '振替休日区分': plan.compDayType,
    '振替休日予定日': plan.compDayDate,
    '備考': plan.note,
    'ステータス': HOLIDAY_WORK_STATUS.PENDING,
    '更新日時': now.timestamp,
  });
  const extra = { '現場': plan.site };
  if (useShift) extra['申請時シフト区分'] = shiftType;
  updateRecord_(SHEET_NAMES.HOLIDAY_WORK, record, onlyExistingColumns_(SHEET_NAMES.HOLIDAY_WORK, extra));
  if (!useShift) return { message: '休日出勤を申請しました（' + plan.workDate + '）。管理者の承認をお待ちください', data: toHolidayWorkView_(record) };
  const shiftNote = isHolidayShift_(shiftType) ? '' : '\n※ ' + plan.workDate + ' は' + shiftType + 'のため、シフトが休日・法定休日に決まるまで承認されません';
  return { message: '休日出勤を申請しました（' + plan.workDate + '・' + shiftType + '）。管理者の承認をお待ちください' + shiftNote, data: toHolidayWorkView_(record) };
}

/**
 * 入力のチェック（画面でも同じ確認をしますが、最終的な判定は必ずここで行う）。
 * その日が休日かどうかは判定しない（シフト・会社カレンダーができたらここに足す）。
 */
function validateHolidayWorkPlan_(input, today) {
  const workDate = requireDateKey_(input.workDate, '休日出勤日');
  if (workDate < today) fail_('休日出勤は事前の申請のため、過去の日付は申請できません。管理者に相談してください');
  const start = requireClockMinutes_(input.plannedStart, '開始予定時刻');
  const end = requireClockMinutes_(input.plannedEnd, '終了予定時刻');
  if (end <= start) fail_('終了予定時刻は開始予定時刻より後の時刻にしてください（日付をまたぐ休日出勤は申請できません）');
  const reason = requireText_(input.reason, '休日出勤理由', { max: TEXT_LIMITS.LONG });
  const content = requireText_(input.content, '業務内容', { max: TEXT_LIMITS.LONG });
  const compDayType = requireChoice_(input.compDayType, holidayCompDayTypeList_(), '振替休日区分');
  let compDayDate = '';
  // 振替休日予定日は「取得予定」のときだけ保存する（日付が未定なら空欄のまま申請できる）
  if (compDayType === COMP_DAY_TYPES.PLANNED && !isBlank_(input.compDayDate)) {
    compDayDate = requireDateKey_(input.compDayDate, '振替休日予定日');
    if (compDayDate === workDate) fail_('振替休日予定日は、休日出勤日と別の日にしてください');
    if (compDayDate < today) fail_('振替休日予定日に過去の日付は指定できません');
  }
  const note = requireText_(input.note, '備考', { required: false, max: TEXT_LIMITS.LONG });
  const site = requireText_(input.site, '現場', { required: false, max: TEXT_LIMITS.SHORT });
  return { workDate: workDate, start: start, end: end, span: end - start, reason: reason, content: content,
    compDayType: compDayType, compDayDate: compDayDate, note: note, site: site };
}

function decideHolidayWork_(requestId, action, reason) {
  requireHolidayWorkSchema_();
  const admin = requireAdmin();
  const record = findHolidayWorkById_(requestId);
  if (!record) fail_('休日出勤申請が見つかりません（申請ID：' + requestId + '）');
  if (String(record['社員ID']).trim() === admin.employeeId) fail_('自分の休日出勤申請は承認・却下できません');
  const status = String(record['ステータス']).trim();
  const now = getNowInfo_().timestamp;
  const isCancel = action === 'approveCancel' || action === 'rejectCancel';
  const expected = isCancel ? HOLIDAY_WORK_STATUS.CANCEL_REQUESTED : HOLIDAY_WORK_STATUS.PENDING;
  if (status !== expected) fail_('この申請は「' + expected + '」ではないため処理できません（今のステータス：' + status + '）');

  // 承認するときは「今の」シフトで判定する（シフト管理を使うときだけ。申請時に未登録でも、シフトが休日・法定休日に決まれば承認できる）
  if (action === 'approve' && isShiftEnabled_()) {
    const shiftType = getShiftType_(String(record['社員ID']).trim(), toDateKey_(record['休日出勤日']));
    if (!isHolidayShift_(shiftType)) {
      fail_(shiftType === SHIFT_STATE.UNREGISTERED ? 'シフト未登録のため承認できません。先にシフトシートで休日・法定休日を登録してください'
        : shiftType === SHIFT_TYPES.NORMAL ? '対象日のシフトが通常勤務のため、休日出勤として承認できません'
          : '対象日のシフトが「' + shiftType + '」のため承認できません。シフトシートを確認してください');
    }
  }

  let changes;
  let message;
  if (action === 'approve') {
    changes = { 'ステータス': HOLIDAY_WORK_STATUS.APPROVED, '承認者ID': admin.employeeId, '承認者名': admin.name, '承認日時': now, '却下理由': '' };
    message = '休日出勤申請を承認しました';
  } else if (action === 'reject') {
    changes = { 'ステータス': HOLIDAY_WORK_STATUS.REJECTED, '承認者ID': admin.employeeId, '承認者名': admin.name, '承認日時': now,
      '却下理由': requireText_(reason, '却下理由', { max: TEXT_LIMITS.LONG }) };
    message = '休日出勤申請を却下しました';
  } else if (action === 'approveCancel') {
    changes = { 'ステータス': HOLIDAY_WORK_STATUS.CANCELLED, '取消承認日時': now, '取消処理者ID': admin.employeeId, '取消処理者名': admin.name };
    message = '取消申請を承認しました（取消済み）';
  } else {
    changes = { 'ステータス': HOLIDAY_WORK_STATUS.APPROVED, '取消処理者ID': admin.employeeId, '取消処理者名': admin.name,
      '取消却下理由': requireText_(reason, '取消を却下する理由', { max: TEXT_LIMITS.LONG }) };
    message = '取消申請を却下しました（承認済みのまま）';
  }
  changes['更新日時'] = now;
  updateRecord_(SHEET_NAMES.HOLIDAY_WORK, record, changes);
  // 承認・取消承認で「承認済みの休日出勤」かどうかが変わる → その日の勤怠の遅刻・早退・社内超過だけ計算し直す
  // （打刻・実働・勤務区間は変えない。却下・取消却下では変わらないので計算しない）
  if (action === 'approve' || action === 'approveCancel') {
    const date = toDateKey_(record['休日出勤日']);
    const att = findAttendance_(String(record['社員ID']).trim(), date);
    if (att) {
      recalculateAttendanceRecord_(att, now);
      message += '（' + date + ' の勤怠の遅刻・早退・社内超過を計算し直しました。打刻・実働は変わりません）';
    }
  }
  return { message: message, data: toHolidayWorkView_(record) };
}

// ============================================================ 権限・準備

/** 休日出勤申請ができる人：在籍中で、スタッフマスタ「休日出勤申請対象」が「対象」 */
function canApplyHolidayWork_(staff) {
  return staff.status === EMPLOYMENT_STATUS.ACTIVE && staff.holidayWorkTarget === true;
}

/** 休日出勤申請シートと、スタッフマスタの「休日出勤申請対象」列があるか */
function hasHolidayWorkSchema_() {
  if (!getSpreadsheet_().getSheetByName(SHEET_NAMES.HOLIDAY_WORK)) return false;
  return readTable_(SHEET_NAMES.STAFF).columnIndex['休日出勤申請対象'] !== undefined;
}

function requireHolidayWorkSchema_() {
  if (!hasHolidayWorkSchema_()) {
    fail_('休日出勤申請に必要な「休日出勤申請」シートまたはスタッフマスタの「休日出勤申請対象」列がありません。管理者が Apps Script で setupSystem() を実行してください');
  }
}

/**
 * スタッフマスタに「休日出勤申請対象」列を新しく作ったときの初期値（setupSystem から呼ばれる）。
 * 勤怠集計対象が「対象外」の人（役員など）→「対象外」、それ以外 →「対象」。氏名では判定しない。
 * 列を作るときだけ。あとから勤怠集計対象を変えても、この列は変わらない（別管理）。
 */
function initHolidayWorkTargetColumn_(sheet, addedHeaders) {
  if (addedHeaders.indexOf('休日出勤申請対象') === -1) return '';
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';
  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (h) { return String(h).trim(); });
  const idCol = headers.indexOf('社員ID');
  const targetCol = headers.indexOf('勤怠集計対象');
  const holidayCol = headers.indexOf('休日出勤申請対象');
  if (idCol === -1 || holidayCol === -1) return '';
  const rows = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  const values = rows.map(function (row) {
    if (isBlank_(row[idCol])) return [''];
    const excluded = targetCol !== -1 && String(row[targetCol]).trim() === ATTENDANCE_TARGET.NO;
    return [excluded ? HOLIDAY_WORK_TARGET.NO : HOLIDAY_WORK_TARGET.YES];
  });
  sheet.getRange(2, holidayCol + 1, values.length, 1).setValues(values);
  const off = values.filter(function (v) { return v[0] === HOLIDAY_WORK_TARGET.NO; }).length;
  const on = values.filter(function (v) { return v[0] === HOLIDAY_WORK_TARGET.YES; }).length;
  return '休日出勤申請対象の初期値を入れました（対象 ' + on + '名・対象外 ' + off + '名。勤怠集計対象が「対象外」の人を対象外にしています）';
}

// ============================================================ 読み取り・画面用

function findHolidayWorkById_(requestId) {
  const id = String(requestId === undefined || requestId === null ? '' : requestId).trim();
  if (!id) return null;
  return findRecords_(SHEET_NAMES.HOLIDAY_WORK, function (r) { return String(r['申請ID']).trim() === id; })[0] || null;
}

/** 本人の申請だけを返す（他人の申請は「見つかりません」） */
function findOwnHolidayWork_(requestId, staff) {
  requireHolidayWorkSchema_();
  const record = findHolidayWorkById_(requestId);
  if (!record || String(record['社員ID']).trim() !== staff.employeeId) fail_('休日出勤申請が見つかりません');
  return record;
}

function holidayCompDayTypeList_() {
  return [COMP_DAY_TYPES.PLANNED, COMP_DAY_TYPES.NONE, COMP_DAY_TYPES.UNDECIDED];
}

function toHolidayWorkView_(r) {
  return {
    requestId: toPlainText_(r['申請ID']),
    requestedAt: toPlainText_(r['申請日時']),
    employeeId: toPlainText_(r['社員ID']),
    name: toPlainText_(r['氏名']),
    workDate: toDateKey_(r['休日出勤日']),
    plannedStart: toClockText_(r['開始予定時刻']),
    plannedEnd: toClockText_(r['終了予定時刻']),
    plannedSpan: toDurationText_(r['予定勤務時間']), // 予定拘束時間（休憩を差し引かない）
    reason: toPlainText_(r['休日出勤理由']),
    content: toPlainText_(r['業務内容']),
    compDayType: toPlainText_(r['振替休日区分']),
    compDayDate: toDateKey_(r['振替休日予定日']),
    note: toPlainText_(r['備考']),
    site: toPlainText_(r['現場']),
    shiftAtRequest: toPlainText_(r['申請時シフト区分']),
    status: toPlainText_(r['ステータス']),
    statusLabel: requestStatusLabel_(toPlainText_(r['ステータス'])), // 画面の表示（申請中 → 承認待ち）
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

/**
 * 承認済みの休日出勤の予定（社員ID|日付 → 申請）。勤怠記録の 社員ID|日付 と突き合わせるための一覧。
 * 「取消申請中」は取消が承認されるまで予定が有効なので含める。
 */
function buildHolidayWorkPlanMap_() {
  const map = {};
  if (!getSpreadsheet_().getSheetByName(SHEET_NAMES.HOLIDAY_WORK)) return map;
  readTable_(SHEET_NAMES.HOLIDAY_WORK).records.forEach(function (r) {
    const status = String(r['ステータス']).trim();
    if (status !== HOLIDAY_WORK_STATUS.APPROVED && status !== HOLIDAY_WORK_STATUS.CANCEL_REQUESTED) return;
    map[String(r['社員ID']).trim() + '|' + toDateKey_(r['休日出勤日'])] = toHolidayWorkView_(r);
  });
  return map;
}

/** 申請（予定）に、同じ社員・同じ日の勤怠記録（実績）を読み取り専用で付ける。勤怠記録は変更しない */
function attachHolidayWorkActual_(view, attendanceByKey) {
  const att = attendanceByKey[view.employeeId + '|' + view.workDate];
  view.actual = att ? {
    attendanceId: toPlainText_(att['勤怠ID']),
    clockIn: toClockText_(att['出勤']),
    clockOut: toClockText_(att['退勤']),
    workTime: toDurationText_(att['実働時間']),
    status: toPlainText_(att['状態']),
  } : null;
  return view;
}

/** 管理者画面用：処理待ち（申請中・取消申請中）と処理済み */
function buildAdminHolidayWork_(ctx) {
  if (!hasHolidayWorkSchema_()) return { setupRequired: true, pending: [], processed: [], pendingCount: 0 };
  const all = readTable_(SHEET_NAMES.HOLIDAY_WORK).records.map(function (r) {
    const view = toHolidayWorkView_(r);
    const staff = ctx.staffById[view.employeeId];
    view.department = staff ? staff.department : '';
    // 今のシフトと、承認できるか（シフト管理を使うときは休日・法定休日のときだけ。使わない間はいつも承認できる）
    view.currentShift = isShiftEnabled_() ? shiftOf_(ctx.shiftMap || {}, view.employeeId, view.workDate).type : '';
    view.approvable = isShiftEnabled_() ? isHolidayShift_(view.currentShift) : true;
    return attachHolidayWorkActual_(view, ctx.attendanceByKey);
  });
  const waiting = function (v) { return v.status === HOLIDAY_WORK_STATUS.PENDING || v.status === HOLIDAY_WORK_STATUS.CANCEL_REQUESTED; };
  const pending = all.filter(waiting).sort(function (a, b) { return a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : 0; });
  const processed = all.filter(function (v) { return !waiting(v); })
    .sort(function (a, b) { return (a.updatedAt || a.requestedAt) < (b.updatedAt || b.requestedAt) ? 1 : -1; })
    .slice(0, ADMIN_RECENT_REQUEST_LIMIT);
  return { setupRequired: false, pending: pending, processed: processed, pendingCount: pending.length };
}
