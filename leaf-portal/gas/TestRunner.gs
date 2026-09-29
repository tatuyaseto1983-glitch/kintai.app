/**
 * TestRunner.gs
 * ------------------------------------------------------------
 * 動作確認用の関数です。Apps Script の画面で関数を選んで「実行」し、「実行ログ」で結果を見ます。
 *
 * 【A. 手動テスト】本物のシートに、今の時刻・自分のアカウントで記録されます
 *   testGetCurrentUser / testClockInOffice / testClockInRemote / testStartBreak / testResumeWork /
 *   testClockOut / testMyAttendance / testTodayStaffStatus / testFlexSummary
 *
 * 【B. 自動テスト】runAllScenarioTests
 *   「Leaf勤怠_自動テスト用」という別のスプレッドシートを自動で作り（2回目以降は使い回し）、
 *   時刻とアカウントを仮に切り替えて、出勤〜残業判定〜フレックス集計までをまとめて確認します。
 *   本物のシートには一切書き込みません。
 *
 * Webアプリとして公開して社員が使い始めたら、このファイルは削除しても動作に影響はありません。
 */

// ============================================================ A. 手動テスト（本物のシートを使う）

function testGetCurrentUser() { return logApiResult_('ログインユーザー取得', getCurrentUser()); }
function testClockInOffice() { return logApiResult_('出勤（出社）', clockIn(WORK_STYLES.OFFICE)); }
function testClockInRemote() { return logApiResult_('出勤（在宅）', clockIn(WORK_STYLES.REMOTE)); }
function testStartBreak() { return logApiResult_('中断', startBreak('テスト')); }
function testResumeWork() { return logApiResult_('再開', resumeWork()); }
function testClockOut() { return logApiResult_('退勤', clockOut()); }
function testMyAttendance() { return logApiResult_('自分の勤怠一覧', getMyAttendance()); }
function testTodayStaffStatus() { return logApiResult_('全スタッフの勤務状況', getTodayStaffStatus()); }
function testFlexSummary() { return logApiResult_('フレックス集計', getFlexSummary()); }

/**
 * ログインユーザー判定の確認。実行ログに次の3つを表示します（データは変更しません）。
 *   ・Session.getActiveUser()   … このシステムが利用者の判定に使うメールアドレス
 *   ・Session.getEffectiveUser()… スクリプトを実行している権限の持ち主（参考。判定には使いません）
 *   ・スタッフマスタに登録されているか
 */
function testLoginCheck() {
  let active = '';
  let effective = '';
  try { active = Session.getActiveUser().getEmail(); } catch (e) { active = '（取得時にエラー：' + e.message + '）'; }
  try { effective = Session.getEffectiveUser().getEmail(); } catch (e) { effective = '（取得時にエラー：' + e.message + '）'; }
  const result = getCurrentUser();
  console.log('【ログイン判定の確認】\n' +
    '・利用者のメールアドレス（getActiveUser）：' + (active || '（空＝取得できません）') + '\n' +
    '・実行権限の持ち主（getEffectiveUser・参考）：' + (effective || '（空）') + '\n' +
    '・判定結果：' + (result.success ? '成功 ' + result.data.name + '（' + result.data.employeeId + '・' + result.data.role + '）' : '失敗 ' + result.message));
  return result;
}

function logApiResult_(title, result) {
  console.log('【' + title + '】' + (result.success ? '成功' : '失敗') + '：' + result.message +
    (result.data ? '\n' + JSON.stringify(result.data, null, 2) : ''));
  return result;
}

// ============================================================ B. 自動テスト（別のスプレッドシートで実行）

