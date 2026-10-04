/**
 * SettingsService.gs
 * ------------------------------------------------------------
 * 「設定」シートの値を読み込み、計算で使える形（分・数値）にして返します。
 *
 * 勤務時間や休憩時間は、コードに直接書かずにここから取得します。
 * 設定シートの「値」を書き換えると、次の打刻から新しい値で計算されます。
 * 設定シートに項目がないときは Config.gs の DEFAULT_SETTINGS の値を使います。
 */

var SETTINGS_CACHE_ = null;

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 設定を取得する。
 * 戻り値の例：
 *   { fixedStartMinutes: 570, fixedEndMinutes: 1110, autoBreakMinutes: 60, flexMonthlyMinutes: 8280, ... }
 */
function getSettings_() {
  if (SETTINGS_CACHE_) return SETTINGS_CACHE_;

  const values = {};
  DEFAULT_SETTINGS.forEach(function (d) { values[d.key] = d.value; });
  readTable_(SHEET_NAMES.SETTINGS).records.forEach(function (r) {
    const key = String(r['項目']).trim();
    if (key && !isBlank_(r['値'])) values[key] = r['値'];
  });

  const settings = {
    fixedStartMinutes: parseSettingClock_(values, SETTING_KEYS.FIXED_START),
    fixedEndMinutes: parseSettingClock_(values, SETTING_KEYS.FIXED_END),
    autoBreakMinutes: parseSettingDuration_(values, SETTING_KEYS.AUTO_BREAK),
    autoBreakThresholdMinutes: parseSettingDuration_(values, SETTING_KEYS.AUTO_BREAK_THRESHOLD),
    flexDailyMinutes: parseSettingDuration_(values, SETTING_KEYS.FLEX_DAILY),
    flexWeeklyMinutes: parseSettingDuration_(values, SETTING_KEYS.FLEX_WEEKLY),
    flexMonthlyMinutes: parseSettingDuration_(values, SETTING_KEYS.FLEX_MONTHLY),
    overtimeFreeLimitMinutes: parseSettingDuration_(values, SETTING_KEYS.OVERTIME_FREE_LIMIT),
    overtimeUnitMinutes: parseSettingDuration_(values, SETTING_KEYS.OVERTIME_UNIT),
    weeklyFullRestDays: parseSettingInteger_(values, SETTING_KEYS.WEEKLY_FULL_REST_DAYS, 0, 7),
    holidayCategory: String(values[SETTING_KEYS.HOLIDAY_CATEGORY]).trim(),
    weekStartDay: parseSettingWeekday_(values, SETTING_KEYS.WEEK_START_DAY),
    monthClosingDay: parseSettingClosingDay_(values, SETTING_KEYS.MONTH_CLOSING_DAY),
    // 段階3：有給・半休（設定の値が正しくないときは、その機能だけを止めて要確認にする＝打刻などは止めない）
    paidLeaveDayMinutes: softSettingDuration_(values, SETTING_KEYS.PAID_LEAVE_DAY),
    paidLeaveHalfMinutes: softSettingDuration_(values, SETTING_KEYS.PAID_LEAVE_HALF),
    amHalfStartMinutes: softSettingClock_(values, SETTING_KEYS.AM_HALF_START),
    pmHalfEndMinutes: softSettingClock_(values, SETTING_KEYS.PM_HALF_END),
    flexPaidLeaveMode: parseFlexPaidLeaveMode_(values),
    // 日報の未提出判定の開始日（空欄・日付でない値なら ''＝判定しない）。判定は isReportDueDate_ に集めている
    reportMissingFrom: toDateKey_(values[SETTING_KEYS.REPORT_MISSING_FROM]),
    reportMissingFromInvalid: !isBlank_(values[SETTING_KEYS.REPORT_MISSING_FROM]) && !toDateKey_(values[SETTING_KEYS.REPORT_MISSING_FROM]),
  };
  if (settings.overtimeUnitMinutes < 1) invalidSetting_(SETTING_KEYS.OVERTIME_UNIT, values, '00:01 以上');
  if (settings.fixedEndMinutes <= settings.fixedStartMinutes) {
    invalidSetting_(SETTING_KEYS.FIXED_END, values, SETTING_KEYS.FIXED_START + 'より後の時刻');
  }

  SETTINGS_CACHE_ = settings;
  return settings;
}

/** 段階3の設定：読めなければ null（エラーにしない。使うところで「設定不備」として要確認にする） */
function softSettingDuration_(values, key) {
  const m = toMinutes_(values[key]);
  return m === null || m < 0 ? null : m;
}
function softSettingClock_(values, key) {
  const m = toMinutes_(values[key]);
  return m === null || m < 0 || m >= 1440 ? null : m;
}
function parseFlexPaidLeaveMode_(values) {
  const v = String(values[SETTING_KEYS.FLEX_PAID_LEAVE] || '').trim();
  return objectValues_(FLEX_PAID_LEAVE_MODES).indexOf(v) !== -1 ? v : FLEX_PAID_LEAVE_MODES.UNDECIDED;
}

function invalidSetting_(key, values, example) {
  fail_('「設定」シートの「' + key + '」の値「' + toPlainText_(values[key]) + '」が正しくありません（' + example + '）');
}

/** 時刻（09:30 など） */
function parseSettingClock_(values, key) {
  const minutes = toMinutes_(values[key]);
  if (minutes === null || minutes < 0 || minutes >= 1440) invalidSetting_(key, values, '例：09:30');
  return minutes;
}

/** 時間の長さ（01:00、138:00 など） */
function parseSettingDuration_(values, key) {
  const minutes = toMinutes_(values[key]);
  if (minutes === null || minutes < 0) invalidSetting_(key, values, '例：01:00');
  return minutes;
}

function parseSettingInteger_(values, key, min, max) {
  const n = Number(String(values[key]).trim());
  if (!isFinite(n) || Math.floor(n) !== n || n < min || n > max) invalidSetting_(key, values, min + '〜' + max + 'の整数');
  return n;
}

/** 曜日（「月」「月曜」「月曜日」のどれでも可） */
function parseSettingWeekday_(values, key) {
  const idx = WEEKDAY_LABELS.indexOf(String(values[key]).trim().charAt(0));
  if (idx === -1) invalidSetting_(key, values, '日・月・火・水・木・金・土のいずれか');
  return idx;
}

/** 締め日。「末日」は 0 として扱う */
function parseSettingClosingDay_(values, key) {
  const text = String(values[key]).trim().replace(/日$/, '');
  if (text === '末' || text === '0' || text === '') return 0;
  const n = Number(text);
  if (!isFinite(n) || Math.floor(n) !== n || n < 1 || n > 27) invalidSetting_(key, values, '「末日」または 1〜27');
  return n;
}
