/**
 * ShiftService.gs
 * ------------------------------------------------------------
 * シフト（社員×日付の 通常勤務・休日・法定休日）の判定です。シフトの読み取りはここに集めています。
 *
 *   通常勤務／休日／法定休日 … シフトシートの「シフト区分」
 *   未登録                   … その社員・その日の行がない（通常勤務とはみなさない）
 *   シフト重複               … その社員・その日の行が2つ以上ある（どちらとも決めない）
 *   シフト不備               … 「シフト区分」が上の3つ以外
 *
 * 法定休日は曜日では決めず、シフトシートの「法定休日」だけで決めます。
 *
 * ※ 今はシフト管理を使っていません（Config.gs の SHIFT_FEATURE.enabled = false）。
 *    その間は、シフトを読まず（すべて「シフトなし」）、申請の受付・承認や遅刻・早退の判定にもシフトを使いません。
 * 入力は今のところ管理者がシートに直接入力します。将来の管理画面・CSV取込・一括登録は、
 * このファイルに書き込みの関数を足せば、読み取り側（判定）はそのまま使えます。
 */

/** 【画面から呼ぶ】自分のシフト（締め期間ごと。他の人のシフトは返さない） */
function getMyShifts(month) {
  return runApi_(function () {
    const staff = getCurrentStaff_();
    if (!isShiftEnabled_()) return { message: 'シフト管理は使っていません', data: { enabled: false, days: [] } };
    const now = getNowInfo_();
    const period = isBlank_(month) ? getPayrollPeriodForDate_(now.date) : getPayrollPeriodByMonthKey_(requireMonthKey_(month, '対象月'));
    const map = buildShiftMap_(period.from, period.to, staff.employeeId);
    const days = listDates_(period.from, period.to).map(function (date) {
      const s = shiftOf_(map, staff.employeeId, date);
      return { date: date, type: s.type, plannedStart: s.plannedStart, plannedEnd: s.plannedEnd, note: s.note };
    });
    return {
      message: period.periodText + ' のシフトを取得しました',
      data: { enabled: true, month: period.monthKey, from: period.from, to: period.to, periodText: period.periodText, today: now.date, available: hasShiftSchema_(), days: days },
    };
  });
}

/** 【画面から呼ぶ】自分の、ある日のシフト区分（申請フォームで表示する。他の人のシフトは返さない） */
function getMyShiftOn(date) {
  return runApi_(function () {
    const staff = getCurrentStaff_();
    const dateKey = requireDateKey_(date, '日付');
    if (!isShiftEnabled_()) return { message: 'シフト管理は使っていません', data: { enabled: false, date: dateKey, type: '', plannedStart: '', plannedEnd: '' } };
    const s = shiftOf_(buildShiftMap_(dateKey, dateKey, staff.employeeId), staff.employeeId, dateKey);
    return { message: dateKey + ' のシフト：' + s.type, data: { enabled: true, date: dateKey, type: s.type, plannedStart: s.plannedStart, plannedEnd: s.plannedEnd } };
  });
}

/** シフト管理を使うか（Config.gs の SHIFT_FEATURE）。false の間はシフトを読まない */
function isShiftEnabled_() {
  return !!SHIFT_FEATURE.enabled;
}

