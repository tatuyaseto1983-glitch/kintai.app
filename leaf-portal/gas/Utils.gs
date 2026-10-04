/**
 * Utils.gs
 * ------------------------------------------------------------
 * どのファイルからも使う共通の道具です。
 *   - エラーと戻り値の形（{ success, message, data }）
 *   - 日付・時刻・時間の変換（すべて日本時間）
 *   - 同時実行を防ぐロック
 *
 * 関数名の最後に「_」が付いているものは内部用です。
 * （Apps Script では「_」付きの関数は画面から直接呼べず、実行ボタンの一覧にも出ません）
 */

/**
 * テストのときだけ「今の時刻」「ログイン中のメールアドレス」「使うスプレッドシート」を差し替えるための入れ物。
 * 通常の運用では、すべて null のままです。
 */
var APP_RUNTIME = { now: null, email: null, spreadsheet: null };

// ============================================================ エラーと戻り値

/** 利用者に見せてよい、想定内のエラー（日本語メッセージ） */
function AppError(message) {
  this.name = 'AppError';
  this.message = message;
  this.stack = new Error(message).stack;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

/** 想定内のエラーを発生させる */
function fail_(message) {
  throw new AppError(message);
}

/**
 * 画面から呼ばれる関数の共通の入口。
 * 中の処理が { message, data } を返せば成功、エラーが起きれば失敗の形にそろえて返します。
 *   成功：{ success: true,  message: '出勤しました', data: {...} }
 *   失敗：{ success: false, message: '本日はすでに出勤済みです', data: null }
 */
function runApi_(action) {
  try {
    clearTableCache_(); // 毎回、最新のシート内容から処理を始める
    const result = action() || {};
    return {
      success: true,
      message: result.message || '完了しました',
      data: result.data === undefined ? null : result.data,
    };
  } catch (e) {
    if (e instanceof AppError) {
      return { success: false, message: e.message, data: null };
    }
    console.error(e && e.stack ? e.stack : e);
    return {
      success: false,
      message: 'システムエラーが発生しました。時間をおいて再度お試しください。続く場合は管理者に連絡してください（詳細：' +
        (e && e.message ? e.message : String(e)) + '）',
      data: null,
    };
  }
}

/**
 * データを書き換える処理を、ロックをかけて1件ずつ順番に実行します。
 * 複数のスタッフが同時に「出勤」を押しても、二重登録や上書きが起きないようにするためです。
 */
function withLock_(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    fail_('ほかの人の処理と重なりました。数秒待ってからもう一度お試しください');
  }
  try {
    clearTableCache_(); // ロックを取った後の最新のシート内容で処理する
    const result = action();
    SpreadsheetApp.flush(); // 書き込みを確定させてからロックを外す
    return result;
  } finally {
    lock.releaseLock();
  }
}

// ============================================================ 入力チェック

function isBlank_(value) {
  return value === '' || value === null || value === undefined;
}

/** 文字列の入力チェック（前後の空白を除いた値を返す） */
function requireText_(value, label, options) {
  const opts = options || {};
  const max = opts.max || TEXT_LIMITS.SHORT;
  let text = isBlank_(value) ? '' : String(value).trim();
  if (opts.required !== false && text === '') fail_(label + 'を入力してください');
  if (text.length > max) fail_(label + 'は' + max + '文字以内で入力してください');
  return text;
}

/** 選択肢のどれかであることを確認する */
function requireChoice_(value, choices, label) {
  const text = isBlank_(value) ? '' : String(value).trim();
  if (choices.indexOf(text) === -1) {
    fail_(label + 'は「' + choices.join('」「') + '」のいずれかを指定してください');
  }
  return text;
}

// ============================================================ 日付・時刻（日本時間）

function pad2_(n) {
  n = Number(n);
  return (n < 10 ? '0' : '') + n;
}

