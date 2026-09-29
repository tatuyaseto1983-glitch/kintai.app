/**
 * Config.gs
 * ------------------------------------------------------------
 * 勤怠管理システムの「設定値」をまとめたファイルです。
 *   - シート名
 *   - 各シートの列名（見出し）
 *   - 選択肢（権限・勤務区分・状態など）
 *   - 「設定」シートへ最初に登録する初期値
 *
 * 勤務時間や休憩時間などの数値は、ここではなく「設定」シートの値が優先されます。
 * （ここに書いてあるのは、設定シートに値がないときの初期値です）
 */

/** タイムゾーン（日本時間で統一） */
const APP_TIMEZONE = 'Asia/Tokyo';

/** 同時実行を防ぐロックの最大待ち時間（ミリ秒） */
const LOCK_WAIT_MS = 10000;

/** シート名 */
const SHEET_NAMES = {
  STAFF: 'スタッフマスタ',
  ATTENDANCE: '勤怠記録',
  BREAKS: '中断履歴',
  CORRECTIONS: '打刻修正申請',
  OVERTIME: '残業申請',
  DAILY_REPORTS: '日報',
  SETTINGS: '設定',
};

/** 権限 */
const ROLES = { STAFF: 'staff', ADMIN: 'admin' };

/** 勤務区分 */
const WORK_TYPES = { FIXED: '固定勤務', FLEX: 'フレックス' };

/** 在籍状況 */
const EMPLOYMENT_STATUS = { ACTIVE: '在籍', ON_LEAVE: '休職', RETIRED: '退職' };

/** 雇用区分（選択肢の例。リスト外の値も入力できます） */
const EMPLOYMENT_TYPES = ['正社員', '契約社員', 'パート・アルバイト'];

/** 勤務形態 */
const WORK_STYLES = { OFFICE: '出社', REMOTE: '在宅' };

/** 勤怠の状態 */
const ATTENDANCE_STATUS = {
  NOT_STARTED: '未出勤',
  WORKING: '勤務中',
  ON_BREAK: '中断中',
  FINISHED: '退勤済み',
};

/** 申請のステータス（残業申請・打刻修正申請で共通） */
const REQUEST_STATUS = { PENDING: '承認待ち', APPROVED: '承認済み', REJECTED: '却下' };

/** 打刻修正の項目 */
const CORRECTION_ITEMS = {
  CLOCK_IN: '出勤',
  CLOCK_OUT: '退勤',
  BREAK_START: '中断',
  BREAK_END: '再開',
  WORK_STYLE: '勤務形態',
};

/** 勤怠記録の「打刻修正状況」列に入れる文字 */
const CORRECTION_STATE = { PENDING: '申請中', APPROVED: '修正済み', REJECTED: '却下' };

/** 日報のステータス */
const REPORT_STATUS = { DRAFT: '下書き', SUBMITTED: '提出済み', CONFIRMED: '確認済み' };

/** 勤怠記録の「事前残業申請」列：申請が見つからないとき／不要なとき */
const OVERTIME_REQUEST_LABEL = { NONE: 'なし', NOT_REQUIRED: '不要' };

/** 勤怠記録の印 */
const MARKS = { YES: '○', NEEDS_CHECK: '要確認' };

/** 「設定」シートの項目名 */
const SETTING_KEYS = {
  FIXED_START: '固定勤務_標準出勤',
  FIXED_END: '固定勤務_標準退勤',
  AUTO_BREAK: '自動休憩',
  FLEX_DAILY: 'フレックス_1日所定',
  FLEX_WEEKLY: 'フレックス_週所定',
  FLEX_MONTHLY: 'フレックス_月所定',
  OVERTIME_FREE_LIMIT: '残業_申請不要上限',
  OVERTIME_UNIT: '残業_記録単位',
  WEEKLY_FULL_REST_DAYS: '週完全休日',
  HOLIDAY_CATEGORY: '土日祝区分',
  WEEK_START_DAY: '週_起算曜日',
  MONTH_CLOSING_DAY: '月_締め日',
  AUTO_BREAK_THRESHOLD: '自動休憩_適用開始',
};

/**
 * 「設定」シートへ最初に登録する値。
 * setupSystem() は、設定シートに「まだ無い項目だけ」を追加します（既存の値は上書きしません）。
 */
