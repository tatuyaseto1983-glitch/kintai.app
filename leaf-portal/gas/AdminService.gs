/**
 * AdminService.gs
 * ------------------------------------------------------------
 * 管理者用の機能です。スタッフマスタの権限が「admin」の人だけが使えます。
 *
 *   requireAdmin()             … 管理者かどうかのチェック（管理者用の関数はすべて最初にこれを呼ぶ）
 *   getAllAttendance(from, to) … 全スタッフの勤怠（期間指定）
 *   getDailyAttendance(date)   … 日別表示（未出勤の人も含む）
 *   getMonthlyAttendance(month)… 月別表示（スタッフごとの合計つき）
 *   getPendingRequests()       … 承認待ちの申請の一覧
 *   checkWeeklyRestDays(date)  … 週1日の完全休日の確認（全スタッフ）
 *   exportAttendanceCsv(month) … CSV 出力（文字列で返す）
 *   recalculateThisMonth()     … 今月の勤怠記録を再計算（シートを直接直した後などに）
 *
 * 申請の承認・却下は OvertimeService.gs / CorrectionService.gs、日報の確認は DailyReportService.gs にあります。
 */

/**
 * 管理者かどうかを確認する。管理者でなければエラーにする。
 * 戻り値：ログイン中の管理者のスタッフ情報
 */
function requireAdmin() {
  const staff = getCurrentStaff_();
  if (staff.role !== ROLES.ADMIN) fail_('管理者権限がありません（この操作は管理者のみ実行できます）');
  return staff;
}

/** 【管理者】全スタッフの勤怠（from〜to、日付・社員ID順） */
function getAllAttendance(fromDate, toDate) {
  return runApi_(function () {
    requireAdmin();
    const from = requireDateKey_(fromDate, '開始日');
    const to = requireDateKey_(toDate, '終了日');
    if (from > to) fail_('開始日は終了日より前にしてください');
    const records = onlyAttendanceTargets_(getAttendanceInRange_(from, to)).map(toAttendanceView_);
    return { message: from + '〜' + to + ' の勤怠を取得しました（' + records.length + '件）', data: { from: from, to: to, records: records } };
  });
}

/** 【管理者】日別表示。在籍スタッフ全員分（出勤していない人は「未出勤」） */
function getDailyAttendance(date) {
  return runApi_(function () {
    requireAdmin();
    const dateKey = isBlank_(date) ? getNowInfo_().date : requireDateKey_(date, '日付');
    const rows = getAllStaff_()
      .filter(isAttendanceTarget_)
      .map(function (s) {
        const record = findAttendance_(s.employeeId, dateKey);
        if (record) return toAttendanceView_(record);
        return { date: dateKey, employeeId: s.employeeId, name: s.name, workType: s.workType, status: ATTENDANCE_STATUS.NOT_STARTED };
      });
    return { message: dateKey + ' の勤怠を取得しました', data: { date: dateKey, records: rows } };
  });
}

/** 【管理者】月別表示。スタッフごとの合計と、明細 */
function getMonthlyAttendance(month) {
  return runApi_(function () {
    requireAdmin();
    const settings = getSettings_();
    const monthKey = isBlank_(month) ? getMonthKeyForDate_(getNowInfo_().date, settings.monthClosingDay) : requireMonthKey_(month, '対象月');
    const range = getMonthRange_(monthKey, settings.monthClosingDay);
    const records = onlyAttendanceTargets_(getAttendanceInRange_(range.from, range.to));

    const summaries = getAllStaff_()
      .filter(function (s) { return s.status !== EMPLOYMENT_STATUS.RETIRED && s.attendanceTarget !== false; })
      .map(function (s) {
        const mine = records.filter(function (r) { return String(r['社員ID']).trim() === s.employeeId; });
        const sum = function (column) { return mine.reduce(function (t, r) { return t + (toMinutes_(r[column]) || 0); }, 0); };
        const worked = sum('実働時間');
        const summary = {
          employeeId: s.employeeId,
          name: s.name,
          workType: s.workType,
          workDays: mine.length,
          workTime: formatMinutes_(worked),
          breakTotal: formatMinutes_(sum('中断合計')),
          internalExcess: formatMinutes_(sum('社内超過時間')),
          lateCount: mine.filter(function (r) { return !isBlank_(r['遅刻']); }).length,
          needsCheckCount: mine.filter(function (r) { return r['要確認'] === MARKS.NEEDS_CHECK; }).length,
          notClockedOutCount: mine.filter(function (r) { return isOpenStatus_(String(r['状態'])); }).length,
        };
        if (s.workType === WORK_TYPES.FLEX) {
          const balance = calculateFlexBalance_(getWorkRule_(s, settings).monthlyMinutes, worked);
          summary.flexScheduled = formatMinutes_(balance.scheduledMinutes);
          summary.flexRemaining = formatMinutes_(balance.remainingMinutes);
          summary.flexExcess = formatMinutes_(balance.excessMinutes);
        }
        return summary;
      });

    return {
      message: monthKey + ' の月別勤怠を取得しました',
      data: { month: monthKey, from: range.from, to: range.to, summaries: summaries, records: records.map(toAttendanceView_) },
    };
  });
}

/** 【管理者】承認待ちの申請（打刻修正・残業） */
function getPendingRequests() {
  return runApi_(function () {
    requireAdmin();
    const isPending = function (r) { return r['ステータス'] === REQUEST_STATUS.PENDING; };
    const corrections = findRecords_(SHEET_NAMES.CORRECTIONS, isPending).map(toCorrectionView_);
    const overtime = findRecords_(SHEET_NAMES.OVERTIME, isPending).map(toOvertimeView_);
    return {
      message: '承認待ち：打刻修正 ' + corrections.length + '件、残業 ' + overtime.length + '件',
      data: { corrections: corrections, overtime: overtime },
    };
  });
}