const TEST_SPREADSHEET_PROPERTY = 'LEAF_TEST_SPREADSHEET_ID';
const TEST_SPREADSHEET_NAME = 'Leaf勤怠_自動テスト用（削除してOK）';
// ※ファイルの読み込み順に左右されないよう、ここでは他のファイルの定数（ROLES など）を使わずに文字で書いています
const TEST_STAFF = {
  ADMIN: { id: 'T900', name: 'テスト 管理者', email: 'test.admin@example.com', role: 'admin', workType: '固定勤務' },
  FIXED: { id: 'T901', name: 'テスト 固定', email: 'test.fixed@example.com', role: 'staff', workType: '固定勤務' },
  FLEX: { id: 'T902', name: 'テスト フレックス', email: 'test.flex@example.com', role: 'staff', workType: 'フレックス' },
};

/**
 * 【自動テスト】出勤〜フレックス集計までを順番に確認します。
 * 実行ログに ✅（成功）／❌（失敗）が表示されます。
 */
function runAllScenarioTests() {
  const saved = { now: APP_RUNTIME.now, email: APP_RUNTIME.email, spreadsheet: APP_RUNTIME.spreadsheet };
  const results = [];
  const check = function (title, ok, detail) {
    results.push({ title: title, ok: !!ok, detail: detail || '' });
  };

  try {
    const testSs = prepareTestSpreadsheet_();
    APP_RUNTIME.spreadsheet = testSs;
    clearTableCache_();
    setupSystem();
    removeResetSheet_(testSs);
    seedTestStaff_();

    runFixedWorkScenarios_(check);
    runOvertimeScenarios_(check);
    runFlexScenarios_(check);
    runPermissionScenarios_(check);
    runCorrectionScenarios_(check);
    runAutoBreakSettingScenarios_(check);

    const passed = results.filter(function (r) { return r.ok; }).length;
    const lines = results.map(function (r) { return (r.ok ? '✅ ' : '❌ ') + r.title + (r.detail ? '（' + r.detail + '）' : ''); });
    const summary = '【自動テスト結果】' + results.length + '件中 ' + passed + '件 成功' +
      (passed === results.length ? '（すべて成功）' : '（失敗あり：❌ の行を確認してください）');
    console.log(lines.join('\n') + '\n\n' + summary + '\nテスト用ファイル：' + testSs.getUrl());
    return { passed: passed, failed: results.length - passed, results: results, url: testSs.getUrl() };
  } finally {
    APP_RUNTIME.now = saved.now;
    APP_RUNTIME.email = saved.email;
    APP_RUNTIME.spreadsheet = saved.spreadsheet;
    clearTableCache_();
  }
}

/** テスト用スプレッドシートを用意する（前回のテストデータは消して作り直す。本物のファイルは使わない） */
function prepareTestSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const active = SpreadsheetApp.getActiveSpreadsheet();
  let ss = null;
  const savedId = props.getProperty(TEST_SPREADSHEET_PROPERTY);
  if (savedId) {
    try { ss = SpreadsheetApp.openById(savedId); } catch (e) { ss = null; }
  }
  if (ss && active && ss.getId() === active.getId()) {
    fail_('テスト用ファイルの設定が本番のスプレッドシートを指しています。スクリプトプロパティ「' + TEST_SPREADSHEET_PROPERTY + '」を削除してください');
  }
  if (!ss) {
    ss = SpreadsheetApp.create(TEST_SPREADSHEET_NAME);
    props.setProperty(TEST_SPREADSHEET_PROPERTY, ss.getId());
  }
  // テスト用ファイルの中だけを空にする
  if (!ss.getSheetByName('__reset__')) ss.insertSheet('__reset__');
  ss.getSheets().forEach(function (sheet) {
    if (sheet.getName() !== '__reset__') ss.deleteSheet(sheet);
  });
  return ss;
}

function removeResetSheet_(ss) {
  const sheet = ss.getSheetByName('__reset__');
  if (sheet && ss.getSheets().length > 1) ss.deleteSheet(sheet);
}

function seedTestStaff_() {
  const rows = objectValues_(TEST_STAFF).map(function (s) {
    return {
      '社員ID': s.id, '氏名': s.name, 'メールアドレス': s.email, '権限': s.role, '雇用区分': '正社員',
      '勤務区分': s.workType, '在籍状況': EMPLOYMENT_STATUS.ACTIVE, '入社日': '2024-04-01', '部署': 'テスト',
    };
  });
  appendRecords_(SHEET_NAMES.STAFF, rows);
}

