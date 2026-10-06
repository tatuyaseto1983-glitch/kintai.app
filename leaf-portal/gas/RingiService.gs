/**
 * RingiService.gs
 * ------------------------------------------------------------
 * 稟議申請（購入・支出の事前承認）です。休日出勤申請と同じ作り（申請 → 管理者が承認・却下）で、
 * 概算の申請は、承認後に確定金額を入力し、申請金額を超えたときだけ再承認を受けます。
 * 購入完了・支払・経費精算・会計処理は扱いません。
 *
 *   申請中 ──承認──→ 承認済 ──［概算］確定金額＞申請金額──→ 再承認待ち ──再承認──→ 再承認済（確定金額は変更不可）
 *     └──却下（理由必須）──→ 却下              ↑ 確定金額≦申請金額なら承認済のまま  └──再承認を却下（理由必須）──→ 却下（却下区分＝再承認却下）
 *
 * ・申請者はログイン中のGoogleアカウントとスタッフマスタで決める（画面から送られた社員ID・氏名・メールは使わない）
 * ・申請できるのは在籍中のスタッフ全員
 * ・承認・却下・再承認・再承認の却下は、毎回スタッフマスタを読み直して「在籍」かつ「権限＝admin（管理者）」の人だけ
 *   （特定の個人名・メールアドレスはコードに書かない。管理者が増えてもスタッフマスタを変えるだけでよい）
 * ・自分の稟議は承認・却下・再承認できない。スタッフマスタ「自己承認可」が TRUE の人（社長）だけ例外
 * ・確定金額の入力・訂正は、申請者本人か管理者だけ。「概算」の稟議で、申請状態が「承認済」「再承認待ち」の間だけ
 *   （再承認済・却下・申請中は不可）。申請金額は書き換えない。差額＝確定金額−申請金額
 * ・確定金額の入力・訂正のたびに再承認要否を判定し直す：1円でも申請金額を超えたら「要」→ 再承認待ち、以下なら「不要」→ 承認済
 * ・操作はすべて 稟議_更新履歴 に1行ずつ残す（確定金額の訂正は変更前・変更後の金額と変更者・日時）
 * ・添付資料は今は共有リンク（URL）を貼るだけ（https:// で始まるもの・任意）。
 *   将来、画面からアップロードする場合は、保存したファイルのURLを同じ「添付資料URL」列に入れれば、ほかは変えずに済む
 */

// ============================================================ 社員が使う関数

/**
 * 【画面から呼ぶ】稟議を申請する。
 * @param {object} input
 *   itemName       購入品名（必須）
 *   quantity       購入数量（1以上の整数）
 *   expenseType    経費種別（RINGI_EXPENSE_TYPES）
 *   purpose        支出理由・目的（必須）
 *   certainty      金額の確度（確定／概算）
 *   amount         見積金額（税込・円。1〜1億の整数）
 *   plannedDate    支出予定日 '2026-10-20'（過去の日付も可）
 *   attachmentUrl  見積書・関連資料の共有リンク（任意。https:// で始まるもの）
 */
function submitRingiRequest(input) {
  return runApi_(function () {
    return withLock_(function () { return submitRingiRequest_(input || {}); });
  });
}

/** 【画面から呼ぶ】自分の稟議（新しい順）と、入力の選択肢 */
function getMyRingiRequests() {
  return runApi_(function () {
    const staff = getCurrentStaff_();
    const base = { eligible: false, today: getNowInfo_().date, requests: [], expenseTypes: RINGI_EXPENSE_TYPES.slice(),
      certainties: [RINGI_CERTAINTY.FIXED, RINGI_CERTAINTY.ESTIMATE], limits: RINGI_LIMITS };
    if (!hasRingiSchema_()) return { message: '稟議申請はまだ準備中です', data: Object.assign(base, { setupRequired: true }) };
    if (!canApplyRingi_(staff)) return { message: '稟議申請はできません（在籍中のスタッフだけ）', data: base };
    const list = findRecords_(SHEET_NAMES.RINGI, function (r) { return String(r['社員ID']).trim() === staff.employeeId; })
      .map(function (r) { return decorateRingiView_(toRingiView_(r), r, staff); })
      .sort(function (a, b) { return a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0; });
    return { message: '稟議申請を取得しました（' + list.length + '件）', data: Object.assign(base, { eligible: true, requests: list }) };
  });
}

