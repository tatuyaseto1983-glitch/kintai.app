'use strict';
// 勤怠・有給・稟議 管理アプリ（外部ライブラリなし / Node.js 22.5 以上）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'kintai.db');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 30;
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';

// 労働時間のルール（今のスプレッドシートの計算に合わせた初期値）
const RULES = {
  breakAfter: Number(process.env.BREAK_AFTER_MIN ?? 360), // この時間（分）を超えて働いたら
  breakMinutes: Number(process.env.BREAK_MIN ?? 60), //       休憩をこの分数だけ自動で差し引く
  standard: Number(process.env.STANDARD_WORK_MIN ?? 480), //  これを超えた分を残業とする
  maxSegments: 5, //                                          1日の打刻（出勤→退勤）の最大回数
};

// ---------------------------------------------------------------- DB
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','employee')),
  hire_date TEXT,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  segments TEXT NOT NULL DEFAULT '[]',
  break_override INTEGER,
  note TEXT NOT NULL DEFAULT '',
  edited_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, work_date)
);
CREATE TABLE IF NOT EXISTS leave_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_date TEXT NOT NULL,
  expires_on TEXT NOT NULL,
  days REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'paid',
  leave_type TEXT NOT NULL CHECK (leave_type IN ('full','am','pm')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  handover INTEGER NOT NULL DEFAULT 0,
  handover_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approver_id INTEGER REFERENCES users(id),
  decision_comment TEXT NOT NULL DEFAULT '',
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS holiday_work (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  reason TEXT NOT NULL,
  substitute_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approver_id INTEGER REFERENCES users(id),
  decision_comment TEXT NOT NULL DEFAULT '',
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ringi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  quantity TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  amount INTEGER,
  certainty TEXT NOT NULL DEFAULT '確定',
  expense_date TEXT,
  attachment_name TEXT,
  attachment_file TEXT,
  attachment_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approver_id INTEGER REFERENCES users(id),
  decision_comment TEXT NOT NULL DEFAULT '',
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------------------------------------------------------------- helpers
const JST_OFFSET = 9 * 60 * 60 * 1000;
function nowJST(offsetDays = 0) {
  const iso = new Date(Date.now() + JST_OFFSET + offsetDays * 86400e3).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), stamp: iso.slice(0, 16).replace('T', ' ') };
}
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addYears(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + n);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(hash, 'hex'));
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };
function str(v, name, { max = 200, required = true } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') bad(`${name}の形式が正しくありません`);
  v = v.trim();
  if (required && !v) bad(`${name}を入力してください`);
  if (v.length > max) bad(`${name}は${max}文字以内で入力してください`);
  return v;
}
function optDate(v, name) {
  if (v === undefined || v === null || v === '') return null;
  if (!isDate(v)) bad(`${name}が正しくありません`);
  return v;
}
function reqTime(v, name) {
  if (!TIME_RE.test(v || '')) bad(`${name}は「09:00」の形で入力してください`);
  return v;
}

// ---------------------------------------------------------------- 初期管理者
if (!db.prepare('SELECT COUNT(*) AS c FROM users').get().c) {
  const pw = process.env.ADMIN_PASSWORD || 'admin1234';
  db.prepare(`INSERT INTO users (login_id, name, role, password_hash, must_change_password)
              VALUES (?, '管理者', 'admin', ?, 1)`).run(process.env.ADMIN_LOGIN_ID || 'admin', hashPassword(pw));
  console.log(`初期管理者を作成しました（ID: ${process.env.ADMIN_LOGIN_ID || 'admin'} / パスワード: ${process.env.ADMIN_PASSWORD ? '環境変数で指定した値' : pw}）`);
}

