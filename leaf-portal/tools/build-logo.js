'use strict';
/**
 * ロゴ画像（leaf-portal/assets/logo.png）を、Apps Script で使える形（gas/Logo.html）に変換します。
 *   npm run logo
 *
 * Apps Script のWebアプリは画像ファイルをそのまま配信できないため、画像を文字（data URI）にして
 * HTML ファイルとして一緒に反映します。画面はこの Logo.html だけを見てロゴを表示します。
 *
 * ロゴを差し替えるとき：assets/logo.png を新しい画像（PNG）に置き換えて npm run logo → npm run push
 */
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', 'assets', 'logo.png');
const OUTPUT = path.join(__dirname, '..', 'gas', 'Logo.html');
const MAX_BYTES = 200 * 1024; // 画面の読み込みが遅くならないよう、大きすぎる画像は止める

function buildLogo(source = SOURCE, output = OUTPUT) {
  const bytes = fs.readFileSync(source);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('logo.png が PNG 画像ではありません');
  if (bytes.length > MAX_BYTES) throw new Error('ロゴ画像が大きすぎます（' + Math.round(bytes.length / 1024) + 'KB）。200KB以下にしてください');
  const dataUri = 'data:image/png;base64,' + bytes.toString('base64');
  fs.writeFileSync(output, dataUri);
  return { bytes: bytes.length, output };
}

if (require.main === module) {
  const r = buildLogo();
  console.log('✔ ロゴを変換しました：' + path.relative(process.cwd(), r.output) + '（元画像 ' + Math.round(r.bytes / 1024 * 10) / 10 + 'KB）');
  console.log('  → npm run push で Apps Script に反映してください');
}

module.exports = { buildLogo };