/** テスト中の「今」と「ログイン中のアカウント」を切り替える */
function actAs_(staff, dateTimeText) {
  APP_RUNTIME.email = staff.email;
  APP_RUNTIME.now = Utilities.parseDate(dateTimeText, APP_TIMEZONE, 'yyyy-MM-dd HH:mm');
  clearTableCache_();
}

function attendanceOf_(staff, dateKey) {
  clearTableCache_();
  return findAttendance_(staff.id, dateKey);
}

/** 固定勤務：出勤・二重出勤・中断・再開・退勤・二重退勤・在宅 */
function runFixedWorkScenarios_(check) {
  const S = TEST_STAFF.FIXED;
  const day = '2026-06-01';
  let r;

  actAs_(S, day + ' 09:30');
  r = clockIn(WORK_STYLES.OFFICE);
  check('1. 出勤：09:30 に出社で出勤できる', r.success && r.data.status === ATTENDANCE_STATUS.WORKING && r.data.late === '', r.message);

  actAs_(S, day + ' 09:35');
  r = clockIn(WORK_STYLES.OFFICE);
  check('2. 二重出勤：2回目の出勤はエラーになる', !r.success && r.message.indexOf('すでに出勤済み') !== -1, r.message);

  actAs_(S, day + ' 09:40');
  r = resumeWork();
  check('   中断していない状態で再開するとエラーになる', !r.success && r.message.indexOf('中断していない') !== -1, r.message);

  actAs_(S, day + ' 12:00');
  r = startBreak('私用外出');
  check('3. 中断：勤務中に中断できる（状態＝中断中）', r.success && r.data.status === ATTENDANCE_STATUS.ON_BREAK, r.message);
  r = startBreak();
  check('   中断中にもう一度中断するとエラーになる', !r.success && r.message.indexOf('すでに中断中') !== -1, r.message);

  actAs_(S, day + ' 12:10');
  r = clockOut();
  check('   中断中に退勤するとエラーになる', !r.success && r.message.indexOf('中断中のため退勤できません') !== -1, r.message);

  actAs_(S, day + ' 12:20');
  r = resumeWork();
  check('4. 再開：中断20分が記録され、状態が勤務中に戻る', r.success && r.data.breakTotal === '00:20' && r.data.status === ATTENDANCE_STATUS.WORKING, r.message);

  actAs_(S, day + ' 19:00');
  r = clockOut();
  const rec = r.data || {};
  check('5. 退勤：09:30〜19:00・中断20分 → 実働 08:10', r.success && rec.workTime === '08:10' && rec.autoBreak === '01:00' && rec.status === ATTENDANCE_STATUS.FINISHED,
    '実働 ' + rec.workTime + '／自動休憩 ' + rec.autoBreak);

  actAs_(S, day + ' 19:05');
  r = clockOut();
  check('6. 二重退勤：2回目の退勤はエラーになる', !r.success && r.message.indexOf('すでに退勤済み') !== -1, r.message);

  const day2 = '2026-06-02';
  actAs_(S, day2 + ' 09:45');
  r = clockIn(WORK_STYLES.REMOTE);
  check('7. 在宅勤務：在宅で出勤でき、遅刻 00:15 が記録される', r.success && r.data.workStyle === WORK_STYLES.REMOTE && r.data.late === '00:15', '遅刻 ' + (r.data && r.data.late));
  actAs_(S, day2 + ' 18:00');
  r = clockOut();
  check('   在宅勤務の退勤：早退 00:30・実働 07:15', r.success && r.data.earlyLeave === '00:30' && r.data.workTime === '07:15',
    '早退 ' + (r.data && r.data.earlyLeave) + '／実働 ' + (r.data && r.data.workTime));

  actAs_(S, day2 + ' 18:10');
  r = clockIn('直行');
  check('   不正な勤務形態はエラーになる', !r.success && r.message.indexOf('勤務形態') !== -1, r.message);
}

