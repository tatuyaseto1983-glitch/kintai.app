/**
 * DailyReportShareService.gs
 * ------------------------------------------------------------
 * 提出済みの日報の一覧・閲覧・「確認しました」・コメントです。
 *
 * 【見られる人】
 *   提出済み … ログインできる全社員（役員も含む）
 *   下書き   … 本人だけ（管理者・役員にも返さない。本人以外には「見つかりません」と同じ扱い）
 *
 * 【確認の対象（分母）】
 *   在籍中の全社員から、提出者本人を除いた人。役員（勤怠集計の対象外）も含む。
 *   ※全スタッフ勤務状況の対象（isAttendanceTarget_）とは別のルールです
 *
 * 【確認済みかどうか】
 *   「日報_確認」に、今の日報バージョンでの確認の行があるかで決める。
 *   提出後に修正されるとバージョンが上がるので、全員が自動的に「未確認」に戻る（過去の確認の行は残る）。
 */

// ============================================================ 画面から呼ぶ関数

/**
 * 【画面から呼ぶ】日報の一覧。
 * @param {object} [params] { month: '2026-10' }（省略すると今月）
 * 戻り値：提出済みの全員分 ＋ 自分の下書き
 */
function getReportList(params) {
  return runApi_(function () {
    requireReportSchema_();
    const viewer = getCurrentStaff_();
    const p = params || {};
    const range = isBlank_(p.month)
      ? getReportMonthPeriodForDate_(getNowInfo_().date) // 日報は暦月（締め日の設定は使わない）
      : getReportMonthPeriod_(requireMonthKey_(p.month, '対象月'));
    const monthKey = range.monthKey;
    const ctx = buildReportShareContext_();

    const visible = readTable_(SHEET_NAMES.DAILY_REPORTS).records.filter(function (r) {
      const date = toDateKey_(r['日付']);
      return date >= range.from && date <= range.to && canViewReport_(r, viewer);
    });
    const items = visible.map(function (r) { return toReportListItem_(r, viewer, ctx); })
      .sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return (a.submittedAt || a.updatedAt) < (b.submittedAt || b.updatedAt) ? 1 : -1;
      });
    return {
      message: '日報の一覧を取得しました',
      data: {
        month: monthKey, from: range.from, to: range.to, periodLabel: range.label, periodText: range.periodText, today: getNowInfo_().date,
        reports: items.filter(function (x) { return x.status === REPORT_STATE.SUBMITTED; }),
        myDrafts: items.filter(function (x) { return x.status === REPORT_STATE.DRAFT; }),
      },
    };
  });
}

/**
 * 【画面から呼ぶ】日報1件の詳細（接客記録・確認状況・コメント・履歴）。
 * 他の社員の下書きは「見つかりません」と返す（下書きがあることも知らせない）。
 */
function getReportDetail(reportId) {
  return runApi_(function () {
    requireReportSchema_();
    const viewer = getCurrentStaff_();
    const record = findReportById_(reportId);
    if (!record || !canViewReport_(record, viewer)) fail_('日報が見つかりません');
    const ctx = buildReportShareContext_();
    return { message: '日報を取得しました', data: buildReportDetail_(record, viewer, ctx) };
  });
}

/** 【画面から呼ぶ】「確認しました」（今のバージョンを確認したことを記録する） */
function confirmReport(reportId) {
  return runApi_(function () {
    return withLock_(function () {
      requireReportSchema_();
      const viewer = getCurrentStaff_();
      const record = findReportById_(reportId);
      if (!record || !canViewReport_(record, viewer)) fail_('日報が見つかりません');
      if (reportStateOf_(record) !== REPORT_STATE.SUBMITTED) fail_('提出済みの日報だけ確認できます');
      if (isLegacySubmittedReport_(record)) fail_('以前の仕組みで提出された日報は、確認の対象外です');
      if (String(record['社員ID']).trim() === viewer.employeeId) fail_('自分の日報は確認の対象外です');
      if (!isReportMember_(viewer)) fail_('在籍中の社員だけが確認できます');
      const version = reportVersionOf_(record);
      const id = String(record['日報ID']).trim();
      const already = findRecords_(SHEET_NAMES.REPORT_CONFIRMATIONS, function (c) {
        return String(c['日報ID']).trim() === id && String(c['社員ID']).trim() === viewer.employeeId && Number(c['日報バージョン']) === version;
      })[0];
      if (already) fail_('この日報（最新版）はすでに確認済みです');
      const now = getNowInfo_();
      appendRecord_(SHEET_NAMES.REPORT_CONFIRMATIONS, {
        '確認ID': makeUniqueId_(SHEET_NAMES.REPORT_CONFIRMATIONS, '確認ID', 'RC-' + compactTimestamp_() + '-' + viewer.employeeId),
        '日報ID': id,
        '日報バージョン': version,
        '社員ID': viewer.employeeId,
        '確認者名': viewer.name,
        '確認日時': now.timestamp,
      });
      return { message: '「確認しました」を記録しました', data: buildReportDetail_(record, viewer, buildReportShareContext_()) };
    });
  });
}

