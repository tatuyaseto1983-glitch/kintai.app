'use strict';
// リーフ社内ポータルのスタッフ画面を、パソコン上で確認するためのサーバー。
// leaf-portal/gas の doGet() が返す画面を、GAS のまね（dev/leaf-gas-mock.js）の上で動かします。
//   node dev/leaf-portal-server.js      → http://localhost:3100
// 画面の google.script.run は、このサーバーの /__gas に送られ、GAS の関数がそのまま実行されます。
// テスト用に「ログイン中のアカウント」と「今の時刻」を切り替える /__test/* もあります（本番の GAS にはありません）。
const http = require('node:http');
const { createLeafGas } = require('./leaf-gas-mock');

const SAMPLE_STAFF = [
  { '社員ID': 'E001', '氏名': '山田 太郎', 'メールアドレス': 'yamada@example.com', '権限': 'admin', '雇用区分': '正社員', '勤務区分': '固定勤務', '在籍状況': '在籍', '部署': '管理部' },
  { '社員ID': 'E002', '氏名': '佐藤 花子', 'メールアドレス': 'sato@example.com', '権限': 'staff', '雇用区分': '正社員', '勤務区分': '固定勤務', '在籍状況': '在籍', '部署': '設計部' },
  { '社員ID': 'E003', '氏名': '鈴木 一郎', 'メールアドレス': 'suzuki@example.com', '権限': 'staff', '雇用区分': '契約社員', '勤務区分': 'フレックス', '在籍状況': '在籍', '部署': '施工管理部' },
  { '社員ID': 'E004', '氏名': '田中 美咲', 'メールアドレス': 'tanaka@example.com', '権限': 'staff', '雇用区分': 'パート・アルバイト', '勤務区分': '固定勤務', '在籍状況': '在籍', '部署': '営業部' },
];

// ブラウザの google.script.run をまねるスクリプト（withSuccessHandler / withFailureHandler に対応）
const SHIM = `<script>
(function () {
  function makeRunner(success, failure) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (fn) { return makeRunner(fn, failure); };
        if (name === 'withFailureHandler') return function (fn) { return makeRunner(success, fn); };
        return function () {
          var args = Array.prototype.slice.call(arguments);
          fetch('/__gas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: name, args: args }) })
            .then(function (r) { return r.json(); })
            .then(function (body) {
              if (body.error) { if (failure) failure(new Error(body.error)); }
              else if (success) success(body.result);
            })
            .catch(function (e) { if (failure) failure(e); });
        };
      },
    });
  }
  window.google = { script: { run: makeRunner(null, null) } };
})();
</script>`;

function createServer(options = {}) {
  const gas = createLeafGas({ email: options.email || 'sato@example.com' });
  gas.g.setupSystem();
  gas.g.appendRecords_('スタッフマスタ', SAMPLE_STAFF);
  // 段階3：シフト（2026年5月〜12月）。平日＝通常勤務、土曜＝休日、日曜＝法定休日（画面テスト用の例。実際は曜日固定ではない）
  if (options.shifts !== false) {
    const rows = [];
    for (let t = Date.UTC(2026, 4, 1); t <= Date.UTC(2026, 11, 31); t += 86400000) {
      const d = new Date(t);
      const date = d.toISOString().slice(0, 10);
      const type = d.getUTCDay() === 0 ? '法定休日' : d.getUTCDay() === 6 ? '休日' : '通常勤務';
      SAMPLE_STAFF.forEach((s) => rows.push({ '日付': date, '社員ID': s['社員ID'], '氏名': s['氏名'], 'シフト区分': type }));
    }
    gas.g.appendRecords_('シフト', rows);
  }
  const calls = [];
  const delayMs = { value: options.delayMs || 0 };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
      try {
        if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
          const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
          const html = gas.g.doGet({ parameter: query }).getContent().replace('<head>', '<head>\n<meta name="viewport" content="width=device-width, initial-scale=1">' + SHIM);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
        if (req.method === 'POST' && req.url === '/__gas') {
          const { fn, args } = JSON.parse(body || '{}');
          calls.push(fn);
          if (typeof gas.g[fn] !== 'function' || fn.endsWith('_')) return json(200, { error: 'Script function not found: ' + fn });
          // 本物の GAS と同じく、結果は JSON にできる値だけが画面に届く
          const result = JSON.parse(JSON.stringify(gas.g[fn](...(args || [])) ?? null));
          setTimeout(() => json(200, { result }), delayMs.value);
          return;
        }
        if (req.method === 'POST' && req.url === '/__test/login') { gas.loginAs(JSON.parse(body).email); return json(200, { ok: true }); }
        if (req.method === 'POST' && req.url === '/__test/now') { gas.setNow(JSON.parse(body).now); return json(200, { ok: true }); }
        if (req.method === 'POST' && req.url === '/__test/delay') { delayMs.value = JSON.parse(body).ms; return json(200, { ok: true }); }
        res.writeHead(404); res.end('not found');
      } catch (e) {
        json(500, { error: e.message });
      }
    });
  });
  return { server, gas, calls };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3100);
  const { server } = createServer();
  server.listen(port, () => {
    console.log('スタッフ画面の確認用サーバー：http://localhost:' + port);
    console.log('ログイン中：佐藤 花子（固定勤務）。切り替え例：');
    console.log(`  curl -X POST localhost:${port}/__test/login -d '{"email":"suzuki@example.com"}'   # フレックス`);
  });
}

module.exports = { createServer, SAMPLE_STAFF };