/** 社内超過時間と事前残業申請 */
function runOvertimeScenarios_(check) {
  const S = TEST_STAFF.FIXED;
  let r;
  let rec;

  // 5番の日（19:00退勤）は社内超過 00:30 ＝ ちょうど30分 → 申請が必要
  rec = attendanceOf_(S, '2026-06-01');
  check('   19:00退勤：社内超過時間 00:30（30分ちょうどは申請が必要）', rec['社内超過時間'] === '00:30' && rec['要確認'] === MARKS.NEEDS_CHECK,
    '社内超過 ' + rec['社内超過時間'] + '／要確認 ' + rec['要確認']);

  // 8. 30分未満
  actAs_(S, '2026-06-03 09:30');
  clockIn(WORK_STYLES.OFFICE);
  actAs_(S, '2026-06-03 18:42');
  r = clockOut();
  rec = attendanceOf_(S, '2026-06-03');
  check('8. 30分未満の残業：18:42退勤 → 社内超過 00:12、申請不要、要確認なし',
    r.success && rec['社内超過時間'] === '00:12' && rec['30分以上'] === '' && rec['事前残業申請'] === OVERTIME_REQUEST_LABEL.NOT_REQUIRED && rec['要確認'] === '',
    '社内超過 ' + rec['社内超過時間'] + '／事前残業申請 ' + rec['事前残業申請']);

  // 9. 30分以上・申請なし
  actAs_(S, '2026-06-04 09:30');
  clockIn(WORK_STYLES.OFFICE);
  actAs_(S, '2026-06-04 19:12');
  r = clockOut();
  rec = attendanceOf_(S, '2026-06-04');
  check('9. 30分以上・申請なし：19:12退勤 → 社内超過 00:42、要確認',
    r.success && rec['社内超過時間'] === '00:42' && rec['30分以上'] === MARKS.YES && rec['事前残業申請'] === OVERTIME_REQUEST_LABEL.NONE && rec['要確認'] === MARKS.NEEDS_CHECK,
    '社内超過 ' + rec['社内超過時間'] + '／要確認 ' + rec['要確認']);
  check('   実績は丸めない：退勤 19:12・実働 08:42 のまま保存', rec['退勤'] === '19:12' && rec['実働時間'] === '08:42', '実働 ' + rec['実働時間']);

  // 10. 30分以上・承認済みの申請あり
  actAs_(S, '2026-06-05 10:00');
  r = submitOvertimeRequest({ targetDate: '2026-06-05', plannedStart: '18:30', plannedEnd: '19:30', reason: '図面の修正対応' });
  check('10-1. 事前残業申請を提出できる（承認待ち）', r.success && r.data.status === REQUEST_STATUS.PENDING && r.data.plannedOvertime === '01:00', r.message);
  const requestId = r.data ? r.data.requestId : '';

  r = approveOvertimeRequest(requestId);
  check('10-2. 管理者以外は承認できない', !r.success && r.message.indexOf('管理者のみ') !== -1, r.message);

  actAs_(TEST_STAFF.ADMIN, '2026-06-05 11:00');
  r = approveOvertimeRequest(requestId);
  check('10-3. 管理者が承認できる', r.success && r.data.status === REQUEST_STATUS.APPROVED, r.message);

  actAs_(S, '2026-06-05 09:30');
  clockIn(WORK_STYLES.OFFICE);
  actAs_(S, '2026-06-05 19:12');
  r = clockOut();
  rec = attendanceOf_(S, '2026-06-05');
  check('10. 30分以上・申請あり：社内超過 00:42、事前残業申請＝承認済み、要確認なし',
    r.success && rec['社内超過時間'] === '00:42' && rec['事前残業申請'] === REQUEST_STATUS.APPROVED && rec['要確認'] === '',
    '事前残業申請 ' + rec['事前残業申請'] + '／要確認 ' + rec['要確認']);
  const request = findRecords_(SHEET_NAMES.OVERTIME, function (x) { return x['申請ID'] === requestId; })[0];
  check('   残業申請の「実績残業」に 00:42 が入る', request && request['実績残業'] === '00:42', request ? request['実績残業'] : '申請なし');
}