function isDateObject_(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

/** 今の日時（テスト中は差し替えた時刻） */
function now_() {
  return APP_RUNTIME.now ? new Date(APP_RUNTIME.now.getTime()) : new Date();
}

/** 日本時間で書式を整える */
function formatJst_(date, pattern) {
  return Utilities.formatDate(date, APP_TIMEZONE, pattern);
}

/**
 * 今の日付・時刻をまとめて取得する。
 *   date: '2026-09-29'  time: '09:31'  minutes: 571（0時からの分）  timestamp: '2026-09-29 09:31:05'
 */
function getNowInfo_() {
  const d = now_();
  const time = formatJst_(d, 'HH:mm');
  return {
    date: formatJst_(d, 'yyyy-MM-dd'),
    time: time,
    minutes: toMinutes_(time),
    timestamp: formatJst_(d, 'yyyy-MM-dd HH:mm:ss'),
  };
}

/**
 * セルの値や入力値を「yyyy-MM-dd」形式の日付文字列にそろえる。
 * 日付の比較はすべてこの文字列同士で行うため、時刻部分のずれによるバグが起きません。
 * 変換できないときは '' を返します。
 */
function toDateKey_(value) {
  if (isBlank_(value)) return '';
  if (isDateObject_(value)) {
    return isNaN(value.getTime()) ? '' : formatJst_(value, 'yyyy-MM-dd');
  }
  const m = String(value).trim().match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})日?/);
  if (!m) return '';
  const key = m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]);
  return isValidDateKey_(key) ? key : '';
}

/** 同じ日かどうか（どちらかが日付でなければ false） */
function isSameDate_(a, b) {
  const keyA = toDateKey_(a);
  return keyA !== '' && keyA === toDateKey_(b);
}

