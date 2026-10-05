/**
 * AdminMonthlyService.gs
 * ------------------------------------------------------------
 * 段階5：管理者の月次の詳細・集計・出力です（すべて読み取りと集計だけ。シートには書き込みません）。
 *
 *   社内詳細月次（社員1名×20日締め1か月を1日1行）     … getAdminEmployeeMonth / exportAdminEmployeeMonthCsv
 *   月次の集計（接客・日報確認・理由付き要確認一覧）    … getAdminMonthlyAnalysis
 *   月次サマリーCSV（社員ごとの合計）                  … exportAdminMonthlySummaryCsv
 *   社労士確認用の詳細表（CSV）                        … exportSharoushiDetailCsv
 *   社労士提出用Excel（社員別シート・.xlsx）           … exportSharoushiTimecardXlsx（XlsxWriter.gs で作る）
 *
 * 【期間】勤怠・社労士用は20日締め（getPayrollPeriodByMonthKey_）。接客・日報は暦月（getReportMonthPeriod_）。
 * 【実働】勤務区間履歴・中断履歴から計算した値（勤怠記録の実働時間は同じ計算で書かれている）を使う。
 *   実働 ＝ 勤務区間 − 中断（私用の中抜け） − 自動休憩（昼休み）。
 * 【まだ計算しないもの】法定時間外・週40時間・深夜・法定休日・割増・フレックスの法定時間外・フレックスの有給算入
 *   （社労士の確認待ち。社労士確認用の詳細表では「未確定」の列として空欄で出す）
 */

/** 社労士確認用の詳細表で、まだ計算しない列（見出しに「未確定」と付けて空欄で出す） */
const SHAROUSHI_UNDECIDED_COLUMNS = ['法定時間外（未確定）', '深夜（未確定）', '法定休日（未確定）'];

/** 要確認の理由の区分 */
const CHECK_CATEGORIES = { PUNCH: '打刻', OVERTIME: '残業', REQUEST: '有給・申請', REPORT: '日報' };

// ============================================================ 画面・出力から呼ぶ関数（管理者だけ）

/**
 * 【管理者】社員1名の20日締め1か月を1日1行で返す（勤務のない日も1行）。勤務区間・中断・交通費の明細つき。
 * @param {string} employeeId 社員ID
 * @param {string} [month] '2026-10'（2026/09/21〜2026/10/20）。省略すると今日を含む期間
 */
function getAdminEmployeeMonth(employeeId, month) {
  return runApi_(function () {
    requireAdmin();
    const env = buildMonthlyEnv_(month);
    const staff = requireStaffForMonthly_(employeeId);
    const result = buildEmployeeMonth_(env, staff);
    return { message: staff.name + ' の ' + env.range.periodText + ' を取得しました', data: result };
  });
}

/** 【管理者】社員1名の詳細CSV（1日1行。勤務のない日も出す） */
function exportAdminEmployeeMonthCsv(employeeId, month) {
  return runApi_(function () {
    requireAdmin();
    const env = buildMonthlyEnv_(month);
    const staff = requireStaffForMonthly_(employeeId);
    const m = buildEmployeeMonth_(env, staff);
    const headers = ['日付', '曜日', '勤務場所', '勤務区間数', '勤務区間', '出勤', '退勤', '中断', '自動休憩', '実働', '会社時間', '在宅時間',
      '遅刻', '早退', '社内超過', '休日出勤', '休日出勤時間', '有給種別', '有給時間', '直行', '直帰', '現場', '出張', '日備考',
      '業務走行距離', '交通費', '残業申請', '日報', '要確認の理由'];
    const lines = [headers.map(csvCell_).join(',')];
    m.days.forEach(function (d) {
      lines.push([d.date, d.weekday, d.workPlace, d.segmentCount || '', segmentsText_(d.segments), d.clockIn, d.clockOut, d.breakTotal, d.autoBreak, d.workTime,
        d.officeTime, d.remoteTime, d.late, d.earlyLeave, d.internalExcess, d.holidayWork ? '○' : '', d.holidayWork ? d.holidayWorkTime : '',
        d.leaveType, d.leaveTime, d.direct ? '○' : '', d.directReturn ? '○' : '', d.sites.join('・'), d.businessTrip ? '○' : '', d.dayNote,
        d.kmText, d.transportAmount ? String(d.transportAmount) : '', d.overtimeRequest, d.reportStatus, reasonsText_(d.reasons)].map(csvCell_).join(','));
    });
    const t = m.totals;
    lines.push(['合計', '', '', '', '', t.workDays + '日', '', t.breakTotal, t.autoBreak, t.workTime, t.officeTime, t.remoteTime, t.late, t.earlyLeave,
      t.internalExcess, t.holidayWorkDays + '日', t.holidayWorkTime, '', t.leaveTime, t.directDays + '日', t.directReturnDays + '日', '',
      t.businessTripDays + '日', '', t.kmText, String(t.transportAmount), '', '提出 ' + t.reportSubmitted + '件', '要確認 ' + t.checkDays + '日'].map(csvCell_).join(','));
    return {
      message: staff.name + ' の詳細CSVを作成しました（' + env.range.periodText + '）',
      data: { fileName: 'kintai_detail_' + staff.employeeId + '_' + env.range.monthKey + '.csv', csv: '﻿' + lines.join('\r\n') },
    };
  });
}

/**
 * 【管理者】月次の集計：接客集計・日報確認集計（どちらも暦月）と、理由付き要確認一覧（20日締め）。
 * @param {string} [month] '2026-10'
 */
function getAdminMonthlyAnalysis(month) {
  return runApi_(function () {
    requireAdmin();
    const env = buildMonthlyEnv_(month);
    const reportRange = getReportMonthPeriod_(env.range.monthKey);
    return {
      message: '月次の集計を取得しました',
      data: {
        month: env.range.monthKey,
        sales: buildSalesSummary_(env, reportRange),
        reports: buildReportSummary_(env, reportRange),
        checks: buildCheckList_(env),
      },
    };
  });
}

