/**
 * TASK-09 (sprint 20260804-145603 / review iteration 1) — FR-B11 md link の path traversal 防御
 *
 * TC-B11-08  resolveMdFilePath に traversal id（fractal:// md link の decode 済みセグメント相当）を
 *            渡しても mainFolder 配下に clamp される（basename 縮退）。
 *            counterfactual: clamp（safeResolveUnderDir ガード）を外すと note 外パスを返す = RED。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveMdFilePath } from '../../src/shared/flat-layout';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'inapp-trav-'));
}

test('TC-B11-08a traversal id（../../etc/passwd_copy）が mainFolder 配下に clamp される', () => {
    const dir = mkTmp();
    // fractal://note/{folder}/md/..%2F..%2F..%2Fetc%2Fpasswd_copy の decode 後セグメント
    const p = resolveMdFilePath(dir, '../../../etc/passwd_copy');
    expect(p.startsWith(dir + path.sep), `resolved ${p} must stay under ${dir}`).toBe(true);
    expect(path.basename(p)).toBe('passwd_copy.md');
});

test('TC-B11-08b 絶対パス id も clamp される', () => {
    const dir = mkTmp();
    const p = resolveMdFilePath(dir, '/etc/passwd_copy');
    expect(p.startsWith(dir + path.sep)).toBe(true);
});

test('TC-B11-08c 正常な生成 id（1 セグメント）は従来どおり（flat 直下・無影響）', () => {
    const dir = mkTmp();
    expect(resolveMdFilePath(dir, '1234567890')).toBe(path.join(dir, '1234567890.md'));
    // legacy fallback も不変
    fs.mkdirSync(path.join(dir, '_notes_md'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_notes_md', 'legacyid.md'), '# x');
    expect(resolveMdFilePath(dir, 'legacyid')).toBe(path.join(dir, '_notes_md', 'legacyid.md'));
});
