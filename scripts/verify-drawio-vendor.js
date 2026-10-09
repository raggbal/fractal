// verify-drawio-vendor.js — draw.io 描画ライブラリの照合（compile で毎回実行）
//
// sprint 20261009-130815-file-viewer-drawio / ADRL-0136 / INV-D5。
// media/drawio-viewer/manifest.json に記録した size・SHA-256 と実ファイルが一致しなければ exit 1 で
// ビルドを止める（固定版以外の JS を vsix に入れない）。
//
// 使い方: node scripts/verify-drawio-vendor.js [--dir <dir>]（--dir はテスト用）

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const i = process.argv.indexOf('--dir');
const DIR = i >= 0 ? path.resolve(process.argv[i + 1]) : path.join(__dirname, '..', 'media', 'drawio-viewer');

function fail(msg) { console.error(`  ✗ drawio vendor: ${msg}`); process.exit(1); }

const manifestPath = path.join(DIR, 'manifest.json');
if (!fs.existsSync(manifestPath)) { fail(`${manifestPath} がありません`); }
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const names = Object.keys(manifest.files || {});
if (names.length === 0) { fail('manifest.json に files がありません'); }
for (const name of names) {
    const want = manifest.files[name];
    const p = path.join(DIR, name);
    if (!fs.existsSync(p)) { fail(`${name} がありません`); }
    const buf = fs.readFileSync(p);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    if (buf.length !== want.size) { fail(`${name}: サイズが一致しません（${buf.length} ≠ ${want.size}）`); }
    if (sha256 !== want.sha256) { fail(`${name}: SHA-256 が一致しません`); }
}
console.log(`  ✓ drawio vendor: v${manifest.version}（${names.length} files）`);