/** 【管理者】月次サマリーCSV（社員ごとの合計。20日締め） */
function exportAdminMonthlySummaryCsv(month) {
  return runApi_(function () {
    requireAdmin();
    const env = buildMonthlyEnv_(month);
    const monthly = buildAdminMonthly_(env.ctx, env.range.monthKey);
    const headers = ['社員ID', '氏名', '部署', '勤務区分', '出勤日数', '実働', '遅刻合計', '遅刻回数', '早退合計', '社内超過合計', '打刻漏れ件数',
      '打刻修正申請件数', '残業要確認件数', '休日出勤日数', '休日出勤時間', '1日有給', '午前半休', '午後半休', '有給時間', '在宅日数', '業務走行距離',
      '交通費（通勤以外）', '要確認（申請）件数', 'フレックス月所定', 'フレックス実働', 'フレックス有給', 'フレックス残り', 'フレックス超過', 'フレックス有給算入'];
    const lines = [headers.map(csvCell_).join(',')];
    monthly.rows.forEach(function (r) {
      const d = r.days || {};
      const f = r.flex || {};
      lines.push([r.employeeId, r.name, r.department, r.workType, r.workDays, r.workTime, r.lateTotal, r.lateCount, r.earlyLeaveTotal,
        r.workType === WORK_TYPES.FLEX ? '' : r.internalExcessTotal, r.missingPunchCount, r.correctionCount, r.needsCheckCount,
        d.holidayWorkDays || 0, d.holidayWorkTime || '00:00', d.fullLeaveDays || 0, d.amLeaveDays || 0, d.pmLeaveDays || 0, d.leaveTime || '00:00',
        d.remoteDays || 0, r.mileageText, r.transportAmount, d.checkCount || 0,
        f.scheduled || '', f.worked || '', f.paidLeave || '', f.remaining || '', f.excess || '', r.flex ? f.paidLeaveMode : ''].map(csvCell_).join(','));
    });
    return {
      message: env.range.periodText + ' の月次サマリーCSVを作成しました（' + monthly.rows.length + '名）',
      data: { fileName: 'kintai_summary_' + env.range.monthKey + '.csv', csv: '﻿' + lines.join('\r\n') },
    };
  });
}

/**
 * 【管理者】社労士確認用の詳細表（CSV）。勤怠集計対象の社員×20日締め期間の全日を1日1行、社員ごとに合計行。
 * 確定している項目だけを値で出す（数式なし）。法定時間外・深夜・法定休日は「未確定」の列として空欄。
 */
function exportSharoushiDetailCsv(month) {
  return runApi_(function () {
    requireAdmin();
    const env = buildMonthlyEnv_(month);
    const headers = ['社員ID', '氏名', '勤務区分', '日付', '曜日', '出勤', '退勤', '勤務区間', '会社時間', '在宅時間', '中断（私用の中抜け）',
      '休憩（自動）', '実働', '休日出勤（承認済み）', '休日出勤時間', '有給種別', '有給時間', '出張', '直行', '直帰', '要確認の理由'].concat(SHAROUSHI_UNDECIDED_COLUMNS);
    const lines = [headers.map(csvCell_).join(',')];
    const blanks = SHAROUSHI_UNDECIDED_COLUMNS.map(function () { return ''; });
    const staffList = visibleStaff_(env.ctx);
    staffList.forEach(function (s) {
      const m = buildEmployeeMonth_(env, s);
      m.days.forEach(function (d) {
        lines.push([s.employeeId, s.name, s.workType, d.date, d.weekday, d.clockIn, d.clockOut, segmentsText_(d.segments), d.officeTime, d.remoteTime,
          d.breakTotal, d.autoBreak, d.workTime, d.holidayWork ? '○' : '', d.holidayWork ? d.holidayWorkTime : '', d.leaveType, d.leaveTime,
          d.businessTrip ? '○' : '', d.direct ? '○' : '', d.directReturn ? '○' : '', reasonsText_(d.reasons)].concat(blanks).map(csvCell_).join(','));
      });
      const t = m.totals;
      lines.push([s.employeeId, s.name, s.workType, '合計', '', t.workDays + '日', '', '', t.officeTime, t.remoteTime, t.breakTotal, t.autoBreak, t.workTime,
        t.holidayWorkDays + '日', t.holidayWorkTime, '', t.leaveTime, t.businessTripDays + '日', t.directDays + '日', t.directReturnDays + '日',
        '要確認 ' + t.checkDays + '日'].concat(blanks).map(csvCell_).join(','));
    });
    return {
      message: env.range.periodText + ' の社労士確認用の詳細表を作成しました（' + staffList.length + '名）',
      data: {
        fileName: 'sharoushi_check_' + env.range.monthKey + '.csv', csv: '﻿' + lines.join('\r\n'),
        notes: [
          '期間：' + env.range.periodText + '（20日締め）。勤怠集計対象の社員だけ',
          '実働 ＝ 勤務区間 − 中断（私用の中抜け） − 休憩（自動。中断を除いた勤務が「自動休憩_適用開始」を超えた日）',
          '休日出勤は承認済みの休日出勤申請がある日。休日と法定休日の区別はしていません',
          '法定時間外・深夜・法定休日は社労士の確認待ちのため空欄（未確定）です',
        ],
      },
    };
  });
}

/**
 * 【管理者】社労士提出用Excel（社員別シート）。勤怠集計対象の社員を1人1シート（20日締め1か月・全日を1日1行・合計行）。
 * 元の「【改定版】タイムカード」の列構成に合わせ、固定勤務は A形式、フレックスは B形式（フレックスの月集計つき）。
 * 勤務区分がどちらでもない人は出さない。基本列のあとに直行・直帰・勤務区間・備考・要確認の理由を足す。
 * 値だけを入れる（数式なし）。法定時間外・深夜・法定休日（A形式は法定内も）は「未確定」として空欄。給与の項目は出さない。
 * 会社時間・在宅時間・遅刻・早退・社内超過・有給種別・有給時間は社内管理用なので出さない（社内詳細月次・CSVにはある）。
 * ドライブに一時ファイルは作らず、元のシートにも書き込まない（.xlsx をその場で作って base64 で返す）。
 * @param {string} [month] '2026-10'
 * @return data: { fileName, mimeType, base64, sheetNames, skipped: [{ employeeId, name, workType }] }
 */
function exportSharoushiTimecardXlsx(month) {
  return runApi_(function () {
    requireAdmin();
    const env = buildMonthlyEnv_(month);
    const flexByEmployee = {};
    buildAdminMonthly_(env.ctx, env.range.monthKey).rows.forEach(function (r) { if (r.flex) flexByEmployee[r.employeeId] = r.flex; });
    const used = {};
    const sheets = [];
    const skipped = [];
    visibleStaff_(env.ctx).forEach(function (s) {
      if (s.workType !== WORK_TYPES.FIXED && s.workType !== WORK_TYPES.FLEX) {
        skipped.push({ employeeId: s.employeeId, name: s.name, workType: s.workType });
        return;
      }
      const m = buildEmployeeMonth_(env, s);
      const sheet = buildTimecardSheet_(env, m, s.workType === WORK_TYPES.FLEX ? flexByEmployee[s.employeeId] || null : undefined);
      sheet.name = xlsxSheetName_(s.name, s.employeeId, used);
      sheets.push(sheet);
    });
    if (!sheets.length) fail_('出力する社員がいません（勤怠集計対象で、勤務区分が固定勤務・フレックスの社員）');
    const fileName = '社労士提出用タイムカード_' + env.range.monthKey + '.xlsx';
    const blob = buildXlsxBlob_(sheets, fileName);
    return {
      message: env.range.periodText + ' の社労士提出用Excelを作成しました（' + sheets.length + '名）' +
        (skipped.length ? '。勤務区分が未設定などで出さなかった人：' + skipped.map(function (x) { return x.name; }).join('、') : ''),
      data: {
        fileName: fileName, mimeType: XLSX_MIME_TYPE, base64: Utilities.base64Encode(blob.getBytes()),
        sheetNames: sheets.map(function (x) { return x.name; }), skipped: skipped,
      },
    };
  });
}

