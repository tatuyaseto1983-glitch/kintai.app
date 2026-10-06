/**
 * NotificationService.gs
 * ------------------------------------------------------------
 * 各種申請（残業・有給休暇・休日出勤・稟議）の通知です。各申請のサービスから呼びます。
 * 通知の方法は設定「通知方法」で切り替える：メール／Google Chat／両方／通知なし（初期値：Google Chat）
 *
 *   通知                         管理者へ                         申請者本人へ
 *   申請時                       Chat・メール「新しい申請」         メール「受け付けました」
 *   承認・却下                   —                                 メール（却下は却下理由）
 *   稟議：再承認待ちになった       Chat・メール「再承認が必要」       メール「再承認待ちになりました」
 *   稟議：再承認・再承認却下       —                                 メール（再承認却下は却下理由）
 *   ・Google Chat は第1段階として「管理者向け」だけ（管理者用スペースの Incoming Webhook）。
 *     申請者本人への Chat（DM）は第2段階（Incoming Webhook では個人に送れないため、Google Chat API で別に作る）
 *   ・メール：「メール」「両方」のときに送る（管理者・本人とも）。Chat：「Google Chat」「両方」のときに送る（管理者だけ）
 *
 * 送り方（申請・承認そのものを、通知の失敗で止めないため）
 *   1. 各サービスは、シートへの保存が終わった後に通知を「予約」するだけ（ここでは送らない）
 *   2. runApi_ が、処理が成功して withLock_ の保存・ロック解除まで終わった後に flushNotifications_ で送る
 *      （処理がエラーで終わったときは、予約した通知を捨てる＝保存されていない申請の通知は送らない）
 *   3. 1件ずつ送り、失敗してもほかの通知・画面の結果には影響させない。失敗は console.error（Apps Script の実行ログ）に残す
 *
 * 宛先
 *   管理者（メール）… スタッフマスタで「在籍」かつ 権限＝admin の人（メールアドレスはコードに書かない）。申請者本人は除く
 *   管理者（Chat）  … スクリプトプロパティ GOOGLE_CHAT_WEBHOOK_URL の管理者用スペース（URLはコード・シートに書かない）
 *   申請者（メール）… スタッフマスタの社員IDから今のメールアドレス（稟議は 申請者メール 列も予備に使う）
 *
 * 設定シート
 *   通知方法                     … メール／Google Chat／両方／通知なし
 *   メール通知                   … 送信する／送信しない（「送信しない」なら通知方法に関係なくメールは送らない）
 *   メール通知_送信先の上書き     … メールアドレスを入れると、すべての通知メールをそのアドレスだけに送る（テスト環境用）
 */

/** 1回の画面操作（runApi_）の中で予約した通知（{ channel: 'mail' | 'chat', ... }） */
var NOTIFICATION_QUEUE_ = [];

/** Google Chat の Incoming Webhook の URL を入れるスクリプトプロパティ（テスト用・本番用の Apps Script で別々に設定する） */
const CHAT_WEBHOOK_PROPERTY = 'GOOGLE_CHAT_WEBHOOK_URL';
/** Chat の1メッセージの文字数の上限（Chat は 4096 文字まで。余裕を持たせる） */
const CHAT_TEXT_LIMIT = 3500;

/** 件名の先頭 */
function mailSubjectPrefix_() {
  return '【' + APP_BRAND_NAME + ' 社内ポータル】';
}

/**
 * 【エディタから実行・管理者だけ】メール通知の確認：自分（実行している管理者）にテストメールを1通送る。
 * 初めて実行するときに「メールの送信」の権限の承認を求められます（承認しないと通知メールは送られません）。
 * 設定「メール通知_送信先の上書き」もここで確かめられます（設定「通知方法」に関係なく送る）。
 */
function sendTestNotification() {
  const result = runApi_(function () {
    const admin = requireAdmin();
    queueMail_(admin.email, 'メール通知のテスト', admin.name + ' さん\n\n社内ポータルのメール通知のテストです。このメールが届いていれば、各種申請の通知メールを送れます。');
    NOTIFICATION_QUEUE_[NOTIFICATION_QUEUE_.length - 1].force = true; // テストは「通知方法」に関係なく送る
    return { message: admin.email + ' 宛にテストメールを送りました（届かない場合は、設定「メール通知」と Apps Script の実行ログを確認してください）' };
  });
  console.log(result.message);
  return result;
}

/**
 * 【エディタから実行・管理者だけ】Google Chat 通知の確認：管理者用スペースにテストメッセージを1件送る。
 * 初めて実行するときに「外部サービスへの接続」の権限の承認を求められます（承認しないと Chat には送られません）。
 * スクリプトプロパティ GOOGLE_CHAT_WEBHOOK_URL もここで確かめられます（設定「通知方法」に関係なく送る）。
 */
