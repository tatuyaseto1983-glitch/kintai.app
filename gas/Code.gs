/**
 * 勤怠・有給・稟議 管理アプリ（Google Apps Script 版のサーバー）
 *
 * データはこのスクリプトを入れたスプレッドシートの各シートに保存します。
 * 画面（GitHub Pages）からは、Webアプリとして公開したURLにリクエストが届きます。
 * 使い方は README.md の「公開の手順」を参照してください。
 */

// ---------------------------------------------------------------- 設定
var CONFIG = {
  closingDay: 20, //        締め日（20日締め＝21日から翌月20日までを1か月として集計）。月末締めにするときは 0
  breakAfter: 360, //       この時間（分）を超えて働いた日は
  breakMinutes: 60, //      休憩をこの分数だけ自動で差し引く
  standard: 480, //         これを超えた分を残業とする
  maxSegments: 5, //        1日の打刻（出勤→退勤、再開→終了）の最大回数
  sessionDays: 30, //       ログインしたままでいられる日数
  initialAdminId: 'admin', // 最初に作る管理者のID（パスワードは admin1234。初回ログイン時に変更）
};

var TABLES = {
  users: ['id:n', 'login_id', 'name', 'role', 'hire_date', 'password_hash', 'must_change_password:n', 'active:n', 'created_at'],
  attendance: ['id:n', 'user_id:n', 'work_date', 'segments:j', 'break_override:n', 'note', 'edited_by:n', 'updated_at'],
  leave_grants: ['id:n', 'user_id:n', 'grant_date', 'expires_on', 'days:n', 'note', 'created_at'],
  leave_requests: ['id:n', 'user_id:n', 'kind', 'leave_type', 'start_date', 'end_date', 'days:n', 'reason', 'handover:n', 'handover_note',
    'status', 'approver_id:n', 'decision_comment', 'decided_at', 'created_at'],
  holiday_work: ['id:n', 'user_id:n', 'work_date', 'start_time', 'end_time', 'reason', 'substitute_date',
    'status', 'approver_id:n', 'decision_comment', 'decided_at', 'created_at'],
  ringi: ['id:n', 'user_id:n', 'title', 'quantity', 'category', 'content', 'amount:n', 'certainty', 'expense_date',
    'attachment_name', 'attachment_file', 'attachment_type', 'attachment_url',
    'status', 'approver_id:n', 'decision_comment', 'decided_at', 'created_at'],
};

// ---------------------------------------------------------------- 初期設定（エディタから1回だけ実行）
function setup() {
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) props.setProperty('SPREADSHEET_ID', ss.getId());
  Object.keys(TABLES).forEach(function (t) { sheet_(t); });
  if (!props.getProperty('UPLOAD_FOLDER_ID')) {
    props.setProperty('UPLOAD_FOLDER_ID', DriveApp.createFolder('勤怠アプリ_添付ファイル').getId());
  }
  if (!all_('users').length) {
    insert_('users', {
      login_id: CONFIG.initialAdminId, name: '管理者', role: 'admin', hire_date: null,
      password_hash: hashPassword_('admin1234'), must_change_password: 1, active: 1, created_at: nowJST_().stamp,
    });
  }
  Logger.log('初期設定が完了しました。次に「デプロイ」→「新しいデプロイ」でWebアプリとして公開してください。');
}

// ---------------------------------------------------------------- 表（シート）の読み書き
var cache_ = {};
function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
function cols_(t) { return TABLES[t].map(function (c) { var p = c.split(':'); return { name: p[0], type: p[1] || 's' }; }); }
function sheet_(t) {
  var ss = ss_();
  var sh = ss.getSheetByName(t);
  if (!sh) {
    sh = ss.insertSheet(t);
    var cols = cols_(t);
    var head = sh.getRange(1, 1, 1, cols.length);
    head.setNumberFormat('@');
    head.setValues([cols.map(function (c) { return c.name; })]);
    head.setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function decode_(type, v) {
  if (v === '' || v === null || v === undefined) return type === 'j' ? [] : null;
  if (type === 'n') return Number(v);
  if (type === 'j') return JSON.parse(v);
  return String(v);
}
function encode_(type, v) {
  if (v === null || v === undefined) return '';
  if (type === 'j') return JSON.stringify(v);
  return String(v);
}
function all_(t) {
  if (cache_[t]) return cache_[t];
  var sh = sheet_(t);
  var cols = cols_(t);
  var last = sh.getLastRow();
  var rows = [];
  if (last > 1) {
    var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
    for (var i = 0; i < values.length; i++) {
      if (values[i][0] === '' || values[i][0] === null) continue;
      var o = { _row: i + 2 };
      for (var j = 0; j < cols.length; j++) o[cols[j].name] = decode_(cols[j].type, values[i][j]);
      rows.push(o);
    }
  }
  cache_[t] = rows;
  return rows;
}
function rowValues_(t, o) { return cols_(t).map(function (c) { return encode_(c.type, o[c.name]); }); }
function nextId_(t) { return all_(t).reduce(function (m, r) { return Math.max(m, r.id); }, 0) + 1; }
function insertMany_(t, list) {
  if (!list.length) return [];
  var sh = sheet_(t);
  var id = nextId_(t);
  var rows = list.map(function (o) { o.id = id++; return rowValues_(t, o); });
  var range = sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length);
  range.setNumberFormat('@'); // 日付や時刻が勝手に変換されないよう文字列として保存
  range.setValues(rows);
  delete cache_[t];
  return list.map(function (o) { return o.id; });
}
function insert_(t, o) { return insertMany_(t, [o])[0]; }
function find_(t, id) {
  id = Number(id);
  var r = all_(t).filter(function (x) { return x.id === id; })[0];
  return r ? copy_(r) : null;
}
function update_(t, id, changes) {
  var r = find_(t, id);
  if (!r) throw new HttpError(404, 'データが見つかりません');
  Object.keys(changes).forEach(function (k) { r[k] = changes[k]; });
  var values = rowValues_(t, r);
  var range = sheet_(t).getRange(r._row, 1, 1, values.length);
  range.setNumberFormat('@');
  range.setValues([values]);
  delete cache_[t];
  return r;
}
function remove_(t, id) {
  var r = find_(t, id);
  if (r) { sheet_(t).deleteRow(r._row); delete cache_[t]; }
}
function where_(t, fn) { return all_(t).filter(fn).map(copy_); }
function copy_(o) { var c = {}; Object.keys(o).forEach(function (k) { c[k] = o[k]; }); return c; }

// ---------------------------------------------------------------- 共通の道具
function HttpError(status, message) { this.status = status; this.message = message; }
function bad_(msg) { throw new HttpError(400, msg); }
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
var MONTH_RE = /^\d{4}-\d{2}$/;
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function nowJST_(offsetDays) {
  var iso = new Date(Date.now() + 9 * 3600e3 + (offsetDays || 0) * 86400e3).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), stamp: iso.slice(0, 16).replace('T', ' ') };
}
function isDate_(s) { return typeof s === 'string' && DATE_RE.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
function addDays_(date, n) { var d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function addYears_(date, n) { var d = new Date(date + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + n); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
function daysBetween_(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3); }
function shiftMonth_(ym, n) { var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return y + '-' + pad2_(m + 1); }
function lastDayOf_(ym) { return addDays_(shiftMonth_(ym, 1) + '-01', -1); }
function toMin_(t) { var p = t.split(':'); return Number(p[0]) * 60 + Number(p[1]); }
function hm_(m) { return m === null || m === undefined ? '' : Math.floor(m / 60) + ':' + pad2_(m % 60); }

// 締め日で区切った「◯月度」の期間。20日締めなら 2026-10月度 = 2026-09-21〜2026-10-20
function periodRange_(ym) {
  var c = CONFIG.closingDay;
  if (!c || c >= 28) return { from: ym + '-01', to: lastDayOf_(ym) };
  return { from: shiftMonth_(ym, -1) + '-' + pad2_(c + 1), to: ym + '-' + pad2_(c) };
}
function periodOf_(date) {
  var c = CONFIG.closingDay;
  var ym = date.slice(0, 7);
  return c && c < 28 && Number(date.slice(8, 10)) > c ? shiftMonth_(ym, 1) : ym;
}

function str_(v, name, opt) {
  opt = opt || {};
  var max = opt.max || 200;
  var required = opt.required !== false;
  if (v === undefined || v === null) v = '';
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') bad_(name + 'の形式が正しくありません');
  v = v.trim();
  if (required && !v) bad_(name + 'を入力してください');
  if (v.length > max) bad_(name + 'は' + max + '文字以内で入力してください');
  return v;
}
function optDate_(v, name) {
  if (v === undefined || v === null || v === '') return null;
  if (!isDate_(v)) bad_(name + 'が正しくありません');
  return v;
}
function reqTime_(v, name) {
  if (!TIME_RE.test(v || '')) bad_(name + 'は「09:00」の形で入力してください');
  return v;
}

function toHex_(bytes) { return bytes.map(function (b) { return ((b + 256) % 256).toString(16); }).map(function (h) { return h.length < 2 ? '0' + h : h; }).join(''); }
function hashWith_(pw, salt) {
  var h = pw;
  for (var i = 0; i < 100; i++) h = toHex_(Utilities.computeHmacSha256Signature(h, salt));
  return h;
}
function hashPassword_(pw) {
  var salt = Utilities.getUuid().replace(/-/g, '');
  return salt + ':' + hashWith_(pw, salt);
}
function verifyPassword_(pw, stored) {
  var p = String(stored || '').split(':');
  return p.length === 2 && hashWith_(pw, p[0]) === p[1];
}
function randomPassword_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }

// ---------------------------------------------------------------- ログイン状態（スクリプトのプロパティに保存）
function createSession_(userId) {
  var props = PropertiesService.getScriptProperties();
  var now = Date.now();
  var all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('sess_') !== 0) return;
    try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty('sess_' + token, JSON.stringify({ uid: userId, exp: now + CONFIG.sessionDays * 86400e3 }));
  return token;
}
function sessionUser_(token) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  var raw = PropertiesService.getScriptProperties().getProperty('sess_' + token);
  if (!raw) return null;
  var s = JSON.parse(raw);
  if (s.exp < Date.now()) return null;
  var u = find_('users', s.uid);
  return u && u.active ? u : null;
}
function dropSessions_(userId) {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('sess_') === 0 && JSON.parse(all[k]).uid === userId) props.deleteProperty(k);
  });
}
function checkRate_(key) {
  var cache = CacheService.getScriptCache();
  var k = 'login_' + key;
  var n = Number(cache.get(k) || 0);
  if (n >= 10) throw new HttpError(429, 'ログインの試行回数が多すぎます。10分ほど待ってからお試しください');
  cache.put(k, String(n + 1), 600);
}

