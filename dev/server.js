'use strict';
// 手元で動作確認するための簡易サーバー。
// 画面（public/）を配信し、/api へのリクエストを gas/Code.gs（Apps Script 版のサーバー）に渡す。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createGas } = require('./gas-mock');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'dev-data.json');
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
const gas = createGas({ file: DATA_FILE });
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/api') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let out;
      try { out = gas.context.doPost({ postData: { contents: Buffer.concat(chunks).toString('utf8') } }).getContent(); } catch (e) { console.error(e); out = JSON.stringify({ ok: false, status: 500, error: String(e) }); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(out);
    });
    return;
  }
  // 手元では config.js の代わりに /api を使う
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return res.end("window.KINTAI_API_URL = '/api';\n");
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not Found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`手元確認用サーバー: http://localhost:${PORT}（初期ID admin / パスワード admin1234）`));