/** 社労士提出用Excelの日別の行数（20日締めの期間は最大31日。足りない行は空欄の枠。元のタイムカードと同じ） */
const TIMECARD_DAY_ROWS = 31;

/**
 * 列：見出し（2段。sub は2段目）・幅・種類。元の「【改定版】タイムカード」の列名・並びに合わせる。
 *   kind: date 日付／text 文字（中央）／time 時刻・時間／mark ○／wide 長い文字（左寄せ・折り返し）／undecided 未確定（空欄）
 */
const TIMECARD_COLUMNS = {
  date: { header: '日付', width: 10.33, kind: 'date' },
  weekday: { header: '曜日', width: 5.5, kind: 'text' },
  clockIn: { header: '出勤', width: 7.5, kind: 'time' },
  clockOut: { header: '退勤', width: 7.5, kind: 'time' },
  remoteStart: { header: '在宅開始', width: 7.5, kind: 'time' },
  remoteEnd: { header: '在宅終了', width: 7.5, kind: 'time' },
  rest: { header: '休憩', width: 7.5, kind: 'time' },
  work1: { header: '労働1', sub: '会社等', width: 7.5, kind: 'time' },
  work2: { header: '労働2', sub: '在宅', width: 7.5, kind: 'time' },
  workTime: { header: '労働時間', width: 7.5, kind: 'time' },
  legalOvertime: { header: '法定時間外', sub: '未確定', width: 7.5, kind: 'undecided' },
  lateNight: { header: '深夜', sub: '未確定', width: 7.5, kind: 'undecided' },
  legalWithin: { header: '法定内', sub: '未確定', width: 7.5, kind: 'undecided' },
  holiday: { header: '休日', sub: '承認済み', width: 7.5, kind: 'time' },
  legalHoliday: { header: '法定休日', sub: '未確定', width: 7.5, kind: 'undecided' },
  businessTrip: { header: '出張', width: 5.5, kind: 'mark' },
  direct: { header: '直行', width: 5.5, kind: 'mark' },
  directReturn: { header: '直帰', width: 5.5, kind: 'mark' },
  segments: { header: '勤務区間', width: 28, kind: 'wide' },
  reasons: { header: '備考・要確認の理由', width: 32, kind: 'wide' },
};

/**
 * A形式（固定勤務）と B形式（フレックス）の列の並び。
 * 元のタイムカードの基本列のあとに、直行・直帰・勤務区間・備考・要確認の理由を足す。
 * 会社時間・在宅時間・遅刻・早退・社内超過・有給種別・有給時間は社内管理用なので出さない（社内詳細月次・CSVにはある）。
 */
const TIMECARD_LAYOUTS = {
  A: ['date', 'weekday', 'clockIn', 'clockOut', 'rest', 'workTime', 'legalOvertime', 'lateNight', 'legalWithin', 'holiday', 'legalHoliday',
    'direct', 'directReturn', 'segments', 'reasons'],
  B: ['date', 'weekday', 'clockIn', 'clockOut', 'remoteStart', 'remoteEnd', 'rest', 'work1', 'work2', 'workTime', 'lateNight', 'legalOvertime',
    'holiday', 'businessTrip', 'direct', 'directReturn', 'segments', 'reasons'],
};

/** 社労士提出用の備考：残業の事前申請の要確認（社内ルール。法定時間外の判定ではない） */
const TIMECARD_OVERTIME_NOTE = '社内確認：30分以上の社内超過に対する承認済み事前申請なし';

/** 'YYYY-MM-DD' → Excel の日付の数値（1900年方式） */
function xlsxDateValue_(dateKey) {
  const p = String(dateKey).split('-').map(Number);
  return (Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(1899, 11, 30)) / 86400000;
}

/**
 * 社労士提出用の1日分の値（元のタイムカードの列に合わせた形）。新しい法的な計算はしない。
 *   A形式：出勤＝最初の開始、退勤＝最後の終了、休憩＝（退勤−出勤）−労働時間（中断・自動休憩・退勤〜再出勤の間を含む）
 *   B形式：出勤・退勤＝会社等（会社・旧現場・旧外出）の区間の最初の開始・最後の終了、在宅開始・終了＝在宅の区間の最初・最後、
 *          労働1＝会社等の区間の長さの合計、労働2＝在宅の区間の長さの合計、休憩＝労働1＋労働2−労働時間（中断・自動休憩）
 *   労働時間＝システムの実働（勤務区間 − 中断 − 自動休憩）。休日＝承認済みの休日出勤の日の実働
 *   備考・要確認の理由：有給・休日出勤・出張（A形式）・休憩の内訳・日備考・打刻漏れなどの要確認（日報の未提出は社内用なので入れない）。
 *     残業の事前申請なしは「社内確認：…」と書き、社内ルールの確認事項であることを示す（TIMECARD_OVERTIME_NOTE）
 */
function buildTimecardDay_(d, isFlex) {
  const toMin = function (t) { const v = toMinutes_(t); return v === null ? null : v; };
  const work = toMin(d.workTime);
  const autoBreak = toMin(d.autoBreak) || 0;
  const interruption = toMin(d.breakTotal) || 0;
  const v = { clockIn: d.clockIn, clockOut: d.clockOut, workTime: d.workTime, rest: '' };
  const lengthOf = function (s) {
    const a = toMin(s.start);
    const b = toMin(s.end);
    if (a === null || b === null) return null;
    return b >= a ? b - a : b + 1440 - a; // 日をまたぐ区間
  };
  let gap = 0;
  if (isFlex) {
    const office = d.segments.filter(function (s) { return s.place !== '在宅'; });
    const remote = d.segments.filter(function (s) { return s.place === '在宅'; });
    const sum = function (list) {
      return list.reduce(function (t, s) { const len = lengthOf(s); return t === null || len === null ? null : t + len; }, 0);
    };
    v.clockIn = office.length ? office[0].start : '';
    v.clockOut = office.length ? office[office.length - 1].end : '';
    v.remoteStart = remote.length ? remote[0].start : '';
    v.remoteEnd = remote.length ? remote[remote.length - 1].end : '';
    const w1 = office.length ? sum(office) : 0;
    const w2 = remote.length ? sum(remote) : 0;
    v.work1 = office.length && w1 !== null ? formatMinutes_(w1) : '';
    v.work2 = remote.length && w2 !== null ? formatMinutes_(w2) : '';
    if (work !== null && w1 !== null && w2 !== null && w1 + w2 >= work) v.rest = formatMinutes_(w1 + w2 - work);
  } else {
    const start = toMin(d.clockIn);
    const end = toMin(d.clockOut);
    if (work !== null && start !== null && end !== null) {
      const span = end >= start ? end - start : end + 1440 - start;
      if (span >= work) {
        v.rest = formatMinutes_(span - work);
        gap = Math.max(0, span - work - autoBreak - interruption);
      }
    }
  }
  const notes = [];
  if (d.leaveType) notes.push('有給：' + d.leaveType + (d.leaveTime ? '（' + d.leaveTime + '）' : ''));
  if (d.holidayWork) notes.push('休日出勤（承認済み）');
  if (!isFlex && d.businessTrip) notes.push('出張');
  if (v.rest && (interruption || gap)) {
    notes.push('休憩の内訳：' + ['自動休憩 ' + formatMinutes_(autoBreak), interruption ? '中断（私用の中抜け） ' + formatMinutes_(interruption) : '',
      gap ? '退勤〜再出勤の間 ' + formatMinutes_(gap) : ''].filter(function (x) { return x; }).join('＋'));
  }
  if (d.dayNote) notes.push('備考：' + d.dayNote);
  d.reasons.forEach(function (r) {
    if (r.category === CHECK_CATEGORIES.REPORT) return;
    // 残業の事前申請は社内ルールの確認事項。法定時間外の判定と混同しないよう、社労士提出用では言い方を変える
    notes.push(r.category === CHECK_CATEGORIES.OVERTIME ? TIMECARD_OVERTIME_NOTE : r.text);
  });
  v.notes = notes;
  return v;
}

