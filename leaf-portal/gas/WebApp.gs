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
/** 会社名（ヘッダー・ブラウザのタイトル・フッターに表示） */
const APP_BRAND_NAME = 'Leaf Co.,Ltd';
/**
 * 画面の一番下に出る「版」。どのコードが動いているか（push とデプロイ更新が済んでいるか）を画面で確かめるためのもの。
 * コードを変えて反映するときは、この値も変えてください（npm run check の表示と見比べます）。
 */
const APP_BUILD = '2026.10.04-9';

/** 画面のタイトル（ブラウザのタブに表示） */
const WEB_APP_TITLE = 'Leaf Co.,Ltd｜勤怠管理';

/**
 * ブラウザのタブのアイコン（favicon）にする画像のURL。空欄なら Google の標準アイコンのまま。
 * Apps Script の仕組み上、ここには「インターネットから見られる画像のURL（https://…）」しか指定できません。
 * （ロゴ画像を画面に埋め込む方法は favicon には使えないため。README「N」参照）
 */
const APP_FAVICON_URL = '';

/** getStaffDashboard() で取得できる情報の種類 */
const DASHBOARD_PARTS = ['user', 'today', 'month', 'staffStatus', 'flex', 'overtime', 'overtimeRule', 'transport'];

/**
 * WebアプリのURLを開いたときに呼ばれ、画面を返します。
 * URLの最後に ?view=admin を付けると管理者画面、?view=reports を付けると日報一覧を最初に開きます。
 * ※ここでは「どちらの画面を先に開くか」だけを決めます。管理者のデータは、画面が
 *   getAdminDashboard() を呼んだときにサーバー側で requireAdmin() を通った場合だけ返します。
 */
function doGet(e) {
  const template = HtmlService.createTemplateFromFile('Index');
  const requested = e && e.parameter ? String(e.parameter.view || '') : '';
  template.initialView = requested === 'admin' || requested === 'reports' ? requested : 'staff';
  template.brandName = APP_BRAND_NAME;
  template.logoSrc = getLogoDataUri_();
  template.envLabel = getEnvironmentLabel_();
  template.appBuild = APP_BUILD;
  const output = template.evaluate()
    .setTitle((template.envLabel ? '【' + template.envLabel + '】' : '') + WEB_APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  if (APP_FAVICON_URL) output.setFaviconUrl(APP_FAVICON_URL);
  return output;
}

/**
 * テスト用スプレッドシートで動いているときの表示（ヘッダーの「テスト環境」とタブの名前）。
 * スプレッドシート名に「テスト」が入っていればテスト環境とみなします（例：【テスト】リーフ勤怠管理）。
 * 本番のスプレッドシート名には「テスト」を入れないでください。
 */
function getEnvironmentLabel_() {
  try {
    return /テスト/.test(getSpreadsheet_().getName()) ? 'テスト環境' : '';
  } catch (e) {
    return '';
  }
}

/**
 * ロゴ画像（Logo.html に入っている data:image/png;base64,... の文字）。
 * ロゴはこの1か所から読み込みます。差し替えは leaf-portal/assets/logo.png を置き換えて npm run logo。
 * 形が正しくないときは空文字を返し、画面は会社名の文字だけで表示します。
 */
function getLogoDataUri_() {
  let text = '';
  try {
    text = HtmlService.createHtmlOutputFromFile('Logo').getContent().trim();
  } catch (e) {
    return '';
  }
  return /^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+\/=]+$/.test(text) ? text : '';
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
 *   'overtimeRule' 残業申請のルール（設定「残業_申請不要上限」。固定勤務の人だけ）
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

    if (wanted.indexOf('transport') !== -1) result.transport = getMyTransportExpenses(); // 本人の今の期間の交通費だけ

    if (wanted.indexOf('overtimeRule') !== -1) {
      result.overtimeRule = runApi_(function () {
        const staff = getCurrentStaff_();
        if (staff.workType !== WORK_TYPES.FIXED) return { message: '残業申請の対象外です', data: null };
        return { message: '残業申請のルールを取得しました', data: getOvertimeRule_() };
      });
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
    let view = null;
    let timeline = null;
    if (record) {
      view = toAttendanceView_(record);
      timeline = buildAttendanceTimeline_(record); // 本人の記録だけ（他の人の勤務区間は返さない）
      view.currentStyle = timeline.currentStyle || view.workStyle;
    }
    return {
      message: record ? '本日の勤怠を取得しました' : '本日はまだ出勤していません',
      data: { date: now.date, time: now.time, record: view, timeline: timeline },
    };
  });
}