/** フレックスの週・月の集計と完全休日の確認 */
function runFlexScenarios_(check) {
  const F = TEST_STAFF.FLEX;
  let r;

  // 2026-06-01（月）〜06-04（木）に 8:00・8:00・8:00・7:15 → 週の実働 31:15
  const days = [['2026-06-01', '10:00', '19:00'], ['2026-06-02', '09:00', '18:00'], ['2026-06-03', '08:00', '17:00'], ['2026-06-04', '11:00', '19:15']];
  days.forEach(function (d) {
    actAs_(F, d[0] + ' ' + d[1]);
    clockIn(WORK_STYLES.OFFICE);
    actAs_(F, d[0] + ' ' + d[2]);
    clockOut();
  });
  const rec = attendanceOf_(F, '2026-06-01');
  check('   フレックスは遅刻・社内超過を判定しない（10:00出勤でも遅刻なし）', rec['遅刻'] === '' && rec['社内超過時間'] === '' && rec['要確認'] === '', '遅刻 ' + rec['遅刻']);

  actAs_(F, '2026-06-05 12:00');
  r = getFlexSummary();
  const w = r.data ? r.data.week : {};
  check('11. フレックス週集計：所定 32:00・実働 31:15・残り 00:45・超過 00:00',
    r.success && w.scheduled === '32:00' && w.worked === '31:15' && w.remaining === '00:45' && w.excess === '00:00',
    '実働 ' + w.worked + '／残り ' + w.remaining + '／超過 ' + w.excess);
  check('   週の完全休日：まだ休日がない → 未確定（あと1日必要）', w.restDayCheck && w.restDayCheck.status === '未確定', w.restDayCheck && w.restDayCheck.message);

  actAs_(F, '2026-06-05 10:00');
  clockIn(WORK_STYLES.REMOTE);
  actAs_(F, '2026-06-05 13:00');
  clockOut();
  actAs_(F, '2026-06-05 13:30');
  r = getFlexSummary();
  const w2 = r.data ? r.data.week : {};
  check('   週の所定を超えたら残り 00:00・超過 01:15（マイナスは表示しない）', r.success && w2.remaining === '00:00' && w2.excess === '01:15',
    '残り ' + w2.remaining + '／超過 ' + w2.excess);

  // 月の集計：シートに直接テストデータを追加（6月の合計を 103:15 にする）
  seedFlexRecords_(F, ['2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18'], '08:45');
  // ここまでの6月：33:15（上の5日）＋ 70:00 ＝ 103:15
  actAs_(F, '2026-06-30 12:00');
  r = getFlexSummary();
  const m = r.data ? r.data.month : {};
  check('12. フレックス月集計：所定 138:00・実働 103:15・残り 34:45',
    r.success && m.scheduled === '138:00' && m.worked === '103:15' && m.remaining === '34:45' && m.excess === '00:00',
    '実働 ' + m.worked + '／残り ' + m.remaining);

  seedFlexRecords_(F, ['2026-06-22', '2026-06-23', '2026-06-24', '2026-06-25'], '08:00');
  seedFlexRecords_(F, ['2026-06-26'], '07:05');
  actAs_(F, '2026-06-30 12:00');
  r = getFlexSummary();
  const m2 = r.data ? r.data.month : {};
  check('12. フレックス月集計：実働 142:20 → 残り 00:00・超過 04:20',
    r.success && m2.worked === '142:20' && m2.remaining === '00:00' && m2.excess === '04:20',
    '実働 ' + m2.worked + '／残り ' + m2.remaining + '／超過 ' + m2.excess);

  actAs_(TEST_STAFF.ADMIN, '2026-06-08 09:00');
  r = checkWeeklyRestDays('2026-06-01');
  const flexRow = r.data ? r.data.staff.filter(function (s) { return s.employeeId === F.id; })[0] : null;
  check('   週1日の完全休日の確認（管理者）：6/1〜6/7 は6/6・6/7が休み → 確保済み', r.success && flexRow && flexRow.status === '確保済み', flexRow && flexRow.message);

  actAs_(TEST_STAFF.FIXED, '2026-06-30 12:00');
  r = getFlexSummary();
  check('   固定勤務の人がフレックス集計を開くとエラーになる', !r.success && r.message.indexOf('フレックス勤務ではありません') !== -1, r.message);
}