/**
 * 【画面から呼ぶ】稟議1件の詳細と操作の履歴。見られるのは申請者本人と管理者だけ（それ以外は「見つかりません」）。
 */
function getRingiRequestDetail(ringiId) {
  return runApi_(function () {
    requireRingiSchema_();
    const staff = getCurrentStaff_();
    const record = findRingiById_(ringiId);
    if (!record || !(isRingiOwner_(record, staff) || isRingiAdmin_(staff))) fail_('稟議が見つかりません');
    const view = decorateRingiView_(toRingiView_(record), record, staff);
    view.history = listRingiHistory_(view.ringiId);
    return { message: '稟議 ' + view.ringiId + ' を取得しました', data: view };
  });
}

/**
 * 【画面から呼ぶ】確定金額を入力・訂正する（申請者本人か管理者。概算の稟議で、承認済・再承認待ちの間だけ）。
 * @param {string} ringiId
 * @param {number|string} amount 確定金額（税込・円。1〜1億の整数）
 * @param {string} [note] 訂正の理由など（任意。履歴に残す）
 */
function enterRingiFinalAmount(ringiId, amount, note) {
  return runApi_(function () {
    return withLock_(function () { return enterRingiFinalAmount_(ringiId, amount, note); });
  });
}

// ============================================================ 管理者が使う関数

/** 【管理者】稟議を承認する（申請中 → 承認済） */
function approveRingiRequest(ringiId) {
  return runApi_(function () {
    return withLock_(function () { return decideRingi_(ringiId, 'approve', ''); });
  });
}

/** 【管理者】稟議を却下する（申請中 → 却下。却下理由は必須） */
function rejectRingiRequest(ringiId, reason) {
  return runApi_(function () {
    return withLock_(function () { return decideRingi_(ringiId, 'reject', reason); });
  });
}

/** 【管理者】再承認する（再承認待ち → 再承認済） */
function reapproveRingiRequest(ringiId) {
  return runApi_(function () {
    return withLock_(function () { return decideRingi_(ringiId, 'reapprove', ''); });
  });
}

/** 【管理者】再承認を却下する（再承認待ち → 却下。却下区分＝再承認却下。却下理由は必須） */
function rejectRingiReapproval(ringiId, reason) {
  return runApi_(function () {
    return withLock_(function () { return decideRingi_(ringiId, 'rejectReapproval', reason); });
  });
}

// ============================================================ 中身

function submitRingiRequest_(input) {
  requireRingiSchema_();
  const staff = getCurrentStaff_();
  if (!canApplyRingi_(staff)) fail_('稟議申請ができるのは在籍中のスタッフだけです');
  const plan = validateRingiInput_(input);
  const now = getNowInfo_();
  const record = appendRecord_(SHEET_NAMES.RINGI, {
    '稟議ID': makeUniqueId_(SHEET_NAMES.RINGI, '稟議ID', 'RG-' + compactTimestamp_() + '-' + staff.employeeId),
    '申請日時': now.timestamp,
    '申請者メール': staff.email,
    '申請者名': staff.name,
    '社員ID': staff.employeeId,
    '購入品名': plan.itemName,
    '購入数量': plan.quantity,
    '経費種別': plan.expenseType,
    '支出理由・目的': plan.purpose,
    '金額の確度': plan.certainty,
    '申請金額': plan.amount,
    '支出予定日': plan.plannedDate,
    '添付資料URL': plan.attachmentUrl,
    '申請状態': RINGI_STATUS.PENDING,
    '最終更新日時': now.timestamp,
  });
  appendRingiHistory_(record, RINGI_ACTIONS.SUBMIT, staff, { statusBefore: '', statusAfter: RINGI_STATUS.PENDING, note: '申請金額 ' + yen_(plan.amount) + '（' + plan.certainty + '）' });
  // 保存の後でメール通知を予約（送るのは runApi_ の最後。失敗しても申請は取り消さない）
  notifyRequestSubmitted_('稟議申請', staff, toPlainText_(record['稟議ID']), plan.itemName + '・' + yen_(plan.amount), ringiMailDetails_(record));
  return { message: '稟議を申請しました（' + toPlainText_(record['稟議ID']) + '）。管理者の承認をお待ちください', data: decorateRingiView_(toRingiView_(record), record, staff) };
}

