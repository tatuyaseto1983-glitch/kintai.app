'use strict';
/* 勤怠・有給・稟議 管理アプリ 画面側 */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { me: null, today: null, rules: null, pending: { leave: 0, holiday: 0, ringi: 0 } };

// ------------------------------------------------------------ 通信
// サーバー（Google Apps Script）のURLは config.js で設定する
const API_URL = window.KINTAI_API_URL || '';
const TOKEN_KEY = 'kintai_token';
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const setToken = (t) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* 保存できない環境 */ } };

async function api(path, { method = 'GET', body } = {}) {
  if (!API_URL || API_URL.includes('ここに')) throw new Error('サーバーのURLが設定されていません（public/config.js）');
  let res;
  try {
    // text/plain で送ると、Apps Script でも事前確認なしで受け付けられる
    res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ method, path, body, token: getToken() }), redirect: 'follow' });
  } catch {
    throw new Error('サーバーに接続できませんでした。電波の状態を確認して、もう一度お試しください');
  }
  const out = await res.json().catch(() => ({ ok: false, status: 500, error: 'サーバーの応答を読み取れませんでした' }));
  if (out.status === 401 && path !== '/api/login') { setToken(null); state.me = null; renderLogin(); throw new Error(out.error || 'ログインしてください'); }
  if (!out.ok) throw new Error(out.error || `エラーが発生しました（${out.status}）`);
  return out.data;
}

// サーバーから受け取った内容をファイルとして保存させる
function saveFile(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function downloadCsv(path) {
  try { const d = await api(path); saveFile(d.filename, d.csv, 'text/csv;charset=utf-8'); } catch (e) { toast(e.message, true); }
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' err' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = ''; }, 3000);
}

// ------------------------------------------------------------ 表示用
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const STATUS = { pending: ['承認待ち', 'b-pending'], approved: ['承認済み', 'b-approved'], rejected: ['差戻し', 'b-rejected'], cancelled: ['取り下げ', 'b-cancelled'] };
const LEAVE_TYPE = { full: '全日', am: '午前半休', pm: '午後半休' };
const badge = (s) => `<span class="badge ${STATUS[s][1]}">${STATUS[s][0]}</span>`;
const hm = (m) => (m == null ? '' : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`);
const yen = (n) => (n == null ? '—' : `${Number(n).toLocaleString('ja-JP')}円`);
const days = (d) => `${Number(d)}日`;
const dow = (d) => WEEK[new Date(d + 'T00:00:00').getDay()];
function dateLabel(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return `${dt.getMonth() + 1}/${dt.getDate()}（${WEEK[dt.getDay()]}）`;
}
function fullDate(d) {
  if (!d) return '';
  const [y, m, dd] = d.split('-');
  return `${y}年${Number(m)}月${Number(dd)}日`;
}
function periodLabel(l) {
  if (l.start_date === l.end_date) return `${fullDate(l.start_date)}（${dow(l.start_date)}）`;
  return `${fullDate(l.start_date)}（${dow(l.start_date)}）〜 ${dateLabel(l.end_date)}`;
}
function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const monthLabel = (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月度`;
// その日が含まれる「◯月度」（20日締めなら 9/21 は 10月度）
function periodOf(date) {
  const c = state.rules.closingDay;
  const ym = date.slice(0, 7);
  return c && c < 28 && Number(date.slice(8, 10)) > c ? shiftMonth(ym, 1) : ym;
}
const rangeLabel = (from, to) => `${dateLabel(from)}〜${dateLabel(to)}`;
const isAdmin = () => state.me && state.me.role === 'admin';
const monthNav = (base, month, from, to) => `
  <a class="btn secondary small" href="${base}/${shiftMonth(month, -1)}">← 前の月</a>
  <strong>${monthLabel(month)}<span class="muted small">（${rangeLabel(from, to)}）</span></strong>
  <a class="btn secondary small" href="${base}/${shiftMonth(month, 1)}">次の月 →</a>
  ${month !== state.period ? `<a class="btn ghost small" href="${base}/${state.period}">今月度へ</a>` : ''}`;

// ------------------------------------------------------------ モーダル
function openModal(html, onSubmit, { wide = false } = {}) {
  const dlg = $('#modal');
  const form = $('#modal-form');
  dlg.classList.toggle('wide', wide);
  form.innerHTML = html + '<p class="error" data-error></p>';
  form.onsubmit = async (ev) => {
    const submitter = ev.submitter;
    if (!submitter || submitter.value === 'cancel') return;
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    submitter.disabled = true;
    try {
      const keepOpen = await onSubmit(fd, form);
      if (!keepOpen) dlg.close();
    } catch (e) {
      $('[data-error]', form).textContent = e.message;
    } finally {
      submitter.disabled = false;
    }
  };
  dlg.showModal();
  const first = form.querySelector('input:not([type=hidden]), select, textarea');
  if (first) first.focus();
  return form;
}
const modalButtons = (label = '保存する') =>
  `<div class="actions"><button value="cancel" class="secondary" formnovalidate>キャンセル</button><button value="ok">${label}</button></div>`;

// ------------------------------------------------------------ ログイン
function renderLogin() {
  $('#app').className = '';
  $('#app').innerHTML = `
  <div class="login-wrap">
    <form class="card login" id="login-form">
      <div class="brand"><img src="icon.svg" alt="">勤怠・有給・稟議</div>
      <label>ログインID（メールアドレス）<input name="login_id" autocomplete="username" required></label>
      <label>パスワード<input name="password" type="password" autocomplete="current-password" required></label>
      <p class="error" id="login-error"></p>
      <button>ログイン</button>
      <p class="small muted">パスワードを忘れた場合は、管理者に再発行を依頼してください。</p>
    </form>
  </div>`;
  $('#login-form').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const d = await api('/api/login', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) });
      setToken(d.token);
      await boot();
    } catch (e) { $('#login-error').textContent = e.message; }
  };
}

function renderForcePassword() {
  $('#app').innerHTML = `
  <div class="login-wrap">
    <form class="card login" id="pw-form">
      <div class="brand"><img src="icon.svg" alt="">はじめにパスワードを変更</div>
      <p class="small muted">仮のパスワードでログインしています。ご自身だけが知っているパスワード（8文字以上）に変更してください。</p>
      <label>現在（仮）のパスワード<input name="current" type="password" autocomplete="current-password" required></label>
      <label>新しいパスワード（8文字以上）<input name="next" type="password" minlength="8" autocomplete="new-password" required></label>
      <label>新しいパスワード（確認）<input name="confirm" type="password" minlength="8" autocomplete="new-password" required></label>
      <p class="error" id="pw-error"></p>
      <button>変更して始める</button>
      <p class="right"><button type="button" class="ghost" id="pw-logout">ログアウト</button></p>
    </form>
  </div>`;
  $('#pw-logout').onclick = logout;
  $('#pw-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(ev.target));
    if (fd.next !== fd.confirm) { $('#pw-error').textContent = '確認用のパスワードが一致しません'; return; }
    try {
      await api('/api/me/password', { method: 'POST', body: fd });
      toast('パスワードを変更しました');
      await boot();
    } catch (e) { $('#pw-error').textContent = e.message; }
  };
}

async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  setToken(null);
  state.me = null;
  history.replaceState(null, '', location.pathname);
  renderLogin();
}