/** 列幅（文字数）の欄に文字を折り返して入れたときの行数の目安（全角は2、半角は1と数える。文字は10ポイント） */
function timecardTextLines_(text, width) {
  const units = String(text || '').split('').reduce(function (t, c) { return t + (c.charCodeAt(0) > 255 ? 2 : 1); }, 0);
  return Math.max(1, Math.ceil(units / Math.max(1, (width - 1) * 1.05)));
}

/**
 * 社員1名のシート（buildXlsxBlob_ に渡す形。name は呼び出し側で付ける）。見た目は元の「【改定版】タイムカード」に寄せる
 * （1行目：月・氏名、2〜3行目：2段の見出し、4〜34行目：31日分の枠、35行目：合計）。A4横・1ページに収める。
 * @param {Object} m buildEmployeeMonth_ の結果
 * @param {Object|null|undefined} flex B形式のときのフレックスの月集計（buildAdminMonthly_ の rows[].flex）。A形式は undefined
 */
function buildTimecardSheet_(env, m, flex) {
  const isFlex = flex !== undefined;
  const keys = TIMECARD_LAYOUTS[isFlex ? 'B' : 'A'];
  const n = keys.length;
  const last = xlsxColumnName_(n);
  const rows = [];
  const merges = [];
  const heights = [];
  const cell = function (v, s) { return { v: v, s: s }; };
  const timeCell = function (text, timeStyle, textStyle) {
    const t = xlsxTimeValue_(text);
    return t === null ? cell(text || '', textStyle) : cell(t, timeStyle);
  };
  const closing = env.range.closingDay ? env.range.closingDay + '日締め' : '末日締め';
  const formLabel = isFlex ? 'B形式（フレックス）' : 'A形式（固定勤務）';

  // 1行目：対象月・氏名・社員ID・対象期間（元のタイムカードの「月」「氏名」の行）
  const head = [];
  const put = function (from, to, value, style) {
    head[from - 1] = cell(value, style);
    for (let c = from + 1; c <= to; c++) head[c - 1] = cell('', style);
    if (to > from) merges.push(xlsxColumnName_(from) + '1:' + xlsxColumnName_(to) + '1');
  };
  put(1, 2, env.range.label, 'month');
  put(3, 5, m.employee.name, 'name');
  put(6, 7, '社員ID：' + m.employee.employeeId, 'info');
  put(8, n, '対象期間：' + m.from.replace(/-/g, '/') + '～' + m.to.replace(/-/g, '/') + '（' + closing + '）　勤務区分：' + m.employee.workType + '　' + formLabel, 'info');
  rows.push(head);
  heights[0] = 24;

  // 2〜3行目：見出し（2段目がない列は縦に結合）
  rows.push(keys.map(function (k) { return cell(TIMECARD_COLUMNS[k].header, TIMECARD_COLUMNS[k].kind === 'undecided' ? 'undecidedHeader' : 'header'); }));
  rows.push(keys.map(function (k) {
    const c = TIMECARD_COLUMNS[k];
    return cell(c.sub || '', c.kind === 'undecided' ? 'undecidedSub' : 'subHeader');
  }));
  keys.forEach(function (k, i) { if (!TIMECARD_COLUMNS[k].sub) merges.push(xlsxColumnName_(i + 1) + '2:' + xlsxColumnName_(i + 1) + '3'); });
  heights[1] = 19.95;
  heights[2] = 15;

  // 4〜34行目：期間の全日（勤務のない日・休日も1行。31行の枠）
  const totals = { rest: 0, work1: 0, work2: 0, workTime: 0, holiday: 0, clockIn: 0, businessTrip: 0, direct: 0, directReturn: 0, holidayDays: 0, checkDays: 0 };
  for (let i = 0; i < TIMECARD_DAY_ROWS; i++) {
    const d = m.days[i];
    heights[rows.length] = 19.95;
    if (!d) {
      rows.push(keys.map(function (k) {
        const kind = TIMECARD_COLUMNS[k].kind;
        return cell('', kind === 'undecided' ? 'undecided' : kind === 'date' ? 'date' : kind === 'time' ? 'time' : kind === 'wide' ? 'text' : 'center');
      }));
      continue;
    }
    const v = buildTimecardDay_(d, isFlex);
    const leave = !!d.leaveType;
    const suffix = leave ? 'Leave' : '';
    const values = {
      date: xlsxDateValue_(d.date), weekday: d.weekday, clockIn: v.clockIn, clockOut: v.clockOut, remoteStart: v.remoteStart, remoteEnd: v.remoteEnd,
      rest: v.rest, work1: v.work1, work2: v.work2, workTime: v.workTime, holiday: d.holidayWork ? d.holidayWorkTime : '',
      businessTrip: d.businessTrip ? '○' : '', direct: d.direct ? '○' : '', directReturn: d.directReturn ? '○' : '',
      segments: segmentsText_(d.segments), reasons: v.notes.join('・'),
    };
    // 行の高さ：元のタイムカードと同じ 19.95。勤務区間・備考が長い日は折り返す行数に合わせて高くする（文字が切れないように）
    heights[rows.length] = Math.max(19.95, Math.max(timecardTextLines_(values.segments, TIMECARD_COLUMNS.segments.width),
      timecardTextLines_(values.reasons, TIMECARD_COLUMNS.reasons.width)) * 12.5 + 4);
    ['rest', 'work1', 'work2', 'workTime', 'holiday'].forEach(function (k) { totals[k] += toMinutes_(values[k]) || 0; });
    if (d.worked) totals.clockIn += 1;
    if (d.holidayWork) totals.holidayDays += 1;
    if (d.businessTrip) totals.businessTrip += 1;
    if (d.direct) totals.direct += 1;
    if (d.directReturn) totals.directReturn += 1;
    if (d.reasons.some(function (r) { return r.category !== CHECK_CATEGORIES.REPORT; })) totals.checkDays += 1;
    rows.push(keys.map(function (k) {
      const kind = TIMECARD_COLUMNS[k].kind;
      if (kind === 'undecided') return cell('', 'undecided');
      if (kind === 'date') return cell(values.date, 'date' + suffix);
      if (kind === 'time') return timeCell(values[k], 'time' + suffix, 'center' + suffix);
      if (kind === 'wide') return cell(values[k] || '', 'text' + suffix);
      return cell(values[k] || '', 'center' + suffix);
    }));
  }

  // 35行目：合計（時間は [h]:mm、出勤・出張・直行・直帰は日数。法定時間外・深夜・法定内・法定休日は空欄）
  const totalRow = rows.length + 1;
  heights[rows.length] = 19.95;
  const totalValues = {
    date: '合計', clockIn: totals.clockIn + '日', rest: formatMinutes_(totals.rest), work1: formatMinutes_(totals.work1),
    work2: formatMinutes_(totals.work2), workTime: formatMinutes_(totals.workTime), holiday: formatMinutes_(totals.holiday),
    businessTrip: totals.businessTrip + '日', direct: totals.direct + '日', directReturn: totals.directReturn + '日',
    reasons: '休日出勤 ' + totals.holidayDays + '日・要確認 ' + totals.checkDays + '日',
  };
  rows.push(keys.map(function (k) {
    const kind = TIMECARD_COLUMNS[k].kind;
    if (kind === 'undecided') return cell('', 'undecided');
    const value = totalValues[k] === undefined ? '' : totalValues[k];
    if (kind === 'time' && k !== 'clockIn') return timeCell(value, 'totalTime', 'totalText');
    return cell(value, kind === 'wide' ? 'totalLeft' : 'totalText');
  }));
  merges.push('A' + totalRow + ':B' + totalRow);

  // 注意書き
  rows.push([cell('法定時間外・深夜・法定休日' + (isFlex ? '' : '・法定内') + 'は社労士の確認待ちのため空欄（未確定）です。会社の標準退勤からの超過（社内超過）は法定時間外に入れていません。' +
    '労働時間 ＝ 勤務区間 − 中断（私用の中抜け） − 自動休憩（昼休み）。休日は承認済みの休日出勤の日の労働時間。値だけで数式は入れていません。', 'note')]);
  merges.push('A' + rows.length + ':' + last + rows.length);
  heights[rows.length - 1] = 30;

  // B形式：フレックスの月集計（有給の算入が未確定の間は「未確定」）
  if (isFlex) {
    const f = flex || {};
    const mode = f.paidLeaveMode || FLEX_PAID_LEAVE_MODES.UNDECIDED;
    rows.push([cell('フレックスの月集計（' + env.range.label + '）', 'label')]);
    const labels = ['月所定', '実働', '有給', '残り', '超過', '有給算入状態'];
    const values = [f.scheduled, f.worked, f.paidLeave, f.remaining, f.excess, mode];
    rows.push(labels.map(function (label) { return cell(label, 'header'); }));
    rows.push(values.map(function (v, i) { return i === 5 ? cell(v, 'totalText') : timeCell(v, 'valueTime', 'value'); }));
    rows.push([cell(mode === FLEX_PAID_LEAVE_MODES.UNDECIDED
      ? '有給の算入は未確定です（残り・超過には有給を入れていません）。フレックスの法定時間外も未確定です。'
      : '有給の算入：' + mode + '。フレックスの法定時間外は未確定です。', 'note')]);
    merges.push('A' + rows.length + ':' + last + rows.length);
  }
  return {
    widths: keys.map(function (k) { return TIMECARD_COLUMNS[k].width; }),
    rows: rows, merges: merges, rowHeights: heights, landscape: true, fitToHeight: 1, printTitleRows: '$1:$3',
  };
}

