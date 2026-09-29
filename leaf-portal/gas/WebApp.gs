/**
 * WebApp.gs
 * ------------------------------------------------------------
 * スタッフ画面（Webアプリ）の入口です。
 *
 *   doGet()              … WebアプリのURLを開いたときに画面（Index.html）を返す
 *   getStaffDashboard()  … 画面の表示に必要な情報を1回でまとめて返す（読み取り専用）
 *
 * 【安全のための決まり】
 *   - 画面から社員IDを受け取りません。本人は必ずログイン中のGoogleアカウントから判定します
 *   - 他のスタッフについて返すのは getTodayStaffStatus() の「氏名・勤務形態・状態」だけです
 *   - 管理者用の関数はここから呼びません
 * 打刻・申請・日報は、既存の clockIn() などを画面から直接呼びます（このファイルでは処理しません）。
 */

/** 画面のタイトル */
const WEB_APP_TITLE = 'リーフ 社内ポータル｜勤怠管理';

/** getStaffDashboard() で取得できる情報の種類 */
const DASHBOARD_PARTS = ['user', 'today', 'month', 'staffStatus', 'flex', 'overtime'];

/**
 * WebアプリのURLを開いたときに呼ばれ、画面を返します。
 * URLの最後に ?view=admin を付けると、最初に管理者画面を開きます。
 * ※ここでは「どちらの画面を先に開くか」だけを決めます。管理者のデータは、画面が
 *   getAdminDashboard() を呼んだときにサーバー側で requireAdmin() を通った場合だけ返します。
 */
function doGet(e) {
  const template = HtmlService.createTemplateFromFile('Index');
  const requested = e && e.parameter ? String(e.parameter.view || '') : '';
  template.initialView = requested === 'admin' ? 'admin' : 'staff';
  return template.evaluate()
    .setTitle(WEB_APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * HTML の中で別のHTMLファイル（Styles・Scripts）を読み込むための関数。
 * Index.html の <?!= includeHtml_('Styles') ?> から使います。
 */
function includeHtml_(fileName) {
  return HtmlService.createHtmlOutputFromFile(fileName).getContent();
}

/**
 * 【画面から呼ぶ】スタッフ画面に必要な情報をまとめて取得する（読み取りのみ・何も書き込みません）。
 *
 * @param {string[]} [parts] 取得したい情報。省略するとすべて。
 *   'user'        ログイン中のユーザー          … getCurrentUser()
 *   'today'       自分の今日の勤怠（1件 or null）
 *   'month'       自分の今月の勤怠一覧          … getMyAttendance()
 *   'staffStatus' 全スタッフの今の状況          … getTodayStaffStatus()（氏名・勤務形態・状態だけ）
 *   'flex'        フレックス集計（フレックスの人だけ） … getFlexSummary()
 *   'overtime'    自分の残業申請（固定勤務の人だけ）   … getMyOvertimeRequests()
 *
 * 戻り値：{ success, message, data: { user: {...}, today: {...}, ... } }
 *   data の中の各項目も { success, message, data } の形です。
 *   1つが失敗しても、ほかの項目は表示できるようにするためです。
 */
function getStaffDashboard(parts) {
  return runApi_(function () {
    const wanted = normalizeDashboardParts_(parts);
    const result = {};
    let user = null;

    // ログインユーザーは、今日の勤怠やフレックス集計の判定にも使うので、必ず最初に取得する
    const userResult = getCurrentUser();
    if (userResult.success) user = userResult.data;
    if (wanted.indexOf('user') !== -1) result.user = userResult;

    if (wanted.indexOf('today') !== -1) result.today = getMyTodayAttendance_();
    if (wanted.indexOf('month') !== -1) result.month = getMyAttendance();
    if (wanted.indexOf('staffStatus') !== -1) result.staffStatus = getTodayStaffStatus();
    if (wanted.indexOf('flex') !== -1) {
      if (user && user.workType === WORK_TYPES.FLEX) {
        result.flex = getFlexSummary(); // 社員IDは渡さない＝必ず本人の集計
      } else {
        result.flex = { success: true, message: 'フレックス勤務ではないため表示しません', data: null };
      }
    }

    if (wanted.indexOf('overtime') !== -1) {
      if (user && user.workType === WORK_TYPES.FIXED) {
        result.overtime = getMyOvertimeRequests(); // 本人の申請だけ（社員IDは渡さない）
      } else {
        result.overtime = { success: true, message: '残業申請の対象外です', data: null };
      }
    }

    return { message: '画面の情報を取得しました', data: result };
  });
}

/** 画面から来た parts を、決められた名前だけに絞る */
function normalizeDashboardParts_(parts) {
  if (!Array.isArray(parts) || !parts.length) return DASHBOARD_PARTS.slice();
  const wanted = parts.map(function (p) { return String(p); }).filter(function (p) { return DASHBOARD_PARTS.indexOf(p) !== -1; });
  return wanted.length ? wanted : DASHBOARD_PARTS.slice();
}

/**
 * 自分の「今日の勤怠」。
 * 今日の記録がなく、前日の記録がまだ勤務中・中断中なら、そちらを返します（日付をまたぐ勤務）。
 * 出勤していなければ data は null（＝未出勤）。
 */
function getMyTodayAttendance_() {
  return runApi_(function () {
    const staff = getCurrentStaff_();
    const now = getNowInfo_();
    const record = findCurrentAttendance_(staff.employeeId, now.date);
    return {
      message: record ? '本日の勤怠を取得しました' : '本日はまだ出勤していません',
      data: { date: now.date, time: now.time, record: record ? toAttendanceView_(record) : null },
    };
  });
}
