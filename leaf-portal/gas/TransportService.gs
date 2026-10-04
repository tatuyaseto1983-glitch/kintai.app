/**
 * TransportService.gs
 * ------------------------------------------------------------
 * 通勤以外の交通費と、自家用車の業務走行距離です（「交通費明細」シート）。
 *
 * 【決まり】
 *   - 1日に何件でも登録できます。勤怠記録がない日（休日に立て替えた駐車場代など）も登録できます。
 *   - 本人が追加・修正・削除できるのは「今の20日締め期間（前月21日〜当月20日）」の、今日までの日付だけです。
 *     締めた後の期間は本人からは変更できません（管理者がシートで直します）。
 *   - 削除は行を消さずに「削除フラグ」に ○ を入れます。削除した行は一覧・集計に入れません。
 *   - 業務走行距離は、交通手段＝自家用車の行だけに入れます。1日の走行距離は「削除されていない自家用車の行の合計」が唯一の正です
 *     （勤怠記録には距離を保存しません）。
 *   - 金額と距離は別の列です。今回は 1kmあたりの金額換算はしません（将来、単価の設定を足して計算できるように分けています）。
 *   - 社員ID・氏名はログイン中の人で決めます（画面からは受け取りません）。他の人の明細は「見つかりません」とだけ返します。
 *
 * シートを直接直す場合も、列の意味（削除フラグは空欄＝有効、何か入っていれば削除済み）を守れば読めます。
 */

// ============================================================ 画面から呼ぶ関数（本人の分だけ）

/**
 * 【画面から呼ぶ】自分の交通費明細（締め期間ごと）。
 * @param {string} [month] '2026-10'（＝2026年10月分：9/21〜10/20）。省略すると今の期間
 */
function getMyTransportExpenses(month) {
  return runApi_(function () {
    const staff = getCurrentStaff_();
    const now = getNowInfo_();
    const current = getPayrollPeriodForDate_(now.date);
    const period = isBlank_(month) ? current : getPayrollPeriodByMonthKey_(requireMonthKey_(month, '対象月'));
    const items = listTransportRows_(staff.employeeId, period.from, period.to).map(toTransportView_);
    return {
      message: period.periodText + ' の交通費を取得しました（' + items.length + '件）',
      data: {
        month: period.monthKey, from: period.from, to: period.to, periodLabel: period.label, periodText: period.periodText,
        today: now.date,
        currentMonth: current.monthKey,
        editable: period.monthKey === current.monthKey, // 今の期間だけ本人が変更できる
        modes: TRANSPORT_MODES.slice(),
        items: items,
        totals: summarizeTransportItems_(items),
      },
    };
  });
}

/** 【画面から呼ぶ】交通費を1件追加する（本人の分） */
function addTransportExpense(input) {
  return runApi_(function () {
    return withLock_(function () {
      const staff = getCurrentStaff_();
      requireTransportSchema_();
      const now = getNowInfo_();
      const values = validateTransportInput_(input || {}, now);
      const row = appendTransportRow_(staff, values, now.timestamp);
      return { message: '交通費を登録しました（' + values.date + '・' + values.mode + transportAmountText_(values) + '）', data: toTransportView_(row) };
    });
  });
}

/** 【画面から呼ぶ】自分の交通費を修正する（今の期間の分だけ） */
function updateTransportExpense(expenseId, input) {
  return runApi_(function () {
    return withLock_(function () {
      const staff = getCurrentStaff_();
      requireTransportSchema_();
      const now = getNowInfo_();
      const row = findOwnTransportRow_(expenseId, staff.employeeId);
      requireTransportEditable_(row, now);
      const values = validateTransportInput_(input || {}, now);
      updateTransportRow_(row, values, now.timestamp);
      return { message: '交通費を修正しました（' + values.date + '・' + values.mode + transportAmountText_(values) + '）', data: toTransportView_(row) };
    });
  });
}

/** 【画面から呼ぶ】自分の交通費を削除する（行は消さずに削除フラグ。今の期間の分だけ） */
function deleteTransportExpense(expenseId) {
  return runApi_(function () {
    return withLock_(function () {
      const staff = getCurrentStaff_();
      requireTransportSchema_();
      const now = getNowInfo_();
      const row = findOwnTransportRow_(expenseId, staff.employeeId);
      requireTransportEditable_(row, now);
      markTransportDeleted_(row, now.timestamp);
      return { message: '交通費を削除しました（' + toDateKey_(row['日付']) + '・' + toPlainText_(row['交通手段']) + '）', data: { expenseId: toPlainText_(row['明細ID']) } };
    });
  });
}

// ============================================================ シート

function hasTransportSchema_() {
  if (!getSpreadsheet_().getSheetByName(SHEET_NAMES.TRANSPORT)) return false;
  try {
    readTable_(SHEET_NAMES.TRANSPORT);
    return true;
  } catch (e) {
    return false;
  }
}