/** 入力のチェック（画面でも確認するが、最終的な判定は必ずここで行う） */
function validateRingiInput_(input) {
  const itemName = requireText_(input.itemName, '購入品名', { max: TEXT_LIMITS.SHORT });
  const quantity = requireRingiInteger_(input.quantity, '購入数量', 1, RINGI_LIMITS.QUANTITY_MAX);
  const expenseType = requireChoice_(input.expenseType, RINGI_EXPENSE_TYPES, '経費種別');
  const purpose = requireText_(input.purpose, '支出理由・目的', { max: TEXT_LIMITS.LONG });
  const certainty = requireChoice_(input.certainty, [RINGI_CERTAINTY.FIXED, RINGI_CERTAINTY.ESTIMATE], '金額の確度');
  const amount = requireRingiInteger_(input.amount, '見積金額（税込）', RINGI_LIMITS.AMOUNT_MIN, RINGI_LIMITS.AMOUNT_MAX);
  const plannedDate = requireDateKey_(input.plannedDate, '支出予定日'); // 過去の日付も可（事後の申請があるため）
  const attachmentUrl = normalizeRingiUrl_(input.attachmentUrl);
  return { itemName: itemName, quantity: quantity, expenseType: expenseType, purpose: purpose, certainty: certainty,
    amount: amount, plannedDate: plannedDate, attachmentUrl: attachmentUrl };
}

/** 数字だけの整数（「1,000」「1.5」「１０」「-1」などは受け付けない）で、min〜max の範囲 */
function requireRingiInteger_(value, label, min, max) {
  const text = isBlank_(value) ? '' : String(value).trim();
  if (!/^\d+$/.test(text)) fail_(label + 'は数字だけで入力してください（カンマ・小数点・記号は使えません）');
  const n = Number(text);
  if (!isFinite(n) || n < min || n > max) fail_(label + 'は ' + min.toLocaleString('ja-JP') + '〜' + max.toLocaleString('ja-JP') + ' の範囲で入力してください');
  return n;
}

/** 添付資料のURL（任意）。https:// で始まり、空白を含まないもの */
function normalizeRingiUrl_(value) {
  const url = requireText_(value, '見積書・関連資料のURL', { required: false, max: TEXT_LIMITS.LONG });
  if (url && !/^https:\/\/[^\s]+$/.test(url)) fail_('見積書・関連資料のURLは「https://」で始まる共有リンクを貼ってください');
  return url;
}

/**
 * 承認・却下・再承認・再承認の却下（管理者だけ）。毎回スタッフマスタを読み直して権限を確認する。
 * @param {'approve'|'reject'|'reapprove'|'rejectReapproval'} action
 */
