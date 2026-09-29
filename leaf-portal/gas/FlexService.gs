/**
 * FlexService.gs
 * ------------------------------------------------------------
 * フレックス勤務の集計と、「週1日の完全休日」の確認です。
 *
 *   残り時間 = 所定時間 − 実働時間（マイナスにはせず 00:00 とする）
 *   超過時間 = 実働時間 − 所定時間（マイナスにはせず 00:00 とする）
 *
 * 実働時間は「退勤済み」の勤怠記録だけを合計します（勤務中の今日の分は含みません）。
 *
 * 完全休日 = 出勤の記録がない日。
 * 日付をまたいで働いた場合（例：22:00〜翌1:00）は、翌日も完全休日にはなりません。
 */

/**
 * 【画面から呼ぶ】フレックスの今週・今月の集計。
 * @param {string} [employeeId] 省略すると自分。他のスタッフの分は管理者だけが見られます。
 */
function getFlexSummary(employeeId) {
  return runApi_(function () {
    const me = getCurrentStaff_();
    let target = me;
    if (!isBlank_(employeeId) && String(employeeId).trim() !== me.employeeId) {
      if (me.role !== ROLES.ADMIN) fail_('他のスタッフの集計は管理者のみ確認できます');
      target = findStaffById_(employeeId);
      if (!target) fail_('社員ID「' + employeeId + '」のスタッフが見つかりません');
    }
    if (target.workType !== WORK_TYPES.FLEX) fail_(target.name + 'さんはフレックス勤務ではありません（勤務区分：' + target.workType + '）');

    const settings = getSettings_();
    const rule = getWorkRule_(target, settings);
    const today = getNowInfo_().date;
    const week = getWeekRange_(today, settings.weekStartDay);
    const monthKey = getMonthKeyForDate_(today, settings.monthClosingDay);
    const month = getMonthRange_(monthKey, settings.monthClosingDay);
    const records = getAttendanceOfEmployee_(target.employeeId);

    const weekSummary = summarizeFlexPeriod_(records, week.from, week.to, rule.weeklyMinutes);
    weekSummary.restDayCheck = checkWeeklyRest_(records, week.from, today, settings.weeklyFullRestDays);
    const monthSummary = summarizeFlexPeriod_(records, month.from, month.to, rule.monthlyMinutes);
    monthSummary.month = monthKey;

    const todayRecord = records.filter(function (r) { return toDateKey_(r['日付']) === today; })[0];
    return {
      message: target.name + 'さんのフレックス集計を取得しました',
      data: {
        employeeId: target.employeeId,
        name: target.name,
        today: today,
        todayInProgress: !!todayRecord && isOpenStatus_(String(todayRecord['状態'])),
        week: weekSummary,
        month: monthSummary,
      },
    };
  });
}

/** 社員の勤怠記録（全期間） */
function getAttendanceOfEmployee_(employeeId) {
  return findRecords_(SHEET_NAMES.ATTENDANCE, function (r) { return String(r['社員ID']).trim() === employeeId; });
}

/** 期間内の実働を合計し、所定・残り・超過を計算する */
function summarizeFlexPeriod_(records, from, to, scheduledMinutes) {
  let worked = 0;
  let workDays = 0;
  records.forEach(function (r) {
    const date = toDateKey_(r['日付']);
    if (date < from || date > to || String(r['状態']) !== ATTENDANCE_STATUS.FINISHED) return;
    worked += toMinutes_(r['実働時間']) || 0;
    workDays += 1;
  });
  const result = calculateFlexBalance_(scheduledMinutes, worked);
  return {
    from: from,
    to: to,
    workDays: workDays,
    scheduled: formatMinutes_(result.scheduledMinutes),
    worked: formatMinutes_(result.workedMinutes),
    remaining: formatMinutes_(result.remainingMinutes),
    excess: formatMinutes_(result.excessMinutes),
    scheduledMinutes: result.scheduledMinutes,
    workedMinutes: result.workedMinutes,
    remainingMinutes: result.remainingMinutes,
    excessMinutes: result.excessMinutes,
  };
}

/**
 * 所定時間と実働時間から、残り時間と超過時間を計算する（純粋な計算）。
 * 例：所定 138:00・実働 103:15 → 残り 34:45・超過 00:00
 *     所定 138:00・実働 142:20 → 残り 00:00・超過 04:20
 */
function calculateFlexBalance_(scheduledMinutes, workedMinutes) {
  const scheduled = scheduledMinutes || 0;
  return {
    scheduledMinutes: scheduled,
    workedMinutes: workedMinutes,
    remainingMinutes: Math.max(0, scheduled - workedMinutes),
    excessMinutes: Math.max(0, workedMinutes - scheduled),
  };
}

/**
 * 週の完全休日を確認する。
 * @param {object[]} records  その社員の勤怠記録
 * @param {string}   weekFrom 週の初日
 * @param {string}   today    今日（今日以降はまだ休日になる可能性がある日として扱う）
 * @param {number}   required 必要な完全休日の日数
 * 戻り値：{ status: '確保済み' | '未確定' | '不足', confirmedRestDays, possibleRestDays, required, restDates, message }
 */
function checkWeeklyRest_(records, weekFrom, today, required) {
  const weekTo = addDays_(weekFrom, 6);
  const workedDates = {};
  records.forEach(function (r) {
    const date = toDateKey_(r['日付']);
    if (!date || isBlank_(r['出勤'])) return;
    workedDates[date] = true;
    // 日付をまたいだ勤務なら、翌日も休日ではない
    const inMin = toMinutes_(r['出勤']);
    const outMin = toMinutes_(r['退勤']);
    if (inMin !== null && outMin !== null && outMin < inMin) workedDates[addDays_(date, 1)] = true;
  });

  const restDates = [];
  let confirmed = 0;
  let possible = 0;
  listDates_(weekFrom, weekTo).forEach(function (date) {
    if (workedDates[date]) return;
    if (date < today) {
      confirmed += 1;
      restDates.push(date);
    } else {
      possible += 1;
    }
  });

  let status;
  let message;
  if (confirmed >= required) {
    status = '確保済み';
    message = 'この週の完全休日は確保できています（' + confirmed + '日）';
  } else if (confirmed + possible >= required) {
    status = '未確定';
    message = 'この週はあと ' + (required - confirmed) + ' 日の完全休日が必要です（' + today + '〜' + weekTo + ' のうちに）';
  } else {
    status = '不足';
    message = 'この週の完全休日が不足しています（必要 ' + required + '日／確保 ' + confirmed + '日）';
  }
  return {
    weekFrom: weekFrom,
    weekTo: weekTo,
    required: required,
    confirmedRestDays: confirmed,
    possibleRestDays: possible,
    restDates: restDates,
    status: status,
    message: message,
  };
}