function sendTestChatNotification() {
  const result = runApi_(function () {
    const admin = requireAdmin();
    queueChat_('chat-test', '*Google Chat 通知のテスト*\n社内ポータルから ' + admin.name + ' さんが送りました。これが表示されていれば、各種申請の通知を管理者用スペースに送れます。');
    NOTIFICATION_QUEUE_[NOTIFICATION_QUEUE_.length - 1].force = true; // テストは「通知方法」に関係なく送る
    return { message: '管理者用スペースにテストメッセージを送りました（表示されない場合は、スクリプトプロパティ ' + CHAT_WEBHOOK_PROPERTY + '・設定「通知方法」・実行ログを確認してください）' };
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
  NOTIFICATION_QUEUE_.push({ channel: 'mail', to: address, subject: mailSubjectPrefix_() + subject, body: body });
}

/**
 * Google Chat（管理者用スペース）へのメッセージを予約する。
 * @param {string} threadKey 同じ申請の通知を同じスレッドにまとめるキー（申請ID・稟議ID）
 * @param {string} text Chat のテキスト（*太字*・<URL|文字> が使える）
 */
function queueChat_(threadKey, text) {
  let body = String(text || '');
  if (body.length > CHAT_TEXT_LIMIT) body = body.slice(0, CHAT_TEXT_LIMIT - 20) + '\n…（長いため省略）';
  NOTIFICATION_QUEUE_.push({ channel: 'chat', threadKey: String(threadKey || ''), text: body });
}

/**
 * 予約した通知を送る（保存・ロック解除の後）。エラーは投げない。
 * 設定「通知方法」で、メールと Google Chat のどちらを送るか決める（予約は両方しておき、ここで選ぶ）。
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
    console.error('通知：設定を読めないため送りませんでした（' + queue.length + '件）：' + (e && e.message ? e.message : e));
    result.failed = queue.length;
    return result;
  }
  queue.forEach(function (item) {
    // テスト送信（force）は「通知方法」に関係なく送る（Webhook URL・送信先の上書きは守る）
    if (item.channel === 'mail' && !config.mail && !item.force) { result.skipped += 1; return; }
    if (item.channel === 'chat' && !config.chat && !item.force) { result.skipped += 1; return; }
    const ok = item.channel === 'chat' ? sendChat_(item, config) : sendMail_(item, config);
    if (ok) result.sent += 1; else result.failed += 1;
  });
  return result;
}

/** メール1通。失敗は false（ログに残す） */
function sendMail_(mail, config) {
  if (config.mailError) {
    console.error('メール通知：' + config.mailError + '（件名：' + mail.subject + '）');
    return false;
  }
  const to = config.overrideTo || mail.to;
  const body = (config.overrideTo ? '（テスト用の送信先に送っています。本来の宛先：' + mail.to + '）\n\n' : '') + mail.body + mailFooter_();
  try {
    MailApp.sendEmail({ to: to, subject: mail.subject, body: body, name: APP_BRAND_NAME + ' 社内ポータル' });
    return true;
  } catch (e) {
    console.error('メール通知の送信に失敗しました（宛先：' + to + '／件名：' + mail.subject + '）：' + (e && e.message ? e.message : e));
    return false;
  }
}

/**
 * Google Chat（Incoming Webhook）に1件。失敗は false（ログに残す。URL には鍵が入っているのでログに書かない）。
 * 同じ申請の通知は threadKey で同じスレッドにまとめる（スレッドがないスペースでは新しいメッセージになる）。
 */
function sendChat_(item, config) {
  const head = item.text.split('\n')[0];
  if (!config.webhookUrl) {
    console.error('Google Chat 通知：' + (config.webhookError || 'Webhook URL が設定されていません') + '（' + head + '）');
    return false;
  }
  const url = config.webhookUrl + (config.webhookUrl.indexOf('?') === -1 ? '?' : '&') +
    'messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' + (item.threadKey ? '&threadKey=' + encodeURIComponent(item.threadKey) : '');
  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      payload: JSON.stringify({ text: item.text }),
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();
    if (code >= 200 && code < 300) return true;
    console.error('Google Chat 通知の送信に失敗しました（HTTP ' + code + '／' + head + '）：' + String(response.getContentText() || '').slice(0, 300).replace(/https?:\/\/\S+/g, '（URLは省略）'));
    return false;
  } catch (e) {
    // エラーの文言に URL（鍵つき）が入ることがあるので、URL は伏せてからログに書く
    console.error('Google Chat 通知の送信に失敗しました（' + head + '）：' + String(e && e.message ? e.message : e).replace(/https?:\/\/\S+/g, '（URLは省略）'));
    return false;
  }
}

/**
 * 設定「通知方法」「メール通知」「メール通知_送信先の上書き」と、スクリプトプロパティの Webhook URL。
 * 通知方法の値が正しくないときは、何も送らない（エラーにして、ログに残す）。
 */
function notificationConfig_() {
  const s = getSettings_();
  const method = s.notifyMethod;
  if ([NOTIFY_METHODS.MAIL, NOTIFY_METHODS.CHAT, NOTIFY_METHODS.BOTH, NOTIFY_METHODS.NONE].indexOf(method) === -1) {
    throw new Error('設定「' + SETTING_KEYS.NOTIFY_METHOD + '」は「メール」「Google Chat」「両方」「通知なし」のどれかにしてください（今の値：' + method + '）');
  }
  const config = {
    mail: (method === NOTIFY_METHODS.MAIL || method === NOTIFY_METHODS.BOTH) && s.mailNotify !== MAIL_NOTIFY.OFF,
    chat: method === NOTIFY_METHODS.CHAT || method === NOTIFY_METHODS.BOTH,
    overrideTo: '', mailError: '', webhookUrl: '', webhookError: '',
  };
  const override = s.mailNotifyOverrideTo;
  if (override && typeof override === 'object') {
    // 上書きの宛先が正しくないときは、実際の社員に誤って届かないようメールは送らない（Chat には影響しない）
    config.mailError = '設定「' + SETTING_KEYS.MAIL_NOTIFY_OVERRIDE + '」がメールアドレスの形式ではありません（' + override.invalid + '）';
  } else {
    config.overrideTo = override || '';
  }
  // Webhook URL（テスト送信は「通知方法」に関係なく送るので、いつも読む）
  const raw = String(PropertiesService.getScriptProperties().getProperty(CHAT_WEBHOOK_PROPERTY) || '').trim();
  if (!raw) config.webhookError = 'スクリプトプロパティ ' + CHAT_WEBHOOK_PROPERTY + ' に Webhook URL が設定されていません';
  else if (!/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/[^\s]+$/.test(raw)) config.webhookError = 'スクリプトプロパティ ' + CHAT_WEBHOOK_PROPERTY + ' が Google Chat の Webhook URL（https://chat.googleapis.com/v1/spaces/…）ではありません';
  else config.webhookUrl = raw;
  return config;
}

/** Webアプリの URL（取れないときは ''） */
function portalUrl_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
}