function decideRingi_(ringiId, action, reason) {
  requireRingiSchema_();
  const admin = requireRingiApprover_();
  const record = findRingiById_(ringiId);
  if (!record) fail_('稟議が見つかりません（稟議ID：' + ringiId + '）');
  if (isRingiOwner_(record, admin) && !admin.selfApproval) {
    fail_('自分の稟議は承認・却下できません（スタッフマスタの「自己承認可」が TRUE の人だけ自分の稟議を処理できます）。ほかの管理者に依頼してください');
  }
  const status = String(record['申請状態']).trim();
  const isReapproval = action === 'reapprove' || action === 'rejectReapproval';
  const expected = isReapproval ? RINGI_STATUS.REAPPROVAL_PENDING : RINGI_STATUS.PENDING;
  if (status !== expected) fail_('この稟議は「' + expected + '」ではないため処理できません（今の申請状態：' + (status || '空欄') + '）');

  const now = getNowInfo_().timestamp;
  let changes;
  let history;
  let message;
  if (action === 'approve') {
    changes = { '申請状態': RINGI_STATUS.APPROVED, '承認者': admin.name, '承認者メール': admin.email, '承認日時': now, '却下理由': '' };
    history = { action: RINGI_ACTIONS.APPROVE, note: '' };
    message = '稟議を承認しました';
  } else if (action === 'reject') {
    const text = requireText_(reason, '却下理由', { max: TEXT_LIMITS.LONG });
    changes = { '申請状態': RINGI_STATUS.REJECTED, '承認者': admin.name, '承認者メール': admin.email, '承認日時': now, '却下理由': text,
      '却下区分': RINGI_REJECT_KIND.NORMAL };
    history = { action: RINGI_ACTIONS.REJECT, note: '却下理由：' + text };
    message = '稟議を却下しました';
  } else if (action === 'reapprove') {
    changes = { '申請状態': RINGI_STATUS.REAPPROVED, '再承認者': admin.name, '再承認者メール': admin.email, '再承認日時': now };
    history = { action: RINGI_ACTIONS.REAPPROVE, note: '確定金額 ' + yen_(record['確定金額']) + '（申請金額 ' + yen_(record['申請金額']) + '）' };
    message = '再承認しました（再承認済。この後は確定金額を変更できません）';
  } else if (action === 'rejectReapproval') {
    const text = requireText_(reason, '却下理由', { max: TEXT_LIMITS.LONG });
    changes = { '申請状態': RINGI_STATUS.REJECTED, '再承認者': admin.name, '再承認者メール': admin.email, '再承認日時': now, '却下理由': text,
      '却下区分': RINGI_REJECT_KIND.REAPPROVAL };
    history = { action: RINGI_ACTIONS.REAPPROVAL_REJECT, note: '却下理由：' + text };
    message = '再承認を却下しました（却下）';
  } else {
    fail_('処理の種類が正しくありません');
  }
  changes['最終更新日時'] = now;
  updateRecord_(SHEET_NAMES.RINGI, record, onlyExistingColumns_(SHEET_NAMES.RINGI, changes));
  appendRingiHistory_(record, history.action, admin, { statusBefore: status, statusAfter: changes['申請状態'], note: history.note });
  // 申請者本人へ結果をメールで通知（予約。却下・再承認却下は却下理由を入れる）
  const result = { approve: '承認', reject: '却下', reapprove: '再承認', rejectReapproval: '再承認却下' }[action];
  notifyRequestDecided_('稟議申請', result, { employeeId: String(record['社員ID']).trim(), name: toPlainText_(record['申請者名']), email: toPlainText_(record['申請者メール']) },
    admin, toPlainText_(record['稟議ID']), toPlainText_(record['購入品名']) + '・' + yen_(record['申請金額']), ringiMailDetails_(record), changes['却下理由'] || '');
  return { message: message + '（' + toPlainText_(record['稟議ID']) + '）', data: decorateRingiView_(toRingiView_(record), record, admin) };
}

