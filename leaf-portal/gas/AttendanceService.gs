/**
 * AttendanceService.gs
 * ------------------------------------------------------------
 * 出勤・退勤と、勤務時間の計算です。
 *
 * 【用語】
 *   自動休憩     : 実働時間から毎日自動で差し引く休憩（設定「自動休憩」＝1時間）
 *   中断         : 私用外出など、業務から一時的に離れた時間（中断履歴シートに1回ずつ記録）
 *   社内超過時間 : 固定勤務の人が標準退勤（18:30）より後まで働いた時間。
 *                  社内管理のための数字で、法律上の「時間外労働（法定残業）」とは別のものです。
 *
 * 【実働時間の計算】
 *   実働時間 = 退勤 − 出勤 − 自動休憩 − 中断合計（マイナスにはしない）
 */

// ============================================================ 画面から呼ぶ関数

/**
 * 【画面から呼ぶ】出勤する。
 * @param {string} workStyle 「出社」または「在宅」
 */
function clockIn(workStyle) {
  return runApi_(function () {
    return withLock_(function () { return clockIn_(workStyle); });
  });
}

/** 【画面から呼ぶ】退勤する。 */
function clockOut() {
  return runApi_(function () {
    return withLock_(function () { return clockOut_(); });
  });
}

/**
 * 【画面から呼ぶ】自分の勤怠一覧（本人の分だけ）。
 * @param {string} [month] '2026-09' の形。省略すると今月。
 */
function getMyAttendance(month) {
  return runApi_(function () {
    const staff = getCurrentStaff_();
    const settings = getSettings_();
    const monthKey = isBlank_(month) ? getMonthKeyForDate_(getNowInfo_().date, settings.monthClosingDay) : requireMonthKey_(month, '対象月');
    const range = getMonthRange_(monthKey, settings.monthClosingDay);

    const records = findRecords_(SHEET_NAMES.ATTENDANCE, function (r) {
      const date = toDateKey_(r['日付']);
      return String(r['社員ID']).trim() === staff.employeeId && date >= range.from && date <= range.to;
    }).map(toAttendanceView_).sort(function (a, b) { return a.date < b.date ? -1 : 1; });

    const totalWorkMinutes = records.reduce(function (sum, r) { return sum + (toMinutes_(r.workTime) || 0); }, 0);
    return {
      message: monthKey + ' の勤怠を取得しました（' + records.length + '件）',
      data: {
        month: monthKey,
        from: range.from,
        to: range.to,
        records: records,
        totals: { workDays: records.length, workTime: formatMinutes_(totalWorkMinutes) },
      },
    };
  });
}

/**
 * 【画面から呼ぶ】今日の全スタッフの勤務状況（スタッフ向け）。
 * 他の人の勤務時間・遅刻・残業などは返しません。返すのは「氏名・勤務形態・状態」と、自分の行かどうか（isSelf）だけです。
 */
function getTodayStaffStatus() {
  return runApi_(function () {
    const me = getCurrentStaff_(); // 登録済みのスタッフだけが見られる
    const now = getNowInfo_();
    const list = getAllStaff_()
      .filter(isAttendanceTarget_) // 在籍中で、勤怠集計対象の人だけ（役員など「対象外」の人は出さない）
      .map(function (s) {
        const record = findCurrentAttendance_(s.employeeId, now.date);
        const status = record ? String(record['状態']) : ATTENDANCE_STATUS.NOT_STARTED;
        const workStyle = record ? String(record['勤務形態']) : '';
        return {
          name: s.name,
          workStyle: workStyle,
          status: status,
          label: status === ATTENDANCE_STATUS.WORKING && workStyle ? workStyle + '・' + status : status,
          isSelf: s.employeeId === me.employeeId, // 自分の行か（画面の「（あなた）」表示用。社員IDそのものは返さない）
        };
      });
    return { message: '本日の勤務状況を取得しました', data: { date: now.date, staff: list } };
  });
}

// ============================================================ 出勤・退勤の中身