/** 退勤済みのフレックス勤怠をシートに直接追加する（月集計テスト用） */
function seedFlexRecords_(staff, dates, workTime) {
  appendRecords_(SHEET_NAMES.ATTENDANCE, dates.map(function (date) {
    return {
      '勤怠ID': makeAttendanceId_(date, staff.id), '日付': date, '社員ID': staff.id, '氏名': staff.name,
      '勤務区分': WORK_TYPES.FLEX, '勤務形態': WORK_STYLES.OFFICE, '出勤': '09:00', '退勤': '', '実働時間': workTime,
      '状態': ATTENDANCE_STATUS.FINISHED, '備考': 'テスト用に直接追加',
    };
  }));
}

/** 権限と未登録ユーザー */
function runPermissionScenarios_(check) {
  let r;
  actAs_({ email: 'unknown@example.com' }, '2026-06-08 09:00');
  r = getCurrentUser();
  check('   未登録のメールアドレスはエラーになる', !r.success && r.message.indexOf('登録されていない') !== -1, r.message);

  actAs_(TEST_STAFF.FIXED, '2026-06-08 09:00');
  r = getCurrentUser();
  check('   ログインユーザー取得：社員ID・氏名・権限が取れる', r.success && r.data.employeeId === TEST_STAFF.FIXED.id && r.data.role === ROLES.STAFF, r.message);
  r = getAllAttendance('2026-06-01', '2026-06-30');
  check('   スタッフは管理者用の関数を使えない', !r.success && r.message.indexOf('管理者のみ') !== -1, r.message);
  r = clockOut();
  check('   出勤前に退勤するとエラーになる', !r.success && r.message.indexOf('まだ出勤していません') !== -1, r.message);

  actAs_(TEST_STAFF.FIXED, '2026-06-05 20:00');
  r = getTodayStaffStatus();
  const list = r.data ? r.data.staff : [];
  const leaked = list.some(function (s) { return s.clockIn !== undefined || s.workTime !== undefined || s.late !== undefined; });
  const fixedRow = list.filter(function (s) { return s.name === TEST_STAFF.FIXED.name; })[0];
  check('   全スタッフ勤務状況：氏名・勤務形態・状態だけを返す（時間は返さない）', r.success && !leaked && fixedRow && fixedRow.status === ATTENDANCE_STATUS.FINISHED,
    list.map(function (s) { return s.name + ' ' + s.label; }).join('／'));

  r = getMyAttendance('2026-06');
  const others = r.data ? r.data.records.filter(function (x) { return x.employeeId !== TEST_STAFF.FIXED.id; }) : [1];
  check('   自分の勤怠一覧：自分の記録だけが返る', r.success && r.data.records.length === 5 && others.length === 0, (r.data ? r.data.records.length : 0) + '件');
}