// ============================================================ 準備

/** 月次の処理で使う情報（20日締めの期間・管理者画面と同じ集計の準備）を1回だけ読む */
function buildMonthlyEnv_(month) {
  const settings = getSettings_();
  const now = getNowInfo_();
  const range = isBlank_(month)
    ? getPayrollPeriodForDate_(now.date, settings.monthClosingDay)
    : getPayrollPeriodByMonthKey_(requireMonthKey_(month, '対象月'), settings.monthClosingDay);
  const ctx = buildAdminContext_(settings, now.date);
  return { settings: settings, now: now, range: range, ctx: ctx, reportByKey: buildReportStateMap_() };
}

function requireStaffForMonthly_(employeeId) {
  const id = requireText_(employeeId, '社員ID', { max: TEXT_LIMITS.SHORT });
  const staff = findStaffById_(id);
  if (!staff) fail_('社員ID「' + id + '」のスタッフが見つかりません');
  return staff;
}

/** 日報シートを1回読む：社員ID|日付 → { submitted: 行, draft: 行 }（シートがなければ空） */
function buildReportStateMap_() {
  const map = {};
  if (!getSpreadsheet_().getSheetByName(SHEET_NAMES.DAILY_REPORTS)) return map;
  readTable_(SHEET_NAMES.DAILY_REPORTS).records.forEach(function (r) {
    const key = String(r['社員ID']).trim() + '|' + toDateKey_(r['日付']);
    const slot = map[key] = map[key] || {};
    if (reportStateOf_(r) === REPORT_STATE.SUBMITTED) slot.submitted = r; else slot.draft = r;
  });
  return map;
}

// ============================================================ 社内詳細月次（1日1行）

/** 社員1名の期間の日別の行と合計 */
function buildEmployeeMonth_(env, staff) {
  const ctx = env.ctx;
  const range = env.range;
  const transportsByDate = {};
  listTransportRows_(staff.employeeId, range.from, range.to).forEach(function (r) {
    const v = toTransportView_(r);
    (transportsByDate[v.date] = transportsByDate[v.date] || []).push(v);
  });
  const days = listDates_(range.from, range.to).map(function (date) {
    return buildEmployeeDay_(env, staff, date, transportsByDate[date] || []);
  });
  return {
    employee: { employeeId: staff.employeeId, name: staff.name, department: staff.department, workType: staff.workType },
    month: range.monthKey, from: range.from, to: range.to, periodText: range.periodText,
    days: days,
    totals: totalEmployeeDays_(days),
  };
}

