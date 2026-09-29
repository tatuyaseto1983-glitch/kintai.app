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
 * 注意：Webアプリとして公開したとき、設定や利用者のアカウントの種類によっては空になることがあります（README 参照）。
 */
function getActiveUserEmail_() {
  if (APP_RUNTIME.email) return String(APP_RUNTIME.email).trim().toLowerCase();
  let email = '';
  try {
    email = Session.getActiveUser().getEmail();
  } catch (e) {
    email = '';
  }
  if (!email) {
    fail_('Googleアカウントのメールアドレスを取得できませんでした。会社のGoogleアカウントでログインしているか確認してください');
  }
  return String(email).trim().toLowerCase();
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
      };
    });
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
