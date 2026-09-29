/**
 * OvertimeService.gs
 * ------------------------------------------------------------
 * 事前残業申請です（固定勤務の社内超過時間に関するルール）。
 *
 *   社内超過時間が 30分未満 → 事前残業申請は不要
 *   社内超過時間が 30分以上 → 承認済みの事前残業申請が必要
 *                              申請がなければ勤怠記録の「要確認」に「要確認」と入れる
 *
 * 実際の打刻や勤務時間は、申請の有無で削ったり丸めたりしません。
 * 勤務実績（勤怠記録）と申請状況（残業申請）は別々に保存します。
 */

/**
 * 【画面から呼ぶ】残業を事前に申請する。
 * @param {object} request
 *   targetDate   対象日 '2026-09-29'（今日以降）
 *   plannedStart 予定開始 '18:30'
 *   plannedEnd   予定終了 '20:00'
 *   reason       申請理由
 */
function submitOvertimeRequest(request) {
  return runApi_(function () {
    return withLock_(function () { return submitOvertimeRequest_(request || {}); });
  });
}

/** 【画面から呼ぶ】自分の残業申請の一覧（新しい順） */
function getMyOvertimeRequests() {
  return runApi_(function () {
    const staff = getCurrentStaff_();
    const list = findRecords_(SHEET_NAMES.OVERTIME, function (r) { return String(r['社員ID']).trim() === staff.employeeId; })
      .map(toOvertimeView_)
      .sort(function (a, b) { return a.requestedAt < b.requestedAt ? 1 : -1; });
    return { message: '残業申請を取得しました（' + list.length + '件）', data: list };
  });
}

/** 【管理者】残業申請を承認する */
function approveOvertimeRequest(requestId) {
  return runApi_(function () {
    return withLock_(function () { return decideOvertimeRequest_(requestId, REQUEST_STATUS.APPROVED, ''); });
  });
}

/** 【管理者】残業申請を却下する */
function rejectOvertimeRequest(requestId, reason) {
  return runApi_(function () {
    return withLock_(function () { return decideOvertimeRequest_(requestId, REQUEST_STATUS.REJECTED, reason); });
  });
}

function submitOvertimeRequest_(request) {
  const staff = getCurrentStaff_();
  requireActiveStaff_(staff);
  const now = getNowInfo_();
  const targetDate = requireDateKey_(request.targetDate, '対象日');
  if (targetDate < now.date) fail_('事前の申請のため、過去の日付は申請できません。管理者に相談してください');
  // フレックス社員には、固定勤務の「標準退勤以降・一定時間以上は事前申請」のルールを適用しない
  if (staff.workType === WORK_TYPES.FLEX) fail_('フレックス勤務の方は、残業申請の対象外です');
  const start = requireClockMinutes_(request.plannedStart, '予定開始');
  const end = requireClockMinutes_(request.plannedEnd, '予定終了');
  checkOvertimePlan_(start, end, getSettings_());
  const reason = requireText_(request.reason, '申請理由', { max: TEXT_LIMITS.LONG });

  const duplicate = findRecords_(SHEET_NAMES.OVERTIME, function (r) {
    return String(r['社員ID']).trim() === staff.employeeId && toDateKey_(r['対象日']) === targetDate &&
      (r['ステータス'] === REQUEST_STATUS.PENDING || r['ステータス'] === REQUEST_STATUS.APPROVED);
  })[0];
  if (duplicate) fail_(targetDate + ' の残業申請はすでに提出されています（ステータス：' + duplicate['ステータス'] + '）');

  const record = appendRecord_(SHEET_NAMES.OVERTIME, {
    '申請ID': makeUniqueId_(SHEET_NAMES.OVERTIME, '申請ID', 'OT-' + compactTimestamp_() + '-' + staff.employeeId),
    '申請日時': now.timestamp,
    '社員ID': staff.employeeId,
    '氏名': staff.name,
    '対象日': targetDate,
    '予定開始': minutesToClock_(start),
    '予定終了': minutesToClock_(end),
    '予定残業時間': formatMinutes_(durationBetween_(start, end)),
    '申請理由': reason,
    'ステータス': REQUEST_STATUS.PENDING,
  });
  refreshAttendanceAfterOvertimeChange_(staff.employeeId, targetDate);
  return { message: '残業申請を提出しました（' + targetDate + '）。管理者の承認をお待ちください', data: toOvertimeView_(record) };
}

/**
 * 予定時間のチェック（同じ日の中で、開始より後に終わること・申請が必要な長さであること）。
 *   終了が開始以前   → エラー（日付をまたぐ残業は、この画面からは申請できません）
 *   上限未満        → エラー「30分未満の残業は事前申請不要です」（上限＝設定「残業_申請不要上限」。00:45 なら「45分未満」）
 *   上限ちょうど以上 → OK（社内超過がこの時間以上になると事前申請が必要なため）
 * 画面側でも同じ設定値で事前に判定しますが、最終的な判定は必ずここ（設定シートの値）で行います。
 */