function publicUser_(u) {
  return { id: u.id, login_id: u.login_id, name: u.name, role: u.role, hire_date: u.hire_date, active: !!u.active, must_change_password: !!u.must_change_password };
}
function userById_(id) { return find_('users', id); }
function userName_(id) { var u = id ? userById_(id) : null; return u ? u.name : null; }

// ---------------------------------------------------------------- 勤怠の計算
function segMinutes_(s) {
  if (!s.in || !s.out) return 0;
  var m = toMin_(s.out) - toMin_(s.in);
  return m < 0 ? m + 1440 : m; // 日付をまたいだ退勤
}
function calcDay_(r) {
  if (!r) return null;
  var segs = r.segments || [];
  var worked = segs.reduce(function (s, x) { return s + segMinutes_(x); }, 0);
  var open = segs.some(function (s) { return s.in && !s.out; });
  var auto = worked > CONFIG.breakAfter ? CONFIG.breakMinutes : 0;
  var brk = r.break_override === null || r.break_override === undefined ? auto : r.break_override;
  var work = worked ? Math.max(0, worked - brk) : 0;
  var o = copy_(r);
  delete o._row;
  o.segments = segs;
  o.open = open;
  o.clock_in = segs.length ? segs[0].in : null;
  o.clock_out = !open && segs.length ? segs[segs.length - 1].out : null;
  o.break_minutes = worked ? brk : 0;
  o.break_auto = r.break_override === null || r.break_override === undefined;
  o.work_minutes = segs.length ? work : null;
  o.overtime_minutes = segs.length ? Math.max(0, work - CONFIG.standard) : null;
  return o;
}
function attendanceOf_(userId, date) {
  return where_('attendance', function (a) { return a.user_id === userId && a.work_date === date; })[0] || null;
}
function recordsBetween_(userId, from, to) {
  return where_('attendance', function (a) { return a.user_id === userId && a.work_date >= from && a.work_date <= to; })
    .sort(function (a, b) { return a.work_date < b.work_date ? -1 : 1; }).map(calcDay_);
}
function leavesBetween_(userId, from, to) {
  return where_('leave_requests', function (l) {
    return l.user_id === userId && (l.status === 'approved' || l.status === 'pending') && l.start_date <= to && l.end_date >= from;
  }).map(function (l) { return { kind: l.kind, leave_type: l.leave_type, start_date: l.start_date, end_date: l.end_date, status: l.status }; });
}
function summarize_(records) {
  var worked = records.filter(function (r) { return r.segments.length; });
  var today = nowJST_().date;
  return {
    days: worked.length,
    work_minutes: worked.reduce(function (s, r) { return s + (r.work_minutes || 0); }, 0),
    overtime_minutes: worked.reduce(function (s, r) { return s + (r.overtime_minutes || 0); }, 0),
    missing: records.filter(function (r) { return r.open && r.work_date < today; }).length,
  };
}

// ---------------------------------------------------------------- 有給の計算
var STATUTORY = [[0.5, 10], [1.5, 11], [2.5, 12], [3.5, 14], [4.5, 16], [5.5, 18], [6.5, 20]];
function statutoryDays_(hireDate, onDate) {
  if (!hireDate) return null;
  var h = new Date(hireDate + 'T00:00:00Z'), o = new Date(onDate + 'T00:00:00Z');
  var months = (o.getUTCFullYear() - h.getUTCFullYear()) * 12 + (o.getUTCMonth() - h.getUTCMonth()) - (o.getUTCDate() < h.getUTCDate() ? 1 : 0);
  var days = 0;
  STATUTORY.forEach(function (s) { if (months >= s[0] * 12) days = s[1]; });
  return days;
}
// 残日数：有効な付与を古い順に消化していく
function leaveBalance_(userId, today) {
  today = today || nowJST_().date;
  var grants = where_('leave_grants', function (g) { return g.user_id === userId; })
    .sort(function (a, b) { return a.grant_date < b.grant_date ? -1 : a.grant_date > b.grant_date ? 1 : a.id - b.id; })
    .map(function (g) { delete g._row; g.remaining = g.days; return g; });
  var paid = where_('leave_requests', function (l) { return l.user_id === userId && l.kind === 'paid'; });
  var used = paid.filter(function (l) { return l.status === 'approved'; }).sort(function (a, b) { return a.start_date < b.start_date ? -1 : 1; });
  var unmatched = 0;
  used.forEach(function (u) {
    var need = u.days;
    grants.forEach(function (g) {
      if (need <= 0) return;
      if (g.grant_date <= u.start_date && u.start_date <= g.expires_on && g.remaining > 0) {
        var take = Math.min(g.remaining, need);
        g.remaining -= take; need -= take;
      }
    });
    unmatched += need;
  });
  var remaining = grants.filter(function (g) { return g.grant_date <= today && today <= g.expires_on; })
    .reduce(function (s, g) { return s + g.remaining; }, 0) - unmatched;
  var pending = paid.filter(function (l) { return l.status === 'pending'; }).reduce(function (s, l) { return s + l.days; }, 0);
  var big = grants.filter(function (g) { return g.days >= 10 && g.grant_date <= today; });
  var obligation = null;
  if (big.length) {
    var from = big[big.length - 1].grant_date, to = addYears_(from, 1);
    var taken = used.filter(function (l) { return l.start_date >= from && l.start_date <= to; }).reduce(function (s, l) { return s + l.days; }, 0);
    obligation = { from: from, to: to, taken: taken, required: 5 };
  }
  return { remaining: remaining, pending: pending, grants: grants, obligation: obligation };
}

