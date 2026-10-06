/**
 * NotificationService.gs
 * ------------------------------------------------------------
 * 各種申請（残業・有給休暇・休日出勤・稟議）のメール通知です。各申請のサービスから呼びます。
 *
 *   申請時                … 管理者へ「新しい申請が届きました」、申請者本人へ「申請を受け付けました」
 *   承認・却下時          … 申請者本人へ結果（却下は却下理由を必ず入れる）
 *   稟議：再承認待ち      … 管理者へ「再承認が必要です」、申請者本人へ「再承認待ちになりました」
 *   稟議：再承認・再承認却下 … 申請者本人へ結果（再承認却下は却下理由を必ず入れる）
 *
 * 送り方（申請・承認そのものを、メールの失敗で止めないため）
 *   1. 各サービスは、シートへの保存が終わった後に queueMail_ でメールを「予約」するだけ（ここでは送らない）
 *   2. runApi_ が、処理が成功して withLock_ の保存・ロック解除まで終わった後に flushNotifications_ で送る
 *      （処理がエラーで終わったときは、予約したメールを捨てる＝保存されていない申請の通知は送らない）
 *   3. 1通ずつ送り、失敗してもほかのメール・画面の結果には影響させない。失敗は console.error（Apps Script の実行ログ）に残す
 *
 * 宛先
 *   管理者 … スタッフマスタで「在籍」かつ 権限＝admin の人（メールアドレスはコードに書かない）。申請者本人は除く（本人には受付の通知が届く）
 *   申請者 … スタッフマスタの社員IDから今のメールアドレス（稟議は 申請者メール 列も予備に使う）
 * 送信元は Webアプリを「自分として実行」しているアカウント（MailApp）。
 *
 * 設定シート
 *   メール通知                   … 送信する／送信しない（送信しない＝予約しても送らない）
 *   メール通知_送信先の上書き     … メールアドレスを入れると、すべての通知をそのアドレスだけに送る（テスト環境で実際の社員に届かないように）。
 *                                   本文の最初に本来の宛先を書く。空欄＝通常どおり
 */

/** 1回の画面操作（runApi_）の中で予約したメール */
var NOTIFICATION_QUEUE_ = [];

/** 件名の先頭 */
function mailSubjectPrefix_() {
  return '【' + APP_BRAND_NAME + ' 社内ポータル】';
}

/**
 * 【エディタから実行・管理者だけ】メール通知の確認：自分（実行している管理者）にテストメールを1通送る。
 * 初めて実行するときに「メールの送信」の権限の承認を求められます（承認しないと通知メールは送られません）。
 * 設定「メール通知」「メール通知_送信先の上書き」もここで確かめられます。
 */
function sendTestNotification() {
  const result = runApi_(function () {
    const admin = requireAdmin();
    queueMail_(admin.email, 'メール通知のテスト', admin.name + ' さん\n\n社内ポータルのメール通知のテストです。このメールが届いていれば、各種申請の通知メールを送れます。');
    return { message: admin.email + ' 宛にテストメールを送りました（届かない場合は、設定「メール通知」と Apps Script の実行ログを確認してください）' };
  });
  console.log(result.message);
  return result;
}

// ============================================================ 予約・送信（runApi_ から呼ぶ）

function clearNotificationQueue_() {
  NOTIFICATION_QUEUE_ = [];
}

/** メールを予約する（to はメールアドレス。空・形式が違うものは予約しない） */
function queueMail_(to, subject, body) {
  const address = String(to || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(address)) return;
  NOTIFICATION_QUEUE_.push({ to: address, subject: mailSubjectPrefix_() + subject, body: body });
}

/**
 * 予約したメールを送る（保存・ロック解除の後）。エラーは投げない。
 * @return {{ sent: number, failed: number, skipped: number }}
 */