function checkOvertimePlan_(startMinutes, endMinutes, settings) {
  if (endMinutes <= startMinutes) fail_('予定終了は予定開始より後の時刻にしてください（日付をまたぐ残業は管理者に相談してください）');
  const planned = endMinutes - startMinutes;
  if (planned < settings.overtimeFreeLimitMinutes) {
    fail_(formatDurationLabel_(settings.overtimeFreeLimitMinutes) + '未満の残業は事前申請不要です（予定残業時間：' + formatMinutes_(planned) + '）');
  }
  return planned;
}

/**
 * 残業申請のルール（画面の説明文・事前チェック用）。値は設定シート「残業_申請不要上限」から取る。
 *   { freeLimitMinutes: 30, freeLimitLabel: '30分' }
 */
function getOvertimeRule_() {
  const minutes = getSettings_().overtimeFreeLimitMinutes;
  return { freeLimitMinutes: minutes, freeLimitLabel: formatDurationLabel_(minutes) };
}

/** 分を「45分」「1時間」「1時間30分」の形にする（画面・メッセージ用） */
function formatDurationLabel_(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return m + '分';
  return h + '時間' + (m ? m + '分' : '');
}

function decideOvertimeRequest_(requestId, newStatus, reason) {
  const admin = requireAdmin();
  const request = findRecords_(SHEET_NAMES.OVERTIME, function (r) { return String(r['申請ID']).trim() === String(requestId).trim(); })[0];
  if (!request) fail_('残業申請が見つかりません（申請ID：' + requestId + '）');
  if (request['ステータス'] !== REQUEST_STATUS.PENDING) fail_('この申請はすでに処理済みです（ステータス：' + request['ステータス'] + '）');

  const changes = {
    'ステータス': newStatus,
    '承認者': admin.name,
    '承認日時': getNowInfo_().timestamp,
  };
  if (newStatus === REQUEST_STATUS.REJECTED) {
    changes['備考'] = '却下理由：' + requireText_(reason, '却下理由', { max: TEXT_LIMITS.LONG });
  }
  updateRecord_(SHEET_NAMES.OVERTIME, request, changes);

  // 承認・却下の結果を、その日の勤怠記録の「事前残業申請」「要確認」に反映する
  refreshAttendanceAfterOvertimeChange_(String(request['社員ID']).trim(), toDateKey_(request['対象日']));
  return { message: '残業申請を「' + newStatus + '」にしました', data: toOvertimeView_(request) };
}

/**
 * 社員ID・日付ごとの申請状況の一覧。
 * 同じ日に複数あるときは「承認済み」＞「承認待ち」＞「却下」の順で優先します。
 */
function buildOvertimeStatusMap_() {
  const priority = {};
  priority[REQUEST_STATUS.APPROVED] = 3;
  priority[REQUEST_STATUS.PENDING] = 2;
  priority[REQUEST_STATUS.REJECTED] = 1;
  const map = {};
  readTable_(SHEET_NAMES.OVERTIME).records.forEach(function (r) {
    const status = String(r['ステータス']).trim();
    if (!priority[status]) return;
    const key = String(r['社員ID']).trim() + '|' + toDateKey_(r['対象日']);
    if (!map[key] || priority[status] > priority[map[key]]) map[key] = status;
  });
  return map;
}

/** その日の勤怠記録が退勤済みなら再計算する */
function refreshAttendanceAfterOvertimeChange_(employeeId, dateKey) {
  const record = findAttendance_(employeeId, dateKey);
  if (!record || isBlank_(record['退勤'])) return;
  recalculateAttendanceRecord_(record);
  syncOvertimeActual_(record);
}

/**
 * 残業申請の「実績残業」に、勤怠記録の社内超過時間を書き込む。
 * 対象は同じ社員・同じ日の申請（承認済みを優先、なければ承認待ち）。
 */
function syncOvertimeActual_(attendanceRecord) {
  const employeeId = String(attendanceRecord['社員ID']).trim();
  const dateKey = toDateKey_(attendanceRecord['日付']);
  const requests = findRecords_(SHEET_NAMES.OVERTIME, function (r) {
    return String(r['社員ID']).trim() === employeeId && toDateKey_(r['対象日']) === dateKey;
  });
  const target = requests.filter(function (r) { return r['ステータス'] === REQUEST_STATUS.APPROVED; })[0] ||
    requests.filter(function (r) { return r['ステータス'] === REQUEST_STATUS.PENDING; })[0];
  if (!target) return;
  const actual = toDurationText_(attendanceRecord['社内超過時間']);
  if (String(target['実績残業']) !== actual) updateRecord_(SHEET_NAMES.OVERTIME, target, { '実績残業': actual });
}

function toOvertimeView_(r) {
  return {
    requestId: toPlainText_(r['申請ID']),
    requestedAt: toPlainText_(r['申請日時']),
    employeeId: toPlainText_(r['社員ID']),
    name: toPlainText_(r['氏名']),
    targetDate: toDateKey_(r['対象日']),
    plannedStart: toClockText_(r['予定開始']),
    plannedEnd: toClockText_(r['予定終了']),
    plannedOvertime: toDurationText_(r['予定残業時間']),
    reason: toPlainText_(r['申請理由']),
    status: toPlainText_(r['ステータス']),
    approver: toPlainText_(r['承認者']),
    approvedAt: toPlainText_(r['承認日時']),
    actualOvertime: toDurationText_(r['実績残業']),
    note: toPlainText_(r['備考']),
  };
}