/** 【管理者】指定日を含む週の、全スタッフの完全休日の確認 */
function checkWeeklyRestDays(date) {
  return runApi_(function () {
    requireAdmin();
    const settings = getSettings_();
    const today = getNowInfo_().date;
    const dateKey = isBlank_(date) ? today : requireDateKey_(date, '日付');
    const week = getWeekRange_(dateKey, settings.weekStartDay);
    // 過去の週なら週の全日が確定済み。今週なら今日以降は「まだ休める日」として扱う
    const judgeDate = week.to < today ? addDays_(week.to, 1) : today;
    const results = getAllStaff_()
      .filter(isAttendanceTarget_)
      .map(function (s) {
        const check = checkWeeklyRest_(getAttendanceOfEmployee_(s.employeeId), week.from, judgeDate, settings.weeklyFullRestDays);
        return { employeeId: s.employeeId, name: s.name, workType: s.workType, status: check.status, restDays: check.confirmedRestDays, message: check.message };
      });
    const shortCount = results.filter(function (r) { return r.status === '不足'; }).length;
    return {
      message: week.from + '〜' + week.to + ' の完全休日を確認しました（不足 ' + shortCount + '名）',
      data: { from: week.from, to: week.to, required: settings.weeklyFullRestDays, staff: results },
    };
  });
}

/**
 * 【管理者】勤怠記録を CSV にする。
 * 戻り値の data.csv を画面側でファイルとして保存します（Excel で文字化けしないよう先頭に BOM を付けています）。
 */
function exportAttendanceCsv(month) {
  return runApi_(function () {
    requireAdmin();
    const settings = getSettings_();
    const monthKey = isBlank_(month) ? getMonthKeyForDate_(getNowInfo_().date, settings.monthClosingDay) : requireMonthKey_(month, '対象月');
    const range = getMonthRange_(monthKey, settings.monthClosingDay);
    const headers = getSheetDefinition_(SHEET_NAMES.ATTENDANCE).headers;
    const lines = [headers.map(csvEscape_).join(',')];
    onlyAttendanceTargets_(getAttendanceInRange_(range.from, range.to)).forEach(function (r) {
      lines.push(headers.map(function (h) { return csvEscape_(h === '日付' ? toDateKey_(r[h]) : toPlainText_(r[h])); }).join(','));
    });
    return {
      message: monthKey + ' の勤怠CSVを作成しました（' + (lines.length - 1) + '件）',
      data: { fileName: '勤怠記録_' + monthKey + '.csv', csv: '﻿' + lines.join('\r\n') },
    };
  });
}

/**
 * 【管理者・エディタから実行可】今月の勤怠記録の計算列（実働時間・社内超過時間・要確認など）を計算し直す。
 * スプレッドシート上で出勤・退勤や中断履歴、残業申請のステータスを直接直したときに使います。
 * 打刻の時刻そのもの（出勤・退勤）は変更しません。
 */
function recalculateThisMonth() {
  const result = runApi_(function () {
    return withLock_(function () {
      requireAdmin();
      const settings = getSettings_();
      const monthKey = getMonthKeyForDate_(getNowInfo_().date, settings.monthClosingDay);
      return recalculateAttendanceInRange_(getMonthRange_(monthKey, settings.monthClosingDay));
    });
  });
  console.log(result.message);
  showToast_(result.message, '勤怠システム');
  return result;
}

/** 期間内の勤怠記録をまとめて再計算し、計算列だけを一括で書き込む */
function recalculateAttendanceInRange_(range) {
  const ctx = buildCalcContext_();
  const targets = getAttendanceInRange_(range.from, range.to);
  if (!targets.length) return { message: range.from + '〜' + range.to + ' の勤怠記録はありません', data: { count: 0 } };

  let columns = [];
  targets.forEach(function (record) {
    const fields = calculateAttendanceFields_(record, ctx);
    columns = Object.keys(fields);
    updateRecordInMemory_(SHEET_NAMES.ATTENDANCE, record, fields);
  });
  writeColumnsInBulk_(SHEET_NAMES.ATTENDANCE, columns);
  return { message: range.from + '〜' + range.to + ' の勤怠記録 ' + targets.length + '件を再計算しました', data: { count: targets.length } };
}

/** 期間内の勤怠記録（日付・社員ID順） */
function getAttendanceInRange_(from, to) {
  return findRecords_(SHEET_NAMES.ATTENDANCE, function (r) {
    const date = toDateKey_(r['日付']);
    return date >= from && date <= to;
  }).sort(function (a, b) {
    const da = toDateKey_(a['日付']);
    const db = toDateKey_(b['日付']);
    if (da !== db) return da < db ? -1 : 1;
    return String(a['社員ID']) < String(b['社員ID']) ? -1 : 1;
  });
}

/**
 * 勤怠記録のうち、勤怠集計の対象の人の分だけを残す（スタッフマスタで「勤怠集計対象＝対象外」の人を除く）。
 * スタッフマスタにいない人の記録は、これまでどおり残す。
 */
function onlyAttendanceTargets_(records) {
  const excluded = {};
  getAllStaff_().forEach(function (s) { if (s.attendanceTarget === false) excluded[s.employeeId] = true; });
  return records.filter(function (r) { return !excluded[String(r['社員ID']).trim()]; });
}

function csvEscape_(value) {
  const text = String(value === null || value === undefined ? '' : value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