function flushNotifications_() {
  const queue = NOTIFICATION_QUEUE_;
  NOTIFICATION_QUEUE_ = [];
  const result = { sent: 0, failed: 0, skipped: 0 };
  if (!queue.length) return result;
  let config;
  try {
    config = notificationConfig_();
  } catch (e) {
    console.error('メール通知：設定を読めないため送信しませんでした（' + queue.length + '通）：' + (e && e.message ? e.message : e));
    result.failed = queue.length;
    return result;
  }
  if (!config.enabled) {
    result.skipped = queue.length;
    return result;
  }
  queue.forEach(function (mail) {
    const to = config.overrideTo || mail.to;
    const body = (config.overrideTo ? '（テスト用の送信先に送っています。本来の宛先：' + mail.to + '）\n\n' : '') + mail.body + mailFooter_();
    try {
      MailApp.sendEmail({ to: to, subject: mail.subject, body: body, name: APP_BRAND_NAME + ' 社内ポータル' });
      result.sent += 1;
    } catch (e) {
      result.failed += 1;
      console.error('メール通知の送信に失敗しました（宛先：' + to + '／件名：' + mail.subject + '）：' + (e && e.message ? e.message : e));
    }
  });
  return result;
}

/** 設定「メール通知」「メール通知_送信先の上書き」 */
function notificationConfig_() {
  const s = getSettings_();
  const override = s.mailNotifyOverrideTo;
  if (override && typeof override === 'object') {
    throw new Error('設定「' + SETTING_KEYS.MAIL_NOTIFY_OVERRIDE + '」がメールアドレスの形式ではありません（' + override.invalid + '）');
  }
  return { enabled: s.mailNotify !== MAIL_NOTIFY.OFF, overrideTo: override || '' };
}

function mailFooter_() {
  let url = '';
  try {
    url = ScriptApp.getService().getUrl() || '';
  } catch (e) {
    url = '';
  }
  return '\n\n' + (url ? 'ポータルを開く：' + url + '\n' : '') + '※このメールは社内ポータルから自動で送信しています。';
}

// ============================================================ 宛先

/** 通知する管理者（在籍・権限＝admin・メールあり）。exceptEmployeeId の人は除く */
function adminNotificationRecipients_(exceptEmployeeId) {
  return getAllStaff_().filter(function (s) {
    return s.status === EMPLOYMENT_STATUS.ACTIVE && s.role === ROLES.ADMIN && s.email && s.employeeId !== exceptEmployeeId;
  });
}

/** 申請者（社員IDで今のスタッフマスタを引く。見つからなければ予備のメールアドレス） */
function applicantForNotification_(employeeId, fallbackName, fallbackEmail) {
  const staff = findStaffById_(employeeId);
  if (staff && staff.status !== EMPLOYMENT_STATUS.RETIRED) return { name: staff.name, email: staff.email };
  return { name: fallbackName || '', email: staff ? '' : String(fallbackEmail || '') };
}

// ============================================================ 通知の中身（各申請のサービスから呼ぶ）

/**
 * 申請時：管理者へ「新しい申請が届きました」、申請者本人へ「申請を受け付けました」。
 * @param {string} kind 残業申請／有給休暇申請／休日出勤申請／稟議申請
 * @param {object} applicant ログイン中の申請者（getCurrentStaff_）
 * @param {string} requestId 申請ID・稟議ID
 * @param {string} headline 件名に付ける短い内容（例：'10/7 18:30〜20:00'）
 * @param {Array<Array<string>>} details [['対象日', '2026-10-07'], ...]
 */
function notifyRequestSubmitted_(kind, applicant, requestId, headline, details) {
  const lines = detailLines_([[requestIdLabel_(kind), requestId], ['申請者', applicant.name + '（' + applicant.employeeId + '）']].concat(details));
  adminNotificationRecipients_(applicant.employeeId).forEach(function (admin) {
    queueMail_(admin.email, '新しい' + kind + 'が届きました（' + applicant.name + '・' + headline + '）',
      admin.name + ' さん\n\n' + applicant.name + ' さんから' + kind + 'が届きました。管理者画面で承認・却下してください。\n\n' + lines);
  });
  queueMail_(applicant.email, kind + 'を受け付けました（' + headline + '）',
    applicant.name + ' さん\n\n' + kind + 'を受け付けました。管理者の承認をお待ちください。結果はメールでお知らせします。\n\n' + lines);
}

