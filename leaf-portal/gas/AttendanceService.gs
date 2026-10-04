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
 * 【実働時間の計算】（勤務区間の計算は WorkSegmentService.gs）
 *   実働時間 = 各勤務区間の（長さ − 重なる中断）の合計 − 自動休憩（1日1回）（マイナスにはしない）
 *   勤務区間が1つで中断がその中にある日は、以前と同じく 退勤 − 出勤 − 自動休憩 − 中断合計 になります。
 *   中断合計 は記録した中断の合計（以前と同じ意味）。出社から在宅へ「中断→在宅で再開」した場合、
 *   その中断はどちらの区間にも入らないので、実働から二重に引かれることはありません。
 */

// ============================================================ 画面から呼ぶ関数

/**
 * 【画面から呼ぶ】出勤する。退勤済みの日にもう一度押すと「再出勤」（新しい勤務区間）になります。
 * @param {string} workStyle 「出社」「在宅」「現場」「外出」
 * @param {object} [options] { direct: true（直行）, site: '現場名' }（勤務区間の付帯情報。時刻には影響しない）
 */
function clockIn(workStyle, options) {
  return runApi_(function () {
    return withLock_(function () { return clockIn_(workStyle, options); });
  });
}

/**
 * 【画面から呼ぶ】退勤する。
 * @param {object} [options] { directReturn: true（直帰） }
 */
function clockOut(options) {
  return runApi_(function () {
    return withLock_(function () { return clockOut_(options); });
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
    const period = isBlank_(month)
      ? getPayrollPeriodForDate_(getNowInfo_().date, settings.monthClosingDay)
      : getPayrollPeriodByMonthKey_(requireMonthKey_(month, '対象月'), settings.monthClosingDay);
    const monthKey = period.monthKey;
    const range = period;

    const records = findRecords_(SHEET_NAMES.ATTENDANCE, function (r) {
      const date = toDateKey_(r['日付']);
      return String(r['社員ID']).trim() === staff.employeeId && date >= range.from && date <= range.to;
    }).map(toAttendanceView_).sort(function (a, b) { return a.date < b.date ? -1 : 1; });

    const totalWorkMinutes = records.reduce(function (sum, r) { return sum + (toMinutes_(r.workTime) || 0); }, 0);
    return {
      message: period.periodText + ' の勤怠を取得しました（' + records.length + '件）',
      data: {
        month: monthKey,
        from: range.from,
        to: range.to,
        periodLabel: period.label,
        periodText: period.periodText,
        records: records,
        totals: { workDays: records.length, workTime: formatMinutes_(totalWorkMinutes) },
      },
    };
  });
}