/** 1日分（勤怠記録がない日も、有給・交通費・日報があれば出す） */
function buildEmployeeDay_(env, staff, date, transports) {
  const ctx = env.ctx;
  const record = ctx.attendanceByKey[staff.employeeId + '|' + date] || null;
  const view = record ? toAdminAttendanceRow_(record, ctx) : null;
  const st = buildDayStatus_(staff.employeeId, date, record, ctx.day);
  const attendanceId = record ? String(record['勤怠ID']).trim() : '';
  const segments = record ? getDaySegments_(record, ctx.calc.segmentsByAttendance[attendanceId] || []) : [];
  const interruptions = record ? (ctx.calc.breakIntervalsByAttendance[attendanceId] || []) : [];
  const tsum = summarizeTransportItems_(transports);
  const worked = !!record && !isBlank_(record['出勤']);
  const report = reportStatusOfDay_(env, staff, date, worked);
  const day = {
    date: date,
    weekday: WEEKDAY_LABELS[weekdayOf_(date)],
    hasAttendance: !!record,
    worked: worked,
    workPlace: view ? view.workPlace : '',
    segmentCount: view ? Number(view.segmentCount) || segments.length : 0,
    segments: segments.map(function (s) {
      return {
        place: workPlaceLabel_(s.style), start: minutesToClock_(s.startMinutes), end: s.endMinutes === null ? '' : minutesToClock_(s.endMinutes),
        direct: !!s.direct, directReturn: !!s.directReturn, site: s.site || '', note: s.note || '',
      };
    }),
    interruptions: interruptions.map(function (b) { return { start: minutesToClock_(b.startMinutes), end: minutesToClock_(b.endMinutes) }; }),
    clockIn: view ? view.clockIn : '',
    clockOut: view ? view.clockOut : '',
    breakTotal: view ? view.breakTotal : '',
    autoBreak: view ? view.autoBreak : '',
    workTime: view ? view.workTime : '',
    officeTime: view ? view.officeTime : '',
    remoteTime: view ? view.remoteTime : '',
    late: view ? view.late : '',
    earlyLeave: view ? view.earlyLeave : '',
    internalExcess: view ? view.internalExcess : '',
    holidayWork: st.kind === '休日出勤' || st.kind === '法定休日出勤',
    holidayWorkTime: st.holidayWork ? formatMinutes_(st.holidayWork.minutes) : '',
    leaveType: st.leave ? st.leave.type : '',
    leaveTime: st.leave ? formatMinutes_(st.leave.minutes) : '',
    direct: view ? !!view.direct : false,
    directReturn: view ? !!view.directReturn : false,
    sites: view ? view.sites : [],
    businessTrip: view ? !!view.businessTrip : false,
    dayNote: view ? view.dayNote : '',
    km: tsum.km,
    kmText: tsum.km ? tsum.kmText : '',
    transportAmount: tsum.amount,
    transportCount: tsum.count,
    transports: transports,
    overtimeRequest: view ? view.preOvertimeRequest : '',
    reportStatus: report.label,
    reportState: report.state,
    reasons: collectDayReasons_(view, st, report),
  };
  return day;
}

/**
 * その日の日報の状態（暦月とは関係なく、その日の日報）。判定は judgeReportDay_（日報_未提出判定開始日を含む）。
 *   提出済み／未提出（下書きあり）／未提出（出勤ありの日報提出対象者で、開始日以降・前日まで）／空欄（対象外・開始日前・今日・先の日）
 */
function reportStatusOfDay_(env, staff, date, worked) {
  const slot = env.reportByKey[staff.employeeId + '|' + date] || {};
  return judgeReportDay_({ date: date, today: env.now.date, worked: worked, submitTarget: staff.reportSubmitTarget,
    submitted: !!slot.submitted, draft: !!slot.draft, settings: env.settings });
}

/**
 * 理由付きの要確認（1日分）。勤怠記録の1列の「要確認」（残業の事前申請）とは別に、理由ごとに返す。
 * 戻り値：[{ category: 打刻|残業|有給・申請|日報, text }]
 */
function collectDayReasons_(view, st, report) {
  const reasons = [];
  if (view) {
    (view.issues || []).forEach(function (t) { reasons.push({ category: CHECK_CATEGORIES.PUNCH, text: t }); });
    if (view.needsCheck === MARKS.NEEDS_CHECK) reasons.push({ category: CHECK_CATEGORIES.OVERTIME, text: '残業：30分以上で承認済みの事前申請なし' });
  }
  (st.checks || []).forEach(function (t) { reasons.push({ category: CHECK_CATEGORIES.REQUEST, text: t }); });
  if (report.state === 'missing') reasons.push({ category: CHECK_CATEGORIES.REPORT, text: '日報未提出' });
  if (report.state === 'draft') reasons.push({ category: CHECK_CATEGORIES.REPORT, text: '日報未提出（下書きあり）' });
  return reasons;
}

function totalEmployeeDays_(days) {
  const sumTime = function (key) { return days.reduce(function (t, d) { return t + (toMinutes_(d[key]) || 0); }, 0); };
  const count = function (fn) { return days.filter(fn).length; };
  const km = Math.round(days.reduce(function (t, d) { return t + d.km * 10; }, 0)) / 10;
  return {
    workDays: count(function (d) { return d.worked; }),
    breakTotal: formatMinutes_(sumTime('breakTotal')),
    autoBreak: formatMinutes_(sumTime('autoBreak')),
    workTime: formatMinutes_(sumTime('workTime')),
    officeTime: formatMinutes_(sumTime('officeTime')),
    remoteTime: formatMinutes_(sumTime('remoteTime')),
    late: formatMinutes_(sumTime('late')),
    earlyLeave: formatMinutes_(sumTime('earlyLeave')),
    internalExcess: formatMinutes_(sumTime('internalExcess')),
    holidayWorkDays: count(function (d) { return d.holidayWork; }),
    holidayWorkTime: formatMinutes_(sumTime('holidayWorkTime')),
    leaveDays: count(function (d) { return !!d.leaveType; }),
    leaveTime: formatMinutes_(sumTime('leaveTime')),
    directDays: count(function (d) { return d.direct; }),
    directReturnDays: count(function (d) { return d.directReturn; }),
    businessTripDays: count(function (d) { return d.businessTrip; }),
    km: km,
    kmText: formatKm_(km),
    transportAmount: days.reduce(function (t, d) { return t + d.transportAmount; }, 0),
    reportSubmitted: count(function (d) { return d.reportState === 'submitted'; }),
    reportMissing: count(function (d) { return d.reportState === 'missing'; }),
    reportDraftOnly: count(function (d) { return d.reportState === 'draft'; }),
    checkDays: count(function (d) { return d.reasons.length > 0; }),
  };
}

/** 「会社 09:00〜12:00（直行・現場：〇〇）／在宅 13:00〜18:00」 */
function segmentsText_(segments) {
  return (segments || []).map(function (s) {
    const extra = [s.direct ? '直行' : '', s.directReturn ? '直帰' : '', s.site ? '現場：' + s.site : ''].filter(function (x) { return x; });
    return s.place + ' ' + s.start + '〜' + (s.end || '（勤務中）') + (extra.length ? '（' + extra.join('・') + '）' : '');
  }).join('／');
}

function reasonsText_(reasons) {
  return (reasons || []).map(function (r) { return r.text; }).join('・');
}