// ------------------------------------------------------------ 枠（メニュー）
const NAV_USER = [
  ['#/punch', '打刻'],
  ['#/attendance', '勤怠の記録'],
  ['#/leave', '休暇申請・有給'],
  ['#/holiday', '休日出勤申請'],
  ['#/ringi', '稟議（購入申請）'],
];
const NAV_ADMIN = [
  ['#/admin', '全体の状況'],
  ['#/admin/attendance', '勤怠の確認・修正'],
  ['#/admin/monthly', '月次集計'],
  ['#/admin/leave', '休暇・有給の管理', 'leave'],
  ['#/admin/holiday', '休日出勤の承認', 'holiday'],
  ['#/admin/ringi', '稟議の承認', 'ringi'],
  ['#/admin/users', '社員の管理'],
];

function renderShell() {
  const link = ([href, label, countKey]) => `<a href="${href}" data-href="${href}" data-count="${countKey || ''}">${label}</a>`;
  $('#app').className = '';
  $('#app').innerHTML = `
  <div class="layout">
    <aside class="side" id="side">
      <div class="brand"><img src="icon.svg" alt="">勤怠・有給・稟議</div>
      <button class="secondary small menu-toggle" id="menu-toggle" type="button">メニュー</button>
      <div class="nav-wrap">
        <nav class="nav">
          <div class="nav-label">自分のこと</div>
          ${NAV_USER.map(link).join('')}
          ${isAdmin() ? `<div class="nav-label">管理者メニュー</div>${NAV_ADMIN.map(link).join('')}` : ''}
        </nav>
      </div>
      <div class="side-foot">
        <div class="who">${esc(state.me.name)}</div>
        <div class="muted small">${isAdmin() ? '管理者' : '社員'}（${esc(state.me.login_id)}）</div>
        <div class="actions"><button class="ghost small" id="btn-pw" type="button">パスワード変更</button><button class="ghost small" id="btn-logout" type="button">ログアウト</button></div>
      </div>
    </aside>
    <main class="main" id="main"></main>
  </div>`;
  $('#btn-logout').onclick = logout;
  $('#btn-pw').onclick = changePasswordModal;
  $('#menu-toggle').onclick = () => $('#side').classList.toggle('open');
}

function markNav() {
  const hash = location.hash || '#/punch';
  document.querySelectorAll('.nav a').forEach((a) => {
    const h = a.dataset.href;
    a.classList.toggle('active', hash === h || (h !== '#/admin' && hash.startsWith(h + '/')));
  });
  const side = $('#side');
  if (side) side.classList.remove('open');
}

function drawCounts() {
  document.querySelectorAll('.nav a[data-count]').forEach((a) => {
    const key = a.dataset.count;
    a.querySelector('.count')?.remove();
    if (key && state.pending[key]) a.insertAdjacentHTML('beforeend', `<span class="count">${state.pending[key]}</span>`);
  });
}
async function refreshPending() {
  if (!isAdmin()) return;
  try { state.pending = (await api('/api/admin/dashboard')).pending; drawCounts(); } catch { /* 表示のみ */ }
}

function changePasswordModal() {
  openModal(`
    <h2>パスワード変更</h2>
    <label>現在のパスワード<input name="current" type="password" autocomplete="current-password" required></label>
    <label>新しいパスワード（8文字以上）<input name="next" type="password" minlength="8" autocomplete="new-password" required></label>
    <label>新しいパスワード（確認）<input name="confirm" type="password" minlength="8" autocomplete="new-password" required></label>
    ${modalButtons('変更する')}`, async (fd) => {
    if (fd.next !== fd.confirm) throw new Error('確認用のパスワードが一致しません');
    await api('/api/me/password', { method: 'POST', body: fd });
    toast('パスワードを変更しました');
  });
}

// ------------------------------------------------------------ 画面切り替え
const pages = [];
const page = (re, fn, admin = false) => pages.push({ re, fn, admin });

async function router() {
  if (!state.me) return;
  const hash = location.hash || '#/punch';
  const p = pages.find((x) => x.re.test(hash));
  const main = $('#main');
  if (!main) return;
  if (!p || (p.admin && !isAdmin())) { location.hash = '#/punch'; return; }
  markNav();
  clearInterval(router.timer);
  // 画面ごとに新しい描画先を用意する（前の画面の読み込みが遅れて届いても上書きされない）
  const view = document.createElement('div');
  main.replaceChildren(view);
  try {
    await p.fn(view, hash.match(p.re));
  } catch (e) {
    view.innerHTML = `<div class="notice">${esc(e.message)}</div>`;
  }
}

async function boot() {
  try {
    const d = await api('/api/me');
    Object.assign(state, { me: d.user, today: d.today, period: d.period, rules: d.rules });
  } catch { renderLogin(); return; }
  if (state.me.must_change_password) { renderForcePassword(); return; }
  if (!location.hash) location.hash = '#/punch';
  renderShell();
  await refreshPending();
  router();
}
window.addEventListener('hashchange', () => { router(); window.scrollTo(0, 0); });
document.addEventListener('DOMContentLoaded', boot);

function ruleText() {
  const r = state.rules;
  return `${r.closingDay ? `毎月${r.closingDay}日締め（${r.closingDay + 1}日から翌月${r.closingDay}日まで）で集計します。` : ''}実働が${hm(r.breakAfter)}を超えた日は休憩${r.breakMinutes}分を自動で差し引き、${hm(r.standard)}を超えた分を残業として数えます。`;
}

// ============================================================ 打刻
page(/^#\/punch$/, async (main) => {
  const draw = (d) => {
    const r = d.record;
    const segs = r?.segments || [];
    const working = r?.open || !!d.carry;
    const st = working ? ['勤務中', 'b-working'] : segs.length ? ['退勤済み', 'b-off'] : ['未出勤', 'b-off'];
    main.innerHTML = `
      <h1>打刻</h1>
      <div class="card clock">
        <div class="date">${fullDate(d.date)}（${dow(d.date)}）</div>
        <div class="time" id="clock-time">--:--:--</div>
        <span class="badge ${st[1]} state">${st[0]}</span>
        ${d.carry ? `<p class="small">前日（${dateLabel(d.carry.work_date)}）${esc(d.carry.segments.at(-1).in)}からの勤務が続いています。退勤を押すと前日の記録として保存します。</p>` : ''}
        <div class="punch-buttons">
          <button data-act="in" ${working || segs.length ? 'disabled' : ''}>出勤</button>
          <button data-act="out" class="amber" ${working ? '' : 'disabled'}>退勤</button>
          <button data-act="resume" class="resume" ${working || !segs.length || segs.length >= state.rules.maxSegments ? 'disabled' : ''}>再開<small>退勤後にもう一度働くとき</small></button>
        </div>
        <div class="punch-log">
          <div><span class="small muted">出勤</span><b>${esc(r?.clock_in || '—')}</b></div>
          <div><span class="small muted">退勤</span><b>${esc(r?.clock_out || '—')}</b></div>
          <div><span class="small muted">休憩</span><b>${r?.break_minutes ? r.break_minutes + '分' : '—'}</b></div>
          <div><span class="small muted">実働</span><b>${r && !r.open && r.work_minutes != null ? hm(r.work_minutes) : '—'}</b></div>
        </div>
        ${segs.length > 1 ? `<p class="small muted">本日の打刻：${segs.map((s) => `${esc(s.in)}〜${esc(s.out || '')}`).join('　/　')}</p>` : ''}
      </div>
      <div class="notice info small">
        帰宅後などに仕事を再開するときは「再開」を、終わったら「退勤」を押してください（1日${state.rules.maxSegments}回まで）。<br>
        ${ruleText()}<br>
        押し忘れ・押し間違いは「勤怠の記録」の備考欄に書いて、管理者へ修正を依頼してください。
      </div>`;
    main.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          const res = await api('/api/attendance/punch', { method: 'POST', body: { action: b.dataset.act } });
          toast({ in: '出勤しました。今日もよろしくお願いします', resume: '勤務を再開しました', out: '退勤しました。おつかれさまでした' }[b.dataset.act]);
          draw(res);
        } catch (e) { toast(e.message, true); b.disabled = false; }
      };
    });
    const tick = () => {
      const el = $('#clock-time');
      if (el) el.textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Tokyo' });
    };
    tick();
    clearInterval(router.timer);
    router.timer = setInterval(tick, 1000);
  };
  draw(await api('/api/attendance/today'));
});