/**
 * 【画面から呼ぶ】今日の全スタッフの勤務状況（スタッフ向け）。
 * 他の人の勤務時間・遅刻・残業・勤務区間などは返しません。返すのは「氏名・今の勤務形態・状態」と、自分の行かどうか（isSelf）だけです。
 * 状態の表示：勤務中（出社）／勤務中（在宅）／中断中／退勤済み／未出勤
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
        const workStyle = record ? getCurrentWorkStyle_(record) : '';
        return {
          name: s.name,
          workStyle: workStyle,
          status: status,
          // 会社勤務中／在宅勤務中／中断中（会社）／退勤済み（勤務場所は出社→会社と表示）
          label: status === ATTENDANCE_STATUS.WORKING && workStyle ? workPlaceLabel_(workStyle) + '勤務中'
            : status === ATTENDANCE_STATUS.ON_BREAK && workStyle ? status + '（' + workPlaceLabel_(workStyle) + '）' : status,
          isSelf: s.employeeId === me.employeeId, // 自分の行か（画面の「（あなた）」表示用。社員IDそのものは返さない）
        };
      });
    return { message: '本日の勤務状況を取得しました', data: { date: now.date, staff: list } };
  });
}

// ============================================================ 出勤・退勤の中身

function clockIn_(workStyle, options) {
  const style = requireChoice_(workStyle, punchWorkStyles_(), '勤務形態');
  const staff = getCurrentStaff_();
  requireActiveStaff_(staff);
  const settings = getSettings_();
  const rule = getWorkRule_(staff, settings);
  const now = getNowInfo_();

  const existing = findAttendance_(staff.employeeId, now.date);
  // 直行はその日の最初の出勤のときだけ選べる（再出勤では選べない）
  const extras = normalizeSegmentExtras_(options, { direct: !existing });
  if (existing) return reClockIn_(existing, style, now, extras);

  // 固定勤務だけ遅刻を判定する（フレックスは出勤時刻が自由なので判定しない）。休日は判定せず、午前半休は基準を変える
  const judge = dayJudgeFor_(staff.employeeId, now.date, rule, settings, buildShiftMap_(now.date, now.date, staff.employeeId), buildPaidLeaveMap_(), buildHolidayWorkPlanMap_());
  const lateMinutes = rule.isFixed && judge.judgeLate ? Math.max(0, now.minutes - judge.startBase) : 0;

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
  if (hasWorkSegmentSchema_()) {
    appendSegment_(record, style, now.time, '', now.timestamp, now.timestamp, extras);
    updateRecord_(SHEET_NAMES.ATTENDANCE, record, onlyExistingColumns_(SHEET_NAMES.ATTENDANCE, {
      '勤務形態区分': style, '勤務区間数': '1', '直行': extras['直行'] || '',
    }));
  }

  let message = '出勤しました（' + workPlaceLabel_(style) + '・' + now.time + '）';
  if (lateMinutes > 0) message += '\n' + (judge.startBase === rule.standardStartMinutes ? '標準出勤' : '午前半休の勤務開始') + ' ' + minutesToClock_(judge.startBase) + ' から ' + formatMinutes_(lateMinutes) + ' の遅れとして記録しました';
  const unfinished = findRecords_(SHEET_NAMES.ATTENDANCE, function (r) {
    return String(r['社員ID']).trim() === staff.employeeId && toDateKey_(r['日付']) < now.date && isOpenStatus_(r['状態']);
  });
  if (unfinished.length) {
    message += '\n※ ' + unfinished.map(function (r) { return toDateKey_(r['日付']); }).join('、') +
      ' の退勤が記録されていません。打刻修正申請をしてください';
  }
  return { message: message, data: toAttendanceView_(record) };
}

/**
 * 退勤済みの日の「再出勤」。新しい勤務区間をこの時刻から始める（1日に何回でもできる）。
 */
function reClockIn_(record, style, now, extras) {
  const status = String(record['状態']);
  if (status === ATTENDANCE_STATUS.WORKING) fail_('本日はすでに出勤済みです（勤務中・出勤 ' + toClockText_(record['出勤']) + '）');
  if (status === ATTENDANCE_STATUS.ON_BREAK) fail_('中断中です。業務に戻るときは「再開」を押してください');
  if (status !== ATTENDANCE_STATUS.FINISHED) fail_('勤怠の状態が「' + status + '」のため出勤できません。管理者に確認してください');
  requireWorkSegmentSchema_();

  ensureSegmentsForCurrent_(record, now.timestamp);
  // 再出勤は必ず新しい区間を足す（前の区間の開始・終了は書き換えない＝出勤＝最初の開始は変わらない）
  appendSegment_(record, style, now.time, '', now.timestamp, now.timestamp, extras);
  updateRecord_(SHEET_NAMES.ATTENDANCE, record, { '退勤': '', '状態': ATTENDANCE_STATUS.WORKING, '更新日時': now.timestamp });
  recalculateAttendanceRecord_(record, now.timestamp, { segmentsWin: true });
  syncOvertimeActual_(record);
  return {
    message: '再出勤しました（' + workPlaceLabel_(style) + '・' + now.time + '）。本日の勤務区間は ' + getSegmentRowsOfAttendance_(String(record['勤怠ID']).trim()).length + ' つ目です',
    data: toAttendanceView_(record),
  };
}