function clockIn_(workStyle) {
  const style = requireChoice_(workStyle, [WORK_STYLES.OFFICE, WORK_STYLES.REMOTE], '勤務形態');
  const staff = getCurrentStaff_();
  requireActiveStaff_(staff);
  const settings = getSettings_();
  const rule = getWorkRule_(staff, settings);
  const now = getNowInfo_();

  const existing = findAttendance_(staff.employeeId, now.date);
  if (existing) {
    fail_('本日はすでに出勤済みです（出勤 ' + toClockText_(existing['出勤']) + '）');
  }

  // 固定勤務だけ遅刻を判定する（フレックスは出勤時刻が自由なので判定しない）
  const lateMinutes = rule.isFixed ? Math.max(0, now.minutes - rule.standardStartMinutes) : 0;

  const record = appendRecord_(SHEET_NAMES.ATTENDANCE, {
    '勤怠ID': makeAttendanceId_(now.date, staff.employeeId),
    '日付': now.date,
    '社員ID': staff.employeeId,
    '氏名': staff.name,
    '勤務区分': rule.workType,
    '勤務形態': style,
    '出勤': now.time,
    '中断合計': formatMinutes_(0),
    '所定終了': rule.isFixed ? minutesToClock_(rule.standardEndMinutes) : '',
    '遅刻': rule.isFixed ? formatMinutesOrBlank_(lateMinutes) : '',
    '状態': ATTENDANCE_STATUS.WORKING,
    '更新日時': now.timestamp,
  });

  let message = '出勤しました（' + style + '・' + now.time + '）';
  if (lateMinutes > 0) message += '\n標準出勤 ' + minutesToClock_(rule.standardStartMinutes) + ' から ' + formatMinutes_(lateMinutes) + ' の遅れとして記録しました';
  const unfinished = findRecords_(SHEET_NAMES.ATTENDANCE, function (r) {
    return String(r['社員ID']).trim() === staff.employeeId && toDateKey_(r['日付']) < now.date && isOpenStatus_(r['状態']);
  });
  if (unfinished.length) {
    message += '\n※ ' + unfinished.map(function (r) { return toDateKey_(r['日付']); }).join('、') +
      ' の退勤が記録されていません。打刻修正申請をしてください';
  }
  return { message: message, data: toAttendanceView_(record) };
}

function clockOut_() {
  const staff = getCurrentStaff_();
  requireActiveStaff_(staff);
  const now = getNowInfo_();
  const record = findCurrentAttendance_(staff.employeeId, now.date);

  if (!record) fail_('本日はまだ出勤していません。先に「出勤」を押してください');
  const status = String(record['状態']);
  if (status === ATTENDANCE_STATUS.FINISHED) fail_('本日はすでに退勤済みです（退勤 ' + toClockText_(record['退勤']) + '）');
  if (status === ATTENDANCE_STATUS.ON_BREAK) fail_('中断中のため退勤できません。先に「再開」を押してから退勤してください');
  if (status !== ATTENDANCE_STATUS.WORKING) fail_('勤怠の状態が「' + status + '」のため退勤できません。管理者に確認してください');

  updateRecord_(SHEET_NAMES.ATTENDANCE, record, { '退勤': now.time });
  recalculateAttendanceRecord_(record, now.timestamp);
  syncOvertimeActual_(record);

  let message = '退勤しました（退勤 ' + now.time + '／実働 ' + record['実働時間'] + '）';
  if (record['要確認'] === MARKS.NEEDS_CHECK) {
    message += '\n社内超過時間が ' + record['社内超過時間'] + ' ですが、承認済みの事前残業申請がないため「要確認」として記録しました';
  }
  return { message: message, data: toAttendanceView_(record) };
}

// ============================================================ 勤怠記録を探す

/** 勤怠ID（1人1日1件）：AT-20260929-E001 */
function makeAttendanceId_(dateKey, employeeId) {
  return 'AT-' + dateKey.replace(/-/g, '') + '-' + employeeId;
}

/** 指定した社員・日付の勤怠記録（なければ null） */
function findAttendance_(employeeId, dateKey) {
  const id = String(employeeId).trim();
  return findRecords_(SHEET_NAMES.ATTENDANCE, function (r) {
    return String(r['社員ID']).trim() === id && toDateKey_(r['日付']) === dateKey;
  })[0] || null;
}

/** まだ終わっていない状態（勤務中・中断中）か */
function isOpenStatus_(status) {
  return status === ATTENDANCE_STATUS.WORKING || status === ATTENDANCE_STATUS.ON_BREAK;
}

/**
 * 今操作すべき勤怠記録。
 * 基本は今日の記録。今日の記録がなく、前日の記録がまだ勤務中・中断中なら、それを返す（日付をまたぐ勤務用）。
 */
function findCurrentAttendance_(employeeId, todayKey) {
  const today = findAttendance_(employeeId, todayKey);
  if (today) return today;
  const yesterday = findAttendance_(employeeId, addDays_(todayKey, -1));
  return yesterday && isOpenStatus_(String(yesterday['状態'])) ? yesterday : null;
}

// ============================================================ 勤務時間の計算