// ============================================================ 理由付き要確認一覧（20日締め）

/** 勤怠集計対象の社員の、期間内で要確認の理由がある日（今日まで）。理由ごとの件数つき */
function buildCheckList_(env) {
  const items = [];
  const byCategory = {};
  const byReason = {};
  Object.keys(CHECK_CATEGORIES).forEach(function (k) { byCategory[CHECK_CATEGORIES[k]] = 0; });
  const last = env.range.to < env.now.date ? env.range.to : env.now.date;
  visibleStaff_(env.ctx).forEach(function (s) {
    const m = buildEmployeeMonth_(env, s);
    m.days.forEach(function (d) {
      if (d.date > last || !d.reasons.length) return;
      items.push({ date: d.date, weekday: d.weekday, employeeId: s.employeeId, name: s.name, reasons: d.reasons });
      d.reasons.forEach(function (r) {
        byCategory[r.category] = (byCategory[r.category] || 0) + 1;
        byReason[r.text] = (byReason[r.text] || 0) + 1;
      });
    });
  });
  items.sort(function (a, b) { return a.date !== b.date ? (a.date < b.date ? -1 : 1) : (a.employeeId < b.employeeId ? -1 : 1); });
  return {
    from: env.range.from, to: env.range.to, periodText: env.range.periodText, until: last,
    items: items, byCategory: byCategory,
    byReason: Object.keys(byReason).sort().map(function (k) { return { reason: k, count: byReason[k] }; }),
  };
}

// ============================================================ 接客集計（暦月）

/** 来場きっかけの小計（以前の値は書き換えず、表示用に「（旧）」を付けて小計に含める） */
const VISIT_TRIGGER_GROUPS = [
  { name: '検索（合計）', members: ['Google検索', 'Yahoo!検索', '検索（不明）', 'Web検索'] },
  { name: 'イベント（合計）', members: ['イベント（見学会など）', 'イベント'] },
];

/**
 * 接客の集計（提出済みの日報の接客記録だけ。下書きは数えない）。
 *   会社の接客件数 ＝ 主担当の件数だけ（担当区分が空欄の以前の記録は主担当）
 *   副担当参加件数 ＝ 副担当の件数（会社の件数には足さない）
 *   来場きっかけ別 ＝ 主担当の記録で数える（同じ接客を副担当の分まで数えない）
 */
function buildSalesSummary_(env, reportRange) {
  const ss = getSpreadsheet_();
  const empty = { from: reportRange.from, to: reportRange.to, periodText: reportRange.periodText, companyMainCount: 0, subCount: 0, employees: [], triggers: [], groups: [], warnings: [] };
  if (!ss.getSheetByName(SHEET_NAMES.DAILY_REPORTS) || !ss.getSheetByName(SHEET_NAMES.REPORT_CUSTOMERS)) return empty;
  const reports = {};
  readTable_(SHEET_NAMES.DAILY_REPORTS).records.forEach(function (r) {
    const date = toDateKey_(r['日付']);
    if (date < reportRange.from || date > reportRange.to || reportStateOf_(r) !== REPORT_STATE.SUBMITTED) return;
    reports[String(r['日報ID']).trim()] = { date: date, employeeId: String(r['社員ID']).trim(), name: toPlainText_(r['氏名']) };
  });
  const rows = [];
  readTable_(SHEET_NAMES.REPORT_CUSTOMERS).records.forEach(function (r) {
    if (String(r['削除']).trim() === '1') return;
    const rep = reports[String(r['日報ID']).trim()];
    if (!rep) return;
    rows.push({
      date: rep.date, employeeId: rep.employeeId, name: rep.name,
      role: toPlainText_(r['担当区分']).trim() || CUSTOMER_ROLES.MAIN,
      mainStaffId: toPlainText_(r['主担当者ID']).trim(), mainStaffName: toPlainText_(r['主担当者名']),
      customerName: toPlainText_(r['顧客名']), unknown: String(r['顧客名未確認']).trim() === '1',
      trigger: toPlainText_(r['来場のきっかけ']).trim(),
    });
  });

  const byEmployee = {};
  const staffName = {};
  env.ctx.staffList.forEach(function (s) { staffName[s.employeeId] = s.name; });
  rows.forEach(function (x) {
    const e = byEmployee[x.employeeId] = byEmployee[x.employeeId] || { employeeId: x.employeeId, name: staffName[x.employeeId] || x.name, mainCount: 0, subCount: 0 };
    if (x.role === CUSTOMER_ROLES.SUB) e.subCount += 1; else e.mainCount += 1;
  });
  const mains = rows.filter(function (x) { return x.role !== CUSTOMER_ROLES.SUB; });
  const triggerCount = {};
  mains.forEach(function (x) { const k = x.trigger || '（未入力）'; triggerCount[k] = (triggerCount[k] || 0) + 1; });
  const order = VISIT_TRIGGERS.concat(LEGACY_VISIT_TRIGGERS, ['（未入力）']);
  const triggers = Object.keys(triggerCount).sort(function (a, b) {
    const ia = order.indexOf(a) === -1 ? 999 : order.indexOf(a);
    const ib = order.indexOf(b) === -1 ? 999 : order.indexOf(b);
    return ia - ib;
  }).map(function (k) {
    const legacy = LEGACY_VISIT_TRIGGERS.indexOf(k) !== -1;
    return { trigger: k, label: legacy ? k + '（旧）' : k, legacy: legacy, count: triggerCount[k] };
  });
  const groups = VISIT_TRIGGER_GROUPS.map(function (g) {
    return { name: g.name, members: g.members, count: g.members.reduce(function (t, k) { return t + (triggerCount[k] || 0); }, 0) };
  });

  return {
    from: reportRange.from, to: reportRange.to, periodText: reportRange.periodText,
    companyMainCount: mains.length,
    subCount: rows.length - mains.length,
    employees: Object.keys(byEmployee).map(function (k) { return byEmployee[k]; }).sort(function (a, b) { return a.employeeId < b.employeeId ? -1 : 1; }),
    triggers: triggers,
    groups: groups,
    warnings: findSalesDuplicateWarnings_(rows),
  };
}

/** 顧客名の比較用（空白と末尾の「様」「さん」を除く） */
function normalizeCustomerName_(name) {
  return String(name || '').replace(/[\s　]/g, '').replace(/(様|さん)$/, '');
}

/**
 * 同じ接客の重複の候補（データは書き換えない。警告だけ）。
 *   主担当側の記録なし … 副担当の記録の主担当者が、同じ日に主担当の接客を記録していない（同じ顧客名、名前が未確認ならどれでも）
 *   主担当の重複の候補 … 同じ日・同じ顧客名で、別の社員がそれぞれ主担当として記録している
 */