function clockOut_(options) {
  const extras = normalizeSegmentExtras_(options, { directReturn: true });
  const staff = getCurrentStaff_();
  requireActiveStaff_(staff);
  const now = getNowInfo_();
  const record = findCurrentAttendance_(staff.employeeId, now.date);

  if (!record) fail_('本日はまだ出勤していません。先に「出勤」を押してください');
  const status = String(record['状態']);
  if (status === ATTENDANCE_STATUS.FINISHED) fail_('本日はすでに退勤済みです（退勤 ' + toClockText_(record['退勤']) + '）');
  if (status === ATTENDANCE_STATUS.ON_BREAK) fail_('中断中のため退勤できません。先に「再開」を押してから退勤してください');
  if (status !== ATTENDANCE_STATUS.WORKING) fail_('勤怠の状態が「' + status + '」のため退勤できません。管理者に確認してください');

  if (hasWorkSegmentSchema_()) {
    const open = findOpenSegmentRow_(ensureSegmentsForCurrent_(record, now.timestamp));
    if (open) {
      closeSegmentRow_(open, now.time, now.timestamp, now.timestamp);
      if (extras['直帰']) updateRecord_(SHEET_NAMES.WORK_SEGMENTS, open, { '直帰': extras['直帰'] });
    }
  }
  updateRecord_(SHEET_NAMES.ATTENDANCE, record, { '退勤': now.time });
  recalculateAttendanceRecord_(record, now.timestamp, { segmentsWin: true });
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
  const breakIntervalsByAttendance = {};
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
    (breakIntervalsByAttendance[id] = breakIntervalsByAttendance[id] || []).push({ startMinutes: start, endMinutes: end });
  });

  return {
    settings: getSettings_(),
    staffById: staffById,
    breakMinutesByAttendance: breakMinutesByAttendance,
    breakIntervalsByAttendance: breakIntervalsByAttendance,
    openBreakByAttendance: openBreakByAttendance,
    segmentsByAttendance: buildSegmentMap_(),
    // 段階3：シフトと承認済みの有給（休日の勤務・半休の日は遅刻・早退・社内超過の判定を変える）
    shiftMap: buildShiftMap_(),
    paidLeaveMap: buildPaidLeaveMap_(),
    holidayWorkMap: buildHolidayWorkPlanMap_(), // 承認済み（取消申請中を含む）の休日出勤申請

    attendanceColumns: readTable_(SHEET_NAMES.ATTENDANCE).columnIndex,
    overtimeStatusByKey: buildOvertimeStatusMap_(),
  };
}

/**
 * 勤怠記録1件の「計算で決まる列」をすべて計算し直す。
 * 出勤・退勤（勤務区間）・中断履歴・残業申請の今の内容から計算するので、何度実行しても同じ結果になります。
 * 勤務区間がある日は、出勤・退勤・勤務形態も勤務区間から決めます（出勤＝最初の開始、退勤＝最後の終了、勤務形態＝最初の区間）。
 * 勤務区間がない日（以前の記録）は、出勤〜退勤を1区間として計算し、出勤・退勤・勤務形態は変えません。
 *
 * 管理者が勤怠記録の出勤・退勤・勤務形態をシートで直接直してから再計算した場合（以前からの運用）は、
 * その値を勤務区間（最初の区間の開始・勤務形態、最後の区間の終了）にも反映します（直した値を消さない）。
 * 打刻の操作から呼ぶときは opts.segmentsWin = true（勤務区間の値を正として勤怠記録を合わせる）。
 * 戻り値は { fields: { 列名: 新しい値 }, segmentChanges: [{ row, changes }] }。
 */