// ---------------------------------------------------------------- ルーティング
var ROUTES = [];
function route_(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  var keys = [];
  var re = new RegExp('^' + pattern.replace(/:(\w+)/g, function (_, k) { keys.push(k); return '(\\d+)'; }) + '$');
  ROUTES.push({ method: method, re: re, keys: keys, handler: handler, auth: opts.auth !== false, admin: !!opts.admin });
}

function handle_(req) {
  cache_ = {};
  var method = req.method || 'GET';
  var full = String(req.path || '');
  var qi = full.indexOf('?');
  var path = qi >= 0 ? full.slice(0, qi) : full;
  var query = {};
  if (qi >= 0) full.slice(qi + 1).split('&').forEach(function (kv) {
    if (!kv) return;
    var p = kv.split('=');
    query[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' '));
  });
  var match = null;
  for (var i = 0; i < ROUTES.length; i++) if (ROUTES[i].method === method && ROUTES[i].re.test(path)) { match = ROUTES[i]; break; }
  if (!match) throw new HttpError(404, 'APIが見つかりません');
  var m = path.match(match.re);
  var params = {};
  match.keys.forEach(function (k, i) { params[k] = Number(m[i + 1]); });
  var user = sessionUser_(req.token);
  if (match.auth && !user) throw new HttpError(401, 'ログインしてください');
  if (match.admin && user.role !== 'admin') throw new HttpError(403, '管理者のみ操作できます');
  if (user && user.must_change_password && match.auth && path !== '/api/me' && path !== '/api/me/password') {
    throw new HttpError(403, '最初にパスワードを変更してください');
  }
  return match.handler({ user: user, body: req.body || {}, params: params, query: query, token: req.token });
}

