/**
 * AdminService.gs
 * ------------------------------------------------------------
 * 管理者用の機能です。スタッフマスタの権限が「admin」の人だけが使えます。
 *
 *   requireAdmin()             … 管理者かどうかのチェック（管理者用の関数はすべて最初にこれを呼ぶ）
 *   getAllAttendance(from, to) … 全スタッフの勤怠（期間指定）
 *   getDailyAttendance(date)   … 日別表示（未出勤の人も含む）
 *   getMonthlyAttendance(month)… 月別表示（スタッフごとの合計つき。期間は締め日の設定による「◯月分」）
 *   getAttendanceDetail(id)    … 1日の勤務区間と中断（日別一覧で行を開いたとき）
 *   getPendingRequests()       … 承認待ちの申請の一覧
 *   checkWeeklyRestDays(date)  … 週1日の完全休日の確認（全スタッフ）
 *   exportAttendanceCsv(month) … CSV 出力（文字列で返す）
 *   recalculateThisMonth()     … 今月の勤怠記録を再計算（エディタから実行する場合だけ。画面からは使わない）
 *   previewAttendanceRecalculation(p) … 再計算のプレビュー（変わる記録だけ。書き込みなし）
 *   applyAttendanceRecalculation(p)   … プレビューで確認した記録だけを再計算
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

/**
 * 【管理者】勤怠1日分の勤務区間と中断（日別一覧で行を開いたときに使う）。
 * 勤務区間がない日（以前の記録）は、出勤〜退勤の1区間として返します（virtual: true）。
 */
function getAttendanceDetail(attendanceId) {
  return runApi_(function () {
    requireAdmin();
    const id = requireText_(attendanceId, '勤怠ID', { max: TEXT_LIMITS.SHORT });
    const record = findRecords_(SHEET_NAMES.ATTENDANCE, function (r) { return String(r['勤怠ID']).trim() === id; })[0];
    if (!record) fail_('勤怠記録が見つかりません（勤怠ID：' + id + '）');
    const timeline = buildAttendanceTimeline_(record);
    timeline.record = toAttendanceView_(record);
    timeline.detail = buildDayDetailForEmployee_(String(record['社員ID']).trim(), toDateKey_(record['日付']), record, getNowInfo_());
    timeline.day = buildDayStatus_(String(record['社員ID']).trim(), toDateKey_(record['日付']), record, buildDayStatusContext_());
    return { message: toDateKey_(record['日付']) + ' ' + toPlainText_(record['氏名']) + ' の勤務区間を取得しました', data: timeline };
  });
}

/**
 * 【管理者】社員1人・1日の詳細（勤務区間・中断・直行／直帰・現場・日備考・出張・自家用車の走行距離・交通費明細）。
 * 勤怠記録がない日（交通費だけの日）も見られる。
 */
function getAdminDayDetail(employeeId, date) {
  return runApi_(function () {
    requireAdmin();
    const id = requireText_(employeeId, '社員ID', { max: TEXT_LIMITS.SHORT });
    const dateKey = requireDateKey_(date, '日付');
    const staff = findStaffById_(id);
    if (!staff) fail_('社員ID「' + id + '」のスタッフが見つかりません');
    const record = findAttendance_(id, dateKey);
    const data = record ? buildAttendanceTimeline_(record) : { events: [], segments: [], breaks: [], currentStyle: '', segmentCount: 0, showSeconds: false };
    data.record = record ? toAttendanceView_(record) : null;
    data.detail = buildDayDetailForEmployee_(id, dateKey, record, getNowInfo_());
    data.day = buildDayStatus_(id, dateKey, record, buildDayStatusContext_()); // シフト・有給・休日出勤と要確認の理由
    return { message: dateKey + ' ' + staff.name + ' の詳細を取得しました', data: data };
  });
}