/** 打刻修正申請と日報 */
function runCorrectionScenarios_(check) {
  const S = TEST_STAFF.FIXED;
  let r;

  actAs_(S, '2026-06-08 09:00');
  r = submitCorrectionRequest({ targetDate: '2026-06-03', item: CORRECTION_ITEMS.CLOCK_OUT, after: '18:20', reason: '退勤の押し忘れ' });
  check('   打刻修正申請：申請できる（勤怠記録はまだ変わらない）', r.success && attendanceOf_(S, '2026-06-03')['退勤'] === '18:42' &&
    attendanceOf_(S, '2026-06-03')['打刻修正状況'] === CORRECTION_STATE.PENDING, r.message);
  const requestId = r.data ? r.data.requestId : '';

  actAs_(TEST_STAFF.ADMIN, '2026-06-08 10:00');
  r = approveCorrectionRequest(requestId);
  const rec = attendanceOf_(S, '2026-06-03');
  check('   打刻修正の承認：退勤 18:20 に直り、社内超過 00:00・早退 00:10 に再計算される',
    r.success && rec['退勤'] === '18:20' && rec['社内超過時間'] === '00:00' && rec['早退'] === '00:10' && rec['打刻修正状況'] === CORRECTION_STATE.APPROVED,
    '退勤 ' + rec['退勤'] + '／早退 ' + rec['早退']);

  actAs_(S, '2026-06-08 18:00');
  r = saveDailyReport({ workContent: '現場打合せ', progress: '図面確認完了', tomorrowPlan: '見積作成' });
  check('   日報を提出できる', r.success && r.data.status === REPORT_STATUS.SUBMITTED, r.message);
  r = saveDailyReport({ status: REPORT_STATUS.SUBMITTED });
  check('   日報：業務内容が空のまま提出するとエラーになる', !r.success, r.message);
}

/** 自動休憩_適用開始 の設定変更だけで、短時間勤務の自動休憩を引かないようにできるか */
function runAutoBreakSettingScenarios_(check) {
  const S = TEST_STAFF.FIXED;
  const workDay = function (date, inTime, outTime, breakStart, breakEnd) {
    actAs_(S, date + ' ' + inTime);
    clockIn(WORK_STYLES.OFFICE);
    if (breakStart) {
      actAs_(S, date + ' ' + breakStart);
      startBreak('テスト');
      actAs_(S, date + ' ' + breakEnd);
      resumeWork();
    }
    actAs_(S, date + ' ' + outTime);
    return clockOut().data || {};
  };

  let rec = workDay('2026-06-09', '09:30', '13:30');
  check('   自動休憩_適用開始＝00:00（初期値）：4時間勤務でも自動休憩 01:00 を引く', rec.autoBreak === '01:00' && rec.workTime === '03:00',
    '自動休憩 ' + rec.autoBreak + '／実働 ' + rec.workTime);

  // テスト用ファイルの設定シートだけを書き換える
  clearTableCache_();
  const setting = findRecords_(SHEET_NAMES.SETTINGS, function (r) { return r['項目'] === SETTING_KEYS.AUTO_BREAK_THRESHOLD; })[0];
  updateRecord_(SHEET_NAMES.SETTINGS, setting, { '値': '06:00' });

  rec = workDay('2026-06-10', '09:30', '15:30');
  check('   自動休憩_適用開始＝06:00：ちょうど6時間の勤務では自動休憩を引かない', rec.autoBreak === '00:00' && rec.workTime === '06:00',
    '自動休憩 ' + rec.autoBreak + '／実働 ' + rec.workTime);
  rec = workDay('2026-06-11', '09:30', '15:31');
  check('   自動休憩_適用開始＝06:00：6時間を超えたら自動休憩を引く', rec.autoBreak === '01:00' && rec.workTime === '05:01',
    '自動休憩 ' + rec.autoBreak + '／実働 ' + rec.workTime);
  rec = workDay('2026-06-12', '09:30', '16:30', '12:00', '13:30');
  check('   自動休憩_適用開始＝06:00：中断を除いて6時間以下なら引かない（7時間−中断1:30）', rec.autoBreak === '00:00' && rec.workTime === '05:30',
    '自動休憩 ' + rec.autoBreak + '／実働 ' + rec.workTime);

  clearTableCache_();
  updateRecord_(SHEET_NAMES.SETTINGS, findRecords_(SHEET_NAMES.SETTINGS, function (r) { return r['項目'] === SETTING_KEYS.AUTO_BREAK_THRESHOLD; })[0], { '値': '00:00' });
}