function calculateAttendanceDetail_(record, ctx, opts) {
  const segmentsWin = !!(opts && opts.segmentsWin);
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
  const segments = getDaySegments_(record, ctx.segmentsByAttendance[attendanceId]);
  const hasRealSegments = segments.length > 0 && !segments[0].virtual;
  const columns = ctx.attendanceColumns || {};
  const segmentChanges = [];
  const changeOf = function (row) {
    let entry = segmentChanges.filter(function (c) { return c.row === row; })[0];
    if (!entry) { entry = { row: row, changes: {} }; segmentChanges.push(entry); }
    return entry.changes;
  };
  if (hasRealSegments && !segmentsWin) reconcileSegmentsWithSummary_(record, segments, changeOf);

  const fields = {
    '勤務区分': workType,
    '中断合計': formatMinutes_(interruptionMinutes),
    '自動休憩': '', '実働時間': '', '所定終了': '', '社内超過時間': '', '30分以上': '',
    '事前残業申請': '', '要確認': '', '遅刻': '', '早退': '',
  };
  // 計算で決まる任意の列（日備考・出張は本人の入力なのでここには入れない＝再計算で消さない）
  // 「現場外出時間」は新しい集計では使わない（列は残し、以前の値も書き換えない）
  const optional = { '勤務形態区分': '', '勤務区間数': '', '出社時間': '', '在宅時間': '', '直行': '', '直帰': '' };
  const finish = function () {
    Object.keys(optional).forEach(function (k) { if (columns[k] !== undefined) fields[k] = optional[k]; });
    return { fields: fields, segmentChanges: segmentChanges };
  };

  if (!segments.length) {
    fields['状態'] = ATTENDANCE_STATUS.NOT_STARTED;
    return finish();
  }
  const open = findOpenSegment_(segments);
  // 出勤＝全区間の最小の開始、退勤＝終了済みの区間の最大の終了（毎回すべての区間から作り直す）
  const summary = summarizeDaySegments_(segments);
  if (hasRealSegments) {
    fields['出勤'] = summary.clockIn;
    fields['退勤'] = summary.clockOut;
    fields['勤務形態'] = summary.workStyle;
  }
  optional['勤務形態区分'] = workStyleCategory_(segments);
  optional['勤務区間数'] = String(segments.length);
  if (hasRealSegments) {
    optional['直行'] = summary.direct ? MARKS.YES : '';
    optional['直帰'] = summary.directReturn ? MARKS.YES : '';
  }
  const judge = dayJudgeFor_(employeeId, toDateKey_(record['日付']), rule, settings, ctx.shiftMap, ctx.paidLeaveMap, ctx.holidayWorkMap);
  if (rule.isFixed) {
    fields['所定終了'] = minutesToClock_(rule.standardEndMinutes);
    fields['遅刻'] = judge.judgeLate ? formatMinutesOrBlank_(Math.max(0, summary.clockInMinutes - judge.startBase)) : '';
  }
  if (open) {
    fields['状態'] = ctx.openBreakByAttendance[attendanceId] ? ATTENDANCE_STATUS.ON_BREAK : ATTENDANCE_STATUS.WORKING;
    return finish();
  }

  const result = calculateSegmentedWorkTime_({
    segments: segments,
    interruptions: ctx.breakIntervalsByAttendance[attendanceId] || [],
    isFixed: rule.isFixed,
    standardStartMinutes: judge.startBase,
    standardEndMinutes: judge.endBase,
    excessBaseMinutes: rule.standardEndMinutes, // 社内超過は半休の日も標準退勤（18:30）より後
    autoBreakMinutes: settings.autoBreakMinutes,
    autoBreakThresholdMinutes: settings.autoBreakThresholdMinutes,
    overtimeFreeLimitMinutes: settings.overtimeFreeLimitMinutes,
    overtimeUnitMinutes: settings.overtimeUnitMinutes,
  });
  fields['状態'] = ATTENDANCE_STATUS.FINISHED;
  fields['自動休憩'] = formatMinutes_(result.autoBreakMinutes);
  fields['実働時間'] = formatMinutes_(result.netMinutes);
  optional['出社時間'] = formatMinutes_(result.officeMinutes);
  optional['在宅時間'] = formatMinutes_(result.remoteMinutes);
  segments.forEach(function (seg, i) {
    const workTime = formatMinutes_(result.segments[i].netMinutes);
    if (seg.row && toPlainText_(seg.row['区間実働']) !== workTime) changeOf(seg.row)['区間実働'] = workTime;
  });

  if (rule.isFixed && !judge.judgeExcess) {
    // 休日出勤の日：遅刻・早退・社内超過は判定しない（勤務時間は「休日出勤」として別に表示する）。
    // 残業申請の判定（30分以上・事前残業申請・要確認）にも入れない。前に計算した値が残らないよう空欄にする（実働・勤務区間はそのまま）
    fields['遅刻'] = '';
    fields['早退'] = '';
    fields['社内超過時間'] = '';
    fields['30分以上'] = '';
    fields['事前残業申請'] = '';
    fields['要確認'] = '';
    return finish();
  }
  if (rule.isFixed) {
    // 勤務実績（社内超過時間）と申請状況は別々に保存する。実績を申請に合わせて丸めることはしない
    const requestStatus = ctx.overtimeStatusByKey[employeeId + '|' + toDateKey_(record['日付'])] || '';
    fields['社内超過時間'] = formatMinutes_(result.internalExcessMinutes);
    fields['30分以上'] = result.requiresPreApproval ? MARKS.YES : '';
    fields['事前残業申請'] = requestStatus || (result.requiresPreApproval ? OVERTIME_REQUEST_LABEL.NONE : OVERTIME_REQUEST_LABEL.NOT_REQUIRED);
    fields['要確認'] = result.requiresPreApproval && requestStatus !== REQUEST_STATUS.APPROVED ? MARKS.NEEDS_CHECK : '';
    fields['早退'] = judge.judgeEarly ? formatMinutesOrBlank_(result.earlyLeaveMinutes) : '';
    if (!judge.judgeLate) fields['遅刻'] = '';
  }
  return finish();
}