/** 【管理者】月別表示。スタッフごとの合計と、明細 */
function getMonthlyAttendance(month) {
  return runApi_(function () {
    requireAdmin();
    const settings = getSettings_();
    const range = isBlank_(month)
      ? getPayrollPeriodForDate_(getNowInfo_().date, settings.monthClosingDay)
      : getPayrollPeriodByMonthKey_(requireMonthKey_(month, '対象月'), settings.monthClosingDay);
    const monthKey = range.monthKey;
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
      message: range.periodText + ' の月別勤怠を取得しました',
      data: { month: monthKey, from: range.from, to: range.to, periodLabel: range.label, periodText: range.periodText,
        summaries: summaries, records: records.map(toAttendanceView_) },
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
    const range = isBlank_(month)
      ? getPayrollPeriodForDate_(getNowInfo_().date, settings.monthClosingDay)
      : getPayrollPeriodByMonthKey_(requireMonthKey_(month, '対象月'), settings.monthClosingDay);
    const monthKey = range.monthKey;
    // 以前からの列の順番のまま、新しい列（勤務形態区分など）はシートにある分だけ右端に足す
    const definition = getSheetDefinition_(SHEET_NAMES.ATTENDANCE);
    // 「現場外出時間」は新しい集計では使わないので出さない（列はシートに残す）
    const headers = definition.headers.concat((definition.optionalHeaders || []).filter(function (h) { return h !== '現場外出時間' && hasColumn_(SHEET_NAMES.ATTENDANCE, h); }));
    const lines = [headers.map(csvEscape_).join(',')];
    onlyAttendanceTargets_(getAttendanceInRange_(range.from, range.to)).forEach(function (r) {
      lines.push(headers.map(function (h) { return csvEscape_(h === '日付' ? toDateKey_(r[h]) : toPlainText_(r[h])); }).join(','));
    });
    return {
      message: range.periodText + ' の勤怠CSVを作成しました（' + (lines.length - 1) + '件）',
      data: { fileName: '勤怠記録_' + monthKey + '.csv', csv: '﻿' + lines.join('\r\n') },
    };
  });
}

/**
 * 【管理者・エディタから実行】今月の勤怠記録の計算列（確認なしで全件を書き直す）。
 * 管理者画面・スプレッドシートのメニューからは呼ばない（画面では previewAttendanceRecalculation → applyAttendanceRecalculation を使う）。
 * 以下、もとの説明：今月の勤怠記録の計算列（実働時間・社内超過時間・要確認など）を計算し直す。
 * スプレッドシート上で出勤・退勤や中断履歴、残業申請のステータスを直接直したときに使います。
 * 打刻の時刻そのもの（出勤・退勤）は変更しません。
 */