function findSalesDuplicateWarnings_(rows) {
  const warnings = [];
  const mains = rows.filter(function (x) { return x.role !== CUSTOMER_ROLES.SUB; });
  rows.filter(function (x) { return x.role === CUSTOMER_ROLES.SUB && x.mainStaffId; }).forEach(function (x) {
    const name = normalizeCustomerName_(x.customerName);
    const found = mains.some(function (m) {
      if (m.date !== x.date || m.employeeId !== x.mainStaffId) return false;
      return x.unknown || !name || m.unknown || normalizeCustomerName_(m.customerName) === name;
    });
    if (!found) {
      warnings.push({ type: '主担当側の記録なし', date: x.date, text: x.name + '（副担当）の「' + (x.unknown ? '顧客名未確認' : x.customerName) + '」：主担当 ' +
        (x.mainStaffName || x.mainStaffId) + ' の同じ日の日報に、主担当の接客記録がありません' });
    }
  });
  const seen = {};
  mains.forEach(function (m) {
    const name = normalizeCustomerName_(m.customerName);
    if (m.unknown || !name) return;
    const key = m.date + '|' + name;
    (seen[key] = seen[key] || []).push(m);
  });
  Object.keys(seen).forEach(function (key) {
    const list = seen[key];
    const people = list.map(function (m) { return m.employeeId; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (people.length < 2) return;
    warnings.push({ type: '主担当の重複の候補', date: list[0].date, text: '「' + list[0].customerName + '」を ' + list.map(function (m) { return m.name; }).join('・') +
      ' がそれぞれ主担当として記録しています（同じ接客なら、どちらかを副担当にしてください）' });
  });
  return warnings.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}

// ============================================================ 日報確認集計（暦月）

/**
 * 日報の提出と確認の集計（暦月）。
 *   提出側（日報提出対象者）：勤務日数・提出数・未提出（前日まで）・下書きのみ・自分の日報の確認率
 *   確認側（日報確認対象者）：確認すべき日報の数・確認した数・確認率（他の人の提出済みの日報の最新版）
 */
function buildReportSummary_(env, reportRange) {
  const ctx = env.ctx;
  const ss = getSpreadsheet_();
  const base = { from: reportRange.from, to: reportRange.to, periodText: reportRange.periodText, authors: [], readers: [], totals: null, reports: [] };
  if (![SHEET_NAMES.DAILY_REPORTS, SHEET_NAMES.REPORT_CONFIRMATIONS, SHEET_NAMES.REPORT_CUSTOMERS, SHEET_NAMES.REPORT_COMMENTS]
    .every(function (n) { return !!ss.getSheetByName(n); })) return base;
  const share = buildReportShareContext_();
  const last = reportRange.to < env.now.date ? reportRange.to : env.now.date;
  const dates = reportRange.from <= last ? listDates_(reportRange.from, last) : [];
  const active = ctx.staffList.filter(function (s) { return s.status === EMPLOYMENT_STATUS.ACTIVE; });

  // 期間内の提出済みの日報（旧日報は確認の対象外なので除く）と、その確認状況
  const reports = [];
  readTable_(SHEET_NAMES.DAILY_REPORTS).records.forEach(function (r) {
    const date = toDateKey_(r['日付']);
    if (date < reportRange.from || date > reportRange.to || reportStateOf_(r) !== REPORT_STATE.SUBMITTED || isLegacySubmittedReport_(r)) return;
    const c = confirmationStatus_(r, share);
    const id = String(r['日報ID']).trim();
    reports.push({
      reportId: id, date: date, employeeId: String(r['社員ID']).trim(), name: toPlainText_(r['氏名']),
      targetCount: c.targetCount, confirmedCount: c.confirmedCount,
      confirmedIds: c.confirmed.map(function (x) { return x.employeeId; }),
      pendingNames: c.pending.map(function (x) { return x.name; }),
      commentCount: share.commentCounts[id] || 0,
    });
  });
  const rate = function (done, all) { return all ? Math.round(done / all * 1000) / 10 : null; };

  const authors = active.filter(function (s) { return s.reportSubmitTarget || reports.some(function (r) { return r.employeeId === s.employeeId; }); }).map(function (s) {
    const row = { employeeId: s.employeeId, name: s.name, submitTarget: s.reportSubmitTarget, workDays: 0, submitted: 0, missing: 0, draftOnly: 0, dueSubmitted: 0, confirmed: 0, targets: 0 };
    dates.forEach(function (d) {
      const a = ctx.attendanceByKey[s.employeeId + '|' + d];
      const worked = !!a && !isBlank_(a['出勤']);
      if (worked) row.workDays += 1;
      const j = reportStatusOfDay_(env, s, d, worked);
      if (j.state === 'missing') row.missing += 1;
      if (j.state === 'draft') row.draftOnly += 1;
      if (j.state === 'submitted' && j.due) row.dueSubmitted += 1; // 提出率の分母に入る日に提出した分
    });
    reports.filter(function (r) { return r.employeeId === s.employeeId; }).forEach(function (r) {
      row.submitted += 1;
      row.confirmed += r.confirmedCount;
      row.targets += r.targetCount;
    });
    // 提出率：日報_未提出判定開始日以降・前日までの判定する日だけ（開始日前の日は分母に入れない）
    row.submitRate = rate(row.dueSubmitted, row.dueSubmitted + row.missing + row.draftOnly);
    row.confirmRate = rate(row.confirmed, row.targets);
    return row;
  });

  const readers = active.filter(isReportConfirmTarget_).map(function (s) {
    const mine = reports.filter(function (r) { return r.employeeId !== s.employeeId; });
    const done = mine.filter(function (r) { return r.confirmedIds.indexOf(s.employeeId) !== -1; }).length;
    return { employeeId: s.employeeId, name: s.name, required: mine.length, confirmed: done, rate: rate(done, mine.length) };
  });

  const totalTargets = reports.reduce(function (t, r) { return t + r.targetCount; }, 0);
  const totalConfirmed = reports.reduce(function (t, r) { return t + r.confirmedCount; }, 0);
  const submitted = authors.reduce(function (t, a) { return t + a.submitted; }, 0);
  const dueSubmitted = authors.reduce(function (t, a) { return t + a.dueSubmitted; }, 0);
  const missing = authors.reduce(function (t, a) { return t + a.missing; }, 0);
  const draftOnly = authors.reduce(function (t, a) { return t + a.draftOnly; }, 0);
  return {
    from: reportRange.from, to: reportRange.to, periodText: reportRange.periodText, until: last,
    authors: authors, readers: readers,
    reports: reports.map(function (r) { return { reportId: r.reportId, date: r.date, name: r.name, confirmedCount: r.confirmedCount, targetCount: r.targetCount, pendingNames: r.pendingNames, commentCount: r.commentCount }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }),
    totals: {
      submitted: submitted, missing: missing, draftOnly: draftOnly, submitRate: rate(dueSubmitted, dueSubmitted + missing + draftOnly),
      reportMissingFrom: env.settings.reportMissingFrom, // 空欄なら未提出の判定をしていない
      confirmations: totalConfirmed, confirmationTargets: totalTargets, confirmRate: rate(totalConfirmed, totalTargets),
    },
  };
}