/**
 * 1日の勤務時間を計算する（シートを使わない純粋な計算）。
 * すべて「分」で受け取り、「分」で返します。
 *
 * @param {object} p
 *   clockInMinutes, clockOutMinutes     出勤・退勤（0時からの分。退勤が出勤より前なら翌日とみなす）
 *   interruptionMinutes                 中断合計
 *   isFixed                             固定勤務なら true
 *   standardStartMinutes, standardEndMinutes  標準出勤・標準退勤
 *   autoBreakMinutes, autoBreakThresholdMinutes 自動休憩と、それを差し引き始める長さ
 *                                       （中断を除いた勤務時間が threshold を「超えた」日だけ差し引く。0 なら常に差し引く）
 *   overtimeFreeLimitMinutes            事前申請が不要な社内超過時間の上限（これ以上で申請必須）
 *   overtimeUnitMinutes                 社内超過時間の記録単位（端数は切り捨て）
 */
function calculateWorkTime_(p) {
  const grossMinutes = durationBetween_(p.clockInMinutes, p.clockOutMinutes);
  const clockOutAbsolute = p.clockInMinutes + grossMinutes; // 日付をまたいだ場合は 1440 以上になる
  // 自動休憩：中断を除いた勤務時間が「自動休憩_適用開始」を超えた日だけ差し引く
  // （例：適用開始 06:00 なら、6時間ちょうどまでの短時間勤務では引かない）
  const minutesBeforeAutoBreak = Math.max(0, grossMinutes - p.interruptionMinutes);
  const autoBreakMinutes = minutesBeforeAutoBreak > p.autoBreakThresholdMinutes ? p.autoBreakMinutes : 0;
  const result = {
    grossMinutes: grossMinutes,
    autoBreakMinutes: autoBreakMinutes,
    interruptionMinutes: p.interruptionMinutes,
    netMinutes: Math.max(0, grossMinutes - autoBreakMinutes - p.interruptionMinutes),
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    internalExcessMinutes: 0,
    requiresPreApproval: false,
  };
  if (!p.isFixed) return result;

  result.lateMinutes = Math.max(0, p.clockInMinutes - p.standardStartMinutes);
  result.earlyLeaveMinutes = Math.max(0, p.standardEndMinutes - clockOutAbsolute);
  // 社内超過時間：標準退勤より後に働いた時間（法定の時間外労働とは別の、社内管理用の数字）
  const excessRaw = Math.max(0, clockOutAbsolute - Math.max(p.standardEndMinutes, p.clockInMinutes));
  result.internalExcessMinutes = Math.floor(excessRaw / p.overtimeUnitMinutes) * p.overtimeUnitMinutes;
  result.requiresPreApproval = result.internalExcessMinutes > 0 && result.internalExcessMinutes >= p.overtimeFreeLimitMinutes;
  return result;
}

/**
 * 再計算に必要な情報をまとめて読み込む（設定・スタッフ・中断履歴・残業申請）。
 * 何件再計算しても、シートの読み込みはこの1回で済みます。
 */
function buildCalcContext_() {
  const staffById = {};
  getAllStaff_().forEach(function (s) { staffById[s.employeeId] = s; });

  const breakMinutesByAttendance = {};
  const openBreakByAttendance = {};
  readTable_(SHEET_NAMES.BREAKS).records.forEach(function (b) {
    const id = String(b['勤怠ID']).trim();
    const start = toMinutes_(b['中断開始']);
    const end = toMinutes_(b['再開']);
    if (start === null) return;
    if (end === null) {
      openBreakByAttendance[id] = true;
      return;
    }
    breakMinutesByAttendance[id] = (breakMinutesByAttendance[id] || 0) + durationBetween_(start, end);
  });

  return {
    settings: getSettings_(),
    staffById: staffById,
    breakMinutesByAttendance: breakMinutesByAttendance,
    openBreakByAttendance: openBreakByAttendance,
    overtimeStatusByKey: buildOvertimeStatusMap_(),
  };
}

/**
 * 勤怠記録1件の「計算で決まる列」をすべて計算し直す。
 * 出勤・退勤・中断履歴・残業申請の今の内容から計算するので、何度実行しても同じ結果になります。
 * 戻り値は { 列名: 新しい値 }。
 */