/** 【画面から呼ぶ】コメントを投稿する（任意。確認とは別） */
function addReportComment(reportId, text) {
  return runApi_(function () {
    return withLock_(function () {
      requireReportSchema_();
      const viewer = getCurrentStaff_();
      const record = findReportById_(reportId);
      if (!record || !canViewReport_(record, viewer)) fail_('日報が見つかりません');
      if (reportStateOf_(record) !== REPORT_STATE.SUBMITTED) fail_('提出済みの日報にだけコメントできます');
      if (isLegacySubmittedReport_(record)) fail_('以前の仕組みで提出された日報には、コメントできません');
      if (!isReportMember_(viewer)) fail_('在籍中の社員だけがコメントできます');
      const body = requireText_(text, 'コメント', { max: TEXT_LIMITS.LONG });
      const now = getNowInfo_();
      appendRecord_(SHEET_NAMES.REPORT_COMMENTS, {
        'コメントID': makeUniqueId_(SHEET_NAMES.REPORT_COMMENTS, 'コメントID', 'CM-' + compactTimestamp_() + '-' + viewer.employeeId),
        '日報ID': String(record['日報ID']).trim(),
        '社員ID': viewer.employeeId,
        '社員名': viewer.name,
        'コメント': body,
        '投稿日時': now.timestamp,
      });
      return { message: 'コメントを投稿しました', data: buildReportDetail_(record, viewer, buildReportShareContext_()) };
    });
  });
}

// ============================================================ 権限

/** 日報を見てよいか：提出済みなら全社員、下書きは本人だけ、旧日報は本人と管理者だけ */
function canViewReport_(record, viewer) {
  const isOwner = String(record['社員ID']).trim() === viewer.employeeId;
  if (reportStateOf_(record) !== REPORT_STATE.SUBMITTED) return isOwner;
  if (isLegacySubmittedReport_(record)) return isOwner || viewer.role === ROLES.ADMIN;
  return true;
}

/** 日報の確認・コメントができ、確認の対象（分母）になる人：在籍中の社員（役員も含む） */
function isReportMember_(staff) {
  return staff.status === EMPLOYMENT_STATUS.ACTIVE;
}

// ============================================================ 集計

/** 一覧・詳細で使う情報を1回だけ読む（社員・確認・接客） */
function buildReportShareContext_() {
  const members = getAllStaff_().filter(isReportMember_);
  const confirmations = {};
  readTable_(SHEET_NAMES.REPORT_CONFIRMATIONS).records.forEach(function (c) {
    const id = String(c['日報ID']).trim();
    (confirmations[id] = confirmations[id] || []).push({
      employeeId: String(c['社員ID']).trim(),
      name: toPlainText_(c['確認者名']),
      version: Number(c['日報バージョン']) || 0,
      at: toPlainText_(c['確認日時']),
    });
  });
  const customerCounts = {};
  readTable_(SHEET_NAMES.REPORT_CUSTOMERS).records.forEach(function (r) {
    if (String(r['削除']).trim() === '1') return;
    const id = String(r['日報ID']).trim();
    customerCounts[id] = (customerCounts[id] || 0) + 1;
  });
  return { members: members, confirmations: confirmations, customerCounts: customerCounts };
}

/**
 * 確認の状況。
 *   targets   … 確認の対象（在籍中の社員 − 提出者）
 *   confirmed … 今のバージョンを確認した人（最新の確認日時）
 *   pending   … まだ今のバージョンを確認していない人（前のバージョンを確認していれば、その日時も）
 */
function confirmationStatus_(record, ctx) {
  const id = String(record['日報ID']).trim();
  const author = String(record['社員ID']).trim();
  const version = reportVersionOf_(record);
  const rows = ctx.confirmations[id] || [];
  const confirmed = [];
  const pending = [];
  ctx.members.filter(function (m) { return m.employeeId !== author; }).forEach(function (m) {
    const mine = rows.filter(function (c) { return c.employeeId === m.employeeId; });
    const current = mine.filter(function (c) { return c.version === version; }).sort(function (a, b) { return a.at < b.at ? 1 : -1; })[0];
    if (current) {
      confirmed.push({ employeeId: m.employeeId, name: m.name, confirmedAt: current.at });
      return;
    }
    const older = mine.sort(function (a, b) { return a.at < b.at ? 1 : -1; })[0];
    pending.push({ employeeId: m.employeeId, name: m.name, confirmedOlderAt: older ? older.at : '', confirmedOlderVersion: older ? older.version : 0 });
  });
  return { version: version, targetCount: confirmed.length + pending.length, confirmedCount: confirmed.length, confirmed: confirmed, pending: pending };
}