/**
 * 承認・却下（稟議は再承認・再承認却下も）：申請者本人へ結果。却下・再承認却下は却下理由を必ず入れる。
 * @param {string} kind 残業申請 など
 * @param {string} result 承認／却下／再承認／再承認却下
 * @param {{employeeId: string, name: string, email?: string}} applicant 申請した人（記録の値）
 * @param {object} decider 処理した管理者
 * @param {string} requestId
 * @param {string} headline
 * @param {Array<Array<string>>} details
 * @param {string} [reason] 却下理由
 */
function notifyRequestDecided_(kind, result, applicant, decider, requestId, headline, details, reason) {
  const rejected = result === '却下' || result === '再承認却下';
  if (rejected && !String(reason || '').trim()) {
    // 却下理由は各処理で必須にしているので、ここに来ることはない（念のため、理由のない却下メールは送らない）
    console.error('メール通知：却下理由がないため送りませんでした（' + kind + '・' + requestId + '）');
    return;
  }
  const to = applicantForNotification_(applicant.employeeId, applicant.name, applicant.email);
  const phrase = kind + ({ '承認': 'が承認されました', '却下': 'が却下されました', '再承認': 'が再承認されました', '再承認却下': 'の再承認が却下されました' }[result] || '：' + result);
  const rows = [[requestIdLabel_(kind), requestId], ['結果', result], ['処理した人', decider.name]];
  if (rejected) rows.push(['却下理由', String(reason).trim()]);
  queueMail_(to.email, phrase + '（' + headline + '）',
    (to.name || applicant.name) + ' さん\n\n' + phrase + '。\n\n' + detailLines_(rows.concat(details)));
}

/**
 * 稟議：確定金額が申請金額を超えて「再承認待ち」になったとき。管理者へ「再承認が必要です」、申請者本人へ「再承認待ちになりました」。
 */
function notifyRingiReapprovalNeeded_(record, actor, details) {
  const applicant = applicantForNotification_(String(record['社員ID']).trim(), toPlainText_(record['申請者名']), toPlainText_(record['申請者メール']));
  const ringiId = toPlainText_(record['稟議ID']);
  const headline = toPlainText_(record['購入品名']);
  const lines = detailLines_([['稟議ID', ringiId], ['申請者', toPlainText_(record['申請者名']) + '（' + toPlainText_(record['社員ID']) + '）'],
    ['確定金額を入力した人', actor.name]].concat(details));
  adminNotificationRecipients_(String(record['社員ID']).trim()).forEach(function (admin) {
    queueMail_(admin.email, '稟議の再承認が必要です（' + toPlainText_(record['申請者名']) + '・' + headline + '）',
      admin.name + ' さん\n\n確定金額が申請金額（概算）を超えたため、稟議が「再承認待ち」になりました。管理者画面で再承認または再承認の却下をしてください。\n\n' + lines);
  });
  queueMail_(applicant.email, '稟議が再承認待ちになりました（' + headline + '）',
    (applicant.name || toPlainText_(record['申請者名'])) + ' さん\n\n確定金額が申請金額（概算）を超えたため、稟議が「再承認待ち」になりました。管理者の再承認をお待ちください。\n\n' + lines);
}

/** 稟議は「稟議ID」、それ以外は「申請ID」 */
function requestIdLabel_(kind) {
  return kind === '稟議申請' ? '稟議ID' : '申請ID';
}

/** [['項目', '値'], ...] → '項目：値' の行（空の値は「—」） */
function detailLines_(rows) {
  return rows.map(function (r) {
    const value = r[1] === null || r[1] === undefined || String(r[1]).trim() === '' ? '—' : String(r[1]);
    return r[0] + '：' + value;
  }).join('\n');
}

/** '2026-10-07' → '10/7' */
function shortDateLabel_(dateKey) {
  const m = String(dateKey || '').match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? Number(m[1]) + '/' + Number(m[2]) : String(dateKey || '');
}