function requireTransportSchema_() {
  if (!hasTransportSchema_()) fail_('交通費の準備ができていません。管理者が Apps Script で setupSystem() を実行してから、もう一度操作してください');
}

/** 削除フラグ：空欄＝有効。何か入っていれば削除済み（シートを直接直した場合も同じ） */
function isTransportDeleted_(row) {
  return !isBlank_(row['削除フラグ']) && String(row['削除フラグ']).trim() !== '';
}

/** 社員・期間の有効な明細（日付→登録日時の順）。社員IDを空にすると全員分（管理者の集計用） */
function listTransportRows_(employeeId, from, to) {
  if (!hasTransportSchema_()) return [];
  const id = employeeId ? String(employeeId).trim() : '';
  return findRecords_(SHEET_NAMES.TRANSPORT, function (r) {
    if (isTransportDeleted_(r)) return false;
    if (id && String(r['社員ID']).trim() !== id) return false;
    const date = toDateKey_(r['日付']);
    return date && date >= from && date <= to;
  }).sort(function (a, b) {
    const da = toDateKey_(a['日付']);
    const db = toDateKey_(b['日付']);
    if (da !== db) return da < db ? -1 : 1;
    return toPlainText_(a['登録日時']) < toPlainText_(b['登録日時']) ? -1 : 1;
  });
}

/** 明細IDで本人の明細を探す。他の人の明細・削除済みは「見つかりません」（存在するかどうかも返さない） */
function findOwnTransportRow_(expenseId, employeeId) {
  const id = requireText_(expenseId, '明細ID', { max: TEXT_LIMITS.SHORT });
  const row = findRecords_(SHEET_NAMES.TRANSPORT, function (r) { return String(r['明細ID']).trim() === id; })[0];
  if (!row || String(row['社員ID']).trim() !== String(employeeId).trim() || isTransportDeleted_(row)) {
    fail_('交通費の明細が見つかりません（明細ID：' + id + '）');
  }
  return row;
}

/** 今の締め期間の明細か（締めた後の期間は本人から変更できない） */
function requireTransportEditable_(row, now) {
  const date = toDateKey_(row['日付']);
  const current = getPayrollPeriodForDate_(now.date);
  if (date < current.from || date > current.to) {
    fail_(date + ' は締めた後の期間（' + getPayrollPeriodForDate_(date).label + '）のため変更できません。修正が必要なときは管理者に連絡してください');
  }
}

// ============================================================ 入力の確認

/**
 * 画面から来た交通費の入力を確かめて、シートに入れる形にする。
 * 戻り値：{ date, mode, from, to, purpose, amount('' or '1200'), car('○' or ''), km('' or '32.5'), note }
 */
function validateTransportInput_(input, now, opts) {
  const o = opts || {};
  const date = requireDateKey_(input.date, '日付');
  const current = getPayrollPeriodForDate_(now.date);
  if (date > now.date) fail_('未来の日付の交通費は登録できません');
  if (date < current.from) fail_(date + ' は締めた後の期間（' + getPayrollPeriodForDate_(date).label + '）のため登録できません。今の期間は ' + current.periodText + ' です');
  const mode = requireChoice_(input.mode, TRANSPORT_MODES, '交通手段');
  const isCar = mode === TRANSPORT_MODE_CAR;
  const purpose = requireText_(input.purpose, '目的・現場', { required: !o.purposeOptional, max: TEXT_LIMITS.SHORT });
  const amount = parseTransportAmount_(input.amount, !isCar);
  const km = isCar ? parseTransportKm_(input.km, true) : '';
  if (!isCar && !isBlank_(input.km) && String(input.km).trim() !== '') fail_('業務走行距離は、交通手段が「自家用車」のときだけ入力できます');
  return {
    date: date,
    mode: mode,
    from: requireText_(input.from, '出発地', { required: false, max: TEXT_LIMITS.SHORT }),
    to: requireText_(input.to, '到着地', { required: false, max: TEXT_LIMITS.SHORT }),
    purpose: purpose,
    amount: amount,
    car: isCar || input.privateCar === true ? MARKS.YES : '',
    km: km,
    note: requireText_(input.note, '備考', { required: false, max: TEXT_LIMITS.LONG }),
  };
}

/** 金額（円・0以上の整数）。required でなければ空欄を許す（自家用車の行） */
function parseTransportAmount_(value, required) {
  const text = isBlank_(value) ? '' : String(value).trim().replace(/[,，円]/g, '');
  if (text === '') {
    if (required) fail_('金額を入力してください（円）');
    return '';
  }
  if (!/^\d{1,7}$/.test(text)) fail_('金額は 0 以上の整数（円）で入力してください');
  return String(Number(text));
}

