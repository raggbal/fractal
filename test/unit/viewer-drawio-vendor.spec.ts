/**
 * draw.io 描画ライブラリの版・SHA-256・LICENSE（sprint 20261009-130815-file-viewer-drawio / TASK-02 / NFR-DIO-04 / ADRL-0136）
 *
 * TC-DIO-07
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'media', 'drawio-viewer');
const VERIFY = path.join(ROOT, 'scripts', 'verify-drawio-vendor.js');

const sha256 = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** "31.1.9" 形式の比較（a >= b） */
function versionGte(a: string, b: string): boolean {
    const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) { return (pa[i] || 0) > (pb[i] || 0); } }
    return true;
}

test.describe('drawio vendor', () => {
    test('TC-DIO-07: manifest の版・commit・size・sha256 が実ファイルと一致し、LICENSE と verify が機能する', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
        // (a) 版固定
        expect(manifest.version).toBe('32.3.0');
        expect(manifest.commit).toBe('96f8c7acb719aa93f0108eecedf20c3afdcbe431');
        expect(manifest.files['viewer-static.min.js']).toMatchObject({
            size: 4418269, sha256: '1bd0bcf5fad22e258a35c5bc3683e025dfb8205e0797d97cdb4a452f702130c2',
        });
        expect(manifest.files['stencils.min.js']).toMatchObject({
            size: 3870004, sha256: 'f6ee4f7244ed74ba74b012ee621bc8d14f8492583a976e37f2b75328145c29b6',
        });
        // (b) 実ファイルとの一致
        for (const [name, want] of Object.entries<any>(manifest.files)) {
            const p = path.join(DIR, name);
            expect(fs.statSync(p).size, name).toBe(want.size);
            expect(sha256(p), name).toBe(want.sha256);
        }
        // (c) 既知 advisory（GHSA-34m6-jq4j-m83m: <=31.1.8）の修正版以上
        expect(versionGte(manifest.version, '31.1.9')).toBe(true);
        // (d) LICENSE
        const lic = fs.readFileSync(path.join(DIR, 'LICENSE-drawio.txt'), 'utf8');
        expect(lic).toContain('Apache License');
        expect(lic).toContain(manifest.commit);

        // verify スクリプト: 正しいディレクトリは exit 0
        execFileSync(process.execPath, [VERIFY], { stdio: 'pipe' });
        // (e) 1 バイト改変したコピーは exit 1
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drawio-vendor-'));
        try {
            for (const name of fs.readdirSync(DIR)) { fs.copyFileSync(path.join(DIR, name), path.join(tmp, name)); }
            const target = path.join(tmp, 'stencils.min.js');
            const buf = fs.readFileSync(target);
            buf[100] = buf[100] ^ 0x01;
            fs.writeFileSync(target, buf);
            let code = 0;
            try { execFileSync(process.execPath, [VERIFY, '--dir', tmp], { stdio: 'pipe' }); } catch (e: any) { code = e.status; }
            expect(code).toBe(1);
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
});
