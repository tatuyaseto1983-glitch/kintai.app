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
  // 段階3：シフト（管理者がシートに直接入力。行がない日＝未登録）と有給休暇申請
  SHIFTS: 'シフト',
  PAID_LEAVE: '有給休暇申請',
  // 稟議申請（購入・支出の事前承認）と、その操作の履歴（申請・承認・却下・確定金額の入力と訂正・再承認）
  RINGI: '稟議管理',
  RINGI_HISTORY: '稟議_更新履歴',
};

/** 権限 */
const ROLES = { STAFF: 'staff', ADMIN: 'admin' };

/**
 * 稟議申請。状態の流れ：申請中 →（承認）承認済 →［概算で確定金額が申請金額を超えた］再承認待ち →（再承認）再承認済
 *                          └（却下）却下                                 └（再承認を却下）却下（却下区分＝再承認却下）
 * 確定金額が申請金額以下なら承認済のまま。再承認済のあとは確定金額を変えられない。
 */
const RINGI_STATUS = { PENDING: '申請中', APPROVED: '承認済', REJECTED: '却下', REAPPROVAL_PENDING: '再承認待ち', REAPPROVED: '再承認済' };
const RINGI_CERTAINTY = { FIXED: '確定', ESTIMATE: '概算' };
const RINGI_EXPENSE_TYPES = ['備品購入', '旅費交通費', '接待交際費', '研修費', '広告宣伝費', '雑費', 'その他'];
const RINGI_REAPPROVAL = { REQUIRED: '要', NOT_REQUIRED: '不要' };
/** 却下の区分（通常の申請の却下と、再承認の却下を区別する） */
const RINGI_REJECT_KIND = { NORMAL: '通常却下', REAPPROVAL: '再承認却下' };
/** 稟議_更新履歴の「操作」 */
const RINGI_ACTIONS = {
  SUBMIT: '申請', APPROVE: '承認', REJECT: '却下', FINAL_AMOUNT: '確定金額入力', FINAL_AMOUNT_FIX: '確定金額訂正',
  REAPPROVE: '再承認', REAPPROVAL_REJECT: '再承認却下',
};
/** 金額（税込・円）と数量の範囲 */
const RINGI_LIMITS = { AMOUNT_MIN: 1, AMOUNT_MAX: 100000000, QUANTITY_MAX: 100000 };
/** スタッフマスタ「自己承認可」：TRUE の人だけ、自分の稟議を承認・再承認できる（社長を想定。氏名では判定しない） */
const SELF_APPROVAL = { YES: 'TRUE', NO: 'FALSE' };

/** 勤務区分 */
const WORK_TYPES = { FIXED: '固定勤務', FLEX: 'フレックス' };

/** 在籍状況 */
const EMPLOYMENT_STATUS = { ACTIVE: '在籍', ON_LEAVE: '休職', RETIRED: '退職' };

/** 雇用区分（選択肢の例。リスト外の値も入力できます） */
const EMPLOYMENT_TYPES = ['正社員', '契約社員', 'パート・アルバイト'];

/**
 * 勤務形態（内部の値）。新しい打刻で保存するのは 出社・在宅 の2つだけ（画面の表記は「勤務場所：会社／在宅」）。
 * 現場・外出は以前のテストデータに残っていることがあるので、読み取りと表示（旧データ）だけ受け付ける。
 * 現場は勤務形態ではなく、勤務区間の付帯情報（直行・直帰・現場名）で表す。
 */
const WORK_STYLES = { OFFICE: '出社', REMOTE: '在宅', SITE: '現場', OUTING: '外出' };

/** 勤務区間の「勤務形態」として読める値（この順番で「出社＋在宅」のように並べる。現場・外出は旧データ） */
function segmentWorkStyles_() {
  return [WORK_STYLES.OFFICE, WORK_STYLES.REMOTE, WORK_STYLES.SITE, WORK_STYLES.OUTING];
}