function respond_(contents) {
  var out;
  var lock = null;
  try {
    var req = JSON.parse(contents);
    if (req.method && req.method !== 'GET') {
      lock = LockService.getScriptLock();
      lock.waitLock(20000);
    }
    out = { ok: true, status: 200, data: handle_(req) };
  } catch (err) {
    if (err instanceof HttpError) out = { ok: false, status: err.status, error: err.message };
    else { console.error(err && err.stack ? err.stack : err); out = { ok: false, status: 500, error: 'サーバーでエラーが発生しました' }; }
  } finally {
    if (lock) lock.releaseLock();
  }
  return JSON.stringify(out);
}
// GitHub Pages など別の場所に置いた画面からの呼び出し
function doPost(e) {
  return ContentService.createTextOutput(respond_(e.postData.contents)).setMimeType(ContentService.MimeType.JSON);
}
// このURLを開いたときは、アプリの画面（Index.html）をそのまま表示する
function doGet() {
  try {
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('勤怠・有給・稟議')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setFaviconUrl('https://www.gstatic.com/images/icons/material/system/2x/schedule_black_48dp.png');
  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({ ok: true, status: 200, data: { app: 'kintai', message: '勤怠アプリのサーバーは動いています（画面ファイル Index が見つかりません）' } }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
// Index.html の画面から google.script.run で呼ばれる
function apiCall(contents) { return respond_(contents); }

// ---------------------------------------------------------------- 認証
route_('POST', '/api/login', { auth: false }, function (c) {
  var loginId = str_(c.body.login_id, 'ログインID', { max: 100 });
  var password = str_(c.body.password, 'パスワード', { max: 200 });
  checkRate_(loginId.toLowerCase());
  var u = where_('users', function (x) { return x.active && String(x.login_id).toLowerCase() === loginId.toLowerCase(); })[0];
  if (!u || !verifyPassword_(password, u.password_hash)) throw new HttpError(401, 'IDまたはパスワードが違います');
  CacheService.getScriptCache().remove('login_' + loginId.toLowerCase());
  return { token: createSession_(u.id), user: publicUser_(u) };
});

route_('POST', '/api/logout', { auth: false }, function (c) {
  var t = c.token;
  if (t && /^[0-9a-f]{64}$/.test(t)) PropertiesService.getScriptProperties().deleteProperty('sess_' + t);
  return { ok: true };
});

route_('GET', '/api/me', function (c) {
  var today = nowJST_().date;
  return { user: publicUser_(c.user), today: today, period: periodOf_(today), rules: CONFIG_PUBLIC_() };
});
function CONFIG_PUBLIC_() {
  return { closingDay: CONFIG.closingDay, breakAfter: CONFIG.breakAfter, breakMinutes: CONFIG.breakMinutes, standard: CONFIG.standard, maxSegments: CONFIG.maxSegments };
}

route_('POST', '/api/me/password', function (c) {
  var current = str_(c.body.current, '現在のパスワード');
  var next = str_(c.body.next, '新しいパスワード');
  if (!verifyPassword_(current, c.user.password_hash)) bad_('現在のパスワードが違います');
  if (next.length < 8) bad_('新しいパスワードは8文字以上にしてください');
  update_('users', c.user.id, { password_hash: hashPassword_(next), must_change_password: 0 });
  return { ok: true };
});

// ---------------------------------------------------------------- 勤怠
function punchState_(userId) {
  var today = nowJST_().date;
  var rec = calcDay_(attendanceOf_(userId, today));
  var y = calcDay_(attendanceOf_(userId, nowJST_(-1).date));
  var carry = !(rec && rec.open) && y && y.open ? y : null; // 前日から日付をまたいで勤務中
  return { date: today, record: rec, carry: carry };
}

route_('GET', '/api/attendance/today', function (c) { return punchState_(c.user.id); });

route_('POST', '/api/attendance/punch', function (c) {
  var now = nowJST_();
  var st = punchState_(c.user.id);
  var action = c.body.action;
  if (action === 'in' || action === 'resume') {
    if (st.carry) bad_('前日からの勤務が続いています。先に退勤を押してください');
    var r = attendanceOf_(c.user.id, now.date);
    var segs = r ? r.segments : [];
    if (segs.some(function (s) { return !s.out; })) bad_('勤務中です（先に退勤を押してください）');
    if (action === 'in' && segs.length) bad_('本日はすでに出勤しています。仕事を再開するときは「再開」を押してください');
    if (action === 'resume' && !segs.length) bad_('本日はまだ出勤していません。「出勤」を押してください');
    if (segs.length >= CONFIG.maxSegments) bad_('1日の打刻は' + CONFIG.maxSegments + '回までです。管理者に修正を依頼してください');
    segs.push({ in: now.time });
    if (r) update_('attendance', r.id, { segments: segs, updated_at: now.stamp });
    else insert_('attendance', { user_id: c.user.id, work_date: now.date, segments: segs, break_override: null, note: '', edited_by: null, updated_at: now.stamp });
  } else if (action === 'out') {
    var target = st.record && st.record.open ? st.record : st.carry;
    if (!target) bad_('出勤していません（先に出勤を押してください）');
    var s2 = target.segments;
    s2[s2.length - 1].out = now.time;
    update_('attendance', target.id, { segments: s2, updated_at: now.stamp });
  } else {
    bad_('操作が正しくありません');
  }
  return punchState_(c.user.id);
});

function targetUser_(c) {
  var uid = c.user.role === 'admin' && c.query.user_id ? Number(c.query.user_id) : c.user.id;
  var u = userById_(uid);
  if (!u) throw new HttpError(404, '社員が見つかりません');
  return u;
}
function monthParam_(c) {
  var ym = c.query.month || periodOf_(nowJST_().date);
  if (!MONTH_RE.test(ym)) bad_('月の形式が正しくありません');
  return ym;
}

route_('GET', '/api/attendance', function (c) {
  var ym = monthParam_(c);
  var u = targetUser_(c);
  var p = periodRange_(ym);
  var records = recordsBetween_(u.id, p.from, p.to);
  var hw = where_('holiday_work', function (h) {
    return h.user_id === u.id && h.work_date >= p.from && h.work_date <= p.to && (h.status === 'approved' || h.status === 'pending');
  }).map(function (h) { return { work_date: h.work_date, status: h.status }; });
  return { user: publicUser_(u), month: ym, from: p.from, to: p.to, records: records, leaves: leavesBetween_(u.id, p.from, p.to), holiday_work: hw, summary: summarize_(records) };
});

// 社員本人は備考だけ書ける（打刻の修正は管理者へ依頼）
route_('POST', '/api/attendance/note', function (c) {
  if (!isDate_(c.body.work_date)) bad_('日付が正しくありません');
  var note = str_(c.body.note, '備考', { required: false });
  var r = attendanceOf_(c.user.id, c.body.work_date);
  if (r) update_('attendance', r.id, { note: note, updated_at: nowJST_().stamp });
  else insert_('attendance', { user_id: c.user.id, work_date: c.body.work_date, segments: [], break_override: null, note: note, edited_by: null, updated_at: nowJST_().stamp });
  return { ok: true };
});

route_('PUT', '/api/attendance', { admin: true }, function (c) {
  var b = c.body;
  var uid = Number(b.user_id);
  if (!userById_(uid)) bad_('社員が見つかりません');
  if (!isDate_(b.work_date)) bad_('日付が正しくありません');
  if (!Array.isArray(b.segments)) bad_('打刻の形式が正しくありません');
  var segs = [];
  b.segments.forEach(function (s, i) {
    var a = s.in || '', z = s.out || '';
    if (!a && !z) return;
    if (!a) bad_((i + 1) + '回目：出勤（再開）時刻を入力してください');
    reqTime_(a, (i + 1) + '回目の出勤時刻');
    if (z) reqTime_(z, (i + 1) + '回目の退勤時刻');
    segs.push(z ? { in: a, out: z } : { in: a });
  });
  if (segs.length > CONFIG.maxSegments) bad_('打刻は' + CONFIG.maxSegments + '回までです');
  if (segs.slice(0, -1).some(function (s) { return !s.out; })) bad_('最後以外の退勤時刻が空欄になっています');
  var bo = null;
  if (b.break_override !== '' && b.break_override !== null && b.break_override !== undefined) {
    bo = Number(b.break_override);
    if (!(bo >= 0 && bo <= 1440 && Math.floor(bo) === bo)) bad_('休憩時間（分）が正しくありません');
  }
  var note = str_(b.note, '備考', { required: false });
  var r = attendanceOf_(uid, b.work_date);
  if (!segs.length && bo === null && !note) {
    if (r) remove_('attendance', r.id);
    return { ok: true, deleted: true };
  }
  var data = { segments: segs, break_override: bo, note: note, edited_by: c.user.id, updated_at: nowJST_().stamp };
  if (r) update_('attendance', r.id, data);
  else { data.user_id = uid; data.work_date = b.work_date; insert_('attendance', data); }
  return { ok: true };
});

function csv_(rows) {
  return '﻿' + rows.map(function (r) {
    return r.map(function (v) {
      v = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(',');
  }).join('\r\n');
}
function activeUsers_() { return where_('users', function (u) { return u.active; }).sort(function (a, b) { return a.id - b.id; }); }

// 日別の明細（今のシートと同じ並び：出勤・退勤・再開2〜終了5）
route_('GET', '/api/attendance/export', { admin: true }, function (c) {
  var ym = monthParam_(c);
  var p = periodRange_(ym);
  var head = ['日付', '名前', '出勤', '退勤'];
  for (var i = 2; i <= CONFIG.maxSegments; i++) head.push('再開' + i, '終了' + i);
  head.push('休憩(分)', '総労働時間', '残業時間', '備考');
  var rows = [];
  activeUsers_().forEach(function (u) {
    recordsBetween_(u.id, p.from, p.to).forEach(function (r) {
      var cells = [];
      for (var i = 0; i < CONFIG.maxSegments; i++) { var s = r.segments[i] || {}; cells.push(s.in || '', s.out || ''); }
      rows.push([r.work_date.replace(/-/g, '/'), u.name].concat(cells, [r.break_minutes, hm_(r.work_minutes), hm_(r.overtime_minutes), r.note]));
    });
  });
  rows.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  return { filename: 'kintai-' + ym + '.csv', csv: csv_([head].concat(rows)) };
});

function monthlySummary_(ym) {
  var p = periodRange_(ym);
  return activeUsers_().map(function (u) {
    var s = summarize_(recordsBetween_(u.id, p.from, p.to));
    s.user = publicUser_(u);
    s.holiday_work = where_('holiday_work', function (h) { return h.user_id === u.id && h.status === 'approved' && h.work_date >= p.from && h.work_date <= p.to; }).length;
    s.leave_days = where_('leave_requests', function (l) { return l.user_id === u.id && l.status === 'approved' && l.start_date >= p.from && l.start_date <= p.to; })
      .reduce(function (t, l) { return t + l.days; }, 0);
    return s;
  });
}

route_('GET', '/api/admin/monthly', { admin: true }, function (c) {
  var ym = monthParam_(c);
  var p = periodRange_(ym);
  return { month: ym, from: p.from, to: p.to, rules: CONFIG_PUBLIC_(), rows: monthlySummary_(ym) };
});

route_('GET', '/api/admin/monthly/export', { admin: true }, function (c) {
  var ym = monthParam_(c);
  var p = periodRange_(ym);
  var out = [['対象', ym.replace('-', '年') + '月度（' + p.from.replace(/-/g, '/') + '〜' + p.to.replace(/-/g, '/') + '）'],
    ['社員名', '出勤日数', '総労働時間', '残業時間', '打刻漏れ', '休暇(日)', '休日出勤(承認)']];
  monthlySummary_(ym).forEach(function (r) { out.push([r.user.name, r.days, hm_(r.work_minutes), hm_(r.overtime_minutes), r.missing, r.leave_days, r.holiday_work]); });
  return { filename: 'kintai-summary-' + ym + '.csv', csv: csv_(out) };
});

route_('GET', '/api/admin/dashboard', { admin: true }, function () {
  var today = nowJST_().date;
  var list = activeUsers_().map(function (u) {
    var r = calcDay_(attendanceOf_(u.id, today));
    var leave = where_('leave_requests', function (l) { return l.user_id === u.id && l.status === 'approved' && l.start_date <= today && l.end_date >= today; })[0];
    var status = '未出勤';
    if (r && r.open) status = '勤務中';
    else if (r && r.segments.length) status = '退勤済み';
    if (leave && !(r && r.segments.length)) status = leave.leave_type === 'full' ? '休暇' : '半休';
    return { user: publicUser_(u), status: status, record: r };
  });
  var since = addDays_(today, -62);
  var names = {};
  activeUsers_().forEach(function (u) { names[u.id] = u.name; });
  var missing = where_('attendance', function (a) { return names[a.user_id] && a.work_date < today && a.work_date >= since; })
    .map(calcDay_).filter(function (r) { return r.open; })
    .map(function (r) { r.name = names[r.user_id]; return r; })
    .sort(function (a, b) { return a.work_date < b.work_date ? 1 : -1; });
  function pendingCount(t) { return all_(t).filter(function (x) { return x.status === 'pending'; }).length; }
  return { date: today, today: list, missing: missing, pending: { leave: pendingCount('leave_requests'), holiday: pendingCount('holiday_work'), ringi: pendingCount('ringi') } };
});

// ---------------------------------------------------------------- 申請の共通処理
function withNames_(r) {
  delete r._row;
  r.user_name = userName_(r.user_id);
  r.approver_name = userName_(r.approver_id);
  return r;
}
function decide_(table, c, opts) {
  var r = find_(table, c.params.id);
  if (!r) throw new HttpError(404, '申請が見つかりません');
  var d = c.body.decision;
  if (['approved', 'rejected', 'pending'].indexOf(d) < 0) bad_('判断が正しくありません');
  if (d === 'pending') {
    if (r.status === 'pending' || r.status === 'cancelled') bad_('この申請は取り消せません');
    update_(table, r.id, { status: 'pending', approver_id: null, decision_comment: '', decided_at: null });
    return;
  }
  if (r.status !== 'pending') bad_('この申請はすでに処理されています');
  var comment = str_(c.body.comment, 'コメント', { max: 500, required: !!(opts && opts.reasonOnReject) && d === 'rejected' });
  update_(table, r.id, { status: d, approver_id: c.user.id, decision_comment: comment, decided_at: nowJST_().stamp });
}
function cancelOwn_(table, c) {
  var r = find_(table, c.params.id);
  if (!r || (r.user_id !== c.user.id && c.user.role !== 'admin')) throw new HttpError(404, '申請が見つかりません');
  if (r.status !== 'pending') bad_('承認待ちの申請のみ取り下げできます');
  update_(table, r.id, { status: 'cancelled' });
}
function byNewest_(a, b) { return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id; }

// ---------------------------------------------------------------- 休暇
var LEAVE_KINDS = { paid: '有給休暇', substitute: '振替休日', special: '特別休暇（慶弔など）', absence: '欠勤', other: 'その他' };

route_('GET', '/api/leave/summary', function (c) {
  var u = targetUser_(c);
  var b = leaveBalance_(u.id);
  b.user = publicUser_(u);
  b.kinds = LEAVE_KINDS;
  b.requests = where_('leave_requests', function (l) { return l.user_id === u.id; })
    .sort(function (x, y) { return x.start_date < y.start_date ? 1 : x.start_date > y.start_date ? -1 : y.id - x.id; })
    .slice(0, 100).map(withNames_);
  return b;
});

route_('GET', '/api/leave/requests', { admin: true }, function (c) {
  var s = c.query.status;
  var rows = where_('leave_requests', function (l) { return !s || l.status === s; });
  rows = s ? rows.sort(function (a, b) { return a.start_date < b.start_date ? -1 : 1; }) : rows.sort(byNewest_).slice(0, 200);
  return { requests: rows.map(withNames_), kinds: LEAVE_KINDS };
});

route_('POST', '/api/leave/requests', function (c) {
  var b = c.body;
  if (!LEAVE_KINDS[b.kind]) bad_('休暇の種別を選んでください');
  if (['full', 'am', 'pm'].indexOf(b.leave_type) < 0) bad_('全日・午前半休・午後半休から選んでください');
  if (!isDate_(b.start_date)) bad_('休暇取得予定日を選んでください');
  var end = b.leave_type === 'full' ? (optDate_(b.end_date, '最終日') || b.start_date) : b.start_date;
  if (end < b.start_date) bad_('最終日が取得日より前になっています');
  var days = b.leave_type === 'full' ? daysBetween_(b.start_date, end) + 1 : 0.5;
  if (days > 31) bad_('一度に申請できるのは31日までです');
  var reason = str_(b.reason, '理由', { required: false });
  var handover = b.handover === true || b.handover === '1';
  var note = str_(b.handover_note, '申し送り事項', { max: 1000, required: false });
  if (handover && !note) bad_('業務引継ぎ「あり」の場合は、申し送り事項を書いてください');
  var overlap = where_('leave_requests', function (l) {
    return l.user_id === c.user.id && (l.status === 'pending' || l.status === 'approved') && l.start_date <= end && l.end_date >= b.start_date;
  });
  if (overlap.some(function (o) { return o.leave_type === 'full' || b.leave_type === 'full' || o.leave_type === b.leave_type; })) bad_('その期間はすでに申請済みです');
  if (b.kind === 'paid') {
    var today = nowJST_().date;
    var bal = leaveBalance_(c.user.id, b.start_date < today ? today : b.start_date);
    if (bal.remaining - bal.pending < days) bad_('有給の残日数が足りません（残り ' + bal.remaining + ' 日 / 申請中 ' + bal.pending + ' 日）');
  }
  var id = insert_('leave_requests', {
    user_id: c.user.id, kind: b.kind, leave_type: b.leave_type, start_date: b.start_date, end_date: end, days: days,
    reason: reason, handover: handover ? 1 : 0, handover_note: handover ? note : '', status: 'pending',
    approver_id: null, decision_comment: '', decided_at: null, created_at: nowJST_().stamp,
  });
  return { id: id };
});

route_('POST', '/api/leave/requests/:id/cancel', function (c) { cancelOwn_('leave_requests', c); return { ok: true }; });
route_('POST', '/api/leave/requests/:id/decide', { admin: true }, function (c) {
  var r = find_('leave_requests', c.params.id);
  if (r && r.kind === 'paid' && c.body.decision === 'approved' && r.status === 'pending') {
    var today = nowJST_().date;
    var bal = leaveBalance_(r.user_id, r.start_date < today ? today : r.start_date);
    if (bal.remaining < r.days) bad_('有給の残日数が足りないため承認できません（残り ' + bal.remaining + ' 日）');
  }
  decide_('leave_requests', c);
  return { ok: true };
});

route_('POST', '/api/leave/grants', { admin: true }, function (c) {
  var uid = Number(c.body.user_id);
  if (!userById_(uid)) bad_('社員が見つかりません');
  if (!isDate_(c.body.grant_date)) bad_('付与日を入力してください');
  var days = Number(c.body.days);
  if (!(days > 0 && days <= 40) || (days * 2) % 1 !== 0) bad_('付与日数は0.5日単位・40日以内で入力してください');
  insert_('leave_grants', {
    user_id: uid, grant_date: c.body.grant_date, expires_on: addYears_(c.body.grant_date, 2), days: days,
    note: str_(c.body.note, 'メモ', { max: 100, required: false }), created_at: nowJST_().stamp,
  });
  return { ok: true };
});

route_('DELETE', '/api/leave/grants/:id', { admin: true }, function (c) { remove_('leave_grants', c.params.id); return { ok: true }; });

route_('GET', '/api/admin/leave-overview', { admin: true }, function () {
  var today = nowJST_().date;
  return {
    users: activeUsers_().map(function (u) {
      var b = leaveBalance_(u.id, today);
      return { user: publicUser_(u), remaining: b.remaining, pending: b.pending, obligation: b.obligation, statutory_now: statutoryDays_(u.hire_date, today) };
    }),
  };
});

// ---------------------------------------------------------------- 休日出勤
route_('GET', '/api/holiday-work', function (c) {
  var mine = c.user.role !== 'admin' || c.query.mine === '1';
  var rows = where_('holiday_work', function (h) { return (!mine || h.user_id === c.user.id) && (!c.query.status || h.status === c.query.status); })
    .sort(function (a, b) { return a.work_date < b.work_date ? 1 : a.work_date > b.work_date ? -1 : b.id - a.id; });
  return { requests: rows.slice(0, 200).map(withNames_) };
});

route_('POST', '/api/holiday-work', function (c) {
  var b = c.body;
  if (!isDate_(b.work_date)) bad_('休日出勤予定日を選んでください');
  var id = insert_('holiday_work', {
    user_id: c.user.id, work_date: b.work_date, start_time: reqTime_(b.start_time, '開始予定時間'), end_time: reqTime_(b.end_time, '終了予定時間'),
    reason: str_(b.reason, '休日出勤の理由', { max: 500 }), substitute_date: optDate_(b.substitute_date, '振替休日取得予定日'),
    status: 'pending', approver_id: null, decision_comment: '', decided_at: null, created_at: nowJST_().stamp,
  });
  return { id: id };
});
route_('POST', '/api/holiday-work/:id/cancel', function (c) { cancelOwn_('holiday_work', c); return { ok: true }; });
route_('POST', '/api/holiday-work/:id/decide', { admin: true }, function (c) { decide_('holiday_work', c); return { ok: true }; });

// ---------------------------------------------------------------- 稟議（購入・経費の申請）
var RINGI_CATEGORIES = ['備品購入', '消耗品', '工具・資材', '雑費', '交通費', '広告宣伝費', '外注費', '交際費', 'その他'];
var CERTAINTY = ['確定', '概算'];
var ATTACH_TYPES = {
  'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/webp': '.webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
};
function ringiPublic_(r) {
  r = withNames_(r);
  r.has_attachment = !!r.attachment_file;
  delete r.attachment_file;
  return r;
}
function findRingi_(c) {
  var r = find_('ringi', c.params.id);
  if (!r || (r.user_id !== c.user.id && c.user.role !== 'admin')) throw new HttpError(404, '稟議が見つかりません');
  return r;
}
function ringiMeta_() { return { categories: RINGI_CATEGORIES, certainty: CERTAINTY }; }

route_('GET', '/api/ringi', function (c) {
  var mine = c.user.role !== 'admin' || c.query.mine === '1';
  var rows = where_('ringi', function (r) { return (!mine || r.user_id === c.user.id) && (!c.query.status || r.status === c.query.status); })
    .sort(byNewest_).slice(0, 300).map(ringiPublic_);
  var m = ringiMeta_();
  m.ringi = rows;
  return m;
});

route_('GET', '/api/ringi/:id', function (c) { var m = ringiMeta_(); m.ringi = ringiPublic_(findRingi_(c)); return m; });

route_('GET', '/api/ringi/:id/attachment', function (c) {
  var r = findRingi_(c);
  if (!r.attachment_file) throw new HttpError(404, '添付ファイルはありません');
  var blob = DriveApp.getFileById(r.attachment_file).getBlob();
  return { name: r.attachment_name, type: r.attachment_type, data: Utilities.base64Encode(blob.getBytes()) };
});

function parseAmount_(v) {
  var s = String(v === null || v === undefined ? '' : v).replace(/[０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xfee0); });
  var m = s.replace(/[,，]/g, '').match(/\d+/);
  return m ? Number(m[0]) : null;
}

route_('POST', '/api/ringi', function (c) {
  var b = c.body;
  var category = str_(b.category, '経費種別', { max: 50 });
  if (RINGI_CATEGORIES.indexOf(category) < 0) bad_('経費種別を選んでください');
  var amount = null;
  if (b.amount !== '' && b.amount !== null && b.amount !== undefined) {
    if (!/^[\d０-９,，\s円]+$/.test(String(b.amount))) bad_('見積金額は数字（円・税込）で入力してください');
    amount = parseAmount_(b.amount);
  }
  var rec = {
    user_id: c.user.id, title: str_(b.title, '購入品名', { max: 100 }), quantity: str_(b.quantity, '購入数量', { max: 50, required: false }),
    category: category, content: str_(b.content, '支出理由・目的', { max: 4000 }), amount: amount,
    certainty: CERTAINTY.indexOf(b.certainty) >= 0 ? b.certainty : '確定', expense_date: optDate_(b.expense_date, '支出日'),
    attachment_name: null, attachment_file: null, attachment_type: null, attachment_url: null,
    status: 'pending', approver_id: null, decision_comment: '', decided_at: null, created_at: nowJST_().stamp,
  };
  if (b.attachment && b.attachment.data) {
    var a = b.attachment;
    if (!ATTACH_TYPES[a.type]) bad_('添付できるのはPDF・画像・Excel・Wordファイルです');
    var bytes = Utilities.base64Decode(String(a.data));
    if (bytes.length > 5 * 1024 * 1024) bad_('添付ファイルは5MBまでです');
    var name = str_(a.name, 'ファイル名', { max: 200 });
    var folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('UPLOAD_FOLDER_ID'));
    var file = folder.createFile(Utilities.newBlob(bytes, a.type, rec.created_at.slice(0, 10) + '_' + name));
    rec.attachment_name = name; rec.attachment_file = file.getId(); rec.attachment_type = a.type;
  }
  return { id: insert_('ringi', rec) };
});

route_('POST', '/api/ringi/:id/cancel', function (c) { cancelOwn_('ringi', c); return { ok: true }; });
route_('POST', '/api/ringi/:id/decide', { admin: true }, function (c) { decide_('ringi', c, { reasonOnReject: true }); return { ok: true }; });

// ---------------------------------------------------------------- 社員管理
var LOGIN_ID_RE = /^[A-Za-z0-9._@+-]+$/;
function loginIdTaken_(loginId, exceptId) {
  return all_('users').some(function (u) { return u.id !== exceptId && String(u.login_id).toLowerCase() === loginId.toLowerCase(); });
}

route_('GET', '/api/users', function (c) {
  var rows = all_('users').map(copy_).sort(function (a, b) { return (b.active - a.active) || (a.id - b.id); });
  if (c.user.role === 'admin') return { users: rows.map(publicUser_) };
  return { users: rows.filter(function (u) { return u.active; }).map(function (u) { return { id: u.id, name: u.name }; }) };
});

route_('POST', '/api/users', { admin: true }, function (c) {
  var b = c.body;
  var loginId = str_(b.login_id, 'ログインID', { max: 100 });
  if (!LOGIN_ID_RE.test(loginId)) bad_('ログインIDは半角英数字かメールアドレスで入力してください');
  var pw = str_(b.password, '初期パスワード');
  if (pw.length < 8) bad_('初期パスワードは8文字以上にしてください');
  if (['admin', 'employee'].indexOf(b.role) < 0) bad_('権限を選んでください');
  if (loginIdTaken_(loginId)) bad_('そのログインIDはすでに使われています');
  var id = insert_('users', {
    login_id: loginId, name: str_(b.name, '氏名', { max: 50 }), role: b.role, hire_date: optDate_(b.hire_date, '入社日'),
    password_hash: hashPassword_(pw), must_change_password: 1, active: 1, created_at: nowJST_().stamp,
  });
  return { id: id };
});

route_('PUT', '/api/users/:id', { admin: true }, function (c) {
  var b = c.body;
  var t = find_('users', c.params.id);
  if (!t) throw new HttpError(404, '社員が見つかりません');
  var ch = {};
  if (b.name !== undefined) ch.name = str_(b.name, '氏名', { max: 50 });
  if (b.login_id !== undefined) {
    var lid = str_(b.login_id, 'ログインID', { max: 100 });
    if (!LOGIN_ID_RE.test(lid)) bad_('ログインIDは半角英数字かメールアドレスで入力してください');
    if (loginIdTaken_(lid, t.id)) bad_('そのログインIDはすでに使われています');
    ch.login_id = lid;
  }
  if (b.role !== undefined) { if (['admin', 'employee'].indexOf(b.role) < 0) bad_('権限を選んでください'); ch.role = b.role; }
  if (b.hire_date !== undefined) ch.hire_date = optDate_(b.hire_date, '入社日');
  var active = b.active === undefined ? !!t.active : !!b.active;
  ch.active = active ? 1 : 0;
  var role = ch.role || t.role;
  var others = all_('users').filter(function (u) { return u.role === 'admin' && u.active && u.id !== t.id; }).length;
  if (t.role === 'admin' && (role !== 'admin' || !active) && others === 0) bad_('管理者が1人もいなくなるため変更できません');
  if (t.id === c.user.id && !active) bad_('自分自身を利用停止にはできません');
  update_('users', t.id, ch);
  if (!active) dropSessions_(t.id);
  return { ok: true };
});

route_('POST', '/api/users/:id/reset-password', { admin: true }, function (c) {
  var t = find_('users', c.params.id);
  if (!t) throw new HttpError(404, '社員が見つかりません');
  var pw = str_(c.body.password, '新しいパスワード');
  if (pw.length < 8) bad_('パスワードは8文字以上にしてください');
  update_('users', t.id, { password_hash: hashPassword_(pw), must_change_password: 1 });
  dropSessions_(t.id);
  return { ok: true };
});

// ---------------------------------------------------------------- 旧スプレッドシートからの取り込み
route_('POST', '/api/admin/import', { admin: true }, function (c) {
  var url = str_(c.body.url, 'スプレッドシートのURL', { max: 500 });
  var m = url.match(/\/d\/([A-Za-z0-9_-]{20,})/) || url.match(/^([A-Za-z0-9_-]{20,})$/);
  if (!m) bad_('GoogleスプレッドシートのURLを貼り付けてください');
  var src;
  try { src = SpreadsheetApp.openById(m[1]); } catch (e) { bad_('スプレッドシートを開けませんでした。このアプリを公開したアカウントで閲覧できるか確認してください'); }
  return importOldData_(src);
});

function findTable_(src, required) {
  var sheets = src.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (!lastRow || !lastCol) continue;
    var values = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();
    for (var r = 0; r < Math.min(5, values.length); r++) {
      var head = values[r].map(function (h) { return String(h).trim(); });
      if (required.every(function (k) { return head.indexOf(k) >= 0; })) {
        var idx = {};
        head.forEach(function (h, j) { if (h && idx[h] === undefined) idx[h] = j; });
        return { name: sh.getName(), idx: idx, rows: values.slice(r + 1).filter(function (row) { return row.some(function (v) { return String(v).trim(); }); }) };
      }
    }
  }
  return null;
}
function cell_(t, row, key) { var j = t.idx[key]; return j === undefined ? '' : String(row[j] || '').trim(); }
function parseDate_(s) {
  var m = String(s).match(/(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/);
  return m ? m[1] + '-' + pad2_(Number(m[2])) + '-' + pad2_(Number(m[3])) : null;
}
function parseTime_(s) {
  s = String(s).replace(/\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/, '');
  var m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return pad2_(Number(m[1])) + ':' + m[2];
}
function parseStamp_(s) { var d = parseDate_(s); if (!d) return null; var t = parseTime_(s); return d + ' ' + (t || '00:00'); }
function parseStatus_(row) {
  var text = row.join(' ');
  var approver = (text.match(/[(（]([^()（）\s]+@[^()（）\s]+)[)）]/) || [])[1] || null;
  if (/差戻|差し戻|却下/.test(text)) return { status: 'rejected', approver: approver };
  if (/承認済|✅/.test(text)) return { status: 'approved', approver: approver };
  return { status: 'pending', approver: approver };
}

function importOldData_(src) {
  var result = { users_created: [], attendance: 0, attendance_skipped: 0, ringi: 0, leave: 0, holiday: 0, notes: [] };
  var now = nowJST_().stamp;
  var byEmail = {}, byName = {};
  function indexUsers() {
    byEmail = {}; byName = {};
    all_('users').forEach(function (u) { byEmail[String(u.login_id).toLowerCase()] = u; byName[String(u.name).replace(/\s/g, '')] = u; });
  }
  indexUsers();

  // 1) 社員（氏名・メールアドレス）
  var ut = findTable_(src, ['氏名', 'メールアドレス']);
  var approvers = {};
  src.getSheets().forEach(function (sh) {
    if (!sh.getLastRow() || !sh.getLastColumn()) return;
    var text = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues().map(function (r) { return r.join(' '); }).join(' ');
    var re = /(?:承認済み|差戻し?)[^(（]*[(（]([^()（）\s]+@[^()（）\s]+)[)）]/g, m;
    while ((m = re.exec(text))) approvers[m[1].toLowerCase()] = true;
  });
  if (ut) {
    var created = [];
    ut.rows.forEach(function (row) {
      var name = cell_(ut, row, '氏名'), email = cell_(ut, row, 'メールアドレス').toLowerCase();
      if (!name || !email || !LOGIN_ID_RE.test(email) || byEmail[email]) return;
      var pw = randomPassword_();
      created.push({ rec: {
        login_id: email, name: name, role: approvers[email] ? 'admin' : 'employee', hire_date: null,
        password_hash: hashPassword_(pw), must_change_password: 1, active: 1, created_at: now,
      }, pw: pw });
    });
    insertMany_('users', created.map(function (x) { return x.rec; }));
    created.forEach(function (x) { result.users_created.push({ name: x.rec.name, login_id: x.rec.login_id, role: x.rec.role, password: x.pw }); });
    indexUsers();
  } else {
    result.notes.push('「氏名・メールアドレス」の表が見つからなかったため、社員は追加していません');
  }
  function userFor(nameOrEmail) {
    var k = String(nameOrEmail || '').trim();
    return byEmail[k.toLowerCase()] || byName[k.replace(/\s/g, '')] || null;
  }

  // 2) 勤怠（日付・名前・出勤・退勤・再開2〜終了5）
  var at = findTable_(src, ['日付', '名前', '出勤', '退勤']);
  if (at) {
    var existing = {};
    all_('attendance').forEach(function (a) { existing[a.user_id + '|' + a.work_date] = true; });
    var merged = {};
    var order = [];
    at.rows.forEach(function (row) {
      var date = parseDate_(cell_(at, row, '日付'));
      var u = userFor(cell_(at, row, '名前'));
      if (!date || !u) { if (cell_(at, row, '名前')) result.attendance_skipped++; return; }
      var key = u.id + '|' + date;
      if (existing[key]) { result.attendance_skipped++; return; }
      var pairs = [['出勤', '退勤']];
      for (var i = 2; i <= CONFIG.maxSegments; i++) pairs.push(['再開' + i, '終了' + i]);
      var segs = [], dropped = [];
      pairs.forEach(function (p) {
        var a = parseTime_(cell_(at, row, p[0])), z = parseTime_(cell_(at, row, p[1]));
        if (!a && !z) return;
        if (!a) { dropped.push(p[1] + ' ' + z); return; }
        // 先の勤務時間の途中にある「終了のない再開」は入力ミスとみなして除外
        if (!z && segs.some(function (s) { return s.out && toMin_(a) >= toMin_(s.in) && toMin_(a) <= toMin_(s.out); })) { dropped.push(p[0] + ' ' + a); return; }
        segs.push(z ? { in: a, out: z } : { in: a });
      });
      if (!segs.length) return;
      if (!merged[key]) { merged[key] = { user_id: u.id, work_date: date, segments: [], break_override: null, note: '', edited_by: null, updated_at: now }; order.push(key); }
      merged[key].segments = merged[key].segments.concat(segs).slice(0, CONFIG.maxSegments);
      if (dropped.length) merged[key].note = '取込時に除外: ' + dropped.join('、');
    });
    var recs = order.map(function (k) {
      var r = merged[k];
      // 最後以外に退勤がない勤務は、その行を退勤漏れとして残す
      for (var i = 0; i < r.segments.length - 1; i++) if (!r.segments[i].out) { r.segments = r.segments.slice(0, i + 1); break; }
      return r;
    });
    insertMany_('attendance', recs);
    result.attendance = recs.length;
  } else {
    result.notes.push('勤怠の表（日付・名前・出勤・退勤）が見つかりませんでした');
  }

  // 3) 稟議（購入申請）
  var rt = findTable_(src, ['タイムスタンプ', 'メールアドレス', '購入品名']);
  if (rt) {
    var seen = {};
    all_('ringi').forEach(function (r) { seen[r.user_id + '|' + r.created_at + '|' + r.title] = true; });
    var list = [];
    rt.rows.forEach(function (row) {
      var u = userFor(cell_(rt, row, 'メールアドレス'));
      var title = cell_(rt, row, '購入品名');
      var created = parseStamp_(cell_(rt, row, 'タイムスタンプ'));
      if (!u || !title || !created) return;
      if (seen[u.id + '|' + created + '|' + title]) return;
      var st = parseStatus_(row);
      var amountText = rt.idx['見積金額(税込・数字のみ)'] !== undefined ? cell_(rt, row, '見積金額(税込・数字のみ)')
        : (function () { var k = Object.keys(rt.idx).filter(function (h) { return h.indexOf('見積金額') === 0; })[0]; return k ? cell_(rt, row, k) : ''; })();
      var cert = cell_(rt, row, '金額の確度');
      var cat = cell_(rt, row, '経費種別');
      var attach = Object.keys(rt.idx).filter(function (h) { return h.indexOf('見積書') >= 0; })[0];
      var attachUrl = attach ? cell_(rt, row, attach) : '';
      list.push({
        user_id: u.id, title: title, quantity: cell_(rt, row, '購入数量'), category: RINGI_CATEGORIES.indexOf(cat) >= 0 ? cat : 'その他',
        content: cell_(rt, row, '支出理由・目的') || '（旧シートから取込）' + (RINGI_CATEGORIES.indexOf(cat) < 0 && cat ? '　経費種別：' + cat : ''),
        amount: parseAmount_(amountText), certainty: /概算|くらい|程度|約/.test(cert + amountText) ? '概算' : '確定',
        expense_date: parseDate_(cell_(rt, row, '支出日')), attachment_name: null, attachment_file: null, attachment_type: null,
        attachment_url: /^https?:\/\//.test(attachUrl) ? attachUrl : null,
        status: st.status, approver_id: st.approver && byEmail[st.approver.toLowerCase()] ? byEmail[st.approver.toLowerCase()].id : null,
        decision_comment: '', decided_at: st.status === 'pending' ? null : created, created_at: created,
      });
    });
    insertMany_('ringi', list);
    result.ringi = list.length;
  }

  // 4) 休暇申請
  var lt = findTable_(src, ['タイムスタンプ', 'メールアドレス', '休暇種別']);
  if (lt) {
    var seenL = {};
    all_('leave_requests').forEach(function (r) { seenL[r.user_id + '|' + r.created_at] = true; });
    var leaves = [];
    lt.rows.forEach(function (row) {
      var u = userFor(cell_(lt, row, 'メールアドレス'));
      var created = parseStamp_(cell_(lt, row, 'タイムスタンプ'));
      var dateKey = Object.keys(lt.idx).filter(function (h) { return h.indexOf('取得予定日') >= 0; })[0];
      var start = dateKey ? parseDate_(cell_(lt, row, dateKey)) : null;
      if (!u || !created || !start || seenL[u.id + '|' + created]) return;
      var kindText = cell_(lt, row, '休暇種別'), period = cell_(lt, row, '休暇期間');
      var kind = /有給|有休/.test(kindText) ? 'paid' : /振替|振休|代休/.test(kindText) ? 'substitute' : /特別|慶弔/.test(kindText) ? 'special' : /欠勤/.test(kindText) ? 'absence' : 'other';
      var type = /午前/.test(period + kindText) ? 'am' : /午後/.test(period + kindText) ? 'pm' : 'full';
      var endM = period.match(/[〜~\-－]\s*(\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2})/);
      var end = type === 'full' && endM ? parseDate_(endM[1]) : start;
      if (!end || end < start) end = start;
      var days = type === 'full' ? daysBetween_(start, end) + 1 : 0.5;
      var dayM = period.match(/(\d+(?:\.\d+)?)\s*日/);
      if (type === 'full' && dayM && start === end) { days = Number(dayM[1]); end = addDays_(start, Math.max(0, Math.ceil(days) - 1)); }
      var st = parseStatus_(row);
      var handover = /あり|有/.test(cell_(lt, row, '業務引継ぎの有無'));
      leaves.push({
        user_id: u.id, kind: kind, leave_type: type, start_date: start, end_date: end, days: days,
        reason: kind === 'other' && kindText ? kindText : '', handover: handover ? 1 : 0, handover_note: cell_(lt, row, '業務引継ぎ申し送り事項'),
        status: st.status, approver_id: st.approver && byEmail[st.approver.toLowerCase()] ? byEmail[st.approver.toLowerCase()].id : null,
        decision_comment: '', decided_at: st.status === 'pending' ? null : created, created_at: created,
      });
    });
    insertMany_('leave_requests', leaves);
    result.leave = leaves.length;
  }

  // 5) 休日出勤申請
  var ht = findTable_(src, ['タイムスタンプ', '休日出勤予定日']);
  if (ht) {
    var seenH = {};
    all_('holiday_work').forEach(function (r) { seenH[r.user_id + '|' + r.created_at] = true; });
    var hws = [];
    ht.rows.forEach(function (row) {
      var emailCell = row.filter(function (v) { return /@/.test(v) && !/[(（]/.test(v); })[0] || cell_(ht, row, 'メールアドレス');
      var u = userFor(emailCell);
      var created = parseStamp_(cell_(ht, row, 'タイムスタンプ'));
      var date = parseDate_(cell_(ht, row, '休日出勤予定日'));
      if (!u || !created || !date || seenH[u.id + '|' + created]) return;
      var startKey = Object.keys(ht.idx).filter(function (h) { return h.indexOf('開始予定') >= 0; })[0];
      var endKey = Object.keys(ht.idx).filter(function (h) { return h.indexOf('終了予定') >= 0; })[0];
      var subKey = Object.keys(ht.idx).filter(function (h) { return h.indexOf('振替休日') >= 0; })[0];
      var st = parseStatus_(row);
      hws.push({
        user_id: u.id, work_date: date, start_time: parseTime_(startKey ? cell_(ht, row, startKey) : '') || '',
        end_time: parseTime_(endKey ? cell_(ht, row, endKey) : '') || '', reason: cell_(ht, row, '休日出勤の理由') || '（旧シートから取込）',
        substitute_date: subKey ? parseDate_(cell_(ht, row, subKey)) : null,
        status: st.status, approver_id: st.approver && byEmail[st.approver.toLowerCase()] ? byEmail[st.approver.toLowerCase()].id : null,
        decision_comment: '', decided_at: st.status === 'pending' ? null : created, created_at: created,
      });
    });
    insertMany_('holiday_work', hws);
    result.holiday = hws.length;
  }
  return result;
}