function mailFooter_() {
  const url = portalUrl_();
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
function notifyRequestSubmitted_(kind, applicant, requestId, headline, details, record) {
  // Google Chat（管理者用スペース）：申請種別・申請者・申請日時・内容の要点・今の状態
  const r = record || {};
  queueChat_(requestId, chatMessage_('新しい' + kind + 'が届きました', [
    ['申請種別', kind], ['申請者', applicant.name + '（' + applicant.employeeId + '）'], ['申請日時', toPlainText_(r['申請日時'])],
    ['内容', headline], ['状態', r['申請状態'] !== undefined ? toPlainText_(r['申請状態']) : requestStatusLabel_(toPlainText_(r['ステータス']))], // 稟議は申請状態のまま
    [requestIdLabel_(kind), requestId]].concat(details), '管理者画面で承認・却下してください'));
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
  // Google Chat（管理者用スペース）：申請のときと同じスレッドに出す
  queueChat_(ringiId, chatMessage_('稟議の再承認が必要です', [
    ['申請種別', '稟議申請'], ['申請者', toPlainText_(record['申請者名']) + '（' + toPlainText_(record['社員ID']) + '）'],
    ['申請日時', toPlainText_(record['申請日時'])], ['内容', headline + '・確定金額 ' + yen_(record['確定金額']) + '（申請金額 ' + yen_(record['申請金額']) + '・差額 ' + signedYen_(record['概算との差額']) + '）'],
    ['状態', toPlainText_(record['申請状態'])], ['稟議ID', ringiId], ['確定金額を入力した人', actor.name]],
    '確定金額が申請金額（概算）を超えました。管理者画面で再承認または再承認の却下をしてください'));
  adminNotificationRecipients_(String(record['社員ID']).trim()).forEach(function (admin) {
    queueMail_(admin.email, '稟議の再承認が必要です（' + toPlainText_(record['申請者名']) + '・' + headline + '）',
      admin.name + ' さん\n\n確定金額が申請金額（概算）を超えたため、稟議が「再承認待ち」になりました。管理者画面で再承認または再承認の却下をしてください。\n\n' + lines);
  });
  queueMail_(applicant.email, '稟議が再承認待ちになりました（' + headline + '）',
    (applicant.name || toPlainText_(record['申請者名'])) + ' さん\n\n確定金額が申請金額（概算）を超えたため、稟議が「再承認待ち」になりました。管理者の再承認をお待ちください。\n\n' + lines);
}

/**
 * Google Chat のメッセージ（1行目は太字の見出し、項目は「項目：値」、最後に案内と管理者画面へのリンク）。
 * 1項目は 300 文字までに切る（支出理由などが長いとき）
 */
function chatMessage_(title, rows, guide) {
  const lines = rows.map(function (row) {
    let value = row[1] === null || row[1] === undefined || String(row[1]).trim() === '' ? '—' : String(row[1]).replace(/\s*\n\s*/g, ' ');
    if (value.length > 300) value = value.slice(0, 297) + '…';
    return row[0] + '：' + value;
  });
  const url = portalUrl_();
  return '*' + title + '*\n' + lines.join('\n') + '\n' + guide + (url ? '\n<' + url + '?view=admin|管理者画面を開く>' : '');
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
