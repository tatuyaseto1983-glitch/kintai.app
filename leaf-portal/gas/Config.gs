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
  // 日報の詳細（1つの日報に複数行ずつ。日報IDでつなぐ）
  REPORT_CUSTOMERS: '日報_接客',
  REPORT_CONFIRMATIONS: '日報_確認',
  REPORT_COMMENTS: '日報_コメント',
  REPORT_HISTORY: '日報_更新履歴',
  HOLIDAY_WORK: '休日出勤申請',
  // 1日の中の勤務の区切り（出社→在宅への切替、退勤後の再出勤など）。勤怠記録は1日の合計のまま
  WORK_SEGMENTS: '勤務区間履歴',
  // 通勤以外の交通費と、自家用車の業務走行距離（走行距離はここだけに保存する）
  TRANSPORT: '交通費明細',
};

/** 権限 */
const ROLES = { STAFF: 'staff', ADMIN: 'admin' };

/** 勤務区分 */
const WORK_TYPES = { FIXED: '固定勤務', FLEX: 'フレックス' };

/** 在籍状況 */
const EMPLOYMENT_STATUS = { ACTIVE: '在籍', ON_LEAVE: '休職', RETIRED: '退職' };

/** 雇用区分（選択肢の例。リスト外の値も入力できます） */
const EMPLOYMENT_TYPES = ['正社員', '契約社員', 'パート・アルバイト'];

/** 勤務形態（打刻で選べるのは出社・在宅。現場・外出は勤務区間の値として受け付けるだけで、段階2で画面に出す） */
const WORK_STYLES = { OFFICE: '出社', REMOTE: '在宅', SITE: '現場', OUTING: '外出' };

/** 勤務区間の「勤務形態」に入れてよい値（この順番で「出社＋在宅」のように並べる） */
function segmentWorkStyles_() {
  return [WORK_STYLES.OFFICE, WORK_STYLES.REMOTE, WORK_STYLES.SITE, WORK_STYLES.OUTING];
}

/** 打刻（出勤・切替・再開・再出勤）で選べる勤務形態。現場と外出は別々に保存する（集計は「現場外出時間」） */
function punchWorkStyles_() {
  return [WORK_STYLES.OFFICE, WORK_STYLES.REMOTE, WORK_STYLES.SITE, WORK_STYLES.OUTING];
}

/** 交通費明細の交通手段 */
const TRANSPORT_MODES = ['電車', 'バス', 'タクシー', '高速道路', '駐車場', '自家用車', 'その他'];
const TRANSPORT_MODE_CAR = '自家用車';
/** 自家用車の業務走行距離の上限（km。1件あたり） */
const TRANSPORT_MAX_KM = 1000;

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
  // 勤務区間ごとの修正（打刻修正申請の「対象区間」に区間番号を入れる）
  SEGMENT_START: '区間開始',
  SEGMENT_END: '区間終了',
  SEGMENT_STYLE: '区間勤務形態',
};

/** 勤怠記録の「打刻修正状況」列に入れる文字 */
const CORRECTION_STATE = { PENDING: '申請中', APPROVED: '修正済み', REJECTED: '却下' };

/** 日報のステータス（「ステータス」列に入れる表示用の文字。以前の「確認済み」は提出済みとして扱う） */
const REPORT_STATUS = { DRAFT: '下書き', SUBMITTED: '提出済み', CONFIRMED: '確認済み' };

/** 日報のステータス（「日報ステータス」列に入れる内部の値） */
const REPORT_STATE = { DRAFT: 'draft', SUBMITTED: 'submitted' };

/** スタッフマスタ「勤怠集計対象」：この値の人は、全スタッフ勤務状況・勤怠集計に含めない（空欄＝対象） */
const ATTENDANCE_TARGET = { YES: '対象', NO: '対象外' };

/**
 * スタッフマスタ「休日出勤申請対象」：「対象」の人だけが休日出勤申請できる（空欄・対象外は申請できない）。
 * 勤怠集計対象とは別に管理する。列を作るとき（setupSystem）だけ、勤怠集計対象をもとに初期値を入れる。
 */
const HOLIDAY_WORK_TARGET = { YES: '対象', NO: '対象外' };

/** 休日出勤申請のステータス（残業申請・打刻修正申請の「承認待ち」とは別の名前） */
const HOLIDAY_WORK_STATUS = {
  PENDING: '申請中',
  APPROVED: '承認済み',
  REJECTED: '却下',
  CANCEL_REQUESTED: '取消申請中',
  CANCELLED: '取消済み',
};

