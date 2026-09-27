'use strict';
// public/ の画面を1つのファイル（gas/Index.html）にまとめる。
// Apps Script に貼り付けると、Apps Script のURLだけでアプリが開けるようになる。
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, 'public', f), 'utf8');

function build() {
  const icon = 'data:image/svg+xml;base64,' + Buffer.from(read('icon.svg')).toString('base64');
  const css = read('style.css');
  const js = read('app.js').replace(/src="icon\.svg"/g, `src="${icon}"`);
  if (/<\/script/i.test(js) || /<\/style/i.test(css)) throw new Error('埋め込めない文字列が含まれています');
  return `<!doctype html>
<!-- このファイルは自動生成です。直接編集せず、public/ を変えてから npm run build を実行してください -->
<html lang="ja">
<head>
<meta charset="utf-8">
<style>
${css}
</style>
</head>
<body>
<div id="app" class="boot">読み込み中…</div>
<dialog id="modal"><form method="dialog" id="modal-form"></form></dialog>
<div id="toast" role="status" aria-live="polite"></div>
<script>
${js}
</script>
</body>
</html>
`;
}

if (require.main === module) {
  fs.writeFileSync(path.join(root, 'gas', 'Index.html'), build());
  console.log('gas/Index.html を作成しました');
}
module.exports = { build };