function calculateAttendanceFields_(record, ctx) {
  const settings = ctx.settings;
  const employeeId = String(record['社員ID']).trim();
  const staff = ctx.staffById[employeeId] || null;
  const recordedType = String(record['勤務区分']).trim();
  let workType = recordedType;
  if (workType !== WORK_TYPES.FIXED && workType !== WORK_TYPES.FLEX) {
    workType = staff && staff.workType === WORK_TYPES.FLEX ? WORK_TYPES.FLEX : WORK_TYPES.FIXED;
  }
  const rule = buildWorkRule_(workType, staff, settings);

  const attendanceId = String(record['勤怠ID']).trim();
  const interruptionMinutes = ctx.breakMinutesByAttendance[attendanceId] || 0;
  const clockInMinutes = toMinutes_(record['出勤']);
  const clockOutMinutes = toMinutes_(record['退勤']);

  const fields = {
    '勤務区分': workType,
    '中断合計': formatMinutes_(interruptionMinutes),
    '自動休憩': '', '実働時間': '', '所定終了': '', '社内超過時間': '', '30分以上': '',
    '事前残業申請': '', '要確認': '', '遅刻': '', '早退': '',
  };
  if (clockInMinutes === null) {
    fields['状態'] = ATTENDANCE_STATUS.NOT_STARTED;
    return fields;
  }
  if (rule.isFixed) {
    fields['所定終了'] = minutesToClock_(rule.standardEndMinutes);
    fields['遅刻'] = formatMinutesOrBlank_(Math.max(0, clockInMinutes - rule.standardStartMinutes));
  }
  if (clockOutMinutes === null) {
    fields['状態'] = ctx.openBreakByAttendance[attendanceId] ? ATTENDANCE_STATUS.ON_BREAK : ATTENDANCE_STATUS.WORKING;
    return fields;
  }

  const result = calculateWorkTime_({
    clockInMinutes: clockInMinutes,
    clockOutMinutes: clockOutMinutes,
    interruptionMinutes: interruptionMinutes,
    isFixed: rule.isFixed,
    standardStartMinutes: rule.standardStartMinutes,
    standardEndMinutes: rule.standardEndMinutes,
    autoBreakMinutes: settings.autoBreakMinutes,
    autoBreakThresholdMinutes: settings.autoBreakThresholdMinutes,
    overtimeFreeLimitMinutes: settings.overtimeFreeLimitMinutes,
    overtimeUnitMinutes: settings.overtimeUnitMinutes,
  });
  fields['状態'] = ATTENDANCE_STATUS.FINISHED;
  fields['自動休憩'] = formatMinutes_(result.autoBreakMinutes);
  fields['実働時間'] = formatMinutes_(result.netMinutes);

  if (rule.isFixed) {
    // 勤務実績（社内超過時間）と申請状況は別々に保存する。実績を申請に合わせて丸めることはしない
    const requestStatus = ctx.overtimeStatusByKey[employeeId + '|' + toDateKey_(record['日付'])] || '';
    fields['社内超過時間'] = formatMinutes_(result.internalExcessMinutes);
    fields['30分以上'] = result.requiresPreApproval ? MARKS.YES : '';
    fields['事前残業申請'] = requestStatus || (result.requiresPreApproval ? OVERTIME_REQUEST_LABEL.NONE : OVERTIME_REQUEST_LABEL.NOT_REQUIRED);
    fields['要確認'] = result.requiresPreApproval && requestStatus !== REQUEST_STATUS.APPROVED ? MARKS.NEEDS_CHECK : '';
    fields['早退'] = formatMinutesOrBlank_(result.earlyLeaveMinutes);
  }
  return fields;
}

/** 勤怠記録1件を再計算してシートに書き込む */
function recalculateAttendanceRecord_(record, timestamp) {
  const fields = calculateAttendanceFields_(record, buildCalcContext_());
  fields['更新日時'] = timestamp || getNowInfo_().timestamp;
  updateRecord_(SHEET_NAMES.ATTENDANCE, record, fields);
  return record;
}

// ============================================================ 画面へ返す形

/** 勤怠記録1行を、画面で使いやすい形（すべて文字列）にする */
function toAttendanceView_(record) {
  return {
    attendanceId: toPlainText_(record['勤怠ID']),
    date: toDateKey_(record['日付']),
    employeeId: toPlainText_(record['社員ID']),
    name: toPlainText_(record['氏名']),
    workType: toPlainText_(record['勤務区分']),
    workStyle: toPlainText_(record['勤務形態']),
    clockIn: toClockText_(record['出勤']),
    clockOut: toClockText_(record['退勤']),
    autoBreak: toDurationText_(record['自動休憩']),
    breakTotal: toDurationText_(record['中断合計']),
    workTime: toDurationText_(record['実働時間']),
    scheduledEnd: toClockText_(record['所定終了']),
    internalExcess: toDurationText_(record['社内超過時間']),
    over30: toPlainText_(record['30分以上']),
    preOvertimeRequest: toPlainText_(record['事前残業申請']),
    needsCheck: toPlainText_(record['要確認']),
    late: toDurationText_(record['遅刻']),
    earlyLeave: toDurationText_(record['早退']),
    status: toPlainText_(record['状態']),
    correctionStatus: toPlainText_(record['打刻修正状況']),
    updatedAt: toPlainText_(record['更新日時']),
    note: toPlainText_(record['備考']),
  };
}