/** 打刻（出勤・切替・再開・再出勤）で選べる勤務形態＝勤務場所。出社（画面は「会社」）・在宅 だけ */
function punchWorkStyles_() {
  return [WORK_STYLES.OFFICE, WORK_STYLES.REMOTE];
}

/** 画面に出す勤務場所の名前（出社→会社。旧データの現場・外出は「（旧）」を付ける） */
function workPlaceLabel_(style) {
  if (style === WORK_STYLES.OFFICE) return '会社';
  if (style === WORK_STYLES.REMOTE) return '在宅';
  return style ? style + '（旧）' : '';
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

/** シフト区分（シートに入れる値）と、判定の結果（行がない＝未登録、同じ日に2行以上＝シフト重複、区分の値が正しくない＝シフト不備） */
const SHIFT_TYPES = { NORMAL: '通常勤務', HOLIDAY: '休日', LEGAL_HOLIDAY: '法定休日' };
const SHIFT_STATE = { UNREGISTERED: '未登録', DUPLICATE: 'シフト重複', INVALID: 'シフト不備' };

/**
 * シフト管理を使うか（今は使わない）。
 * false の間は、シフトシートを作らず、シフトを読まず、シフトで申請の受付・承認や遅刻・早退の判定を変えません
 * （休日出勤申請・有給休暇申請は、シフトの登録がなくても申請・承認できます）。
 * シフトの判定のコード（ShiftService.gs など）は、後の段階で使うために残しています。使うときは true にして setupSystem() を実行します。
 */
const SHIFT_FEATURE = { enabled: false };

/** 有給の種別 */
const PAID_LEAVE_TYPES = { FULL: '1日有給', AM: '午前半休', PM: '午後半休' };

/** スタッフマスタ「有給申請対象」：「対象」の人だけ有給申請できる */
const PAID_LEAVE_TARGET = { YES: '対象', NO: '対象外' };

/** 申請のステータスの画面での表示（内部の値「申請中」は変えずに「承認待ち」と表示する） */
function requestStatusLabel_(status) {
  return status === HOLIDAY_WORK_STATUS.PENDING ? '承認待ち' : status;
}

/** 休日出勤の振替休日区分 */
const COMP_DAY_TYPES = { PLANNED: '取得予定', NONE: '取得予定なし', UNDECIDED: '未定' };

/**
 * 日報の接客記録：来場のきっかけ（新しく選べる値）。検索は Google／Yahoo!／検索（不明）に分け、合計で検索流入を見る。
 * 「未確認」はいつでも選べる（来場のきっかけを聞けなかったとき）。
 */
const VISIT_TRIGGERS = ['Google検索', 'Yahoo!検索', '検索（不明）', 'Googleマップ', 'Instagram', 'LINE', '紹介', '既存顧客', '看板', '通りがかり',
  'チラシ', 'イベント（見学会など）', 'その他', '未確認'];
/** 以前の選択肢（既存データは書き換えず、そのまま読む・保存し直せる。新しく選ぶ候補には出さない） */
const LEGACY_VISIT_TRIGGERS = ['Web検索', '看板・通りがかり', 'イベント'];
/** 接客の担当区分（会社の接客件数は主担当だけを数える。副担当は「副担当参加件数」として別に数える）。空欄の旧データは主担当 */
const CUSTOMER_ROLES = { MAIN: '主担当', SUB: '副担当' };
/** スタッフマスタの「日報提出対象」「日報確認対象」の値 */
const REPORT_TARGET = { YES: '対象', NO: '対象外' };
/** 本人が新しく日報を作れる過去の日数（今日を含めず7日前まで。勤務実績がある日だけ） */
const REPORT_PAST_DAYS = 7;
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
  // 段階3：有給・半休
  PAID_LEAVE_DAY: '有給_1日時間',
  PAID_LEAVE_HALF: '有給_半日時間',
  AM_HALF_START: '午前半休_勤務開始',
  PM_HALF_END: '午後半休_勤務終了',
  FLEX_PAID_LEAVE: 'フレックス_有給算入',
  REPORT_MISSING_FROM: '日報_未提出判定開始日',
  AUTO_BREAK_THRESHOLD_FROM: '自動休憩_適用開始_有効日',
  // 各種申請のメール通知（NotificationService.gs）
  NOTIFY_METHOD: '通知方法',
  MAIL_NOTIFY: 'メール通知',
  MAIL_NOTIFY_OVERRIDE: 'メール通知_送信先の上書き',
};

