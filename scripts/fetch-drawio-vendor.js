// fetch-drawio-vendor.js — draw.io 描画ライブラリの取得（版更新時に手動で実行する。compile では呼ばない）
//
// sprint 20261009-130815-file-viewer-drawio / ADRL-0136。
// jgraph/drawio（Apache-2.0）の viewer-static.min.js / stencils.min.js を **commit 固定 URL** から取得し、
// サイズ上限つきで受信 → SHA-256 を計算 → media/drawio-viewer/ に書き出して manifest.json を更新する。
// 手順と advisory の確認先は docs/drawio-vendor.md。
//
// 使い方: node scripts/fetch-drawio-vendor.js [--commit <sha> --version <x.y.z>]
//   既定は manifest.json の commit / version（= 現在の固定版の再取得・照合）

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'media', 'drawio-viewer');
const MANIFEST = path.join(DIR, 'manifest.json');
const FILES = ['viewer-static.min.js', 'stencils.min.js'];
const MAX_BYTES = 16 * 1024 * 1024; // 1 ファイルあたりの受信上限（現行は 4.4MB / 3.9MB）

function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function download(url) {
    const res = await fetch(url);
    if (!res.ok || !res.body) { throw new Error(`${url}: HTTP ${res.status}`); }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        total += value.length;
        if (total > MAX_BYTES) { await reader.cancel(); throw new Error(`${url}: ${MAX_BYTES} バイトを超えました`); }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

async function main() {
    const current = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
    const commit = arg('--commit') || current.commit;
    const version = arg('--version') || current.version;
    if (!/^[0-9a-f]{40}$/.test(String(commit || ''))) { throw new Error('--commit に 40 桁の commit hash を指定してください'); }
    if (!version) { throw new Error('--version を指定してください'); }
    const base = `https://raw.githubusercontent.com/jgraph/drawio/${commit}/src/main/webapp/js`;
    fs.mkdirSync(DIR, { recursive: true });
    const files = {};
    for (const name of FILES) {
        const url = `${base}/${name}`;
        const buf = await download(url);
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        const prev = current.commit === commit && current.files && current.files[name];
        if (prev && (prev.size !== buf.length || prev.sha256 !== sha256)) {
            throw new Error(`${name}: 同じ commit なのに manifest と一致しません（取得元が変わった可能性）`);
        }
        fs.writeFileSync(path.join(DIR, name), buf);
        files[name] = { size: buf.length, sha256, url };
        console.log(`  ✓ ${name}  ${buf.length} bytes  sha256=${sha256}`);
    }
    const manifest = { name: 'jgraph/drawio', license: 'Apache-2.0', version, commit, files };
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`  ✓ manifest.json 更新（v${version} / ${commit}）`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
