/**
 * UserService.gs
 * ------------------------------------------------------------
 * ログイン中の Google アカウント（メールアドレス）から、スタッフマスタの誰なのかを判定します。
 * また、スタッフごとの勤務ルール（標準出勤・所定時間など）をまとめます。
 */

/**
 * 【画面から呼ぶ】ログイン中のユーザー情報を取得する。
 * data: { employeeId, name, email, role, isAdmin, workType, department }
 */
function getCurrentUser() {
  return runApi_(function () {
    const staff = getCurrentStaff_();
    return { message: staff.name + 'さんとしてログインしています', data: toPublicUser_(staff) };
  });
}

/**
 * ログイン中のメールアドレス（小文字）。
 * 注意：Webアプリとして公開したとき、設定や利用者のアカウントの種類によっては空になることがあります（README「F」参照）。
 *   - 空のときは必ずエラーにします。Session.getEffectiveUser()（＝スクリプトの所有者）で代用すると、
 *     全員が所有者として打刻されてしまうため、使いません。
 */
function getActiveUserEmail_() {
  if (APP_RUNTIME.email) return String(APP_RUNTIME.email).trim().toLowerCase();
  let email = '';
  try {
    email = Session.getActiveUser().getEmail();
  } catch (e) {
    email = '';
  }
  email = String(email || '').trim().toLowerCase();
  // 取得できないときに、別の人（スクリプトの所有者など）として扱うことは絶対にしない。必ずエラーで止める
  if (!email) {
    fail_('Googleアカウントのメールアドレスを取得できませんでした。打刻などの処理は行っていません。' +
      '個人のGmailアカウントでWebアプリを開いている場合や、会社のGoogle Workspaceアカウントでログインしていない場合に起こります。' +
      '管理者に連絡してください（README「F. ログインユーザー判定」参照）');
  }
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    fail_('Googleアカウントのメールアドレスの形式が正しくありません（' + email + '）。処理は行っていません。管理者に連絡してください');
  }
  return email;
}

/** ログイン中のスタッフ（見つからなければエラー） */
function getCurrentStaff_() {
  const email = getActiveUserEmail_();
  const matches = getAllStaff_().filter(function (s) { return s.email === email; });
  if (!matches.length) {
    fail_('スタッフマスタに登録されていないアカウントです（' + email + '）。管理者にスタッフ登録を依頼してください');
  }
  if (matches.length > 1) {
    fail_('スタッフマスタに同じメールアドレス（' + email + '）が複数登録されています。管理者に修正を依頼してください');
  }
  const staff = matches[0];
  if (staff.status === EMPLOYMENT_STATUS.RETIRED) fail_('退職済みのアカウントのため利用できません');
  return staff;
}

/** 打刻できるのは「在籍」のスタッフだけ */
function requireActiveStaff_(staff) {
  if (staff.status !== EMPLOYMENT_STATUS.ACTIVE) {
    fail_('在籍状況が「' + (staff.status || '未入力') + '」のため打刻できません。管理者に確認してください');
  }
}

/**
 * スタッフマスタの全員を、使いやすい形にして返す。
 * 時間の項目は「分」（未入力なら null）に変換しています。
 */
function getAllStaff_() {
  return readTable_(SHEET_NAMES.STAFF).records
    .filter(function (r) { return !isBlank_(r['社員ID']) || !isBlank_(r['メールアドレス']); })
    .map(function (r) {
      return {
        employeeId: String(r['社員ID']).trim(),
        name: String(r['氏名']).trim(),
        email: String(r['メールアドレス']).trim().toLowerCase(),
        role: String(r['権限']).trim().toLowerCase() === ROLES.ADMIN ? ROLES.ADMIN : ROLES.STAFF,
        employmentType: String(r['雇用区分']).trim(),
        workType: String(r['勤務区分']).trim(),
        standardStartMinutes: toMinutes_(r['標準出勤']),
        standardEndMinutes: toMinutes_(r['標準退勤']),
        dailyMinutes: toMinutes_(r['1日所定時間']),
        weeklyMinutes: toMinutes_(r['週所定時間']),
        monthlyMinutes: toMinutes_(r['月所定時間']),
        status: String(r['在籍状況']).trim(),
        hireDate: toDateKey_(r['入社日']),
        department: String(r['部署']).trim(),
        // 勤怠集計対象：「対象外」の人（役員など）は全スタッフ勤務状況・勤怠集計に含めない。空欄・列なし＝対象
        attendanceTarget: r['勤怠集計対象'] === undefined || String(r['勤怠集計対象']).trim() !== ATTENDANCE_TARGET.NO,
        // 休日出勤申請対象：「対象」と書かれた人だけ true（空欄・列なし＝申請できない）
        holidayWorkTarget: r['休日出勤申請対象'] !== undefined && String(r['休日出勤申請対象']).trim() === HOLIDAY_WORK_TARGET.YES,
      };
    });
}

/**
 * 全スタッフ勤務状況・勤怠集計の対象か（在籍中で、勤怠集計対象が「対象外」でない人）。
 * ※日報の閲覧・確認・コメントの対象とは別のルールです（日報は isReportMember_ を使う）
 */
function isAttendanceTarget_(staff) {
  return staff.status === EMPLOYMENT_STATUS.ACTIVE && staff.attendanceTarget !== false;
}

/** 社員IDでスタッフを探す（見つからなければ null） */
function findStaffById_(employeeId) {
  const id = String(employeeId).trim();
  return getAllStaff_().filter(function (s) { return s.employeeId === id; })[0] || null;
}

/** 画面へ返してよいユーザー情報 */
function toPublicUser_(staff) {
  return {
    employeeId: staff.employeeId,
    name: staff.name,
    email: staff.email,
    role: staff.role,
    isAdmin: staff.role === ROLES.ADMIN,
    workType: staff.workType,
    department: staff.department,
  };
}

/**
 * スタッフの勤務ルール。
 * スタッフマスタに個別の値（標準出勤・所定時間など）があればそれを、無ければ「設定」シートの値を使います。
 */
function getWorkRule_(staff, settings) {
  if (staff.workType !== WORK_TYPES.FIXED && staff.workType !== WORK_TYPES.FLEX) {
    fail_('「' + staff.name + '」さんの勤務区分「' + staff.workType + '」が正しくありません（固定勤務／フレックス）。スタッフマスタを確認してください');
  }
  return buildWorkRule_(staff.workType, staff, settings);
}

/** 勤務区分とスタッフ情報（無い場合は null）から勤務ルールを作る */
function buildWorkRule_(workType, staff, settings) {
  const pick = function (value, fallback) { return value === null || value === undefined ? fallback : value; };
  const isFixed = workType === WORK_TYPES.FIXED;
  const s = staff || {};
  const standardStart = pick(s.standardStartMinutes, settings.fixedStartMinutes);
  const standardEnd = pick(s.standardEndMinutes, settings.fixedEndMinutes);
  return {
    workType: workType,
    isFixed: isFixed,
    standardStartMinutes: standardStart,
    standardEndMinutes: standardEnd,
    dailyMinutes: pick(s.dailyMinutes, isFixed ? standardEnd - standardStart - settings.autoBreakMinutes : settings.flexDailyMinutes),
    weeklyMinutes: pick(s.weeklyMinutes, isFixed ? null : settings.flexWeeklyMinutes),
    monthlyMinutes: pick(s.monthlyMinutes, isFixed ? null : settings.flexMonthlyMinutes),
  };
}