/** 走行距離（km・0.1km単位・0より大きく上限まで）。'32.5' の形で返す */
function parseTransportKm_(value, required) {
  const text = isBlank_(value) ? '' : String(value).trim().replace(/km$/i, '');
  if (text === '') {
    if (required) fail_('業務走行距離（km）を入力してください');
    return '';
  }
  if (!/^\d{1,4}(\.\d)?$/.test(text)) fail_('業務走行距離は 32.5 のように、小数点以下1桁までの km で入力してください');
  const km = Number(text);
  if (!(km > 0) || km > TRANSPORT_MAX_KM) fail_('業務走行距離は 0km より大きく ' + TRANSPORT_MAX_KM + 'km 以下で入力してください');
  return String(km);
}

/** シートの値（数値・文字）を数にする。読めなければ 0 */
function transportNumber_(value) {
  if (isBlank_(value)) return 0;
  const n = Number(String(value).replace(/[,，円km]/gi, '').trim());
  return isFinite(n) ? n : 0;
}

function transportAmountText_(values) {
  return values.mode === TRANSPORT_MODE_CAR ? '・' + values.km + 'km' : '・' + Number(values.amount).toLocaleString('ja-JP') + '円';
}

// ============================================================ 書き込み（将来の管理者修正からも使えるよう、権限確認とは分けている）

function appendTransportRow_(staff, values, timestamp) {
  const prefix = 'TR-' + values.date.replace(/-/g, '') + '-' + staff.employeeId + '-';
  const count = findRecords_(SHEET_NAMES.TRANSPORT, function (r) { return String(r['明細ID']).indexOf(prefix) === 0; }).length;
  return appendRecord_(SHEET_NAMES.TRANSPORT, {
    '明細ID': makeUniqueId_(SHEET_NAMES.TRANSPORT, '明細ID', prefix + pad2_(count + 1)),
    '日付': values.date,
    '社員ID': staff.employeeId,
    '氏名': staff.name,
    '交通手段': values.mode,
    '出発地': values.from,
    '到着地': values.to,
    '目的・現場': values.purpose,
    '金額': values.amount,
    '自家用車使用': values.car,
    '業務走行距離': values.km,
    '備考': values.note,
    '削除フラグ': '',
    '登録日時': timestamp,
    '更新日時': timestamp,
  });
}

function updateTransportRow_(row, values, timestamp) {
  updateRecord_(SHEET_NAMES.TRANSPORT, row, {
    '日付': values.date,
    '交通手段': values.mode,
    '出発地': values.from,
    '到着地': values.to,
    '目的・現場': values.purpose,
    '金額': values.amount,
    '自家用車使用': values.car,
    '業務走行距離': values.km,
    '備考': values.note,
    '更新日時': timestamp,
  });
}

function markTransportDeleted_(row, timestamp) {
  updateRecord_(SHEET_NAMES.TRANSPORT, row, { '削除フラグ': MARKS.YES, '更新日時': timestamp });
}

// ============================================================ 集計・画面へ返す形

function toTransportView_(r) {
  const isCar = toPlainText_(r['交通手段']) === TRANSPORT_MODE_CAR;
  return {
    expenseId: toPlainText_(r['明細ID']),
    date: toDateKey_(r['日付']),
    employeeId: toPlainText_(r['社員ID']),
    name: toPlainText_(r['氏名']),
    mode: toPlainText_(r['交通手段']),
    from: toPlainText_(r['出発地']),
    to: toPlainText_(r['到着地']),
    purpose: toPlainText_(r['目的・現場']),
    amount: isBlank_(r['金額']) ? '' : String(transportNumber_(r['金額'])),
    privateCar: !isBlank_(r['自家用車使用']),
    km: isCar && !isBlank_(r['業務走行距離']) ? String(transportNumber_(r['業務走行距離'])) : '',
    note: toPlainText_(r['備考']),
    createdAt: toPlainText_(r['登録日時']),
    updatedAt: toPlainText_(r['更新日時']),
  };
}

/**
 * 明細の合計。金額＝金額の合計（円）、走行距離＝自家用車の行の業務走行距離の合計（km・小数1桁）。
 * 走行距離は自家用車の行だけを数える（同じ距離を2回数えない）。
 */
function summarizeTransportItems_(items) {
  let amount = 0;
  let kmTenths = 0;
  items.forEach(function (v) {
    amount += transportNumber_(v.amount);
    if (v.mode === TRANSPORT_MODE_CAR) kmTenths += Math.round(transportNumber_(v.km) * 10);
  });
  return { amount: amount, km: kmTenths / 10, count: items.length, kmText: formatKm_(kmTenths / 10), amountText: amount.toLocaleString('ja-JP') + '円' };
}

function formatKm_(km) {
  return (Math.round(km * 10) / 10).toFixed(1) + 'km';
}

/** 期間内の社員ごとの合計（管理者の月次用）。{ 社員ID: { amount, km, count } } */
function summarizeTransportByEmployee_(from, to) {
  const out = {};
  listTransportRows_('', from, to).forEach(function (r) {
    const id = String(r['社員ID']).trim();
    (out[id] = out[id] || []).push(toTransportView_(r));
  });
  Object.keys(out).forEach(function (id) { out[id] = summarizeTransportItems_(out[id]); });
  return out;
}