function hasShiftSchema_() {
  if (!isShiftEnabled_()) return false;
  if (!getSpreadsheet_().getSheetByName(SHEET_NAMES.SHIFTS)) return false;
  try {
    readTable_(SHEET_NAMES.SHIFTS);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * シフトを 社員ID|日付 → [行...] にまとめる（from〜to、社員を絞ることもできる）。シートがなければ空。
 */
function buildShiftMap_(from, to, employeeId) {
  const map = {};
  if (!hasShiftSchema_()) return map;
  const id = employeeId ? String(employeeId).trim() : '';
  readTable_(SHEET_NAMES.SHIFTS).records.forEach(function (r) {
    const emp = String(r['社員ID']).trim();
    const date = toDateKey_(r['日付']);
    if (!emp || !date) return;
    if (id && emp !== id) return;
    if ((from && date < from) || (to && date > to)) return;
    const key = emp + '|' + date;
    (map[key] = map[key] || []).push(r);
  });
  return map;
}

/**
 * 社員・日付のシフトの判定。
 * 戻り値：{ type: 通常勤務|休日|法定休日|未登録|シフト重複|シフト不備, plannedStart, plannedEnd, note }
 */
function shiftOf_(map, employeeId, dateKey) {
  const rows = map[String(employeeId).trim() + '|' + dateKey] || [];
  if (!rows.length) return { type: SHIFT_STATE.UNREGISTERED, plannedStart: '', plannedEnd: '', note: '' };
  if (rows.length > 1) return { type: SHIFT_STATE.DUPLICATE, plannedStart: '', plannedEnd: '', note: '' };
  const r = rows[0];
  const t = String(r['シフト区分']).trim();
  const valid = [SHIFT_TYPES.NORMAL, SHIFT_TYPES.HOLIDAY, SHIFT_TYPES.LEGAL_HOLIDAY].indexOf(t) !== -1;
  return {
    type: valid ? t : SHIFT_STATE.INVALID,
    plannedStart: toClockText_(r['予定開始']),
    plannedEnd: toClockText_(r['予定終了']),
    note: toPlainText_(r['備考']),
  };
}

/** 1人・1日のシフト区分（毎回シートを読むので、たくさんの日を判定するときは buildShiftMap_ を使う） */
function getShiftType_(employeeId, dateKey) {
  return shiftOf_(buildShiftMap_(dateKey, dateKey, employeeId), employeeId, dateKey).type;
}

/** 休日・法定休日か */
function isHolidayShift_(type) {
  return type === SHIFT_TYPES.HOLIDAY || type === SHIFT_TYPES.LEGAL_HOLIDAY;
}

// ============================================================ 1日の区分と要確認（表示のたびに組み立てる。勤怠記録には書かない）

/**
 * 1日の区分と要確認を作るための情報をまとめて読む（シフト・承認済みの有給と休日出勤・休日出勤のすべてのステータス・有給の事後申請）。
 * 勤怠記録の「要確認」列（残業の事前申請用）とは別のもの。
 */
function buildDayStatusContext_(settings) {
  const hwStatusByKey = {};
  if (getSpreadsheet_().getSheetByName(SHEET_NAMES.HOLIDAY_WORK)) {
    readTable_(SHEET_NAMES.HOLIDAY_WORK).records.forEach(function (r) {
      const key = String(r['社員ID']).trim() + '|' + toDateKey_(r['休日出勤日']);
      (hwStatusByKey[key] = hwStatusByKey[key] || []).push(String(r['ステータス']).trim());
    });
  }
  const lateLeaveByKey = {};
  if (hasPaidLeaveSchema_()) {
    readTable_(SHEET_NAMES.PAID_LEAVE).records.forEach(function (r) {
      if (!isActiveRequestStatus_(r['ステータス']) || isBlank_(r['事後申請'])) return;
      lateLeaveByKey[String(r['社員ID']).trim() + '|' + toDateKey_(r['対象日'])] = true;
    });
  }
  return {
    settings: settings || getSettings_(),
    shiftMap: buildShiftMap_(),
    leaveMap: buildPaidLeaveMap_(),
    holidayWorkMap: buildHolidayWorkPlanMap_(),
    hwStatusByKey: hwStatusByKey,
    lateLeaveByKey: lateLeaveByKey,
  };
}

/** 要確認の理由（画面の文言） */
const DAY_CHECKS = {
  UNREGISTERED_WORK: 'シフト未登録日に勤務',
  SHIFT_DUPLICATE: 'シフト重複',
  SHIFT_INVALID: 'シフト区分の値が正しくない',
  NO_HOLIDAY_REQUEST: '未申請休日出勤',
  CANCELLED_HOLIDAY_WORK: '取消済み休日出勤＋実勤務',
  FULL_LEAVE_WORK: '1日有給日に勤務実績あり',
  LATE_LEAVE: '事後申請（有給）',
  HW_SHIFT_MISMATCH: '申請後にシフト区分が変更（休日出勤申請と不一致）',
  LEAVE_SHIFT_MISMATCH: '申請後にシフト区分が変更（有給申請と不一致）',
  HALF_SETTING: '半休基準等の設定不備',
};

/**
 * 社員1人・1日の区分と要確認。勤務時間・有給時間はどちらも消したり丸めたりしない（別々に返す）。
 * @param {object} record その日の勤怠記録（なければ null）
 * 戻り値：{ shiftType, worked, workMinutes, kind: ''|'通常'|'休日出勤'|'法定休日出勤',
 *          holidayWork: { kind, minutes, approved } | null, leave: { type, minutes } | null,
 *          place: ''|'会社'|'在宅'|'会社＋在宅', badges: [{ text, tone }], checks: [理由] }
 */
function buildDayStatus_(employeeId, dateKey, record, dctx) {
  const id = String(employeeId).trim();
  const key = id + '|' + dateKey;
  const settings = dctx.settings;
  const useShift = isShiftEnabled_(); // シフト管理を使わない間は、シフトに関する区分・要確認を出さない
  const shiftType = useShift ? shiftOf_(dctx.shiftMap, id, dateKey).type : '';
  const worked = !!record && !isBlank_(record['出勤']);
  const workMinutes = worked ? (toMinutes_(record['実働時間']) || 0) : 0;
  const leaveView = dctx.leaveMap[key] || null;
  const hwApproved = dctx.holidayWorkMap[key] || null;
  const checks = [];
  const out = { shiftType: shiftType, worked: worked, workMinutes: workMinutes, kind: '', holidayWork: null, leave: null, place: '', badges: [], checks: checks };

  if (useShift) {
    if (shiftType === SHIFT_STATE.DUPLICATE) checks.push(DAY_CHECKS.SHIFT_DUPLICATE);
    if (shiftType === SHIFT_STATE.INVALID) checks.push(DAY_CHECKS.SHIFT_INVALID);
    if (worked && shiftType === SHIFT_STATE.UNREGISTERED) checks.push(DAY_CHECKS.UNREGISTERED_WORK);
  }

  if (useShift && worked && isHolidayShift_(shiftType)) {
    out.kind = shiftType === SHIFT_TYPES.LEGAL_HOLIDAY ? '法定休日出勤' : '休日出勤';
    out.holidayWork = { kind: out.kind, minutes: workMinutes, approved: !!hwApproved }; // 実績の実働（予定時間に丸めない）
    if (!hwApproved) {
      const statuses = dctx.hwStatusByKey[key] || [];
      checks.push(statuses.indexOf(HOLIDAY_WORK_STATUS.CANCELLED) !== -1 ? DAY_CHECKS.CANCELLED_HOLIDAY_WORK : DAY_CHECKS.NO_HOLIDAY_REQUEST);
    }
  } else if (!useShift && worked && hwApproved) {
    // シフト管理を使わない間：承認済みの休日出勤申請がある日の勤務を「休日出勤」とする（法定休日かどうかは判定しない）
    out.kind = '休日出勤';
    out.holidayWork = { kind: out.kind, minutes: workMinutes, approved: true };
  } else if (useShift && worked) {
    out.kind = '通常';
  }
  if (useShift && hwApproved && !isHolidayShift_(shiftType)) checks.push(DAY_CHECKS.HW_SHIFT_MISMATCH);

  if (leaveView) {
    const minutes = paidLeaveMinutesOf_(leaveView.leaveType, settings);
    out.leave = { type: leaveView.leaveType, minutes: minutes || 0, requestId: leaveView.requestId };
    if (useShift && shiftType !== SHIFT_TYPES.NORMAL) checks.push(DAY_CHECKS.LEAVE_SHIFT_MISMATCH);
    if (leaveView.leaveType === PAID_LEAVE_TYPES.FULL && worked) checks.push(DAY_CHECKS.FULL_LEAVE_WORK);
    const halfBad = (leaveView.leaveType === PAID_LEAVE_TYPES.AM && settings.amHalfStartMinutes === null) ||
      (leaveView.leaveType === PAID_LEAVE_TYPES.PM && settings.pmHalfEndMinutes === null);
    if (minutes === null || halfBad) checks.push(DAY_CHECKS.HALF_SETTING);
  }
  if (dctx.lateLeaveByKey[key]) checks.push(DAY_CHECKS.LATE_LEAVE);

  // 勤務場所（会社・在宅だけ。旧データの現場・外出は場所の表示に入れない）
  if (worked) {
    const cat = String(record['勤務形態区分'] || record['勤務形態'] || '');
    const office = cat.indexOf(WORK_STYLES.OFFICE) !== -1;
    const remote = cat.indexOf(WORK_STYLES.REMOTE) !== -1;
    out.place = office && remote ? '会社＋在宅' : remote ? '在宅' : office ? '会社' : '';
  }

  // バッジ：休日系・有給系・場所・要確認（色は 休日系／有給系／要確認 の3つだけ）
  if (out.kind === '通常') out.badges.push({ text: '通常', tone: 'normal' });
  if (out.kind === '休日出勤') out.badges.push({ text: '休出', tone: 'holiday' });
  if (out.kind === '法定休日出勤') out.badges.push({ text: '法休出', tone: 'holiday' });
  if (out.leave) out.badges.push({ text: out.leave.type === PAID_LEAVE_TYPES.FULL ? '有給' : out.leave.type === PAID_LEAVE_TYPES.AM ? '午前休' : '午後休', tone: 'leave' });
  if (out.place === '在宅' || out.place === '会社＋在宅') out.badges.push({ text: out.place, tone: 'normal' });
  if (checks.length) out.badges.push({ text: '要確認', tone: 'ng' });
  return out;
}