// ---------------------------------------------------------------- 勤怠の計算
// 1日の記録は「出勤→退勤」の組（segments）を最大5つまで持つ（中抜け・夜の再開に対応）
function segMinutes(s) {
  if (!s.in || !s.out) return 0;
  let m = toMin(s.out) - toMin(s.in);
  if (m < 0) m += 1440; // 日付をまたいだ退勤
  return m;
}
function calcDay(r) {
  if (!r) return null;
  const segments = JSON.parse(r.segments || '[]');
  const worked = segments.reduce((s, x) => s + segMinutes(x), 0);
  const open = segments.some((s) => s.in && !s.out);
  const autoBreak = worked > RULES.breakAfter ? RULES.breakMinutes : 0;
  const breakMin = r.break_override ?? autoBreak;
  const work = worked ? Math.max(0, worked - breakMin) : 0;
  return {
    ...r,
    segments,
    open,
    clock_in: segments[0]?.in || null,
    clock_out: open ? null : segments[segments.length - 1]?.out || null,
    break_minutes: worked ? breakMin : 0,
    break_auto: r.break_override == null,
    work_minutes: segments.length ? work : null,
    overtime_minutes: segments.length ? Math.max(0, work - RULES.standard) : null,
  };
}
function getAttendance(userId, date) {
  return db.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?').get(userId, date);
}
function saveSegments(id, segments) {
  db.prepare(`UPDATE attendance SET segments = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(segments), id);
}

// ---------------------------------------------------------------- 有給の計算
// 労働基準法の付与日数（週5日以上・フルタイムの場合）
const STATUTORY = [[0.5, 10], [1.5, 11], [2.5, 12], [3.5, 14], [4.5, 16], [5.5, 18], [6.5, 20]];
function statutoryDays(hireDate, onDate) {
  if (!hireDate) return null;
  const h = new Date(hireDate + 'T00:00:00Z');
  const o = new Date(onDate + 'T00:00:00Z');
  const months = (o.getUTCFullYear() - h.getUTCFullYear()) * 12 + (o.getUTCMonth() - h.getUTCMonth()) - (o.getUTCDate() < h.getUTCDate() ? 1 : 0);
  let days = 0;
  for (const [years, d] of STATUTORY) if (months >= years * 12) days = d;
  return days;
}

// 残日数：有効な付与を古い順に消化していく（先に付与された分から使う）
function leaveBalance(userId, today = nowJST().date) {
  const grants = db.prepare('SELECT * FROM leave_grants WHERE user_id = ? ORDER BY grant_date, id').all(userId)
    .map((g) => ({ ...g, remaining: g.days }));
  const used = db.prepare(`SELECT start_date, days FROM leave_requests
                           WHERE user_id = ? AND kind = 'paid' AND status = 'approved' ORDER BY start_date, id`).all(userId);
  let unmatched = 0;
  for (const u of used) {
    let need = u.days;
    for (const g of grants) {
      if (need <= 0) break;
      if (g.grant_date <= u.start_date && u.start_date <= g.expires_on && g.remaining > 0) {
        const take = Math.min(g.remaining, need);
        g.remaining -= take; need -= take;
      }
    }
    unmatched += need;
  }
  const valid = grants.filter((g) => g.grant_date <= today && today <= g.expires_on);
  const remaining = valid.reduce((s, g) => s + g.remaining, 0) - unmatched;
  const pending = db.prepare(`SELECT COALESCE(SUM(days),0) AS d FROM leave_requests
                              WHERE user_id = ? AND kind = 'paid' AND status = 'pending'`).get(userId).d;
  // 年5日の取得義務：直近の10日以上の付与日から1年間での取得日数
  const lastBig = [...grants].reverse().find((g) => g.days >= 10 && g.grant_date <= today);
  let obligation = null;
  if (lastBig) {
    const end = addYears(lastBig.grant_date, 1);
    const taken = db.prepare(`SELECT COALESCE(SUM(days),0) AS d FROM leave_requests
                              WHERE user_id = ? AND kind = 'paid' AND status = 'approved' AND start_date BETWEEN ? AND ?`)
      .get(userId, lastBig.grant_date, end).d;
    obligation = { from: lastBig.grant_date, to: end, taken, required: 5 };
  }
  return { remaining, pending, grants, obligation };
}

// ---------------------------------------------------------------- HTTP 基盤
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'データが大きすぎます（添付ファイルは5MBまで）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSONの形式が正しくありません')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`).get(token, Date.now()) || null;
}
const publicUser = (u) => ({ id: u.id, login_id: u.login_id, name: u.name, role: u.role, hire_date: u.hire_date, active: !!u.active, must_change_password: !!u.must_change_password });

const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false, admin: !!opts.admin, bodyLimit: opts.bodyLimit || 1e6 });
}

// ログイン試行回数の制限（同じIDで10分間に10回まで）
const loginAttempts = new Map();
function checkRate(key) {
  const now = Date.now();
  const list = (loginAttempts.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 10) throw new HttpError(429, 'ログインの試行回数が多すぎます。10分ほど待ってからお試しください');
  list.push(now); loginAttempts.set(key, list);
}

// 申請の承認・差戻しの共通処理
const STATUS_TEXT = { approved: '承認', rejected: '差戻し' };
function decide(table, user, id, body, { commentRequiredOnReject = true } = {}) {
  const r = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!r) throw new HttpError(404, '申請が見つかりません');
  if (!['approved', 'rejected', 'pending'].includes(body.decision)) bad('判断が正しくありません');
  if (body.decision === 'pending') {
    if (r.status === 'pending' || r.status === 'cancelled') bad('この申請は取り消せません');
    db.prepare(`UPDATE ${table} SET status = 'pending', approver_id = NULL, decision_comment = '', decided_at = NULL WHERE id = ?`).run(r.id);
    return r;
  }
  if (r.status !== 'pending') bad('この申請はすでに処理されています');
  const comment = str(body.comment, 'コメント', { max: 500, required: commentRequiredOnReject && body.decision === 'rejected' });
  db.prepare(`UPDATE ${table} SET status = ?, approver_id = ?, decision_comment = ?, decided_at = ? WHERE id = ?`)
    .run(body.decision, user.id, comment, nowJST().stamp, r.id);
  return r;
}
function cancelOwn(table, user, id) {
  const r = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!r || (r.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, '申請が見つかりません');
  if (r.status !== 'pending') bad('承認待ちの申請のみ取り下げできます');
  db.prepare(`UPDATE ${table} SET status = 'cancelled' WHERE id = ?`).run(r.id);
}