// ============================================================ 勤怠の記録（本人・管理者共通）
function attendanceTable(data, { editable }) {
  const byDate = Object.fromEntries(data.records.map((r) => [r.work_date, r]));
  let rows = '';
  const end = new Date(data.to + 'T00:00:00');
  for (let cur = new Date(data.from + 'T00:00:00'); cur <= end; cur.setDate(cur.getDate() + 1)) {
    const date = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    const r = byDate[date];
    const wd = cur.getDay();
    const tags = [];
    for (const l of data.leaves) {
      if (l.start_date <= date && date <= l.end_date) {
        tags.push(`<span class="badge ${l.status === 'approved' ? 'b-leave' : 'b-pending'}">${l.kind === 'paid' ? '有給' : '休暇'}${l.leave_type !== 'full' ? '・' + LEAVE_TYPE[l.leave_type] : ''}${l.status === 'pending' ? '(申請中)' : ''}</span>`);
      }
    }
    for (const h of data.holiday_work) if (h.work_date === date) tags.push(`<span class="badge b-break">休日出勤${h.status === 'pending' ? '(申請中)' : ''}</span>`);
    const isPast = date < state.today;
    const segs = r?.segments || [];
    rows += `<tr class="clickable ${wd === 0 ? 'weekend' : wd === 6 ? 'sat' : ''}" data-date="${date}">
      <td class="nowrap">${dateLabel(date)}</td>
      <td class="num">${esc(segs[0]?.in || '')}</td>
      <td class="num">${r?.open ? `<span class="badge ${isPast ? 'b-rejected' : 'b-working'}">${isPast ? '退勤漏れ' : '勤務中'}</span>` : esc(r?.clock_out || '')}</td>
      <td class="small">${segs.length > 1 ? segs.slice(1).map((s) => `${esc(s.in)}〜${esc(s.out || '')}`).join('<br>') : ''}</td>
      <td class="num">${r && segs.length && !r.open ? `${r.break_minutes}分${r.break_auto ? '' : '<span class="muted small">(修正)</span>'}` : ''}</td>
      <td class="num">${r && segs.length && !r.open ? hm(r.work_minutes) : ''}</td>
      <td class="num">${r?.overtime_minutes ? hm(r.overtime_minutes) : ''}</td>
      <td>${tags.join(' ')} ${esc(r?.note || '')}${r?.edited_by ? ' <span class="small muted">（管理者修正）</span>' : ''}</td>
    </tr>`;
  }
  const s = data.summary;
  return `
    <div class="grid grid-4">
      <div class="stat"><div class="label">出勤日数</div><div class="value">${s.days}<small>日</small></div></div>
      <div class="stat"><div class="label">総労働時間</div><div class="value">${hm(s.work_minutes) || '0:00'}</div></div>
      <div class="stat ${s.overtime_minutes ? 'warn' : ''}"><div class="label">残業時間</div><div class="value">${hm(s.overtime_minutes) || '0:00'}</div></div>
      <div class="stat ${s.missing ? 'bad' : ''}"><div class="label">退勤の打刻漏れ</div><div class="value">${s.missing}<small>件</small></div></div>
    </div>
    <div class="card table-wrap">
      <p class="small muted">${editable ? '行をクリックすると、打刻時刻・休憩・備考を修正できます。' : '行をクリックすると、備考（打刻修正のお願いなど）を書き込めます。'}　${ruleText()}</p>
      <table>
        <thead><tr><th>日付</th><th class="right">出勤</th><th class="right">退勤</th><th>再開〜終了</th><th class="right">休憩</th><th class="right">実働</th><th class="right">残業</th><th>休暇・備考</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function bindAttendanceRows(main, data, { editable }) {
  const byDate = Object.fromEntries(data.records.map((r) => [r.work_date, r]));
  main.querySelectorAll('tr[data-date]').forEach((tr) => {
    tr.onclick = () => {
      const date = tr.dataset.date;
      const r = byDate[date] || { segments: [], note: '', break_auto: true };
      if (editable) {
        const segRows = Array.from({ length: state.rules.maxSegments }, (_, i) => `
          <div class="seg-row">
            <span class="small muted">${i === 0 ? '出勤 → 退勤' : `再開${i + 1} → 終了${i + 1}`}</span>
            <input name="in${i}" type="time" value="${esc(r.segments[i]?.in || '')}">
            <input name="out${i}" type="time" value="${esc(r.segments[i]?.out || '')}">
          </div>`).join('');
        openModal(`
          <h2>${esc(data.user.name)}さん　${fullDate(date)}（${dow(date)}）</h2>
          ${segRows}
          <label>休憩（分）<input name="break_override" type="number" min="0" step="1" value="${r.break_auto ? '' : r.break_minutes}" placeholder="空欄＝自動（${hm(state.rules.breakAfter)}超で${state.rules.breakMinutes}分）"></label>
          <label>備考<input name="note" maxlength="200" value="${esc(r.note || '')}"></label>
          <p class="small muted">日付をまたいだ退勤（例：22:00〜翌1:00）はそのまま入力すれば計算されます。すべて空欄にして保存すると、その日の記録を削除します。</p>
          ${modalButtons()}`, async (fd) => {
          const segments = Array.from({ length: state.rules.maxSegments }, (_, i) => ({ in: fd[`in${i}`], out: fd[`out${i}`] }));
          await api('/api/attendance', { method: 'PUT', body: { user_id: data.user.id, work_date: date, segments, break_override: fd.break_override, note: fd.note } });
          toast('勤怠を保存しました');
          router();
        });
      } else {
        openModal(`
          <h2>${fullDate(date)}（${dow(date)}）の備考</h2>
          <p class="small muted">打刻の押し忘れ・間違いは「18:30退勤、押し忘れ」のように書いてください。管理者が確認して修正します。</p>
          <label>備考<input name="note" maxlength="200" value="${esc(r.note || '')}"></label>
          ${modalButtons()}`, async (fd) => {
          await api('/api/attendance/note', { method: 'POST', body: { work_date: date, note: fd.note } });
          toast('備考を保存しました');
          router();
        });
      }
    };
  });
}

page(/^#\/attendance(?:\/(\d{4}-\d{2}))?$/, async (main, m) => {
  const month = m[1] || state.period;
  const data = await api(`/api/attendance?month=${month}`);
  main.innerHTML = `
    <h1>勤怠の記録</h1>
    <div class="toolbar">${monthNav('#/attendance', month, data.from, data.to)}</div>
    ${attendanceTable(data, { editable: false })}`;
  bindAttendanceRows(main, data, { editable: false });
});

// ============================================================ 休暇申請・有給（本人）
function obligationNotice(ob) {
  if (!ob) return '';
  const short = Math.max(0, ob.required - ob.taken);
  if (!short) return `<div class="notice info">年5日の有給取得義務（${fullDate(ob.from)}〜${fullDate(ob.to)}）：取得済み ${days(ob.taken)}。達成しています。</div>`;
  return `<div class="notice">年5日の有給取得義務（${fullDate(ob.from)}〜${fullDate(ob.to)}）：取得済み ${days(ob.taken)}。あと <b>${days(short)}</b> 取得が必要です。</div>`;
}

page(/^#\/leave$/, async (main) => {
  const d = await api('/api/leave/summary');
  const validGrants = d.grants.filter((g) => g.grant_date <= state.today && state.today <= g.expires_on);
  main.innerHTML = `
    <h1>休暇申請・有給</h1>
    <div class="grid grid-3">
      <div class="stat"><div class="label">有給の残り日数</div><div class="value">${d.remaining}<small>日</small></div></div>
      <div class="stat warn"><div class="label">有給の申請中（承認待ち）</div><div class="value">${d.pending}<small>日</small></div></div>
      <div class="stat"><div class="label">これから申請できる有給</div><div class="value">${Math.max(0, d.remaining - d.pending)}<small>日</small></div></div>
    </div>
    ${obligationNotice(d.obligation)}
    <div class="grid grid-2">
      <form class="card" id="leave-form">
        <h2>休暇を申請する</h2>
        <label>休暇種別<select name="kind">${Object.entries(d.kinds).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
        <label>休暇期間
          <select name="leave_type">
            <option value="full">全日</option>
            <option value="am">午前半休（0.5日）</option>
            <option value="pm">午後半休（0.5日）</option>
          </select>
        </label>
        <div class="form-row">
          <label>休暇取得予定日<input name="start_date" type="date" required value="${state.today}"></label>
          <label data-end>最終日（連休のとき）<input name="end_date" type="date"></label>
        </div>
        <label>理由（任意）<input name="reason" maxlength="200" placeholder="例：私用のため"></label>
        <label>業務引継ぎの有無<select name="handover"><option value="0">なし</option><option value="1">あり</option></select></label>
        <label data-handover class="hidden">業務引継ぎ申し送り事項<textarea name="handover_note" maxlength="1000" placeholder="例：〇〇様の見積もりは△△さんへ依頼済み"></textarea></label>
        <p class="error" id="leave-error"></p>
        <button>申請する</button>
      </form>
      <div class="card">
        <h2>有給の付与（有効なもの）</h2>
        ${validGrants.length ? `<table><thead><tr><th>付与日</th><th>有効期限</th><th class="right">付与</th><th class="right">残り</th></tr></thead><tbody>
          ${validGrants.map((g) => `<tr><td>${fullDate(g.grant_date)}</td><td>${fullDate(g.expires_on)}</td><td class="num">${days(g.days)}</td><td class="num">${days(g.remaining)}</td></tr>`).join('')}
        </tbody></table>` : '<p class="empty">まだ有給が付与されていません。<br>管理者にご確認ください。</p>'}
        <p class="small muted">有効期限は付与日から2年です。古い付与分から先に使われます。有給以外の休暇（振替休日など）は残日数に影響しません。</p>
      </div>
    </div>
    <div class="card table-wrap">
      <h2>申請の履歴</h2>
      ${leaveRequestTable(d.requests, d.kinds, { own: true })}
    </div>`;
  const form = $('#leave-form');
  const sync = () => {
    form.querySelector('[data-end]').classList.toggle('hidden', form.leave_type.value !== 'full');
    form.querySelector('[data-handover]').classList.toggle('hidden', form.handover.value !== '1');
  };
  form.leave_type.onchange = sync;
  form.handover.onchange = sync;
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/leave/requests', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      toast('休暇を申請しました');
      router();
    } catch (e) { $('#leave-error').textContent = e.message; }
  };
  bindDecisionButtons(main);
});

function leaveRequestTable(list, kinds, { own = false, admin = false } = {}) {
  if (!list.length) return '<p class="empty">申請はまだありません。</p>';
  return `<table><thead><tr>${admin ? '<th>社員</th>' : ''}<th>休暇取得予定日</th><th>種別</th><th>理由・引継ぎ</th><th>状態</th><th>コメント</th><th></th></tr></thead><tbody>
    ${list.map((l) => `<tr>
      ${admin ? `<td class="nowrap">${esc(l.user_name)}</td>` : ''}
      <td class="nowrap">${periodLabel(l)}<div class="small muted">${LEAVE_TYPE[l.leave_type]}・${days(l.days)}</div></td>
      <td class="nowrap">${esc(kinds[l.kind] || l.kind)}</td>
      <td class="small">${esc(l.reason)}${l.handover ? `<div><span class="badge b-cancelled">引継ぎあり</span> <span class="pre">${esc(l.handover_note)}</span></div>` : ''}</td>
      <td>${badge(l.status)}</td>
      <td class="small">${esc(l.decision_comment)}${l.approver_name ? `<div class="muted">${esc(l.approver_name)}　${esc(l.decided_at || '')}</div>` : ''}</td>
      <td class="nowrap">${decisionButtons('leave/requests', l, { own, admin })}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

// 承認・差戻し・取り下げボタン（休暇・休日出勤で共通）
function decisionButtons(apiBase, r, { own, admin }) {
  return `<div class="actions">
    ${r.status === 'pending' && admin ? `<button class="small" data-decide="${apiBase}/${r.id}" data-decision="approved">承認</button><button class="small danger" data-decide="${apiBase}/${r.id}" data-decision="rejected">差戻し</button>` : ''}
    ${r.status === 'pending' && own ? `<button class="small secondary" data-cancel="${apiBase}/${r.id}">取り下げ</button>` : ''}
    ${(r.status === 'approved' || r.status === 'rejected') && admin ? `<button class="small ghost" data-decide="${apiBase}/${r.id}" data-decision="pending">判断を取り消す</button>` : ''}
  </div>`;
}
function bindDecisionButtons(root) {
  root.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('この申請を取り下げますか？')) return;
      try { await api(`/api/${b.dataset.cancel}/cancel`, { method: 'POST' }); toast('申請を取り下げました'); router(); } catch (e) { toast(e.message, true); }
    };
  });
  root.querySelectorAll('[data-decide]').forEach((b) => {
    b.onclick = () => {
      const decision = b.dataset.decision;
      const title = { approved: '申請を承認', rejected: '申請を差戻し', pending: '判断を取り消して「承認待ち」に戻す' }[decision];
      openModal(`<h2>${title}</h2>
        ${decision !== 'pending' ? `<label>コメント（任意）<input name="comment" maxlength="200"></label>` : '<p>承認済みの有給を取り消すと、残日数が元に戻ります。</p>'}
        ${modalButtons(decision === 'approved' ? '承認する' : decision === 'rejected' ? '差戻す' : '取り消す')}`, async (fd) => {
        await api(`/api/${b.dataset.decide}/decide`, { method: 'POST', body: { decision, comment: fd.comment || '' } });
        toast('処理しました');
        await refreshPending();
        router();
      });
    };
  });
}

// ============================================================ 休日出勤申請
function holidayTable(list, { own = false, admin = false } = {}) {
  if (!list.length) return '<p class="empty">申請はまだありません。</p>';
  return `<table><thead><tr>${admin ? '<th>社員</th>' : ''}<th>休日出勤予定日</th><th>予定時間</th><th>理由</th><th>振替休日</th><th>状態</th><th>コメント</th><th></th></tr></thead><tbody>
    ${list.map((h) => `<tr>
      ${admin ? `<td class="nowrap">${esc(h.user_name)}</td>` : ''}
      <td class="nowrap">${fullDate(h.work_date)}（${dow(h.work_date)}）</td>
      <td class="nowrap">${esc(h.start_time)}〜${esc(h.end_time)}</td>
      <td class="small">${esc(h.reason)}</td>
      <td class="nowrap">${h.substitute_date ? `${fullDate(h.substitute_date)}（${dow(h.substitute_date)}）` : '<span class="muted small">未定</span>'}</td>
      <td>${badge(h.status)}</td>
      <td class="small">${esc(h.decision_comment)}${h.approver_name ? `<div class="muted">${esc(h.approver_name)}　${esc(h.decided_at || '')}</div>` : ''}</td>
      <td class="nowrap">${decisionButtons('holiday-work', h, { own, admin })}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

page(/^#\/holiday$/, async (main) => {
  const d = await api('/api/holiday-work?mine=1');
  main.innerHTML = `
    <h1>休日出勤申請</h1>
    <div class="grid grid-2">
      <form class="card" id="hw-form">
        <h2>休日出勤を申請する</h2>
        <label>休日出勤予定日<input name="work_date" type="date" required></label>
        <div class="form-row">
          <label>開始予定時間<input name="start_time" type="time" required value="09:30"></label>
          <label>終了予定時間<input name="end_time" type="time" required value="18:30"></label>
        </div>
        <label>休日出勤の理由<textarea name="reason" maxlength="500" required placeholder="例：〇〇様キッチンの見積もりが急ぎのため"></textarea></label>
        <label>振替休日取得予定日（決まっていれば）<input name="substitute_date" type="date"></label>
        <p class="error" id="hw-error"></p>
        <button>申請する</button>
      </form>
      <div class="notice info small">
        振替休日を取るときは、「休暇申請・有給」から種別「振替休日」で申請してください（有給の残日数は減りません）。
      </div>
    </div>
    <div class="card table-wrap"><h2>申請の履歴</h2>${holidayTable(d.requests, { own: true })}</div>`;
  $('#hw-form').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/holiday-work', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) });
      toast('休日出勤を申請しました');
      router();
    } catch (e) { $('#hw-error').textContent = e.message; }
  };
  bindDecisionButtons(main);
});

// ============================================================ 稟議（購入・経費の申請）
page(/^#\/ringi$/, async (main) => {
  const d = await api('/api/ringi?mine=1');
  main.innerHTML = `
    <h1>稟議（購入申請）</h1>
    <div class="actions"><button id="new-ringi">＋ 新しく申請する</button></div><br>
    <div class="card table-wrap">${ringiTable(d.ringi, false)}</div>`;
  $('#new-ringi').onclick = () => newRingiModal(d);
  bindRingiRows(main);
});

function ringiTable(list, showUser) {
  if (!list.length) return '<p class="empty">申請はまだありません。</p>';
  return `<table><thead><tr><th>No.</th><th>申請日</th>${showUser ? '<th>申請者</th>' : ''}<th>購入品名</th><th>経費種別</th><th class="right">見積金額</th><th>支出日</th><th>状態</th></tr></thead><tbody>
    ${list.map((r) => `<tr class="clickable" data-ringi="${r.id}">
      <td class="num">${r.id}</td>
      <td class="nowrap">${esc(r.created_at.slice(0, 10))}</td>
      ${showUser ? `<td class="nowrap">${esc(r.user_name)}</td>` : ''}
      <td>${esc(r.title)}${r.quantity ? `<span class="muted small">　× ${esc(r.quantity)}</span>` : ''}${r.has_attachment ? ' <span class="badge b-cancelled">添付</span>' : ''}</td>
      <td class="nowrap small">${esc(r.category)}</td>
      <td class="num">${yen(r.amount)}${r.certainty === '概算' ? '<div class="small muted">概算</div>' : ''}</td>
      <td class="nowrap">${r.expense_date ? dateLabel(r.expense_date) : ''}</td>
      <td>${badge(r.status)}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function bindRingiRows(main) {
  main.querySelectorAll('tr[data-ringi]').forEach((tr) => { tr.onclick = () => { location.hash = `#/ringi/${tr.dataset.ringi}`; }; });
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(new Error('ファイルを読み込めませんでした'));
    fr.readAsDataURL(file);
  });
}

function newRingiModal(meta, prefill = {}) {
  const form = openModal(`
    <h2>稟議（購入申請）</h2>
    ${prefill.title ? '<p class="notice small">差戻しになった申請の内容をコピーしています。修正して申請してください。</p>' : ''}
    <label>購入品名<input name="title" maxlength="100" required value="${esc(prefill.title || '')}" placeholder="例：35mmダイヤモンドホールソー"></label>
    <div class="form-row">
      <label>購入数量<input name="quantity" maxlength="50" value="${esc(prefill.quantity || '')}" placeholder="例：1、4点、1箱(100個入り)"></label>
      <label>経費種別<select name="category" required>${meta.categories.map((c) => `<option ${c === prefill.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    </div>
    <label>支出理由・目的<textarea name="content" maxlength="4000" required placeholder="例：〇〇様の洗面台のタイル穴あけのため">${esc(prefill.content || '')}</textarea></label>
    <div class="form-row">
      <label>見積金額（税込・数字のみ）<input name="amount" inputmode="numeric" value="${prefill.amount ?? ''}" placeholder="例：1760"></label>
      <label>金額の確度<select name="certainty">${meta.certainty.map((c) => `<option ${c === prefill.certainty ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    </div>
    <label>支出日（予定）<input name="expense_date" type="date" value="${esc(prefill.expense_date || state.today)}"></label>
    <label>見積書または関連資料（任意・5MBまで：PDF／画像／Excel／Word）<input name="file" type="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.webp,.xlsx,.xls,.docx"></label>
    ${modalButtons('申請する')}`, async (fd, f) => {
    const file = f.file.files[0];
    const body = { ...fd };
    delete body.file;
    if (file) {
      if (file.size > 5 * 1024 * 1024) throw new Error('添付ファイルは5MBまでです');
      body.attachment = { name: file.name, type: file.type, data: await readFileBase64(file) };
    }
    const res = await api('/api/ringi', { method: 'POST', body });
    toast('稟議を申請しました');
    location.hash = `#/ringi/${res.id}`;
  }, { wide: true });
  return form;
}

page(/^#\/ringi\/(\d+)$/, async (main, m) => {
  const d = await api(`/api/ringi/${m[1]}`);
  const r = d.ringi;
  const canDecide = isAdmin() && r.status === 'pending';
  const canCancel = r.user_id === state.me.id && r.status === 'pending';
  const canCopy = r.user_id === state.me.id && (r.status === 'rejected' || r.status === 'cancelled');
  main.innerHTML = `
    <p><a href="${isAdmin() && r.user_id !== state.me.id ? '#/admin/ringi' : '#/ringi'}">← 一覧へ戻る</a></p>
    <h1>稟議 No.${r.id}　${esc(r.title)}</h1>
    <div class="card">
      <dl class="detail">
        <dt>状態</dt><dd>${badge(r.status)}</dd>
        <dt>申請者</dt><dd>${esc(r.user_name)}</dd>
        <dt>申請日</dt><dd>${esc(r.created_at.slice(0, 10))}</dd>
        <dt>購入品名</dt><dd>${esc(r.title)}</dd>
        <dt>購入数量</dt><dd>${esc(r.quantity) || '—'}</dd>
        <dt>経費種別</dt><dd>${esc(r.category)}</dd>
        <dt>支出理由・目的</dt><dd class="pre">${esc(r.content)}</dd>
        <dt>見積金額（税込）</dt><dd>${yen(r.amount)}（${esc(r.certainty)}）</dd>
        <dt>支出日</dt><dd>${r.expense_date ? `${fullDate(r.expense_date)}（${dow(r.expense_date)}）` : '—'}</dd>
        <dt>見積書・資料</dt><dd>${r.has_attachment ? `<button type="button" class="small secondary" id="r-attach">${esc(r.attachment_name)} を開く</button>` : r.attachment_url ? `<a href="${esc(r.attachment_url)}" target="_blank" rel="noopener noreferrer">旧シートの添付を開く</a>` : 'なし'}</dd>
      </dl>
    </div>
    ${r.status === 'approved' || r.status === 'rejected' ? `<div class="card"><h2>決裁結果</h2><dl class="detail">
      <dt>結果</dt><dd>${badge(r.status)}</dd><dt>決裁者</dt><dd>${esc(r.approver_name || '')}</dd><dt>日時</dt><dd>${esc(r.decided_at || '')}</dd>
      <dt>コメント</dt><dd class="pre">${esc(r.decision_comment) || '—'}</dd></dl></div>` : ''}
    <div class="actions">
      ${canDecide ? '<button id="r-approve">承認する</button><button id="r-reject" class="danger">差戻す</button>' : ''}
      ${canCancel ? '<button id="r-cancel" class="secondary">取り下げる</button>' : ''}
      ${canCopy ? '<button id="r-copy">内容をコピーして再申請</button>' : ''}
      ${isAdmin() && (r.status === 'approved' || r.status === 'rejected') ? '<button id="r-undo" class="ghost">判断を取り消す</button>' : ''}
      <button class="ghost" id="r-print" type="button">印刷する</button>
    </div>`;
  $('#r-print').onclick = () => window.print();
  if ($('#r-attach')) $('#r-attach').onclick = async () => {
    try {
      const f = await api(`/api/ringi/${r.id}/attachment`);
      const bytes = Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0));
      saveFile(f.name, new Blob([bytes], { type: f.type }));
    } catch (e) { toast(e.message, true); }
  };
  if (canCopy) $('#r-copy').onclick = () => newRingiModal(d, r);
  if (canCancel) $('#r-cancel').onclick = async () => {
    if (!confirm('この申請を取り下げますか？')) return;
    try { await api(`/api/ringi/${r.id}/cancel`, { method: 'POST' }); toast('取り下げました'); router(); } catch (e) { toast(e.message, true); }
  };
  const decide = (decision) => openModal(`
    <h2>${{ approved: '稟議を承認', rejected: '稟議を差戻し', pending: '判断を取り消して「承認待ち」に戻す' }[decision]}</h2>
    ${decision === 'pending' ? '' : `<label>コメント${decision === 'rejected' ? '（差戻しの理由・必須）' : '（任意）'}<textarea name="comment" maxlength="500" ${decision === 'rejected' ? 'required' : ''}></textarea></label>`}
    ${modalButtons({ approved: '承認する', rejected: '差戻す', pending: '取り消す' }[decision])}`, async (fd) => {
    await api(`/api/ringi/${r.id}/decide`, { method: 'POST', body: { decision, comment: fd.comment || '' } });
    toast('処理しました');
    await refreshPending();
    router();
  });
  if (canDecide) {
    $('#r-approve').onclick = () => decide('approved');
    $('#r-reject').onclick = () => decide('rejected');
  }
  if ($('#r-undo')) $('#r-undo').onclick = () => decide('pending');
});

// ============================================================ 管理者：全体の状況
page(/^#\/admin$/, async (main) => {
  const d = await api('/api/admin/dashboard');
  state.pending = d.pending;
  drawCounts();
  const cls = { 勤務中: 'b-working', 退勤済み: 'b-off', 未出勤: 'b-off', 休暇: 'b-leave', 半休: 'b-leave' };
  main.innerHTML = `
    <h1>全体の状況　<span class="muted small">${fullDate(d.date)}（${dow(d.date)}）</span></h1>
    <div class="grid grid-4">
      <div class="stat"><div class="label">いま勤務中</div><div class="value">${d.today.filter((t) => t.status === '勤務中').length}<small>/ ${d.today.length}人</small></div></div>
      <a class="stat ${d.pending.leave ? 'warn' : ''}" href="#/admin/leave"><div class="label">休暇の承認待ち</div><div class="value">${d.pending.leave}<small>件</small></div></a>
      <a class="stat ${d.pending.holiday ? 'warn' : ''}" href="#/admin/holiday"><div class="label">休日出勤の承認待ち</div><div class="value">${d.pending.holiday}<small>件</small></div></a>
      <a class="stat ${d.pending.ringi ? 'warn' : ''}" href="#/admin/ringi"><div class="label">稟議の承認待ち</div><div class="value">${d.pending.ringi}<small>件</small></div></a>
    </div>
    ${d.missing.length ? `<div class="card table-wrap"><h2>退勤の打刻漏れ（${d.missing.length}件）</h2>
      <p class="small muted">クリックすると、その日の勤怠を修正できる画面に移ります。</p>
      <table><thead><tr><th>日付</th><th>社員</th><th>最後の出勤（再開）</th><th>備考</th></tr></thead><tbody>
      ${d.missing.map((r) => `<tr class="clickable" data-goto="#/admin/attendance/${r.user_id}/${periodOf(r.work_date)}"><td class="nowrap">${dateLabel(r.work_date)}</td><td>${esc(r.name)}</td><td>${esc(r.segments.at(-1).in)}</td><td>${esc(r.note)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div class="card table-wrap">
      <h2>本日の出勤状況</h2>
      <table><thead><tr><th>社員</th><th>状態</th><th class="right">出勤</th><th class="right">退勤</th><th class="right">実働</th></tr></thead><tbody>
      ${d.today.map((t) => `<tr class="clickable" data-goto="#/admin/attendance/${t.user.id}/${state.period}">
        <td>${esc(t.user.name)}</td><td><span class="badge ${cls[t.status]}">${t.status}</span></td>
        <td class="num">${esc(t.record?.clock_in || '')}</td><td class="num">${esc(t.record?.clock_out || '')}</td>
        <td class="num">${t.record && !t.record.open ? hm(t.record.work_minutes) : ''}</td>
      </tr>`).join('')}
      </tbody></table>
    </div>`;
  main.querySelectorAll('[data-goto]').forEach((tr) => { tr.onclick = () => { location.hash = tr.dataset.goto; }; });
}, true);

// ============================================================ 管理者：勤怠の確認・修正
async function activeUsers() {
  return (await api('/api/users')).users.filter((u) => u.active);
}

page(/^#\/admin\/attendance(?:\/(\d+))?(?:\/(\d{4}-\d{2}))?$/, async (main, m) => {
  const users = await activeUsers();
  const uid = Number(m[1]) || users[0]?.id;
  const month = m[2] || state.period;
  const data = await api(`/api/attendance?user_id=${uid}&month=${month}`);
  main.innerHTML = `
    <h1>勤怠の確認・修正</h1>
    <div class="toolbar">
      <label>社員<select id="att-user">${users.map((u) => `<option value="${u.id}" ${u.id === uid ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      ${monthNav(`#/admin/attendance/${uid}`, month, data.from, data.to)}
    </div>
    ${attendanceTable(data, { editable: true })}`;
  $('#att-user').onchange = (ev) => { location.hash = `#/admin/attendance/${ev.target.value}/${month}`; };
  bindAttendanceRows(main, data, { editable: true });
}, true);

// ============================================================ 管理者：月次集計
page(/^#\/admin\/monthly(?:\/(\d{4}-\d{2}))?$/, async (main, m) => {
  const month = m[1] || state.period;
  const d = await api(`/api/admin/monthly?month=${month}`);
  const total = d.rows.reduce((a, r) => ({ w: a.w + r.work_minutes, o: a.o + r.overtime_minutes }), { w: 0, o: 0 });
  main.innerHTML = `
    <h1>月次集計</h1>
    <div class="toolbar">
      ${monthNav('#/admin/monthly', month, d.from, d.to)}
      <button class="small" id="csv-summary" type="button">集計をCSVで出力</button>
      <button class="small secondary" id="csv-detail" type="button">日別の明細をCSVで出力</button>
    </div>
    <div class="card table-wrap">
      <table><thead><tr><th>社員名</th><th class="right">出勤日数</th><th class="right">総労働時間</th><th class="right">残業時間</th><th class="right">打刻漏れ</th><th class="right">休日出勤</th><th></th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr>
        <td>${esc(r.user.name)}</td><td class="num">${r.days}日</td><td class="num">${hm(r.work_minutes)}</td>
        <td class="num">${r.overtime_minutes ? `<b>${hm(r.overtime_minutes)}</b>` : '0:00'}</td>
        <td class="num">${r.missing ? `<span class="badge b-rejected">${r.missing}件</span>` : ''}</td>
        <td class="num">${r.holiday_work ? r.holiday_work + '日' : ''}</td>
        <td><a class="btn small secondary" href="#/admin/attendance/${r.user.id}/${month}">明細</a></td>
      </tr>`).join('')}
      <tr><th>合計</th><th></th><th class="right">${hm(total.w)}</th><th class="right">${hm(total.o)}</th><th></th><th></th><th></th></tr>
      </tbody></table>
      <p class="small muted">${ruleText()} 退勤の打刻漏れがある日は、労働時間に含まれていません。</p>
    </div>`;
  $('#csv-summary').onclick = () => downloadCsv(`/api/admin/monthly/export?month=${month}`);
  $('#csv-detail').onclick = () => downloadCsv(`/api/attendance/export?month=${month}`);
}, true);

// ============================================================ 管理者：休暇・有給の管理
page(/^#\/admin\/leave(?:\/(\d+))?$/, async (main, m) => {
  const selected = Number(m[1]) || null;
  const [ov, pend, all] = await Promise.all([
    api('/api/admin/leave-overview'),
    api('/api/leave/requests?status=pending'),
    selected ? null : api('/api/leave/requests'),
  ]);
  const kinds = pend.kinds;
  main.innerHTML = `
    <h1>休暇・有給の管理</h1>
    <div class="tabs"><a href="#/admin/leave" class="${selected ? '' : 'active'}">一覧・承認</a>${selected ? '<a class="active">有給の付与</a>' : ''}</div>
    <div id="leave-body"></div>`;
  const body = $('#leave-body');
  if (!selected) {
    body.innerHTML = `
      <div class="card table-wrap">
        <h2>承認待ちの休暇申請（${pend.requests.length}件）</h2>
        ${leaveRequestTable(pend.requests, kinds, { admin: true })}
      </div>
      <div class="card table-wrap">
        <h2>社員ごとの有給残日数</h2>
        <table><thead><tr><th>社員</th><th>入社日</th><th class="right">残り</th><th class="right">申請中</th><th>年5日の取得義務</th><th></th></tr></thead><tbody>
        ${ov.users.map((u) => {
          const ob = u.obligation;
          const obText = !ob ? '<span class="muted small">対象外</span>' : ob.taken >= 5 ? `<span class="badge b-approved">達成（${days(ob.taken)}）</span>` : `<span class="badge b-pending">あと${days(5 - ob.taken)}</span> <span class="small muted">〜${fullDate(ob.to)}</span>`;
          return `<tr><td>${esc(u.user.name)}</td><td class="nowrap">${u.user.hire_date ? fullDate(u.user.hire_date) : '<span class="muted small">未登録</span>'}</td>
            <td class="num">${days(u.remaining)}</td><td class="num">${u.pending ? days(u.pending) : ''}</td><td>${obText}</td>
            <td><a class="btn small secondary" href="#/admin/leave/${u.user.id}">付与・履歴</a></td></tr>`;
        }).join('')}
        </tbody></table>
      </div>
      <div class="card table-wrap">
        <h2>最近の休暇申請（全員）</h2>
        ${leaveRequestTable(all.requests.slice(0, 50), kinds, { admin: true })}
      </div>`;
    bindDecisionButtons(body);
    return;
  }
  const d = await api(`/api/leave/summary?user_id=${selected}`);
  const info = ov.users.find((u) => u.user.id === selected);
  body.innerHTML = `
    <h2>${esc(d.user.name)}さん</h2>
    <div class="grid grid-3">
      <div class="stat"><div class="label">有給の残り日数</div><div class="value">${d.remaining}<small>日</small></div></div>
      <div class="stat warn"><div class="label">申請中</div><div class="value">${d.pending}<small>日</small></div></div>
      <div class="stat"><div class="label">法律上の付与日数の目安（今日時点）</div><div class="value">${info?.statutory_now ?? '—'}<small>${info?.statutory_now != null ? '日' : '入社日が未登録'}</small></div></div>
    </div>
    ${obligationNotice(d.obligation)}
    <div class="grid grid-2">
      <form class="card" id="grant-form">
        <h2>有給を付与する</h2>
        <label>付与日<input name="grant_date" type="date" required value="${state.today}"></label>
        <label>日数<input name="days" type="number" min="0.5" max="40" step="0.5" required value="${info?.statutory_now || 10}"></label>
        <label>メモ（任意）<input name="note" maxlength="100" placeholder="例：入社6か月の付与／これまでの残日数の繰越"></label>
        <p class="small muted">有効期限は付与日から2年で自動設定されます。フルタイム社員の法定日数：入社半年10日 → 1年半11日 → 2年半12日 → 3年半14日 → 4年半16日 → 5年半18日 → 6年半以降20日。<br>
        このアプリを使い始めるときは、今の残日数を「付与」として登録してください（付与日は元の付与日）。</p>
        <p class="error" id="grant-error"></p>
        <button>付与する</button>
      </form>
      <div class="card table-wrap">
        <h2>付与の履歴</h2>
        ${d.grants.length ? `<table><thead><tr><th>付与日</th><th>期限</th><th class="right">付与</th><th class="right">残り</th><th></th></tr></thead><tbody>
        ${[...d.grants].reverse().map((g) => `<tr><td class="nowrap">${fullDate(g.grant_date)}${g.note ? `<div class="small muted">${esc(g.note)}</div>` : ''}</td>
          <td class="nowrap">${fullDate(g.expires_on)}${g.expires_on < state.today ? ' <span class="badge b-cancelled">期限切れ</span>' : ''}</td>
          <td class="num">${days(g.days)}</td><td class="num">${days(g.remaining)}</td>
          <td><button class="small ghost" data-del-grant="${g.id}">削除</button></td></tr>`).join('')}
        </tbody></table>` : '<p class="empty">付与の履歴はありません。</p>'}
      </div>
    </div>
    <div class="card table-wrap"><h2>休暇申請の履歴</h2>${leaveRequestTable(d.requests, kinds, { admin: true })}</div>`;
  $('#grant-form').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/leave/grants', { method: 'POST', body: { ...Object.fromEntries(new FormData(ev.target)), user_id: selected } });
      toast('有給を付与しました');
      router();
    } catch (e) { $('#grant-error').textContent = e.message; }
  };
  body.querySelectorAll('[data-del-grant]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('この付与を削除しますか？（入力ミスの取り消し用）')) return;
      try { await api(`/api/leave/grants/${b.dataset.delGrant}`, { method: 'DELETE' }); toast('削除しました'); router(); } catch (e) { toast(e.message, true); }
    };
  });
  bindDecisionButtons(body);
}, true);

// ============================================================ 管理者：休日出勤の承認
page(/^#\/admin\/holiday(?:\/(pending|all))?$/, async (main, m) => {
  const tab = m[1] || 'pending';
  const d = await api(`/api/holiday-work${tab === 'pending' ? '?status=pending' : ''}`);
  main.innerHTML = `
    <h1>休日出勤の承認</h1>
    <div class="tabs">
      <a href="#/admin/holiday/pending" class="${tab === 'pending' ? 'active' : ''}">承認待ち</a>
      <a href="#/admin/holiday/all" class="${tab === 'all' ? 'active' : ''}">すべて</a>
    </div>
    <div class="card table-wrap">${holidayTable(d.requests, { admin: true, own: false })}</div>`;
  bindDecisionButtons(main);
}, true);

// ============================================================ 管理者：稟議の承認
page(/^#\/admin\/ringi(?:\/(pending|all))?$/, async (main, m) => {
  const tab = m[1] || 'pending';
  const d = await api(`/api/ringi${tab === 'pending' ? '?status=pending' : ''}`);
  const approvedTotal = d.ringi.filter((r) => r.status === 'approved').reduce((s, r) => s + (r.amount || 0), 0);
  main.innerHTML = `
    <h1>稟議の承認</h1>
    <div class="tabs">
      <a href="#/admin/ringi/pending" class="${tab === 'pending' ? 'active' : ''}">承認待ち</a>
      <a href="#/admin/ringi/all" class="${tab === 'all' ? 'active' : ''}">すべて</a>
    </div>
    ${tab === 'all' ? `<p class="small muted">表示中の承認済み金額の合計：${yen(approvedTotal)}</p>` : ''}
    <div class="card table-wrap">${ringiTable(d.ringi, true)}</div>`;
  bindRingiRows(main);
}, true);

// ============================================================ 管理者：社員の管理
page(/^#\/admin\/users$/, async (main) => {
  const { users } = await api('/api/users');
  main.innerHTML = `
    <h1>社員の管理</h1>
    <div class="actions"><button id="add-user">＋ 社員を追加する</button><span class="muted small">利用中 ${users.filter((u) => u.active).length}人</span></div><br>
    <div class="card table-wrap">
      <table><thead><tr><th>氏名</th><th>ログインID</th><th>権限</th><th>入社日</th><th>状態</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr>
        <td>${esc(u.name)}</td><td>${esc(u.login_id)}</td>
        <td>${u.role === 'admin' ? '<span class="badge b-break">管理者</span>' : '<span class="badge b-approved">社員</span>'}</td>
        <td class="nowrap">${u.hire_date ? fullDate(u.hire_date) : '<span class="muted small">未登録</span>'}</td>
        <td>${u.active ? '利用中' : '<span class="badge b-cancelled">利用停止</span>'}${u.must_change_password ? '<div class="small muted">初回パスワード未変更</div>' : ''}</td>
        <td class="nowrap"><div class="actions"><button class="small secondary" data-edit="${u.id}">編集</button><button class="small ghost" data-reset="${u.id}">パスワード再発行</button></div></td>
      </tr>`).join('')}
      </tbody></table>
    </div>
    <div class="card">
      <h2>今までのスプレッドシートから取り込む</h2>
      <p class="small muted">今お使いのスプレッドシートのURLを貼り付けると、社員（氏名・メールアドレス）、打刻、購入申請、休暇申請、休日出勤申請を取り込みます。
      何度実行しても、取り込み済みの記録は重複しません。新しく追加された社員には、ここに一度だけ初期パスワードを表示します。</p>
      <form id="import-form" class="toolbar">
        <label class="grow">スプレッドシートのURL<input name="url" required placeholder="https://docs.google.com/spreadsheets/d/..."></label>
        <button id="import-btn">取り込む</button>
      </form>
      <div id="import-result"></div>
    </div>
    <div class="notice info small">
      「管理者」は全員の勤怠の修正、有給の付与、休暇・休日出勤・稟議の承認、社員の追加ができます。「社員」は自分の打刻と申請だけを行えます。<br>
      退職した方は削除せず「利用停止」にすると、過去の記録を残したままログインできなくなります。
    </div>`;
  const userForm = (u = {}) => `
    <label>氏名<input name="name" maxlength="50" required value="${esc(u.name || '')}"></label>
    <label>ログインID（メールアドレス推奨）<input name="login_id" maxlength="100" pattern="[A-Za-z0-9._@+\\-]+" required value="${esc(u.login_id || '')}" placeholder="例：taro@example.com"></label>
    <div class="form-row">
      <label>権限<select name="role"><option value="employee" ${u.role !== 'admin' ? 'selected' : ''}>社員</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理者</option></select></label>
      <label>入社日（有給の目安計算に使用）<input name="hire_date" type="date" value="${esc(u.hire_date || '')}"></label>
    </div>
    ${u.id ? `<label>状態<select name="active"><option value="1" ${u.active ? 'selected' : ''}>利用中</option><option value="0" ${u.active ? '' : 'selected'}>利用停止</option></select></label>`
      : '<label>初期パスワード（8文字以上・本人に伝えてください）<input name="password" minlength="8" required></label><p class="small muted">初回ログイン時に、本人がパスワードを変更します。</p>'}`;
  $('#import-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('#import-btn');
    btn.disabled = true; btn.textContent = '取り込み中…（1分ほどかかります）';
    try {
      const r = await api('/api/admin/import', { method: 'POST', body: { url: ev.target.url.value } });
      $('#import-result').innerHTML = `
        <div class="notice info">取り込みました：社員 ${r.users_created.length}人／打刻 ${r.attendance}日分／購入申請 ${r.ringi}件／休暇申請 ${r.leave}件／休日出勤申請 ${r.holiday}件
        ${r.attendance_skipped ? `<br><span class="small">取り込み済み・氏名不明などで飛ばした打刻：${r.attendance_skipped}件</span>` : ''}
        ${r.notes.map((n) => `<br><span class="small">${esc(n)}</span>`).join('')}</div>
        ${r.users_created.length ? `<div class="notice"><b>初期パスワード（この画面を閉じると二度と表示されません。各自にお伝えください）</b>
          <table><thead><tr><th>氏名</th><th>ログインID</th><th>権限</th><th>初期パスワード</th></tr></thead><tbody>
          ${r.users_created.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.login_id)}</td><td>${u.role === 'admin' ? '管理者' : '社員'}</td><td><code>${esc(u.password)}</code></td></tr>`).join('')}
          </tbody></table>
          <p class="small">承認をしていた方は「管理者」にしています。入社日は各社員の「編集」から入れてください。</p></div>` : ''}`;
      toast('取り込みが完了しました');
    } catch (e) { toast(e.message, true); }
    btn.disabled = false; btn.textContent = '取り込む';
  };
  $('#add-user').onclick = () => openModal(`<h2>社員を追加</h2>${userForm()}${modalButtons('追加する')}`, async (fd) => {
    await api('/api/users', { method: 'POST', body: fd });
    toast('社員を追加しました');
    router();
  });
  main.querySelectorAll('[data-edit]').forEach((b) => {
    const u = users.find((x) => x.id === Number(b.dataset.edit));
    b.onclick = () => openModal(`<h2>${esc(u.name)}さんの情報</h2>${userForm(u)}${modalButtons()}`, async (fd) => {
      await api(`/api/users/${u.id}`, { method: 'PUT', body: { ...fd, active: fd.active === '1' } });
      toast('保存しました');
      if (u.id === state.me.id) { await boot(); return; }
      router();
    });
  });
  main.querySelectorAll('[data-reset]').forEach((b) => {
    const u = users.find((x) => x.id === Number(b.dataset.reset));
    b.onclick = () => openModal(`<h2>${esc(u.name)}さんのパスワード再発行</h2>
      <p class="small muted">新しい仮パスワードを設定します。次回ログイン時に本人が変更します。</p>
      <label>新しい仮パスワード（8文字以上）<input name="password" minlength="8" required></label>${modalButtons('再発行する')}`, async (fd) => {
      await api(`/api/users/${u.id}/reset-password`, { method: 'POST', body: fd });
      toast('パスワードを再発行しました');
      if (u.id === state.me.id) { await boot(); return; }
      router();
    });
  });
}, true);