/** 休日出勤の振替休日区分 */
const COMP_DAY_TYPES = { PLANNED: '取得予定', NONE: '取得予定なし', UNDECIDED: '未定' };

/** 日報の接客記録の選択肢 */
const VISIT_TRIGGERS = ['Web検索', 'Googleマップ', 'Instagram', 'LINE', '紹介', '既存顧客', '看板・通りがかり', 'チラシ', 'イベント', 'その他', '未確認'];
const VISIT_TRIGGER_OTHER = 'その他';
const CUSTOMER_RESULTS = ['契約', '見積提出', '検討中', '次回予約', '資料渡し', '案内のみ', '対応完了', 'その他'];
const NEXT_ACTION = { REQUIRED: '必要', NOT_REQUIRED: '不要' };

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
  { key: SETTING_KEYS.MONTH_CLOSING_DAY, value: '20', note: '月の締め日。「末日」または 1〜27 の数字（20＝前月21日〜当月20日を「当月分」として集計。例：9月分＝8/21〜9/20）' },
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
    // 任意の列：setupSystem() が右端に追加する。無くても動く（空欄＝勤怠集計の対象）
    optionalHeaders: ['勤怠集計対象', '休日出勤申請対象'],
    choices: {
      '権限': [ROLES.STAFF, ROLES.ADMIN],
      '勤務区分': [WORK_TYPES.FIXED, WORK_TYPES.FLEX],
      '在籍状況': [EMPLOYMENT_STATUS.ACTIVE, EMPLOYMENT_STATUS.ON_LEAVE, EMPLOYMENT_STATUS.RETIRED],
      '勤怠集計対象': [ATTENDANCE_TARGET.YES, ATTENDANCE_TARGET.NO],
      '休日出勤申請対象': [HOLIDAY_WORK_TARGET.YES, HOLIDAY_WORK_TARGET.NO],
    },
    // 列を新しく作ったときだけ、初期値を入れる（既存の値は変えない）。中身は HolidayWorkService.gs
    onColumnsAdded: function (sheet, added) { return initHolidayWorkTargetColumn_(sheet, added); },
    freeChoices: { '雇用区分': EMPLOYMENT_TYPES },
  },
  {
    name: SHEET_NAMES.ATTENDANCE,
    headers: ['勤怠ID', '日付', '社員ID', '氏名', '勤務区分', '勤務形態', '出勤', '退勤', '自動休憩', '中断合計',
      '実働時間', '所定終了', '社内超過時間', '30分以上', '事前残業申請', '要確認', '遅刻', '早退', '状態',
      '打刻修正状況', '更新日時', '備考'],
    // 勤務区間の合計（setupSystem() が右端に追加。無くても動く）。
    // 出勤＝最初の開始、退勤＝最後の終了、勤務形態＝最初の区間の勤務形態（以前と同じ意味）
    optionalHeaders: ['勤務形態区分', '勤務区間数', '出社時間', '在宅時間', '現場外出時間',
      // 段階2：日の付帯情報。日備考・出張は本人が入力。直行・直帰は勤務区間から自動で写す（正は勤務区間）
      // 自家用車の走行距離はここには持たない（交通費明細だけが正）
      '日備考', '出張', '直行', '直帰'],
  },
  {
    name: SHEET_NAMES.BREAKS,
    headers: ['中断ID', '勤怠ID', '日付', '社員ID', '氏名', '中断開始', '再開', '中断時間', '理由'],
    // 中断したときの勤務区間（以前の行は空欄のまま読める）。打刻日時は秒まで（並び順とテスト環境での確認用）
    optionalHeaders: ['勤務区間ID', '中断打刻日時', '再開打刻日時'],
  },
  {
    name: SHEET_NAMES.CORRECTIONS,
    headers: ['申請ID', '申請日時', '社員ID', '氏名', '対象日', '修正項目', '修正前', '修正後', '申請理由',
      'ステータス', '承認者', '承認日時', '却下理由', '備考'],
    // 区間ごとの修正のときの区間番号（以前の申請は空欄のまま読める）
    optionalHeaders: ['対象区間'],
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
    // 新しい日報の列（setupSystem() が右端に追加。以前の列はそのまま残す）
    optionalHeaders: ['日報ステータス', 'バージョン', '接客件数', '課題・気づき', '申し送り内容', '管理者への相談・確認事項',
      '最終更新日時', '作成日時'],
    choices: { 'ステータス': [REPORT_STATUS.DRAFT, REPORT_STATUS.SUBMITTED, REPORT_STATUS.CONFIRMED] },
  },
  {
    name: SHEET_NAMES.REPORT_CUSTOMERS,
    headers: ['接客ID', '日報ID', '社員ID', '並び順', '顧客名', '顧客名未確認', '来場のきっかけ', 'その他の内容', '接客内容',
      '対応結果', '補足コメント', '次回対応', '次回対応内容', '削除', '作成日時', '更新日時'],
  },
  {
    // 確認するたびに1行追加（消さない）。「確認済み」かどうかは、今の日報バージョンの行があるかで決める
    name: SHEET_NAMES.REPORT_CONFIRMATIONS,
    headers: ['確認ID', '日報ID', '日報バージョン', '社員ID', '確認者名', '確認日時'],
  },
  {
    name: SHEET_NAMES.REPORT_COMMENTS,
    headers: ['コメントID', '日報ID', '社員ID', '社員名', 'コメント', '投稿日時'],
  },
  {
    // 保存・提出・修正のたびに1行追加。「内容」はその時点の日報（JSON）
    name: SHEET_NAMES.REPORT_HISTORY,
    headers: ['履歴ID', '日報ID', 'バージョン', '操作', '社員ID', '社員名', '日時', '内容'],
  },
  {
    // 休日出勤の「予定」。勤怠記録（実績）には書き込まない。照合は 社員ID＋休日出勤日 ↔ 勤怠記録の 社員ID＋日付
    // 「予定勤務時間」は開始〜終了の差（休憩を差し引かない）。画面では「予定拘束時間」と表示する
    name: SHEET_NAMES.HOLIDAY_WORK,
    headers: ['申請ID', '申請日時', '社員ID', '氏名', '休日出勤日', '開始予定時刻', '終了予定時刻', '予定勤務時間',
      '休日出勤理由', '業務内容', '振替休日区分', '振替休日予定日', '備考', 'ステータス', '承認者ID', '承認者名', '承認日時',
      '却下理由', '取消申請日時', '取消承認日時', '取消理由', '取消処理者ID', '取消処理者名', '取消却下理由', '更新日時'],
    choices: {
      'ステータス': [HOLIDAY_WORK_STATUS.PENDING, HOLIDAY_WORK_STATUS.APPROVED, HOLIDAY_WORK_STATUS.REJECTED,
        HOLIDAY_WORK_STATUS.CANCEL_REQUESTED, HOLIDAY_WORK_STATUS.CANCELLED],
      '振替休日区分': [COMP_DAY_TYPES.PLANNED, COMP_DAY_TYPES.NONE, COMP_DAY_TYPES.UNDECIDED],
    },
  },
  {
    // 勤務区間（1日に何行でも）。勤怠記録の勤怠IDでつなぐ。勤務区間がない日は「出勤〜退勤」の1区間として読む
    // 時刻は「09:30」の形。日付をまたぐ場合は、その日の最初の開始より前の時刻を翌日として扱う
    name: SHEET_NAMES.WORK_SEGMENTS,
    headers: ['勤務区間ID', '勤怠ID', '日付', '社員ID', '氏名', '区間番号', '勤務形態', '開始時刻', '終了時刻', '区間実働',
      '直行', '直帰', '現場名', '備考', '作成日時', '更新日時'],
    // 実際に打刻した日時（秒まで）。打刻修正で時刻を直すと空欄にする（直した時刻は 開始時刻・終了時刻 が正）
    optionalHeaders: ['開始打刻日時', '終了打刻日時'],
  },
  {
    // 通勤以外の交通費（1日に何件でも）。削除は行を消さずに「削除フラグ」に ○
    // 業務走行距離は交通手段＝自家用車の行だけ。金額と距離は別の列（将来 1kmあたりの単価で金額を出せるように）
    name: SHEET_NAMES.TRANSPORT,
    headers: ['明細ID', '日付', '社員ID', '氏名', '交通手段', '出発地', '到着地', '目的・現場', '金額', '自家用車使用',
      '業務走行距離', '備考', '削除フラグ', '登録日時', '更新日時'],
    choices: { '交通手段': TRANSPORT_MODES },
  },
  {
    name: SHEET_NAMES.SETTINGS,
    headers: ['項目', '値', '説明'],
  },
];

/** 入力文字数の上限 */
const TEXT_LIMITS = { SHORT: 200, LONG: 2000 };