function enterRingiFinalAmount_(ringiId, amountInput, noteInput) {
  requireRingiSchema_();
  const staff = getCurrentStaff_();
  const record = findRingiById_(ringiId);
  // 申請者本人でも管理者でもない人には、稟議があるかどうかも返さない
  if (!record || !(isRingiOwner_(record, staff) || isRingiAdmin_(staff))) fail_('稟議が見つかりません');
  if (String(record['金額の確度']).trim() !== RINGI_CERTAINTY.ESTIMATE) fail_('確定金額を入力できるのは「概算」の稟議だけです');
  const status = String(record['申請状態']).trim();
  if (status === RINGI_STATUS.REAPPROVED) fail_('再承認済みのため、確定金額は変更できません');
  if (status !== RINGI_STATUS.APPROVED && status !== RINGI_STATUS.REAPPROVAL_PENDING) {
    fail_('確定金額を入力できるのは、申請状態が「承認済」「再承認待ち」の稟議だけです（今の申請状態：' + (status || '空欄') + '）');
  }
  const amount = requireRingiInteger_(amountInput, '確定金額（税込）', RINGI_LIMITS.AMOUNT_MIN, RINGI_LIMITS.AMOUNT_MAX);
  const note = requireText_(noteInput, '訂正の理由・備考', { required: false, max: TEXT_LIMITS.LONG });
  const before = isBlank_(record['確定金額']) ? null : Number(record['確定金額']);
  if (before === amount) fail_('確定金額は今と同じ ' + yen_(amount) + ' です');
  const requested = Number(record['申請金額']);
  const diff = amount - requested;
  const needsReapproval = diff > 0; // 1円でも申請金額を超えたら再承認
  const newStatus = needsReapproval ? RINGI_STATUS.REAPPROVAL_PENDING : RINGI_STATUS.APPROVED;
  const now = getNowInfo_().timestamp;
  updateRecord_(SHEET_NAMES.RINGI, record, {
    '確定金額': amount,
    '確定金額入力者': staff.name,
    '確定金額入力者メール': staff.email,
    '確定金額入力日時': now,
    '概算との差額': diff,
    '再承認要否': needsReapproval ? RINGI_REAPPROVAL.REQUIRED : RINGI_REAPPROVAL.NOT_REQUIRED,
    '申請状態': newStatus,
    '最終更新日時': now,
  });
  appendRingiHistory_(record, before === null ? RINGI_ACTIONS.FINAL_AMOUNT : RINGI_ACTIONS.FINAL_AMOUNT_FIX, staff, {
    statusBefore: status, statusAfter: newStatus, amountBefore: before, amountAfter: amount,
    note: ['差額 ' + signedYen_(diff), needsReapproval ? '申請金額を超えたため再承認待ち' : '申請金額以下のため承認済', note].filter(function (x) { return x; }).join('・'),
  });
  // 申請金額を超えて「再承認待ち」になったとき（承認済から変わったときだけ）は、管理者と申請者本人へメールで通知（予約）
  if (needsReapproval && status !== RINGI_STATUS.REAPPROVAL_PENDING) notifyRingiReapprovalNeeded_(record, staff, ringiMailDetails_(record));
  const verb = before === null ? '入力' : '訂正';
  return {
    message: '確定金額を' + verb + 'しました（' + yen_(amount) + '・差額 ' + signedYen_(diff) + '）。' +
      (needsReapproval ? '申請金額を超えたため「再承認待ち」になりました。管理者の再承認をお待ちください' : '申請金額以下のため「承認済」です'),
    data: decorateRingiView_(toRingiView_(record), record, staff),
  };
}

// ============================================================ 権限・準備

/** 稟議を申請できる人：在籍中のスタッフ全員 */
function canApplyRingi_(staff) {
  return staff.status === EMPLOYMENT_STATUS.ACTIVE;
}

/** 稟議の管理者：在籍中で、スタッフマスタの権限が admin（管理者） */
function isRingiAdmin_(staff) {
  return !!staff && staff.status === EMPLOYMENT_STATUS.ACTIVE && staff.role === ROLES.ADMIN;
}

/** 承認・却下・再承認ができる人（管理者）。毎回スタッフマスタを読み直す（requireAdmin） */
function requireRingiApprover_() {
  const admin = requireAdmin();
  if (admin.status !== EMPLOYMENT_STATUS.ACTIVE) fail_('管理者権限がありません（在籍中の管理者だけが承認できます）');
  return admin;
}

function isRingiOwner_(record, staff) {
  return !!staff && String(record['社員ID']).trim() === staff.employeeId;
}

/** 稟議管理・稟議_更新履歴のシートがあるか */
function hasRingiSchema_() {
  const ss = getSpreadsheet_();
  return !!(ss.getSheetByName(SHEET_NAMES.RINGI) && ss.getSheetByName(SHEET_NAMES.RINGI_HISTORY));
}

function requireRingiSchema_() {
  if (!hasRingiSchema_()) fail_('稟議申請に必要な「稟議管理」「稟議_更新履歴」シートがありません。管理者が Apps Script で setupSystem() を実行してください');
}

/**
 * スタッフマスタに「自己承認可」列を新しく作ったときの初期値（setupSystem から呼ばれる）。全員 FALSE。
 * 社長だけ、管理者がシートで TRUE に変える（氏名・メールでは判定しない）。
 */