const DEFAULT_SETTINGS = [
  { key: SETTING_KEYS.FIXED_START, value: '09:30', note: '固定勤務の標準出勤時刻。これより遅い出勤を「遅刻」として記録します' },
  { key: SETTING_KEYS.FIXED_END, value: '18:30', note: '固定勤務の標準退勤時刻。これ以降の勤務を「社内超過時間」として記録します' },
  { key: SETTING_KEYS.AUTO_BREAK, value: '01:00', note: '実働時間から自動で差し引く休憩時間（中断とは別）' },
  { key: SETTING_KEYS.FLEX_DAILY, value: '08:00', note: 'フレックスの1日の基準時間' },
  { key: SETTING_KEYS.FLEX_WEEKLY, value: '32:00', note: 'フレックスの週の所定時間（週4日勤務が基本）' },
  { key: SETTING_KEYS.FLEX_MONTHLY, value: '138:00', note: 'フレックスの月の所定時間' },
  { key: SETTING_KEYS.OVERTIME_FREE_LIMIT, value: '00:30', note: '社内超過時間がこの時間以上になる日は、事前残業申請（承認済み）が必要です' },
  { key: SETTING_KEYS.OVERTIME_UNIT, value: '00:01', note: '社内超過時間を記録する単位（00:01＝1分単位。端数は切り捨て）' },
  { key: SETTING_KEYS.WEEKLY_FULL_REST_DAYS, value: '1', note: '1週間に必要な完全休日（出勤記録がない日）の日数' },
  { key: SETTING_KEYS.HOLIDAY_CATEGORY, value: 'なし', note: '土日祝の特別区分。現在は「なし」（曜日に関係なく勤務できるシフト制）' },
  { key: SETTING_KEYS.WEEK_START_DAY, value: '月', note: '週の集計を始める曜日（日・月・火・水・木・金・土）。就業規則に合わせてください' },
  { key: SETTING_KEYS.MONTH_CLOSING_DAY, value: '末日', note: '月の締め日。「末日」または 1〜27 の数字（例：20＝21日〜翌月20日を1か月として集計）' },
  { key: SETTING_KEYS.AUTO_BREAK_THRESHOLD, value: '00:00', note: '中断を除いた勤務時間（退勤−出勤−中断合計）がこの時間を超えた日だけ自動休憩を差し引きます。00:00＝常に差し引く／06:00＝6時間以下の日は引かない' },
];

/**
 * 各シートの定義。
 *   headers     : 1行目の見出し（コードはこの名前で列を探すので、列の順番を入れ替えても動きます）
 *   choices     : プルダウン（入力規則）を付ける列と選択肢
 *   freeChoices : プルダウンは付けるが、リスト外の入力も許可する列
 */
const SHEET_DEFINITIONS = [
  {
    name: SHEET_NAMES.STAFF,
    headers: ['社員ID', '氏名', 'メールアドレス', '権限', '雇用区分', '勤務区分', '標準出勤', '標準退勤',
      '1日所定時間', '週所定時間', '月所定時間', '在籍状況', '入社日', '部署', '備考'],
    choices: {
      '権限': [ROLES.STAFF, ROLES.ADMIN],
      '勤務区分': [WORK_TYPES.FIXED, WORK_TYPES.FLEX],
      '在籍状況': [EMPLOYMENT_STATUS.ACTIVE, EMPLOYMENT_STATUS.ON_LEAVE, EMPLOYMENT_STATUS.RETIRED],
    },
    freeChoices: { '雇用区分': EMPLOYMENT_TYPES },
  },
  {
    name: SHEET_NAMES.ATTENDANCE,
    headers: ['勤怠ID', '日付', '社員ID', '氏名', '勤務区分', '勤務形態', '出勤', '退勤', '自動休憩', '中断合計',
      '実働時間', '所定終了', '社内超過時間', '30分以上', '事前残業申請', '要確認', '遅刻', '早退', '状態',
      '打刻修正状況', '更新日時', '備考'],
  },
  {
    name: SHEET_NAMES.BREAKS,
    headers: ['中断ID', '勤怠ID', '日付', '社員ID', '氏名', '中断開始', '再開', '中断時間', '理由'],
  },
  {
    name: SHEET_NAMES.CORRECTIONS,
    headers: ['申請ID', '申請日時', '社員ID', '氏名', '対象日', '修正項目', '修正前', '修正後', '申請理由',
      'ステータス', '承認者', '承認日時', '却下理由', '備考'],
    choices: { 'ステータス': [REQUEST_STATUS.PENDING, REQUEST_STATUS.APPROVED, REQUEST_STATUS.REJECTED] },
  },
  {
    name: SHEET_NAMES.OVERTIME,
    headers: ['申請ID', '申請日時', '社員ID', '氏名', '対象日', '予定開始', '予定終了', '予定残業時間', '申請理由',
      'ステータス', '承認者', '承認日時', '実績残業', '備考'],
    choices: { 'ステータス': [REQUEST_STATUS.PENDING, REQUEST_STATUS.APPROVED, REQUEST_STATUS.REJECTED] },
  },
  {
    name: SHEET_NAMES.DAILY_REPORTS,
    headers: ['日報ID', '日付', '社員ID', '氏名', '勤務形態', '本日の業務内容', '成果・進捗', '課題・困りごと',
      '明日の予定', '共有事項', '提出日時', 'ステータス'],
    choices: { 'ステータス': [REPORT_STATUS.DRAFT, REPORT_STATUS.SUBMITTED, REPORT_STATUS.CONFIRMED] },
  },
  {
    name: SHEET_NAMES.SETTINGS,
    headers: ['項目', '値', '説明'],
  },
];

/** 入力文字数の上限 */
const TEXT_LIMITS = { SHORT: 200, LONG: 2000 };