// ---------------------------------------------------------------- 認証
route('POST', '/api/login', { auth: false }, ({ body, res }) => {
  const loginId = str(body.login_id, 'ログインID', { max: 100 });
  const password = str(body.password, 'パスワード', { max: 200 });
  checkRate(loginId.toLowerCase());
  const u = db.prepare('SELECT * FROM users WHERE login_id = ? AND active = 1').get(loginId);
  if (!u || !verifyPassword(password, u.password_hash)) throw new HttpError(401, 'IDまたはパスワードが違います');
  loginAttempts.delete(loginId.toLowerCase());
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, u.id, Date.now() + SESSION_DAYS * 86400e3);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIE ? '; Secure' : ''}`);
  return { user: publicUser(u) };
});

route('POST', '/api/logout', { auth: false }, ({ req, res }) => {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return { ok: true };
});

route('GET', '/api/me', ({ user }) => ({ user: publicUser(user), today: nowJST().date, rules: RULES }));

route('POST', '/api/me/password', ({ user, body }) => {
  const current = str(body.current, '現在のパスワード');
  const next = str(body.next, '新しいパスワード', { max: 200 });
  if (!verifyPassword(current, user.password_hash)) bad('現在のパスワードが違います');
  if (next.length < 8) bad('新しいパスワードは8文字以上にしてください');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(next), user.id);
  return { ok: true };
});

// ---------------------------------------------------------------- 勤怠
function punchState(userId) {
  const { date } = nowJST();
  const today = calcDay(getAttendance(userId, date));
  // 前日の退勤が押されていない（日付をまたいだ勤務）場合
  const yesterday = calcDay(getAttendance(userId, nowJST(-1).date));
  const carry = !today?.open && yesterday?.open ? yesterday : null;
  return { date, record: today, carry };
}

route('GET', '/api/attendance/today', ({ user }) => punchState(user.id));

route('POST', '/api/attendance/punch', ({ user, body }) => {
  const { date, time } = nowJST();
  const st = punchState(user.id);
  if (body.action === 'in') {
    const r = getAttendance(user.id, date);
    const segs = r ? JSON.parse(r.segments) : [];
    if (segs.some((s) => !s.out)) bad('勤務中です（先に退勤を押してください）');
    if (segs.length >= RULES.maxSegments) bad(`1日の打刻は${RULES.maxSegments}回までです。管理者に修正を依頼してください`);
    segs.push({ in: time });
    if (r) saveSegments(r.id, segs);
    else db.prepare('INSERT INTO attendance (user_id, work_date, segments) VALUES (?, ?, ?)').run(user.id, date, JSON.stringify(segs));
  } else if (body.action === 'out') {
    const target = st.record?.open ? st.record : st.carry;
    if (!target) bad('出勤していません（先に出勤を押してください）');
    const segs = target.segments;
    segs[segs.length - 1].out = time;
    saveSegments(target.id, segs);
  } else {
    bad('操作が正しくありません');
  }
  return punchState(user.id);
});

function monthRecords(userId, month) {
  return db.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date LIKE ? ORDER BY work_date').all(userId, month + '-%').map(calcDay);
}
function monthLeaves(userId, month) {
  const first = month + '-01';
  const last = addDays(addDays(month + '-28', 4).slice(0, 7) + '-01', -1);
  return db.prepare(`SELECT kind, leave_type, start_date, end_date, status FROM leave_requests
                     WHERE user_id = ? AND status IN ('approved','pending') AND start_date <= ? AND end_date >= ?`).all(userId, last, first);
}
function summarize(records) {
  const worked = records.filter((r) => r.segments.length);
  return {
    days: worked.length,
    work_minutes: worked.reduce((s, r) => s + (r.work_minutes || 0), 0),
    overtime_minutes: worked.reduce((s, r) => s + (r.overtime_minutes || 0), 0),
    missing: records.filter((r) => r.open && r.work_date < nowJST().date).length,
  };
}
function resolveTargetUser(user, query) {
  if (user.role !== 'admin' || !query.get('user_id')) return user.id;
  return Number(query.get('user_id'));
}
function checkMonth(query) {
  const month = query.get('month') || nowJST().date.slice(0, 7);
  if (!MONTH_RE.test(month)) bad('月の形式が正しくありません');
  return month;
}

route('GET', '/api/attendance', ({ user, query }) => {
  const month = checkMonth(query);
  const uid = resolveTargetUser(user, query);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!target) throw new HttpError(404, '社員が見つかりません');
  const records = monthRecords(uid, month);
  const holidayWork = db.prepare(`SELECT work_date, status FROM holiday_work WHERE user_id = ? AND work_date LIKE ? AND status IN ('approved','pending')`).all(uid, month + '-%');
  return { user: publicUser(target), month, records, leaves: monthLeaves(uid, month), holiday_work: holidayWork, summary: summarize(records) };
});

// 社員本人：備考のみ編集できる（打刻の修正は管理者へ依頼）
route('POST', '/api/attendance/note', ({ user, body }) => {
  if (!isDate(body.work_date)) bad('日付が正しくありません');
  const note = str(body.note, '備考', { max: 200, required: false });
  db.prepare(`INSERT INTO attendance (user_id, work_date, note) VALUES (?, ?, ?)
              ON CONFLICT(user_id, work_date) DO UPDATE SET note = excluded.note, updated_at = datetime('now')`).run(user.id, body.work_date, note);
  return { ok: true };
});

// 管理者：勤怠の修正
route('PUT', '/api/attendance', { admin: true }, ({ user, body }) => {
  const uid = Number(body.user_id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(uid)) bad('社員が見つかりません');
  if (!isDate(body.work_date)) bad('日付が正しくありません');
  if (!Array.isArray(body.segments)) bad('打刻の形式が正しくありません');
  const segments = [];
  for (const [i, s] of body.segments.entries()) {
    const inT = s.in || ''; const outT = s.out || '';
    if (!inT && !outT) continue;
    if (!inT) bad(`${i + 1}回目：出勤（再開）時刻を入力してください`);
    reqTime(inT, `${i + 1}回目の出勤時刻`);
    if (outT) reqTime(outT, `${i + 1}回目の退勤時刻`);
    segments.push(outT ? { in: inT, out: outT } : { in: inT });
  }
  if (segments.length > RULES.maxSegments) bad(`打刻は${RULES.maxSegments}回までです`);
  if (segments.slice(0, -1).some((s) => !s.out)) bad('最後以外の退勤時刻が空欄になっています');
  let breakOverride = null;
  if (body.break_override !== '' && body.break_override != null) {
    breakOverride = Number(body.break_override);
    if (!Number.isInteger(breakOverride) || breakOverride < 0 || breakOverride > 1440) bad('休憩時間（分）が正しくありません');
  }
  const note = str(body.note, '備考', { max: 200, required: false });
  if (!segments.length && breakOverride == null && !note) {
    db.prepare('DELETE FROM attendance WHERE user_id = ? AND work_date = ?').run(uid, body.work_date);
    return { ok: true, deleted: true };
  }
  db.prepare(`INSERT INTO attendance (user_id, work_date, segments, break_override, note, edited_by)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, work_date) DO UPDATE SET segments = excluded.segments, break_override = excluded.break_override,
                note = excluded.note, edited_by = excluded.edited_by, updated_at = datetime('now')`)
    .run(uid, body.work_date, JSON.stringify(segments), breakOverride, note, user.id);
  return { ok: true };
});

const csvEsc = (v) => { v = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
const hm = (m) => (m == null ? '' : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`);
function sendCsv(res, name, rows) {
  send(res, 200, '﻿' + rows.map((r) => r.map(csvEsc).join(',')).join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
}

// 日別（今のシートと同じ並び：出勤・退勤・再開2〜終了5）
route('GET', '/api/attendance/export', { admin: true }, ({ query, res }) => {
  const month = checkMonth(query);
  const rows = db.prepare(`SELECT u.name, a.* FROM attendance a JOIN users u ON u.id = a.user_id
                           WHERE a.work_date LIKE ? ORDER BY a.work_date, u.id`).all(month + '-%').map((r) => ({ name: r.name, ...calcDay(r) }));
  const head = ['日付', '名前', '出勤', '退勤'];
  for (let i = 2; i <= RULES.maxSegments; i++) head.push(`再開${i}`, `終了${i}`);
  head.push('休憩(分)', '総労働時間', '残業時間', '備考');
  const out = [head];
  for (const r of rows) {
    const segs = [];
    for (let i = 0; i < RULES.maxSegments; i++) segs.push(r.segments[i]?.in || '', r.segments[i]?.out || '');
    out.push([r.work_date.replace(/-/g, '/'), r.name, ...segs, r.break_minutes, hm(r.work_minutes), hm(r.overtime_minutes), r.note]);
  }
  sendCsv(res, `kintai-${month}.csv`, out);
});

function monthlySummary(month) {
  const users = db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY id').all();
  return users.map((u) => {
    const s = summarize(monthRecords(u.id, month));
    const leaves = monthLeaves(u.id, month).filter((l) => l.status === 'approved');
    const paid = leaves.filter((l) => l.kind === 'paid').length;
    const hw = db.prepare(`SELECT COUNT(*) AS c FROM holiday_work WHERE user_id = ? AND work_date LIKE ? AND status = 'approved'`).get(u.id, month + '-%').c;
    return { user: publicUser(u), ...s, paid_leave_requests: paid, holiday_work: hw };
  });
}

// 月次集計（今のシートの「対象年月・出勤日数・総労働時間・残業時間」）
route('GET', '/api/admin/monthly', { admin: true }, ({ query }) => {
  const month = checkMonth(query);
  return { month, rules: RULES, rows: monthlySummary(month) };
});

route('GET', '/api/admin/monthly/export', { admin: true }, ({ query, res }) => {
  const month = checkMonth(query);
  const out = [['対象年月', month.replace('-', '/')], ['社員名', '出勤日数', '総労働時間', '残業時間', '打刻漏れ', '休日出勤(承認)']];
  for (const r of monthlySummary(month)) out.push([r.user.name, r.days, hm(r.work_minutes), hm(r.overtime_minutes), r.missing, r.holiday_work]);
  sendCsv(res, `kintai-summary-${month}.csv`, out);
});

// 管理者ダッシュボード：本日の全員の状況・承認待ち・打刻漏れ
route('GET', '/api/admin/dashboard', { admin: true }, () => {
  const { date } = nowJST();
  const users = db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY id').all();
  const today = users.map((u) => {
    const r = calcDay(getAttendance(u.id, date));
    const leave = db.prepare(`SELECT kind, leave_type FROM leave_requests WHERE user_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?`).get(u.id, date, date);
    let status = '未出勤';
    if (r?.open) status = '勤務中';
    else if (r?.segments.length) status = '退勤済み';
    if (leave && !r?.segments.length) status = leave.leave_type === 'full' ? '休暇' : '半休';
    return { user: publicUser(u), status, record: r };
  });
  const missing = db.prepare(`SELECT a.*, u.name FROM attendance a JOIN users u ON u.id = a.user_id
                              WHERE u.active = 1 AND a.work_date < ? AND a.work_date >= ? ORDER BY a.work_date DESC`)
    .all(date, addDays(date, -62)).map((r) => ({ name: r.name, ...calcDay(r) })).filter((r) => r.open);
  return {
    date,
    today,
    missing,
    pending: {
      leave: db.prepare(`SELECT COUNT(*) AS c FROM leave_requests WHERE status = 'pending'`).get().c,
      holiday: db.prepare(`SELECT COUNT(*) AS c FROM holiday_work WHERE status = 'pending'`).get().c,
      ringi: db.prepare(`SELECT COUNT(*) AS c FROM ringi WHERE status = 'pending'`).get().c,
    },
  };
});

// ---------------------------------------------------------------- 休暇
const LEAVE_KINDS = { paid: '有給休暇', substitute: '振替休日', special: '特別休暇（慶弔など）', absence: '欠勤', other: 'その他' };
const leaveSelect = `SELECT l.*, u.name AS user_name, a.name AS approver_name FROM leave_requests l
                     JOIN users u ON u.id = l.user_id LEFT JOIN users a ON a.id = l.approver_id`;

route('GET', '/api/leave/summary', ({ user, query }) => {
  const uid = resolveTargetUser(user, query);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!target) throw new HttpError(404, '社員が見つかりません');
  return {
    user: publicUser(target),
    kinds: LEAVE_KINDS,
    ...leaveBalance(uid),
    requests: db.prepare(`${leaveSelect} WHERE l.user_id = ? ORDER BY l.start_date DESC, l.id DESC LIMIT 100`).all(uid),
  };
});

