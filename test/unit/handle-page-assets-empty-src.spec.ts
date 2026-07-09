/**
 * fix-notes-roundtrip-paste-stale-clip TASK-02 — handlePageAssets バックストップ
 *
 * 修正2（バックストップ）: copy 経路（!isCut）で srcMdPath が存在しない場合は
 * dest md を書かない（0 バイト md の残渣を残さない防御）。
 *
 *   TC-BK-01 (load-bearing) srcMd 不在時に空 md を書かない
 *   TC-BK-02            srcMd 存在時は従来どおり作る（後方互換）
 *
 * outliner per-note レイアウト:
 *   srcOutDir = <note>            （.out ファイルの dir）
 *   srcPagesDir = <note>/pages    （page md / images / files の親）
 *   page md   = srcPagesDir/<pageId>.md
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handlePageAssets } from '../../src/shared/paste-asset-handler';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hpa-empty-'));
}

/** src note (out=<root>/src, pages=<root>/src/pages) と dst note を用意。 */
function setup(): {
    root: string;
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
} {
    const root = mkTmp();
    const srcOutDir = path.join(root, 'src');
    const srcPagesDir = path.join(srcOutDir, 'pages');
    const destOutDir = path.join(root, 'dst');
    const destPagesDir = path.join(destOutDir, 'pages');
    fs.mkdirSync(srcPagesDir, { recursive: true });
    fs.mkdirSync(destPagesDir, { recursive: true });
    return { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir };
}

test('TC-BK-01 (load-bearing) srcMd 不在時に空 md を書かない', () => {
    const { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir } = setup();
    // srcPagesDir に p1.md を作らない（stale pageId が来て src md が不在のケース）
    expect(fs.existsSync(path.join(srcPagesDir, 'p1.md'))).toBe(false);

    const result = handlePageAssets({
        srcOutDir, srcPagesDir, destOutDir, destPagesDir,
        pageId: 'p1', newPageId: 'pA2', nodeImages: [],
    });

    // ★load-bearing: dest md が作られない（0 バイト md の残渣を残さない）
    // counterfactual: 修正前は 0 バイト pA2.md が作られ、この assert が fail する。
    expect(fs.existsSync(path.join(destPagesDir, 'pA2.md'))).toBe(false);
    expect(result.newNodeImages).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-BK-02 srcMd 存在時は従来どおり作る（後方互換）', () => {
    const { root, srcOutDir, srcPagesDir, destOutDir, destPagesDir } = setup();
    writeSrc(srcPagesDir, 'p1.md', '# hello');

    handlePageAssets({
        srcOutDir, srcPagesDir, destOutDir, destPagesDir,
        pageId: 'p1', newPageId: 'pA2', nodeImages: [],
    });

    const destMd = path.join(destPagesDir, 'pA2.md');
    expect(fs.existsSync(destMd)).toBe(true);
    expect(fs.readFileSync(destMd, 'utf8')).toContain('# hello');
    fs.rmSync(root, { recursive: true, force: true });
});

function writeSrc(dir: string, rel: string, content: string): void {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}