function recalculateThisMonth() {
  const result = runApi_(function () {
    return withLock_(function () {
      requireAdmin();
      return recalculateAttendanceInRange_(getPayrollPeriodForDate_(getNowInfo_().date));
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

  // 記録によって計算する列が違う（勤務区間がある日は出勤・退勤・勤務形態も）ので、すべての列をまとめて書く
  const columns = [];
  const segmentColumns = [];
  targets.forEach(function (record) {
    const detail = calculateAttendanceDetail_(record, ctx);
    Object.keys(detail.fields).forEach(function (k) { if (columns.indexOf(k) === -1) columns.push(k); });
    updateRecordInMemory_(SHEET_NAMES.ATTENDANCE, record, detail.fields);
    detail.segmentChanges.forEach(function (c) {
      Object.keys(c.changes).forEach(function (k) { if (segmentColumns.indexOf(k) === -1) segmentColumns.push(k); });
      updateRecordInMemory_(SHEET_NAMES.WORK_SEGMENTS, c.row, c.changes);
    });
  });
  writeColumnsInBulk_(SHEET_NAMES.ATTENDANCE, columns);
  if (segmentColumns.length) writeColumnsInBulk_(SHEET_NAMES.WORK_SEGMENTS, segmentColumns);
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

// ============================================================ 再計算のプレビュー・再計算・未再計算の判定

/**
 * 再計算で比べる列（勤怠記録の計算列）：列名 → 画面の名前・値の種類。
 * duration は時間の長さ（'' と 00:00 は同じとみなす）、clock は時刻、それ以外は文字。
 */
const RECALC_COLUMNS = {
  '自動休憩': { label: '自動休憩', type: 'duration' },
  '実働時間': { label: '実働', type: 'duration' },
  '中断合計': { label: '中断', type: 'duration' },
  '遅刻': { label: '遅刻', type: 'duration' },
  '早退': { label: '早退', type: 'duration' },
  '社内超過時間': { label: '社内超過', type: 'duration' },
  '出社時間': { label: '会社時間', type: 'duration' },
  '在宅時間': { label: '在宅時間', type: 'duration' },
  '出勤': { label: '出勤', type: 'clock' },
  '退勤': { label: '退勤', type: 'clock' },
  '所定終了': { label: '所定終了', type: 'clock' },
  '30分以上': { label: '30分以上の社内超過' },
  '事前残業申請': { label: '事前残業申請' },
  '要確認': { label: '要確認（残業）' },
};
/** プレビュー・期間の上限（日数） */
const RECALC_MAX_DAYS = 93;

/** 比べるための値（列の種類ごとにそろえる） */
function normalizeRecalcValue_(column, value) {
  const type = (RECALC_COLUMNS[column] || {}).type;
  if (type === 'duration') {
    const m = toMinutes_(value);
    return m ? formatMinutes_(m) : '';
  }
  if (type === 'clock') {
    const m = toMinutes_(value);
    return m === null ? '' : minutesToClock_(m);
  }
  return toPlainText_(value).trim();
}

/** 画面に出す値（時間の長さの空欄は 00:00、文字の空欄は —） */
function displayRecalcValue_(column, normalized) {
  if (normalized) return normalized;
  return (RECALC_COLUMNS[column] || {}).type === 'duration' ? '00:00' : '—';
}

/** 文字列の短い指紋（プレビューのあとで記録・設定が変わっていないかの確認用） */
function recalcFingerprint_(text) {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = (h1 * 33) ^ c;
    h2 = (h2 * 33) ^ c;
    h1 |= 0;
    h2 |= 0;
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + ':' + text.length;
}

/**
 * 勤怠記録1件を今の記録・設定で計算した結果と、保存されている値の違い（書き込みはしない）。
 * 戻り値：{ detail（calculateAttendanceDetail_ の結果）, changes: [{ column, label, before, after }], segmentChangeCount, fingerprint }
 */
function diffRecalculation_(record, calcCtx) {
  const detail = calculateAttendanceDetail_(record, calcCtx);
  const changes = [];
  const parts = [];
  Object.keys(detail.fields).forEach(function (column) {
    const before = normalizeRecalcValue_(column, record[column]);
    const after = normalizeRecalcValue_(column, detail.fields[column]);
    parts.push(column + '=' + before + '>' + after);
    if (before === after) return;
    changes.push({ column: column, label: (RECALC_COLUMNS[column] || {}).label || column,
      before: displayRecalcValue_(column, before), after: displayRecalcValue_(column, after) });
  });
  detail.segmentChanges.forEach(function (c) {
    Object.keys(c.changes).forEach(function (k) { parts.push(toPlainText_(c.row['勤務区間ID']) + '.' + k + '=' + toPlainText_(c.row[k]) + '>' + toPlainText_(c.changes[k])); });
  });
  return {
    detail: detail, changes: changes, segmentChangeCount: detail.segmentChanges.length,
    fingerprint: recalcFingerprint_(String(record['勤怠ID']).trim() + '|' + parts.join('|')),
  };
}

/** 変わる理由（列の組み合わせから。自動休憩は今の設定と、中断を除いた勤務時間を示す） */
function recalcReasons_(record, diff, settings) {
  const cols = diff.changes.map(function (c) { return c.column; });
  const has = function (list) { return list.some(function (c) { return cols.indexOf(c) !== -1; }); };
  const reasons = [];
  if (has(['自動休憩'])) {
    const date = toDateKey_(record['日付']);
    const threshold = autoBreakThresholdFor_(settings, date);
    const work = (toMinutes_(diff.detail.fields['実働時間']) || 0) + (toMinutes_(diff.detail.fields['自動休憩']) || 0);
    const rule = settings.autoBreakThresholdFrom && date < settings.autoBreakThresholdFrom
      ? '「自動休憩_適用開始_有効日」（' + settings.autoBreakThresholdFrom.replace(/-/g, '/') + '）より前の日なので適用開始 00:00'
      : '自動休憩_適用開始 ' + formatMinutes_(threshold);
    reasons.push('自動休憩の設定（' + rule + '）：中断を除いた勤務 ' + formatMinutes_(work) +
      (work > threshold ? ' は超えるため自動休憩 ' + formatMinutes_(settings.autoBreakMinutes) : ' はそれ以下のため自動休憩なし'));
  }
  if (has(['実働時間']) && !has(['自動休憩'])) reasons.push('勤務区間・中断の記録から実働を計算し直し');
  if (has(['中断合計'])) reasons.push('中断履歴の合計が保存値と違う');
  if (has(['出勤', '退勤', '勤務形態', '勤務形態区分', '勤務区間数', '直行', '直帰', '出社時間', '在宅時間']) || diff.segmentChangeCount) {
    reasons.push('勤務区間の記録と保存値が違う（シートの直接修正など）');
  }
  if (has(['遅刻', '早退', '社内超過時間', '所定終了'])) reasons.push('固定勤務の標準時刻と、有給・休日出勤の申請の今の状態で判定し直し');
  if (has(['30分以上', '事前残業申請', '要確認'])) reasons.push('残業申請の今の状態で判定し直し');
  if (has(['勤務区分'])) reasons.push('スタッフマスタの勤務区分に合わせる');
  if (has(['状態'])) reasons.push('勤務の状態を記録に合わせる');
  if (!reasons.length) reasons.push('今の記録と設定で計算し直した結果');
  return reasons;
}

/**
 * 保存されている値が、今の記録・設定で計算した結果と違うか（退勤済みの記録だけ判定する。書き込みはしない）。
 * 画面の値は保存値のまま表示し、違うときだけ「設定変更後に未再計算」の印を付けるために使う。
 * 戻り値：違いがなければ null、あれば { text: '自動休憩 01:00→00:00・実働 02:21→03:21', changes }
 */
function recalcStaleOf_(record, calcCtx) {
  if (!record || !calcCtx || String(record['状態']).trim() !== ATTENDANCE_STATUS.FINISHED) return null;
  const diff = diffRecalculation_(record, calcCtx);
  if (!diff.changes.length && !diff.segmentChangeCount) return null;
  const text = diff.changes.map(function (c) { return c.label + ' ' + c.before + '→' + c.after; }).join('・') || '勤務区間の記録';
  return { text: text, changes: diff.changes };
}

/** 再計算の条件：{ from, to, employeeId? }（期間は RECALC_MAX_DAYS 日まで） */
function parseRecalcQuery_(params) {
  const p = params || {};
  const from = requireDateKey_(p.from, '開始日');
  const to = requireDateKey_(p.to, '終了日');
  if (from > to) fail_('開始日は終了日より前の日にしてください');
  if (listDates_(from, to).length > RECALC_MAX_DAYS) fail_('期間は ' + RECALC_MAX_DAYS + '日以内にしてください');
  const employeeId = isBlank_(p.employeeId) ? '' : requireText_(p.employeeId, '社員ID', { max: TEXT_LIMITS.SHORT });
  let staff = null;
  if (employeeId) {
    staff = findStaffById_(employeeId);
    if (!staff) fail_('社員ID「' + employeeId + '」のスタッフが見つかりません');
  }
  return { from: from, to: to, employeeId: employeeId, staff: staff };
}

function recalcTargets_(q) {
  return getAttendanceInRange_(q.from, q.to).filter(function (r) { return !q.employeeId || String(r['社員ID']).trim() === q.employeeId; });
}

/**
 * 【管理者】再計算のプレビュー：期間（と社員）の勤怠記録を今の記録・設定で計算し、保存値から変わる記録だけを返す。
 * シートには書き込まない。再計算は applyAttendanceRecalculation で、管理者がプレビューを確認してから実行する。
 * @param {{from: string, to: string, employeeId?: string}} params
 */
function previewAttendanceRecalculation(params) {
  return runApi_(function () {
    requireAdmin();
    const q = parseRecalcQuery_(params);
    const calcCtx = buildCalcContext_();
    const settings = calcCtx.settings;
    const targets = recalcTargets_(q);
    const rows = [];
    targets.forEach(function (record) {
      const diff = diffRecalculation_(record, calcCtx);
      if (!diff.changes.length && !diff.segmentChangeCount) return;
      const employeeId = String(record['社員ID']).trim();
      const staff = calcCtx.staffById[employeeId];
      const pick = function (column) {
        const c = diff.changes.filter(function (x) { return x.column === column; })[0];
        const v = displayRecalcValue_(column, normalizeRecalcValue_(column, record[column]));
        return c ? { before: c.before, after: c.after, changed: true } : { before: v, after: v, changed: false };
      };
      rows.push({
        attendanceId: String(record['勤怠ID']).trim(),
        employeeId: employeeId,
        name: staff ? staff.name : toPlainText_(record['氏名']),
        date: toDateKey_(record['日付']),
        weekday: WEEKDAY_LABELS[weekdayOf_(toDateKey_(record['日付']))],
        autoBreak: pick('自動休憩'),
        workTime: pick('実働時間'),
        others: diff.changes.filter(function (c) { return c.column !== '自動休憩' && c.column !== '実働時間'; })
          .map(function (c) { return { label: c.label, before: c.before, after: c.after }; })
          .concat(diff.segmentChangeCount ? [{ label: '勤務区間の記録', before: '—', after: diff.segmentChangeCount + '区間を更新' }] : []),
        reasons: recalcReasons_(record, diff, settings),
        fingerprint: diff.fingerprint,
      });
    });
    const notes = [
      '自動休憩：休憩 ' + formatMinutes_(settings.autoBreakMinutes) + '、適用開始 ' + formatMinutes_(settings.autoBreakThresholdMinutes) +
        (settings.autoBreakThresholdFrom ? '（' + settings.autoBreakThresholdFrom.replace(/-/g, '/') + ' 以降の勤務日。それより前の日は 00:00）' : '（すべての日）'),
    ];
    if (settings.autoBreakThresholdFromInvalid) notes.push('設定「' + SETTING_KEYS.AUTO_BREAK_THRESHOLD_FROM + '」が日付ではないため、空欄として扱っています');
    return {
      message: q.from + '〜' + q.to + (q.staff ? '（' + q.staff.name + '）' : '') + '：勤怠記録 ' + targets.length + '件のうち、再計算で変わる記録は ' + rows.length + '件です',
      data: { from: q.from, to: q.to, employeeId: q.employeeId, employeeName: q.staff ? q.staff.name : '', targetCount: targets.length, changedCount: rows.length, rows: rows, notes: notes },
    };
  });
}

/**
 * 【管理者】プレビューで確認した記録だけを再計算して書き込む。
 * プレビューのあとで記録・設定が変わっていた（指紋が違う）ときは、何も書き込まずに止める（もう一度プレビューしてもらう）。
 * @param {{from: string, to: string, employeeId?: string, items: Array<{attendanceId: string, fingerprint: string}>}} params
 */
function applyAttendanceRecalculation(params) {
  return runApi_(function () {
    return withLock_(function () {
      requireAdmin();
      const q = parseRecalcQuery_(params);
      const items = (params && params.items) || [];
      if (!Array.isArray(items) || !items.length) fail_('再計算する記録がありません（先にプレビューしてください）');
      if (items.length > 5000) fail_('一度に再計算できるのは5000件までです');
      const calcCtx = buildCalcContext_();
      const byId = {};
      recalcTargets_(q).forEach(function (r) { byId[String(r['勤怠ID']).trim()] = r; });
      const planned = [];
      const stale = [];
      items.forEach(function (item) {
        const id = String(item && item.attendanceId || '').trim();
        const record = byId[id];
        if (!record) { stale.push(id); return; }
        const diff = diffRecalculation_(record, calcCtx);
        if (diff.fingerprint !== String(item.fingerprint || '')) { stale.push(id); return; }
        planned.push({ record: record, diff: diff });
      });
      if (stale.length) {
        fail_('プレビューのあとで勤怠記録・設定が変わったため、再計算していません（' + stale.length + '件）。もう一度プレビューしてから実行してください');
      }
      const columns = [];
      const segmentColumns = [];
      planned.forEach(function (p) {
        Object.keys(p.diff.detail.fields).forEach(function (k) { if (columns.indexOf(k) === -1) columns.push(k); });
        updateRecordInMemory_(SHEET_NAMES.ATTENDANCE, p.record, p.diff.detail.fields);
        p.diff.detail.segmentChanges.forEach(function (c) {
          Object.keys(c.changes).forEach(function (k) { if (segmentColumns.indexOf(k) === -1) segmentColumns.push(k); });
          updateRecordInMemory_(SHEET_NAMES.WORK_SEGMENTS, c.row, c.changes);
        });
      });
      if (columns.length) writeColumnsInBulk_(SHEET_NAMES.ATTENDANCE, columns);
      if (segmentColumns.length) writeColumnsInBulk_(SHEET_NAMES.WORK_SEGMENTS, segmentColumns);
      return { message: '確認した勤怠記録 ' + planned.length + '件を再計算しました', data: { count: planned.length } };
    });
  });
}