route('GET', '/api/leave/requests', { admin: true }, ({ query }) => {
  const status = query.get('status');
  const rows = status
    ? db.prepare(`${leaveSelect} WHERE l.status = ? ORDER BY l.start_date, l.id`).all(status)
    : db.prepare(`${leaveSelect} ORDER BY l.created_at DESC, l.id DESC LIMIT 200`).all();
  return { requests: rows, kinds: LEAVE_KINDS };
});

route('POST', '/api/leave/requests', ({ user, body }) => {
  if (!LEAVE_KINDS[body.kind]) bad('休暇の種別を選んでください');
  if (!['full', 'am', 'pm'].includes(body.leave_type)) bad('全日・午前半休・午後半休から選んでください');
  if (!isDate(body.start_date)) bad('休暇取得予定日を選んでください');
  const end = body.leave_type === 'full' ? optDate(body.end_date, '最終日') || body.start_date : body.start_date;
  if (end < body.start_date) bad('最終日が取得日より前になっています');
  const days = body.leave_type === 'full' ? daysBetween(body.start_date, end) + 1 : 0.5;
  if (days > 31) bad('一度に申請できるのは31日までです');
  const reason = str(body.reason, '理由', { max: 200, required: false });
  const handover = body.handover === true || body.handover === '1' || body.handover === 'あり';
  const handoverNote = str(body.handover_note, '申し送り事項', { max: 1000, required: false });
  if (handover && !handoverNote) bad('業務引継ぎ「あり」の場合は、申し送り事項を書いてください');
  const overlap = db.prepare(`SELECT leave_type FROM leave_requests WHERE user_id = ? AND status IN ('pending','approved')
                              AND start_date <= ? AND end_date >= ?`).all(user.id, end, body.start_date);
  if (overlap.some((o) => o.leave_type === 'full' || body.leave_type === 'full' || o.leave_type === body.leave_type)) bad('その期間はすでに申請済みです');
  if (body.kind === 'paid') {
    const bal = leaveBalance(user.id, body.start_date < nowJST().date ? nowJST().date : body.start_date);
    if (bal.remaining - bal.pending < days) bad(`有給の残日数が足りません（残り ${bal.remaining} 日 / 申請中 ${bal.pending} 日）`);
  }
  const info = db.prepare(`INSERT INTO leave_requests (user_id, kind, leave_type, start_date, end_date, days, reason, handover, handover_note)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, body.kind, body.leave_type, body.start_date, end, days, reason, handover ? 1 : 0, handover ? handoverNote : '');
  return { id: Number(info.lastInsertRowid) };
});

route('POST', '/api/leave/requests/:id/cancel', ({ user, params }) => { cancelOwn('leave_requests', user, params.id); return { ok: true }; });

route('POST', '/api/leave/requests/:id/decide', { admin: true }, ({ user, params, body }) => {
  const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(params.id);
  if (r && r.kind === 'paid' && body.decision === 'approved' && r.status === 'pending') {
    const bal = leaveBalance(r.user_id, r.start_date < nowJST().date ? nowJST().date : r.start_date);
    if (bal.remaining < r.days) bad(`有給の残日数が足りないため承認できません（残り ${bal.remaining} 日）`);
  }
  decide('leave_requests', user, params.id, body, { commentRequiredOnReject: false });
  return { ok: true };
});

route('POST', '/api/leave/grants', { admin: true }, ({ body }) => {
  const uid = Number(body.user_id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(uid)) bad('社員が見つかりません');
  if (!isDate(body.grant_date)) bad('付与日を入力してください');
  const days = Number(body.days);
  if (!(days > 0 && days <= 40) || (days * 2) % 1 !== 0) bad('付与日数は0.5日単位・40日以内で入力してください');
  const note = str(body.note, 'メモ', { max: 100, required: false });
  db.prepare('INSERT INTO leave_grants (user_id, grant_date, expires_on, days, note) VALUES (?, ?, ?, ?, ?)')
    .run(uid, body.grant_date, addYears(body.grant_date, 2), days, note);
  return { ok: true };
});

route('DELETE', '/api/leave/grants/:id', { admin: true }, ({ params }) => {
  db.prepare('DELETE FROM leave_grants WHERE id = ?').run(params.id);
  return { ok: true };
});

route('GET', '/api/admin/leave-overview', { admin: true }, () => {
  const { date } = nowJST();
  const users = db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY id').all();
  return {
    users: users.map((u) => {
      const b = leaveBalance(u.id, date);
      return { user: publicUser(u), remaining: b.remaining, pending: b.pending, obligation: b.obligation, statutory_now: statutoryDays(u.hire_date, date) };
    }),
  };
});

// ---------------------------------------------------------------- 休日出勤
const hwSelect = `SELECT h.*, u.name AS user_name, a.name AS approver_name FROM holiday_work h
                  JOIN users u ON u.id = h.user_id LEFT JOIN users a ON a.id = h.approver_id`;

route('GET', '/api/holiday-work', ({ user, query }) => {
  const where = []; const args = [];
  if (user.role !== 'admin' || query.get('mine') === '1') { where.push('h.user_id = ?'); args.push(user.id); }
  if (query.get('status')) { where.push('h.status = ?'); args.push(query.get('status')); }
  return { requests: db.prepare(`${hwSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY h.work_date DESC, h.id DESC LIMIT 200`).all(...args) };
});

route('POST', '/api/holiday-work', ({ user, body }) => {
  if (!isDate(body.work_date)) bad('休日出勤予定日を選んでください');
  const start = reqTime(body.start_time, '開始予定時間');
  const end = reqTime(body.end_time, '終了予定時間');
  const reason = str(body.reason, '休日出勤の理由', { max: 500 });
  const sub = optDate(body.substitute_date, '振替休日取得予定日');
  const info = db.prepare('INSERT INTO holiday_work (user_id, work_date, start_time, end_time, reason, substitute_date) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, body.work_date, start, end, reason, sub);
  return { id: Number(info.lastInsertRowid) };
});

route('POST', '/api/holiday-work/:id/cancel', ({ user, params }) => { cancelOwn('holiday_work', user, params.id); return { ok: true }; });
route('POST', '/api/holiday-work/:id/decide', { admin: true }, ({ user, params, body }) => {
  decide('holiday_work', user, params.id, body, { commentRequiredOnReject: false });
  return { ok: true };
});

// ---------------------------------------------------------------- 稟議（購入・経費の申請）
const RINGI_CATEGORIES = ['備品購入', '消耗品', '工具・資材', '雑費', '交通費', '広告宣伝費', '外注費', '交際費', 'その他'];
const CERTAINTY = ['確定', '概算'];
const ATTACH_TYPES = {
  'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/webp': '.webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
};
const ringiSelect = `SELECT r.*, u.name AS user_name, a.name AS approver_name FROM ringi r
                     JOIN users u ON u.id = r.user_id LEFT JOIN users a ON a.id = r.approver_id`;
const ringiPublic = (r) => { const { attachment_file, ...rest } = r; return { ...rest, has_attachment: !!attachment_file }; };

route('GET', '/api/ringi', ({ user, query }) => {
  const where = []; const args = [];
  if (user.role !== 'admin' || query.get('mine') === '1') { where.push('r.user_id = ?'); args.push(user.id); }
  if (query.get('status')) { where.push('r.status = ?'); args.push(query.get('status')); }
  const rows = db.prepare(`${ringiSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC, r.id DESC LIMIT 300`).all(...args);
  return { ringi: rows.map(ringiPublic), categories: RINGI_CATEGORIES, certainty: CERTAINTY, attach_types: Object.keys(ATTACH_TYPES) };
});

function findRingi(user, id) {
  const r = db.prepare(`${ringiSelect} WHERE r.id = ?`).get(id);
  if (!r || (r.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, '稟議が見つかりません');
  return r;
}

route('GET', '/api/ringi/:id', ({ user, params }) => ({ ringi: ringiPublic(findRingi(user, params.id)), categories: RINGI_CATEGORIES, certainty: CERTAINTY }));

route('GET', '/api/ringi/:id/attachment', ({ user, params, res }) => {
  const r = findRingi(user, params.id);
  if (!r.attachment_file) throw new HttpError(404, '添付ファイルはありません');
  const file = path.join(UPLOAD_DIR, path.basename(r.attachment_file));
  if (!fs.existsSync(file)) throw new HttpError(404, '添付ファイルが見つかりません');
  send(res, 200, fs.readFileSync(file), {
    'Content-Type': ATTACH_TYPES[r.attachment_type] ? r.attachment_type : 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.attachment_name || 'attachment')}`,
  });
});

route('POST', '/api/ringi', { bodyLimit: 8e6 }, ({ user, body }) => {
  const title = str(body.title, '購入品名', { max: 100 });
  const quantity = str(body.quantity, '購入数量', { max: 50, required: false });
  const category = str(body.category, '経費種別', { max: 50 });
  if (!RINGI_CATEGORIES.includes(category)) bad('経費種別を選んでください');
  const content = str(body.content, '支出理由・目的', { max: 4000 });
  let amount = null;
  if (body.amount !== '' && body.amount != null) {
    amount = Number(String(body.amount).replace(/[,，円\s]/g, '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
    if (!Number.isInteger(amount) || amount < 0 || amount > 1e12) bad('見積金額は数字（円・税込）で入力してください');
  }
  const certainty = CERTAINTY.includes(body.certainty) ? body.certainty : '確定';
  const expenseDate = optDate(body.expense_date, '支出日');
  let att = { name: null, file: null, type: null };
  if (body.attachment && body.attachment.data) {
    const a = body.attachment;
    if (!ATTACH_TYPES[a.type]) bad('添付できるのはPDF・画像・Excel・Wordファイルです');
    const buf = Buffer.from(String(a.data), 'base64');
    if (buf.length > 5 * 1024 * 1024) bad('添付ファイルは5MBまでです');
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const file = crypto.randomBytes(16).toString('hex') + ATTACH_TYPES[a.type];
    fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
    att = { name: str(a.name, 'ファイル名', { max: 200 }), file, type: a.type };
  }
  const info = db.prepare(`INSERT INTO ringi (user_id, title, quantity, category, content, amount, certainty, expense_date, attachment_name, attachment_file, attachment_type)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, title, quantity, category, content, amount, certainty, expenseDate, att.name, att.file, att.type);
  return { id: Number(info.lastInsertRowid) };
});

route('POST', '/api/ringi/:id/cancel', ({ user, params }) => { cancelOwn('ringi', user, params.id); return { ok: true }; });
route('POST', '/api/ringi/:id/decide', { admin: true }, ({ user, params, body }) => {
  decide('ringi', user, params.id, body);
  return { ok: true };
});

// ---------------------------------------------------------------- 社員管理
route('GET', '/api/users', ({ user }) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY active DESC, id').all();
  if (user.role === 'admin') return { users: rows.map(publicUser) };
  return { users: rows.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name })) };
});

function validateUserFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) out.name = str(body.name, '氏名', { max: 50 });
  if (!partial || body.role !== undefined) {
    if (!['admin', 'employee'].includes(body.role)) bad('権限を選んでください');
    out.role = body.role;
  }
  if (!partial || body.hire_date !== undefined) out.hire_date = optDate(body.hire_date, '入社日');
  return out;
}

route('POST', '/api/users', { admin: true }, ({ body }) => {
  const loginId = str(body.login_id, 'ログインID', { max: 100 });
  if (!/^[A-Za-z0-9._@+-]+$/.test(loginId)) bad('ログインIDは半角英数字かメールアドレスで入力してください');
  const password = str(body.password, '初期パスワード', { max: 200 });
  if (password.length < 8) bad('初期パスワードは8文字以上にしてください');
  const f = validateUserFields(body);
  if (db.prepare('SELECT id FROM users WHERE login_id = ?').get(loginId)) bad('そのログインIDはすでに使われています');
  const info = db.prepare('INSERT INTO users (login_id, name, role, hire_date, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?, 1)')
    .run(loginId, f.name, f.role, f.hire_date, hashPassword(password));
  return { id: Number(info.lastInsertRowid) };
});

route('PUT', '/api/users/:id', { admin: true }, ({ user, params, body }) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!target) throw new HttpError(404, '社員が見つかりません');
  const f = validateUserFields(body, { partial: true });
  let loginId = target.login_id;
  if (body.login_id !== undefined) {
    loginId = str(body.login_id, 'ログインID', { max: 100 });
    if (!/^[A-Za-z0-9._@+-]+$/.test(loginId)) bad('ログインIDは半角英数字かメールアドレスで入力してください');
    if (db.prepare('SELECT id FROM users WHERE login_id = ? AND id != ?').get(loginId, target.id)) bad('そのログインIDはすでに使われています');
  }
  const active = body.active === undefined ? !!target.active : !!body.active;
  const role = f.role || target.role;
  const otherAdmins = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id != ?`).get(target.id).c;
  if (target.role === 'admin' && (role !== 'admin' || !active) && otherAdmins === 0) bad('管理者が1人もいなくなるため変更できません');
  if (target.id === user.id && !active) bad('自分自身を利用停止にはできません');
  db.prepare('UPDATE users SET login_id = ?, name = ?, role = ?, hire_date = ?, active = ? WHERE id = ?')
    .run(loginId, f.name ?? target.name, role, f.hire_date !== undefined ? f.hire_date : target.hire_date, active ? 1 : 0, target.id);
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  return { ok: true };
});

route('POST', '/api/users/:id/reset-password', { admin: true }, ({ params, body }) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!target) throw new HttpError(404, '社員が見つかりません');
  const password = str(body.password, '新しいパスワード', { max: 200 });
  if (password.length < 8) bad('パスワードは8文字以上にしてください');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(password), target.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  return { ok: true };
});

// ---------------------------------------------------------------- サーバー
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method Not Allowed' });
    return serveStatic(req, res, url.pathname);
  }
  try {
    // 他サイトからの不正な送信を防ぐため、更新系はJSONのみ受け付ける
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
    const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!match) throw new HttpError(404, 'APIが見つかりません');
    const m = url.pathname.match(match.re);
    const params = Object.fromEntries(match.keys.map((k, i) => [k, Number(m[i + 1])]));
    const user = currentUser(req);
    if (match.auth && !user) throw new HttpError(401, 'ログインしてください');
    if (match.admin && user.role !== 'admin') throw new HttpError(403, '管理者のみ操作できます');
    if (user && user.must_change_password && match.auth && !['/api/me', '/api/me/password'].includes(url.pathname)) {
      throw new HttpError(403, '最初にパスワードを変更してください');
    }
    const body = req.method === 'GET' ? {} : await readJson(req, match.bodyLimit);
    const result = await match.handler({ req, res, user, body, params, query: url.searchParams });
    if (result !== undefined) send(res, 200, result);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'サーバーでエラーが発生しました' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`勤怠管理アプリを起動しました: http://localhost:${PORT}`));
}
module.exports = { server, db, calcDay, statutoryDays, leaveBalance, RULES };