function dateKeyToUtcMs_(key) {
  const p = key.split('-');
  return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function utcMsToDateKey_(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

function isValidDateKey_(key) {
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && utcMsToDateKey_(dateKeyToUtcMs_(key)) === key;
}

/** 入力された日付をチェックして「yyyy-MM-dd」で返す */
function requireDateKey_(value, label) {
  const key = toDateKey_(value);
  if (!key) fail_(label + 'は「2026-09-29」の形式で入力してください');
  return key;
}

/** 日付に n 日足す */
function addDays_(key, n) {
  return utcMsToDateKey_(dateKeyToUtcMs_(key) + n * 86400000);
}

/** 曜日（0=日, 1=月, … 6=土） */
function weekdayOf_(key) {
  return new Date(dateKeyToUtcMs_(key)).getUTCDay();
}

/** from〜to（両端を含む）の日付の一覧 */
function listDates_(from, to) {
  const dates = [];
  for (let d = from; d <= to; d = addDays_(d, 1)) dates.push(d);
  return dates;
}

/** 指定日を含む週（weekStartDay 曜日から7日間） */
function getWeekRange_(key, weekStartDay) {
  const diff = (weekdayOf_(key) - weekStartDay + 7) % 7;
  const from = addDays_(key, -diff);
  return { from: from, to: addDays_(from, 6) };
}

/** '2026-09' に n か月足す */
function shiftMonthKey_(monthKey, n) {
  let y = Number(monthKey.slice(0, 4));
  let m = Number(monthKey.slice(5, 7)) - 1 + n;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return y + '-' + pad2_(m + 1);
}

function requireMonthKey_(value, label) {
  const text = isBlank_(value) ? '' : String(value).trim().replace('/', '-');
  const m = text.match(/^(\d{4})-(\d{1,2})$/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) fail_(label + 'は「2026-09」の形式で入力してください');
  return m[1] + '-' + pad2_(m[2]);
}

/**
 * 「◯月」の集計期間。
 *   締め日なし（末日）：2026-09 → 2026-09-01〜2026-09-30
 *   20日締め        ：2026-09 → 2026-08-21〜2026-09-20
 */
function getMonthRange_(monthKey, closingDay) {
  if (!closingDay) {
    const nextMonthFirst = shiftMonthKey_(monthKey, 1) + '-01';
    return { from: monthKey + '-01', to: addDays_(nextMonthFirst, -1) };
  }
  return {
    from: shiftMonthKey_(monthKey, -1) + '-' + pad2_(closingDay + 1),
    to: monthKey + '-' + pad2_(closingDay),
  };
}

/** その日付が「何月分」に入るか（締め日を考慮） */
function getMonthKeyForDate_(dateKey, closingDay) {
  const monthKey = dateKey.slice(0, 7);
  if (!closingDay) return monthKey;
  return Number(dateKey.slice(8, 10)) > closingDay ? shiftMonthKey_(monthKey, 1) : monthKey;
}

/**
 * 「◯年◯月分」の集計期間（締め日の設定を使う共通の関数）。月別の画面・CSV・フレックス集計はすべてこれを使う。
 *   20日締め：getPayrollPeriod_(2026, 9) → { label: '2026年9月分', startDate: '2026-08-21', endDate: '2026-09-20', ... }
 *   末日締め：getPayrollPeriod_(2026, 9) → 2026-09-01〜2026-09-30
 * 月の日数やうるう年に関係なく、前月の（締め日＋1）日〜当月の締め日になる。
 * @param {number} year
 * @param {number} month 1〜12
 * @param {number} [closingDay] 省略すると設定シートの「月_締め日」（0＝末日）
 */
function getPayrollPeriod_(year, month, closingDay) {
  const monthKey = requireMonthKey_(year + '-' + month, '対象月');
  return getPayrollPeriodByMonthKey_(monthKey, closingDay);
}

/** getPayrollPeriod_ の '2026-09' 版 */
function getPayrollPeriodByMonthKey_(monthKey, closingDay) {
  const day = closingDay === undefined || closingDay === null ? getSettings_().monthClosingDay : closingDay;
  const range = getMonthRange_(monthKey, day);
  return {
    monthKey: monthKey,
    label: getPeriodLabel_(monthKey),
    startDate: range.from,
    endDate: range.to,
    from: range.from,
    to: range.to,
    closingDay: day,
    periodText: getPeriodLabel_(monthKey) + ' 対象期間：' + range.from.replace(/-/g, '/') + '〜' + range.to.replace(/-/g, '/'),
  };
}

/** その日付が入る「◯月分」の期間 */
function getPayrollPeriodForDate_(dateKey, closingDay) {
  const day = closingDay === undefined || closingDay === null ? getSettings_().monthClosingDay : closingDay;
  return getPayrollPeriodByMonthKey_(getMonthKeyForDate_(dateKey, day), day);
}

/**
 * 日報の「◯月」の期間（業務記録なので、締め日の設定に関係なく暦月の1日〜末日）。
 * 給与・勤怠の締め期間（getPayrollPeriod_）とは別の関数。日報一覧はこちらを使う。
 *   getReportMonthPeriod_('2026-10') → { label: '2026年10月', from: '2026-10-01', to: '2026-10-31', ... }
 */
function getReportMonthPeriod_(monthKey) {
  const range = getMonthRange_(monthKey, 0);
  const label = Number(monthKey.slice(0, 4)) + '年' + Number(monthKey.slice(5, 7)) + '月';
  return {
    monthKey: monthKey,
    label: label,
    from: range.from,
    to: range.to,
    periodText: label + ' 期間：' + range.from.replace(/-/g, '/') + '〜' + range.to.replace(/-/g, '/'),
  };
}

/** その日付が入る日報の月（暦月） */
function getReportMonthPeriodForDate_(dateKey) {
  return getReportMonthPeriod_(dateKey.slice(0, 7));
}

/** '2026-09' → '2026年9月分' */
function getPeriodLabel_(monthKey) {
  return Number(monthKey.slice(0, 4)) + '年' + Number(monthKey.slice(5, 7)) + '月分';
}

// ============================================================ 時刻・時間（分に変換して計算する）

/**
 * 「09:30」「8:10」「138:00」のような値を「分」に変換する。
 * セルが日付・時刻の形式になっていて Date や数値で読み込まれた場合にも対応します。
 * 変換できないときは null を返します。
 */
function toMinutes_(value) {
  if (isBlank_(value)) return null;
  if (typeof value === 'number') {
    return isFinite(value) ? Math.round(value * 24 * 60) : null; // スプレッドシートの時間（1日＝1）
  }
  if (isDateObject_(value)) {
    if (isNaN(value.getTime())) return null;
    if (value.getFullYear() > 1900) return toMinutes_(formatJst_(value, 'HH:mm')); // 日時が入っている → 時刻部分
    // 「時刻」「経過時間」形式のセル（1899/12/30 0:00 からの経過）
    const base = Utilities.parseDate('1899-12-30 00:00:00', APP_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    return Math.round((value.getTime() - base.getTime()) / 60000);
  }
  const m = String(value).trim().match(/^(-)?(\d{1,4}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m || Number(m[3]) >= 60) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] ? -minutes : minutes;
}

/** 分 → 「08:10」「138:00」の形（時間の長さを表す） */
function formatMinutes_(minutes) {
  if (minutes === null || minutes === undefined || isNaN(minutes)) return '';
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minutes));
  return sign + pad2_(Math.floor(abs / 60)) + ':' + pad2_(abs % 60);
}

/** 分 → 時間の長さ。0 のときは空欄（遅刻・早退の列用） */
function formatMinutesOrBlank_(minutes) {
  return minutes ? formatMinutes_(minutes) : '';
}

/** 分 → 時計の時刻「18:30」（24時をまたいだ値は 0〜23時に戻す） */
function minutesToClock_(minutes) {
  if (minutes === null || minutes === undefined) return '';
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return pad2_(Math.floor(m / 60)) + ':' + pad2_(m % 60);
}

/** セルの値を時計の時刻「09:30」にそろえる（空欄は ''） */
function toClockText_(value) {
  const minutes = toMinutes_(value);
  return minutes === null ? '' : minutesToClock_(minutes);
}

/** セルの値を時間の長さ「08:10」にそろえる（空欄は ''） */
function toDurationText_(value) {
  return formatMinutes_(toMinutes_(value));
}

/** 入力された時刻「HH:mm」をチェックして分で返す */
function requireClockMinutes_(value, label) {
  const text = isBlank_(value) ? '' : String(value).trim();
  const minutes = /^\d{1,2}:\d{2}$/.test(text) ? toMinutes_(text) : null;
  if (minutes === null || minutes >= 1440) fail_(label + 'は「09:30」の形式で入力してください');
  return minutes;
}

/**
 * 開始〜終了の長さ（分）。終了が開始より前なら日付をまたいだとみなして24時間足す。
 * 例：22:00〜01:00 → 180分
 */
function durationBetween_(startMinutes, endMinutes) {
  const diff = endMinutes - startMinutes;
  return diff < 0 ? diff + 1440 : diff;
}

/** セルの値を画面に返せる文字列にする（Date はそのままだと画面に渡せないため） */
function toPlainText_(value) {
  if (isBlank_(value)) return '';
  if (isDateObject_(value)) return formatJst_(value, 'yyyy-MM-dd HH:mm:ss');
  return String(value);
}

// ============================================================ ID

/**
 * 重ならない ID を作る。同じ ID がすでにあれば末尾に -2, -3 … を付ける。
 */
function makeUniqueId_(sheetName, idColumn, baseId) {
  const used = {};
  readTable_(sheetName).records.forEach(function (r) { used[String(r[idColumn])] = true; });
  let id = baseId;
  for (let n = 2; used[id]; n++) id = baseId + '-' + n;
  return id;
}

/** 申請ID などに使う日時の文字列 '20260929093105' */
function compactTimestamp_() {
  return formatJst_(now_(), 'yyyyMMddHHmmss');
}