function initSelfApprovalColumn_(sheet, addedHeaders) {
  if (addedHeaders.indexOf('自己承認可') === -1) return '';
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';
  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (h) { return String(h).trim(); });
  const idCol = headers.indexOf('社員ID');
  const col = headers.indexOf('自己承認可');
  if (idCol === -1 || col === -1) return '';
  const rows = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  const values = rows.map(function (row) { return [isBlank_(row[idCol]) ? '' : SELF_APPROVAL.NO]; });
  sheet.getRange(2, col + 1, values.length, 1).setValues(values);
  return '自己承認可の初期値を入れました（全員 FALSE。社長の行だけ TRUE に変えてください）';
}

// ============================================================ 読み取り・履歴・画面用

function findRingiById_(ringiId) {
  const id = String(ringiId === undefined || ringiId === null ? '' : ringiId).trim();
  if (!id) return null;
  return findRecords_(SHEET_NAMES.RINGI, function (r) { return String(r['稟議ID']).trim() === id; })[0] || null;
}

/** 操作の履歴を1行追加する */
function appendRingiHistory_(record, action, actor, info) {
  const ringiId = toPlainText_(record['稟議ID']);
  appendRecord_(SHEET_NAMES.RINGI_HISTORY, {
    '履歴ID': makeUniqueId_(SHEET_NAMES.RINGI_HISTORY, '履歴ID', 'RH-' + compactTimestamp_() + '-' + actor.employeeId),
    '稟議ID': ringiId,
    '日時': getNowInfo_().timestamp,
    '操作': action,
    '操作者': actor.name,
    '操作者メール': actor.email,
    '操作者社員ID': actor.employeeId,
    '変更前の申請状態': info.statusBefore || '',
    '変更後の申請状態': info.statusAfter || '',
    '変更前の確定金額': info.amountBefore === null || info.amountBefore === undefined ? '' : info.amountBefore,
    '変更後の確定金額': info.amountAfter === null || info.amountAfter === undefined ? '' : info.amountAfter,
    '理由・備考': info.note || '',
  });
}

/** 稟議1件の履歴（古い順） */
function listRingiHistory_(ringiId) {
  return findRecords_(SHEET_NAMES.RINGI_HISTORY, function (r) { return String(r['稟議ID']).trim() === ringiId; })
    .map(function (r) {
      return {
        at: toPlainText_(r['日時']),
        action: toPlainText_(r['操作']),
        actorName: toPlainText_(r['操作者']),
        statusBefore: toPlainText_(r['変更前の申請状態']),
        statusAfter: toPlainText_(r['変更後の申請状態']),
        amountBefore: isBlank_(r['変更前の確定金額']) ? null : Number(r['変更前の確定金額']),
        amountAfter: isBlank_(r['変更後の確定金額']) ? null : Number(r['変更後の確定金額']),
        note: toPlainText_(r['理由・備考']),
      };
    })
    .sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
}

/** 画面に返す形（メールアドレスは返さない） */
function toRingiView_(r) {
  const num = function (v) { return isBlank_(v) ? null : Number(v); };
  const requestedAt = toPlainText_(r['申請日時']);
  return {
    ringiId: toPlainText_(r['稟議ID']),
    requestedAt: requestedAt,
    requestDate: requestedAt.slice(0, 10),
    employeeId: toPlainText_(r['社員ID']),
    applicantName: toPlainText_(r['申請者名']),
    itemName: toPlainText_(r['購入品名']),
    quantity: num(r['購入数量']),
    expenseType: toPlainText_(r['経費種別']),
    purpose: toPlainText_(r['支出理由・目的']),
    certainty: toPlainText_(r['金額の確度']),
    amount: num(r['申請金額']),
    plannedDate: toDateKey_(r['支出予定日']),
    attachmentUrl: toPlainText_(r['添付資料URL']),
    status: toPlainText_(r['申請状態']),
    approverName: toPlainText_(r['承認者']),
    approvedAt: toPlainText_(r['承認日時']),
    rejectReason: toPlainText_(r['却下理由']),
    rejectKind: r['却下区分'] === undefined ? '' : toPlainText_(r['却下区分']),
    finalAmount: num(r['確定金額']),
    finalAmountBy: toPlainText_(r['確定金額入力者']),
    finalAmountAt: toPlainText_(r['確定金額入力日時']),
    diff: num(r['概算との差額']),
    reapprovalRequired: toPlainText_(r['再承認要否']),
    reapproverName: toPlainText_(r['再承認者']),
    reapprovedAt: toPlainText_(r['再承認日時']),
    updatedAt: toPlainText_(r['最終更新日時']),
  };
}