/**
 * 勤怠記録の出勤・退勤・勤務形態がシートで直接直されていたら、勤務区間に反映する（segments も書き換える）。
 * 反映すると区間の順番がおかしくなる（例：出勤を最初の区間の終了より後にした）ときは反映しない。
 */
function reconcileSegmentsWithSummary_(record, segments, changeOf) {
  const sum = summarizeDaySegments_(segments);
  const firstIndex = sum.firstIndex;
  const lastIndex = sum.lastIndex;
  const first = segments[firstIndex];
  const last = segments[lastIndex];
  const recIn = toMinutes_(record['出勤']);
  const recOut = toMinutes_(record['退勤']);
  const recStyle = toPlainText_(record['勤務形態']).trim();
  const planned = segments.map(function (s) { return { number: s.number, startMinutes: s.startMinutes, endMinutes: s.endMinutes }; });
  const fixIn = recIn !== null && recIn !== first.startMinutes;
  const fixOut = recOut !== null && recOut !== last.endMinutes;
  if (fixIn) planned[firstIndex].startMinutes = recIn;
  if (fixOut) planned[lastIndex].endMinutes = recOut;
  if (fixIn || fixOut) {
    try {
      validateSegmentOrder_(planned);
    } catch (e) {
      return; // 直した値では区間が成り立たない → 勤務区間の値のまま（管理者は勤務区間履歴を直す）
    }
    // 直した時刻は打刻の時刻ではないので、秒までの打刻日時は空にする
    if (fixIn) { first.startMinutes = recIn; first.startStamp = ''; Object.assign(changeOf(first.row), { '開始時刻': minutesToClock_(recIn) }, stampClear_('開始打刻日時')); }
    if (fixOut) { last.endMinutes = recOut; last.endStamp = ''; Object.assign(changeOf(last.row), { '終了時刻': minutesToClock_(recOut) }, stampClear_('終了打刻日時')); }
  }
  if (recStyle && segmentWorkStyles_().indexOf(recStyle) !== -1 && recStyle !== first.style) {
    first.style = recStyle;
    changeOf(first.row)['勤務形態'] = recStyle;
  }
}

/** 打刻日時の列を空にする変更（列が無ければ何もしない） */
function stampClear_(column) {
  const out = {};
  if (hasColumn_(SHEET_NAMES.WORK_SEGMENTS, column)) out[column] = '';
  return out;
}

/** 勤怠記録1件の「計算で決まる列」（以前からの関数名。戻り値は { 列名: 新しい値 }） */
function calculateAttendanceFields_(record, ctx) {
  return calculateAttendanceDetail_(record, ctx).fields;
}

