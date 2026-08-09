/**
 * TASK-03 — Clean Notes: tree 登録添付ファイル（ext==='file'）の live 化（FR-TF-07 🔴）
 *
 * design/system.md §6:
 *   cleanup-core.ts に addNotesFilesToLiveSet(structure, mainFolderPath, liveFiles) 新設。
 *   scanSingleNoteCore の live set 構築列（Pass1 の隣）に配線。
 *   filename は safeResolveUnderDir(resolveMdFilesDir(mainFolder), filename) で files/ 配下に clamp。
 *
 * tree file は node/md どこからも参照されない（filename が実体への唯一の参照）ため、
 * live 化しないと Clean Unused Files が tree 登録済み添付を orphan-file として誤削除する。
 *
 * TC-CL-01 tree 登録 file（未参照）が orphan-file に載らない（counterfactual: 配線を外すと載る = RED）
 * TC-CL-02 tree 未登録・未参照の files/ 実体は従来どおり orphan-file に載る（既存挙動不変・over-protect しない）
 * TC-CL-03 filename traversal を仕込んだ file item は live 化されない（clamp 経由）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanSingleNoteCore, addNotesFilesToLiveSet } from '../../src/shared/cleanup-core';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'notetree-file-cleanup-'));
}

/** flat note fixture: files/ 実体 + outline.note に ext==='file' item を登録する。 */
function writeFileNote(
    dir: string,
    filesOnDisk: string[],
    items: Record<string, { title: string; filename: string }>
): void {
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    for (const name of filesOnDisk) {
        fs.writeFileSync(path.join(dir, 'files', name), 'BINARY-CONTENT');
    }
    const structureItems: Record<string, unknown> = {};
    for (const id of Object.keys(items)) {
        structureItems[id] = {
            type: 'file', id, title: items[id].title, ext: 'file', filename: items[id].filename,
        };
    }
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({
        rootIds: Object.keys(structureItems),
        items: structureItems,
    }));
}

test('TC-CL-01 tree 登録 file（node/md 未参照）が orphan-file に載らない', async () => {
    const dir = mkTmp();
    // files/report.pdf を tree に登録するが、どの .out node / md からも参照しない
    writeFileNote(dir, ['report.pdf'], { f1: { title: 'Report', filename: 'report.pdf' } });

    const orphans = await scanSingleNoteCore(dir);
    // counterfactual: addNotesFilesToLiveSet の配線を外すと report.pdf が orphan-file に載る = RED
    expect(orphans.map(o => path.basename(o.absPath))).not.toContain('report.pdf');
    expect(orphans.length).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-CL-02 tree 未登録・未参照の files/ 実体は従来どおり orphan-file に載る（over-protect しない）', async () => {
    const dir = mkTmp();
    // kept.pdf は tree 登録済み → live / orphan.pdf は未登録 → orphan のまま
    writeFileNote(dir, ['kept.pdf', 'orphan.pdf'], { f1: { title: 'Kept', filename: 'kept.pdf' } });

    const orphans = await scanSingleNoteCore(dir);
    const names = orphans.map(o => path.basename(o.absPath));
    expect(names).toContain('orphan.pdf');   // 未登録は既存どおり orphan
    expect(names).not.toContain('kept.pdf'); // 登録済みは保護（選択的）
    // orphan-file としてマークされていること（type 確認）
    const orphanEntry = orphans.find(o => path.basename(o.absPath) === 'orphan.pdf');
    expect(orphanEntry?.type).toBe('orphan-file');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-CL-03 filename traversal を仕込んだ file item は live 化されない（clamp 経由）', async () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });

    // 悪意 filename（files/ を escape する traversal）は safeResolveUnderDir が null → live 化しない
    const liveTraversal = new Set<string>();
    addNotesFilesToLiveSet(
        { items: { bad: { type: 'file', id: 'bad', title: 'x', ext: 'file', filename: '../../etc/passwd' } } },
        dir,
        liveTraversal
    );
    // counterfactual: 生 path.join なら <dir>/etc/passwd 等の escape パスが 1 件混入する = size 1
    expect(liveTraversal.size).toBe(0);

    // 正常 filename は files/ 配下の実体パスとして live 化される（正の対照）
    const liveOk = new Set<string>();
    addNotesFilesToLiveSet(
        { items: { ok: { type: 'file', id: 'ok', title: 'ok', ext: 'file', filename: 'doc.pdf' } } },
        dir,
        liveOk
    );
    expect(liveOk.has(path.join(dir, 'files', 'doc.pdf'))).toBe(true);
    expect([...liveOk].every(p => p.startsWith(path.join(dir, 'files')))).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
});