/** フレックスの有給の扱い（138時間などの所定への算入）。社労士の確認が済むまで「未確定」 */
const FLEX_PAID_LEAVE_MODES = { UNDECIDED: '未確定', EXCLUDE: '算入しない', INCLUDE: '算入する' };

/** 設定「メール通知」 */
const MAIL_NOTIFY = { ON: '送信する', OFF: '送信しない' };
/** 設定「通知方法」：各種申請の通知をどれで送るか */
const NOTIFY_METHODS = { MAIL: 'メール', CHAT: 'Google Chat', BOTH: '両方', NONE: '通知なし' };

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
  { key: SETTING_KEYS.PAID_LEAVE_DAY, value: '08:00', note: '1日有給で記録する有給時間（実働とは別に記録します）' },
  { key: SETTING_KEYS.PAID_LEAVE_HALF, value: '04:00', note: '午前半休・午後半休で記録する有給時間（実働とは別に記録します）' },
  { key: SETTING_KEYS.AM_HALF_START, value: '14:30', note: '午前半休の日の勤務開始の基準（固定勤務・通常勤務日だけ。これより遅い開始を遅刻として記録します）' },
  { key: SETTING_KEYS.PM_HALF_END, value: '13:30', note: '午後半休の日の勤務終了の基準（固定勤務・通常勤務日だけ。これより早い終了を早退として記録します）' },
  { key: SETTING_KEYS.REPORT_MISSING_FROM, value: '', note: 'この日付（例：2026-10-21）以降の勤務日だけ、日報の「未提出」「下書きのみ」を判定します。空欄の間は判定しません（日報の運用開始日を入れてください）。勤務記録の表示は変わりません' },
  { key: SETTING_KEYS.AUTO_BREAK_THRESHOLD_FROM, value: '', note: 'この日付（例：2026-09-21）以降の勤務日に「自動休憩_適用開始」を使います。それより前の日は 00:00（常に差し引く＝以前の初期値）で計算します。空欄＝すべての日に「自動休憩_適用開始」を使います。変えたあとは管理者画面の［再計算のプレビュー］で確認してから再計算してください' },
  { key: SETTING_KEYS.NOTIFY_METHOD, value: NOTIFY_METHODS.CHAT, note: '各種申請の通知の方法：メール／Google Chat／両方／通知なし。Google Chat は管理者用スペースへの通知（新規申請・稟議の再承認待ち）。Webhook URL は Apps Script のスクリプトプロパティ GOOGLE_CHAT_WEBHOOK_URL に入れます。申請者本人への通知はメール（「メール」「両方」のとき）' },
  { key: SETTING_KEYS.MAIL_NOTIFY, value: MAIL_NOTIFY.ON, note: '各種申請（残業・有給休暇・休日出勤・稟議）の申請・承認・却下などをメールで知らせるか：送信する／送信しない。管理者（在籍・権限＝admin）と申請者本人に届きます' },
  { key: SETTING_KEYS.MAIL_NOTIFY_OVERRIDE, value: '', note: 'メールアドレスを入れると、すべての通知メールをそのアドレスだけに送ります（テスト環境で実際の社員に届かないようにするため）。空欄＝通常どおり。本番では空欄にしてください' },
  { key: SETTING_KEYS.FLEX_PAID_LEAVE, value: '未確定', note: 'フレックスの有給を月の所定（138時間など）に算入するか：未確定／算入しない／算入する。社労士に確認してから変えてください（未確定の間は実働と有給を別々に表示し、所定には足しません）' },
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
    optionalHeaders: ['勤怠集計対象', '休日出勤申請対象', '有給申請対象', '日報提出対象', '日報確認対象', '自己承認可'],
    choices: {
      '権限': [ROLES.STAFF, ROLES.ADMIN],
      '勤務区分': [WORK_TYPES.FIXED, WORK_TYPES.FLEX],
      '在籍状況': [EMPLOYMENT_STATUS.ACTIVE, EMPLOYMENT_STATUS.ON_LEAVE, EMPLOYMENT_STATUS.RETIRED],
      '勤怠集計対象': [ATTENDANCE_TARGET.YES, ATTENDANCE_TARGET.NO],
      '休日出勤申請対象': [HOLIDAY_WORK_TARGET.YES, HOLIDAY_WORK_TARGET.NO],
      '有給申請対象': [PAID_LEAVE_TARGET.YES, PAID_LEAVE_TARGET.NO],
    },
    // 列を新しく作ったときだけ、初期値を入れる（既存の値は変えない）。中身は HolidayWorkService.gs・PaidLeaveService.gs
    onColumnsAdded: function (sheet, added) {
      return [initHolidayWorkTargetColumn_(sheet, added), initPaidLeaveTargetColumn_(sheet, added), initReportTargetColumns_(sheet, added),
        initSelfApprovalColumn_(sheet, added)]
        .filter(function (x) { return x; }).join('。');
    },
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
      '最終更新日時', '作成日時',
      // 段階4（なくても動く。setupSystem() で右端に追加）
      '下書き保存日時'],
    choices: { 'ステータス': [REPORT_STATUS.DRAFT, REPORT_STATUS.SUBMITTED, REPORT_STATUS.CONFIRMED] },
  },
  {
    name: SHEET_NAMES.REPORT_CUSTOMERS,
    headers: ['接客ID', '日報ID', '社員ID', '並び順', '顧客名', '顧客名未確認', '来場のきっかけ', 'その他の内容', '接客内容',
      '対応結果', '補足コメント', '次回対応', '次回対応内容', '削除', '作成日時', '更新日時'],
    // 段階4：担当区分（主担当／副担当）、副担当のときの主担当者、日付（集計用。列を作るときに既存行は日報から埋める）
    optionalHeaders: ['担当区分', '主担当者ID', '主担当者名', '日付'],
    choices: { '担当区分': [CUSTOMER_ROLES.MAIN, CUSTOMER_ROLES.SUB] },
    onColumnsAdded: function (sheet, added) { return initCustomerDateColumn_(sheet, added); },
  },
  {
    // 確認するたびに1行追加（消さない）。「確認済み」かどうかは、今の日報バージョンの行があるかで決める
    name: SHEET_NAMES.REPORT_CONFIRMATIONS,
    headers: ['確認ID', '日報ID', '日報バージョン', '社員ID', '確認者名', '確認日時'],
  },
  {
    name: SHEET_NAMES.REPORT_COMMENTS,
    headers: ['コメントID', '日報ID', '社員ID', '社員名', 'コメント', '投稿日時'],
    // 段階4：管理者による削除（行は消さない）と、二重投稿を防ぐ送信ID
    optionalHeaders: ['削除', '削除者ID', '削除者名', '削除日時', '送信ID'],
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
    // 段階3：現場（任意）。申請したときのシフト区分はシフト管理を使うときだけ列を作る（承認は「今の」シフトで判定する）
    optionalHeaders: ['現場'],
    shiftOptionalHeaders: ['申請時シフト区分'],
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
    // 社員×日付のシフト。管理者がシートに直接入力する（行がない日＝未登録。通常勤務とはみなさない）
    // 予定開始・予定終了は表示だけ（今は計算に使わない）。シフト管理を使うとき（SHIFT_FEATURE.enabled）だけ作る
    name: SHEET_NAMES.SHIFTS,
    requiresShift: true,
    headers: ['日付', '社員ID', '氏名', 'シフト区分', '予定開始', '予定終了', '備考', '登録日時', '更新日時'],
    choices: { 'シフト区分': [SHIFT_TYPES.NORMAL, SHIFT_TYPES.HOLIDAY, SHIFT_TYPES.LEGAL_HOLIDAY] },
  },
  {
    // 有給休暇申請（休日出勤申請と同じ構造・同じステータス。画面では「申請中」を「承認待ち」と表示）
    name: SHEET_NAMES.PAID_LEAVE,
    headers: ['申請ID', '申請日時', '社員ID', '氏名', '対象日', '有給種別', '理由', '備考', '申請時シフト区分', '事後申請',
      'ステータス', '承認者ID', '承認者名', '承認日時', '却下理由', '取消申請日時', '取消承認日時', '取消理由',
      '取消処理者ID', '取消処理者名', '取消却下理由', '更新日時'],
    choices: {
      '有給種別': [PAID_LEAVE_TYPES.FULL, PAID_LEAVE_TYPES.AM, PAID_LEAVE_TYPES.PM],
      'ステータス': [HOLIDAY_WORK_STATUS.PENDING, HOLIDAY_WORK_STATUS.APPROVED, HOLIDAY_WORK_STATUS.REJECTED,
        HOLIDAY_WORK_STATUS.CANCEL_REQUESTED, HOLIDAY_WORK_STATUS.CANCELLED],
    },
  },
  {
    // 稟議申請（1申請1行）。申請金額は申請後に書き換えない。確定金額の訂正の履歴は 稟議_更新履歴 に残す
    // 添付資料URL：今は見積書などの共有リンクを貼るだけ（将来、画面からのアップロードを足すときもこの列に保存する）
    name: SHEET_NAMES.RINGI,
    headers: ['稟議ID', '申請日時', '申請者メール', '申請者名', '社員ID', '購入品名', '購入数量', '経費種別', '支出理由・目的',
      '金額の確度', '申請金額', '支出予定日', '添付資料URL', '申請状態', '承認者', '承認者メール', '承認日時', '却下理由',
      '確定金額', '確定金額入力者', '確定金額入力者メール', '確定金額入力日時', '概算との差額', '再承認要否', '再承認者',
      '再承認者メール', '再承認日時', '最終更新日時'],
    // 却下が「通常の却下」か「再承認の却下」か（右端に追加）
    optionalHeaders: ['却下区分'],
    choices: {
      '経費種別': RINGI_EXPENSE_TYPES,
      '金額の確度': [RINGI_CERTAINTY.FIXED, RINGI_CERTAINTY.ESTIMATE],
      '申請状態': [RINGI_STATUS.PENDING, RINGI_STATUS.APPROVED, RINGI_STATUS.REJECTED, RINGI_STATUS.REAPPROVAL_PENDING, RINGI_STATUS.REAPPROVED],
    },
  },
  {
    // 稟議の操作ごとに1行追加（申請・承認・却下・確定金額入力・確定金額訂正・再承認・再承認却下）。行は消さない
    name: SHEET_NAMES.RINGI_HISTORY,
    headers: ['履歴ID', '稟議ID', '日時', '操作', '操作者', '操作者メール', '操作者社員ID', '変更前の申請状態', '変更後の申請状態',
      '変更前の確定金額', '変更後の確定金額', '理由・備考'],
  },
  {
    name: SHEET_NAMES.SETTINGS,
    headers: ['項目', '値', '説明'],
  },
];

/** 入力文字数の上限 */
const TEXT_LIMITS = { SHORT: 200, LONG: 2000 };