/**
 * その日の遅刻・早退・社内超過の判定の仕方（シフトと承認済みの有給で決める）。
 *   休日・法定休日       … 遅刻・早退・社内超過を判定しない
 *   1日有給              … 遅刻・早退を判定しない（勤務があれば管理者画面で要確認）
 *   午前半休（通常勤務） … 遅刻の基準を「午前半休_勤務開始」（14:30）に
 *   午後半休（通常勤務） … 早退の基準を「午後半休_勤務終了」（13:30）に
 *   未登録など           … これまでどおり（標準出勤・標準退勤）。管理者画面で「シフト未登録」の要確認
 * ※ 今はシフト管理を使っていない（SHIFT_FEATURE.enabled = false）ので、シフトの代わりに
 *    承認済みの休日出勤申請（取消申請中を含む。申請中・却下・取消済みは含めない）がある日を「休日出勤」として、
 *    遅刻・早退・社内超過を判定しない。休日か法定休日かは判定しない（法定休日出勤とは推測しない）。
 *    有給は 1日有給は遅刻・早退なし、午前半休は 14:30、午後半休は 13:30 を基準。
 */
function dayJudgeFor_(employeeId, dateKey, rule, settings, shiftMap, paidLeaveMap, holidayWorkMap) {
  const useShift = isShiftEnabled_(); // シフト管理を使わない間は、休日の判定をせず、半休はいつも半休の基準で判定する
  const shiftType = useShift ? shiftOf_(shiftMap || {}, employeeId, dateKey).type : '';
  const leave = (paidLeaveMap || {})[String(employeeId).trim() + '|' + dateKey] || null;
  const out = { shiftType: shiftType, leave: leave, judgeLate: true, judgeEarly: true, judgeExcess: true,
    startBase: rule.standardStartMinutes, endBase: rule.standardEndMinutes };
  const approvedHolidayWork = !useShift && !!(holidayWorkMap || {})[String(employeeId).trim() + '|' + dateKey];
  if ((useShift && isHolidayShift_(shiftType)) || approvedHolidayWork) {
    out.judgeLate = false; out.judgeEarly = false; out.judgeExcess = false;
    return out;
  }
  if (!leave) return out;
  if (leave.leaveType === PAID_LEAVE_TYPES.FULL) { out.judgeLate = false; out.judgeEarly = false; return out; }
  if (useShift && shiftType !== SHIFT_TYPES.NORMAL) return out;
  if (leave.leaveType === PAID_LEAVE_TYPES.AM && settings.amHalfStartMinutes !== null) out.startBase = settings.amHalfStartMinutes;
  if (leave.leaveType === PAID_LEAVE_TYPES.PM && settings.pmHalfEndMinutes !== null) out.endBase = settings.pmHalfEndMinutes;
  return out;
}

/** 勤怠記録1件を再計算してシートに書き込む */
/**
 * 勤怠記録1件を再計算してシートに書き込む。
 * @param {object} [opts] { segmentsWin: true } … 打刻・打刻修正で勤務区間を書き換えた直後（勤務区間の値を正とする）
 */
function recalculateAttendanceRecord_(record, timestamp, opts) {
  const ts = timestamp || getNowInfo_().timestamp;
  const detail = calculateAttendanceDetail_(record, buildCalcContext_(), opts);
  const fields = detail.fields;
  fields['更新日時'] = ts;
  updateRecord_(SHEET_NAMES.ATTENDANCE, record, fields);
  detail.segmentChanges.forEach(function (c) {
    if (Object.keys(c.changes).some(function (k) { return k !== '区間実働'; })) c.changes['更新日時'] = ts;
    updateRecord_(SHEET_NAMES.WORK_SEGMENTS, c.row, c.changes);
  });
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
    // 勤務区間の合計（列が無い・以前の記録は空欄）
    workStyleCategory: toPlainText_(record['勤務形態区分']),
    workPlace: workPlaceCategoryLabel_(toPlainText_(record['勤務形態区分']) || toPlainText_(record['勤務形態'])), // 画面用：会社＋在宅
    segmentCount: toPlainText_(record['勤務区間数']),
    officeTime: toDurationText_(record['出社時間']),
    remoteTime: toDurationText_(record['在宅時間']),
    siteOutingTime: toDurationText_(record['現場外出時間']),
    // 段階2：日の付帯情報（直行・直帰は勤務区間から写した値）
    dayNote: toPlainText_(record['日備考']),
    businessTrip: toPlainText_(record['出張']),
    direct: toPlainText_(record['直行']),
    directReturn: toPlainText_(record['直帰']),
  };
}