/** 見ている人ができる操作（表示の目安。実際の判定は必ず各処理で行う） */
function decorateRingiView_(view, record, staff) {
  const owner = isRingiOwner_(record, staff);
  const admin = isRingiAdmin_(staff);
  const selfBlocked = owner && !(staff && staff.selfApproval);
  view.isMine = owner;
  view.canEnterFinalAmount = (owner || admin) && view.certainty === RINGI_CERTAINTY.ESTIMATE &&
    (view.status === RINGI_STATUS.APPROVED || view.status === RINGI_STATUS.REAPPROVAL_PENDING);
  view.canDecide = admin && !selfBlocked && view.status === RINGI_STATUS.PENDING;
  view.canReapprove = admin && !selfBlocked && view.status === RINGI_STATUS.REAPPROVAL_PENDING;
  view.selfBlocked = admin && selfBlocked && (view.status === RINGI_STATUS.PENDING || view.status === RINGI_STATUS.REAPPROVAL_PENDING);
  return view;
}

/** 管理者画面：申請中・再承認待ち（処理待ち）と、最近処理した稟議 */
function buildAdminRingi_() {
  if (!hasRingiSchema_()) return { setupRequired: true, pending: [], reapproval: [], processed: [], pendingCount: 0, reapprovalCount: 0 };
  const admin = getCurrentStaff_();
  const all = readTable_(SHEET_NAMES.RINGI).records
    .filter(function (r) { return !isBlank_(r['稟議ID']); })
    .map(function (r) { return decorateRingiView_(toRingiView_(r), r, admin); });
  const byRequested = function (a, b) { return a.requestedAt < b.requestedAt ? -1 : a.requestedAt > b.requestedAt ? 1 : 0; };
  const pending = all.filter(function (v) { return v.status === RINGI_STATUS.PENDING; }).sort(byRequested);
  const reapproval = all.filter(function (v) { return v.status === RINGI_STATUS.REAPPROVAL_PENDING; }).sort(byRequested);
  const processed = all.filter(function (v) { return v.status !== RINGI_STATUS.PENDING && v.status !== RINGI_STATUS.REAPPROVAL_PENDING; })
    .sort(function (a, b) { return (a.updatedAt || a.requestedAt) < (b.updatedAt || b.requestedAt) ? 1 : -1; })
    .slice(0, ADMIN_RECENT_REQUEST_LIMIT);
  return { setupRequired: false, pending: pending, reapproval: reapproval, processed: processed,
    pendingCount: pending.length, reapprovalCount: reapproval.length };
}

/** メール通知に書く稟議の内容（確定金額があれば差額も） */
function ringiMailDetails_(r) {
  const rows = [['購入品名', toPlainText_(r['購入品名'])], ['購入数量', toPlainText_(r['購入数量'])], ['経費種別', toPlainText_(r['経費種別'])],
    ['支出理由・目的', toPlainText_(r['支出理由・目的'])], ['金額の確度', toPlainText_(r['金額の確度'])], ['申請金額（税込）', yen_(r['申請金額'])],
    ['支出予定日', toDateKey_(r['支出予定日'])], ['見積書・資料', toPlainText_(r['添付資料URL'])]];
  if (!isBlank_(r['確定金額'])) rows.push(['確定金額（税込）', yen_(r['確定金額']) + '（差額 ' + signedYen_(r['概算との差額']) + '）']);
  return rows;
}

/** 1234567 → '1,234,567円' */
function yen_(value) {
  return Number(value).toLocaleString('ja-JP') + '円';
}

/** 差額の表示 '+5,000円' '-3,000円' '±0円' */
function signedYen_(value) {
  const n = Number(value);
  return (n > 0 ? '+' : n < 0 ? '-' : '±') + Math.abs(n).toLocaleString('ja-JP') + '円';
}
