/**
 * viewer-file-link.spec.ts — In-App file link（FR-FV-09 / ADRL-0068）
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-16 / testcases.md H-4 節。
 * ハーネス: TS 直 import（inapp-link-utils.js は CommonJS export・vscode 非依存）。
 *
 * TC-FV-55: build/parse 往復 + 判定順（file 分岐が node 分岐より先 — outFileId='file' 誤解釈の回避）
 * TC-FV-56: 既存 4 形式（page/md/node/out）の parse 非破壊（regression 番人）
 * TC-FV-57: traversal 番人 — fileId=..%2F.. が getTreeFilePath の clamp（safeResolveUnderDir 内蔵）で
 *           note の files/ 外に到達しない。counterfactual: clamp なしの path.join 直書きは base 外を返して RED
 * TC-FV-58: 構文破壊文字を含む filename（Report (2).pdf / a]b.pdf）で生成した [title](link) が
 *           実 markdown link parser で往復して title/url を保持（designer_failures 2026-08-09）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const linkUtils = require(path.join(ROOT, 'src', 'shared', 'inapp-link-utils.js'));

test.describe('In-App file link（FR-FV-09）', () => {

    test('TC-FV-55: buildFileLink → parseFractalLink 往復 + file 分岐が node より先', () => {
        const link = linkUtils.buildFileLink('note1', 'uuid-1');
        expect(link).toBe('fractal://note/note1/file/uuid-1');
        expect(linkUtils.parseFractalLink(link)).toEqual({ noteFolderName: 'note1', fileId: 'uuid-1' });

        // 判定順: {folder}/file/{id} の 3 セグメント形が node link（outFileId='file'）に誤解釈されない
        const parsed = linkUtils.parseFractalLink('fractal://note/n/file/x');
        expect(parsed).toEqual({ noteFolderName: 'n', fileId: 'x' });
        expect(parsed.outFileId).toBeUndefined();
        expect(parsed.nodeId).toBeUndefined();

        // encode 往復（folder / id に空白・日本語）
        const enc = linkUtils.buildFileLink('メモ 帳', 'id with space');
        expect(linkUtils.parseFractalLink(enc)).toEqual({ noteFolderName: 'メモ 帳', fileId: 'id with space' });
    });

    test('TC-FV-56: 既存 4 形式（page/md/node/out）の parse 非破壊', () => {
        expect(linkUtils.parseFractalLink('fractal://note/n/out1/page/p1'))
            .toEqual({ noteFolderName: 'n', outFileId: 'out1', pageId: 'p1' });
        expect(linkUtils.parseFractalLink('fractal://note/n/md/m1'))
            .toEqual({ noteFolderName: 'n', mdFileId: 'm1' });
        expect(linkUtils.parseFractalLink('fractal://note/n/out1/node1'))
            .toEqual({ noteFolderName: 'n', outFileId: 'out1', nodeId: 'node1' });
        expect(linkUtils.parseFractalLink('fractal://note/n/out1'))
            .toEqual({ noteFolderName: 'n', outFileId: 'out1' });
        expect(linkUtils.parseFractalLink('not-a-link')).toBeNull();
    });

    test('TC-FV-57: traversal 番人 — getTreeFilePath 経由は files/ 外に到達しない（counterfactual: path.join 直書きは base 外）', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { NotesFileManager } = require(path.join(ROOT, 'out', 'shared', 'notes-file-manager.js'));
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-link-'));
        try {
            const noteDir = path.join(tmp, 'note1');
            fs.mkdirSync(path.join(noteDir, 'files'), { recursive: true });
            // 秘匿ファイル（files/ 外 = 到達してはならない先）
            fs.writeFileSync(path.join(tmp, 'secret.pdf'), 'SECRET');
            const fm = new NotesFileManager(noteDir);
            const structure = fm.getStructure();
            // traversal 型 id を items に直接注入（外部入力で filename が汚染されたケースの模擬）
            const evilId = 'evil-id';
            structure.items[evilId] = { id: evilId, type: 'file', ext: 'file', title: 'evil', filename: '../../secret.pdf' };
            fm.saveStructure(structure);

            // 本命: getTreeFilePath は clamp（safeResolveUnderDir）内蔵 → null（files/ 外に出ない）
            const resolved = fm.getTreeFilePath(evilId);
            expect(resolved).toBeNull();

            // counterfactual 実測: clamp を外した path.join 直書きは base 外（secret.pdf）に到達してしまう
            const filesDir = path.join(noteDir, 'files');
            const unclamped = path.resolve(path.join(filesDir, '../../secret.pdf'));
            expect(unclamped.startsWith(filesDir + path.sep)).toBe(false);   // clamp なしだと外に出る = RED の根拠
            expect(fs.existsSync(unclamped)).toBe(true);                      // 実在する秘匿先（攻撃が成立しうる実体）
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('TC-FV-58: 構文破壊文字入り filename の [title](link) が markdown link parser で往復する', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const parser = require(path.join(ROOT, 'src', 'shared', 'markdown-link-parser.js'));

        for (const filename of ['Report (2).pdf', 'a]b.pdf', 'Screenshot (1).png']) {
            // 生成側規則（design §10 / notes-file-panel.js:601 precedent）: title は [] を strip
            const title = filename.replace(/[\[\]]/g, '');
            const link = linkUtils.buildFileLink('note1', 'uuid-9');
            const md = `[${title}](${link})`;
            const links = parser.parseMarkdownLinks(md);
            expect(links.length, `${filename}: リンクとして解析されない`).toBe(1);
            expect(links[0].alt).toBe(title);
            expect(links[0].url).toBe(link);
        }
    });
});