/** 一覧の1行 */
function toReportListItem_(record, viewer, ctx) {
  const id = String(record['日報ID']).trim();
  const state = reportStateOf_(record);
  const isMine = String(record['社員ID']).trim() === viewer.employeeId;
  const item = {
    reportId: id,
    date: toDateKey_(record['日付']),
    employeeId: toPlainText_(record['社員ID']),
    name: toPlainText_(record['氏名']),
    status: state,
    version: reportVersionOf_(record),
    customerCount: ctx.customerCounts[id] || 0,
    submittedAt: toPlainText_(record['提出日時']),
    updatedAt: toPlainText_(record['最終更新日時']) || toPlainText_(record['提出日時']),
    isMine: isMine,
  };
  if (state !== REPORT_STATE.SUBMITTED) return item;
  if (isLegacySubmittedReport_(record)) { item.legacy = true; return item; } // 旧日報：確認の対象外
  const status = confirmationStatus_(record, ctx);
  const me = status.confirmed.filter(function (c) { return c.employeeId === viewer.employeeId; })[0];
  item.targetCount = status.targetCount;
  item.confirmedCount = status.confirmedCount;
  item.allConfirmed = status.targetCount > 0 && status.confirmedCount === status.targetCount;
  item.myConfirmed = !!me;
  item.isUpdated = item.version > 1; // 提出後に修正された
  // 「更新あり」：提出後に修正されていて、自分がまだ最新版を確認していない（本人の日報には出さない）
  item.showUpdated = item.isUpdated && !isMine && !me;
  return item;
}

/** 詳細画面のデータ */
function buildReportDetail_(record, viewer, ctx) {
  const id = String(record['日報ID']).trim();
  const view = toReportView_(record, getActiveCustomers_(id));
  const isMine = view.employeeId === viewer.employeeId;
  const detail = { report: view, isMine: isMine, canEdit: isMine };
  if (view.status !== REPORT_STATE.SUBMITTED) return detail; // 下書き（本人だけ）：確認・コメントはまだない
  if (isLegacySubmittedReport_(record)) { // 旧日報（本人と管理者だけ）：閲覧のみ
    detail.legacy = true;
    detail.canEdit = false;
    return detail;
  }

  const status = confirmationStatus_(record, ctx);
  const me = status.confirmed.filter(function (c) { return c.employeeId === viewer.employeeId; })[0];
  detail.confirmation = status;
  detail.myConfirmed = !!me;
  detail.canConfirm = !isMine && isReportMember_(viewer) && !me;
  detail.canComment = isReportMember_(viewer);
  detail.showUpdated = view.version > 1 && !isMine && !me;
  // 確認の履歴（すべてのバージョン。古い順）
  detail.confirmationHistory = (ctx.confirmations[id] || []).slice()
    .sort(function (a, b) { return a.at < b.at ? -1 : 1; })
    .map(function (c) { return { name: c.name, version: c.version, at: c.at }; });
  // 提出・修正の履歴（内容は返さない）
  detail.updateHistory = findRecords_(SHEET_NAMES.REPORT_HISTORY, function (h) {
    return String(h['日報ID']).trim() === id && String(h['操作']).trim() !== '下書き保存';
  }).map(function (h) {
    return { version: Number(h['バージョン']) || 0, action: toPlainText_(h['操作']), name: toPlainText_(h['社員名']), at: toPlainText_(h['日時']) };
  }).sort(function (a, b) { return a.at < b.at ? -1 : 1; });
  // コメント（古い順）
  detail.comments = findRecords_(SHEET_NAMES.REPORT_COMMENTS, function (c) { return String(c['日報ID']).trim() === id; })
    .map(function (c) {
      return { commentId: toPlainText_(c['コメントID']), employeeId: toPlainText_(c['社員ID']), name: toPlainText_(c['社員名']), text: toPlainText_(c['コメント']), postedAt: toPlainText_(c['投稿日時']) };
    })
    .sort(function (a, b) { return a.postedAt < b.postedAt ? -1 : 1; });
  return detail;
}
