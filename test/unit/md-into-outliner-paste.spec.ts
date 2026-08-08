/**
 * TC-XP-05 / TC-XP-06 — runMdIntoOutlinerPaste（md 行 → outliner node 変換 + asset 複製）
 * (sprint 20260808-000219 FR-XP-02 / FR-XP-03)
 *
 * counterfactual: 従来（handler 不在 = 素通り）だと md リンク構文が生テキスト node になり
 * dest note に実体が無い（本 spec の複製 assert / node 分類 assert が RED）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMdIntoOutlinerPaste } from '../../src/shared/paste-asset-handler';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'md-into-out-'));
}

function writeF(dir: string, rel: string, content: string): void {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

function setupNotes(root: string) {
    const noteA = path.join(root, 'noteA');
    const noteB = path.join(root, 'noteB');
    writeF(noteA, 'images/pic.png', 'PNG-A');
    writeF(noteA, 'files/doc.pdf', 'PDF-A');
    writeF(noteA, 'sub1.md', '# Sub\n');
    fs.mkdirSync(noteB, { recursive: true });
    return {
        srcCtx: {
            imageDir: path.join(noteA, 'images'),
            fileDir: path.join(noteA, 'files'),
            mdDir: noteA,
        },
        noteA,
        noteB,
        destDirs: {
            destOutDir: noteB,
            destPagesDir: noteB,
            destImagesDir: path.join(noteB, 'images'),
            destFilesDir: path.join(noteB, 'files'),
        },
    };
}

test('TC-XP-05 行分類: 画像行 → images node / 📎行 → filePath node / subpage 行 → page node / 混在・プレーン行 → text node', () => {
    const root = mkTmp();
    const { srcCtx, noteB, destDirs } = setupNotes(root);

    const mdText = [
        '![alt-p](images/pic.png)',
        '[📎 doc.pdf](files/doc.pdf)',
        '[[Sub]](sub1.md)',
        'hello [📎 doc.pdf](files/doc.pdf) world',
        'plain line',
        '  indented child',
    ].join('\n');

    const { nodes } = runMdIntoOutlinerPaste({
        mdText, sourceContext: srcCtx, isCut: false, ...destDirs,
    });

    expect(nodes.length).toBe(6);

    // 画像 node: 実体が noteB/images に複製され、node.images は destOutDir 基準相対
    expect(nodes[0].images?.length).toBe(1);
    const imgRel = nodes[0].images![0];
    expect(fs.existsSync(path.join(noteB, imgRel))).toBe(true);
    expect(fs.readFileSync(path.join(noteB, imgRel), 'utf8')).toBe('PNG-A');

    // 📎 node: 実体複製 + filePath
    expect(nodes[1].filePath).toBeTruthy();
    expect(fs.existsSync(path.join(noteB, nodes[1].filePath!))).toBe(true);

    // subpage node: page md が dest に複製され pageId = 複製後 stem
    expect(nodes[2].isPage).toBe(true);
    expect(nodes[2].pageId).toBeTruthy();
    expect(fs.existsSync(path.join(noteB, `${nodes[2].pageId}.md`))).toBe(true);

    // 混在行: text node のまま（リンクは書換済み相対パスを含む）+ 実体は複製済み
    expect(nodes[3].filePath).toBeUndefined();
    expect(nodes[3].text).toContain('hello');
    expect(nodes[3].text).toContain('world');
    expect(nodes[3].text).not.toContain('noteA');

    // プレーン行 / インデント
    expect(nodes[4].text).toBe('plain line');
    expect(nodes[4].level).toBe(0);
    expect(nodes[5].text).toBe('indented child');
    expect(nodes[5].level).toBe(1);
});

test('TC-XP-06 cut+sameOutliner: 複製ゼロ・参照そのまま / cut+cross: 複製あり + src 実体温存 (orphan)', () => {
    const root = mkTmp();
    const { srcCtx, noteA, noteB, destDirs } = setupNotes(root);

    // cut + same (dest = noteA 自身)
    const sameDirs = {
        destOutDir: noteA,
        destPagesDir: noteA,
        destImagesDir: path.join(noteA, 'images'),
        destFilesDir: path.join(noteA, 'files'),
    };
    const same = runMdIntoOutlinerPaste({
        mdText: '[📎 doc.pdf](files/doc.pdf)',
        sourceContext: srcCtx, isCut: true, ...sameDirs,
    });
    // 複製なし: files/ には元の doc.pdf 1 個だけ + 参照そのまま
    expect(fs.readdirSync(path.join(noteA, 'files'))).toEqual(['doc.pdf']);
    expect(same.nodes[0].filePath).toBe('files/doc.pdf');

    // cut + cross (dest = noteB)
    const cross = runMdIntoOutlinerPaste({
        mdText: '[📎 doc.pdf](files/doc.pdf)',
        sourceContext: srcCtx, isCut: true, ...destDirs,
    });
    // 複製あり + counterfactual: src 実体を消すコードが入ると次の assert が RED
    expect(fs.existsSync(path.join(noteB, cross.nodes[0].filePath!))).toBe(true);
    expect(fs.existsSync(path.join(noteA, 'files/doc.pdf'))).toBe(true); // orphan 温存
});

test('TC-XP-05b バレット付き md リスト行: バレット除去 + リンク分類が効く', () => {
    const root = mkTmp();
    const { srcCtx, noteB, destDirs } = setupNotes(root);
    const { nodes } = runMdIntoOutlinerPaste({
        mdText: '- ![p](images/pic.png)\n- plain',
        sourceContext: srcCtx, isCut: false, ...destDirs,
    });
    expect(nodes[0].images?.length).toBe(1);
    expect(fs.existsSync(path.join(noteB, nodes[0].images![0]))).toBe(true);
    expect(nodes[1].text).toBe('plain');
});

test('TC-XP-10 (bugfix 2026-08-09) スペース入りファイル名の 📎 行が添付 node になり実体複製される（ユーザー報告再現）', () => {
    const root = mkTmp();
    const noteA = path.join(root, 'noteA');
    const noteB = path.join(root, 'noteB');
    writeF(noteA, 'files/追記_Solution Space_NMOJ_202607.docx', 'DOCX');
    writeF(noteA, 'files/PACE_Enablement_SolutionSpace_ja.pptx', 'PPTX');
    writeF(noteA, '1786088806332.md', '# test\n');
    fs.mkdirSync(noteB, { recursive: true });
    const srcCtx = {
        imageDir: path.join(noteA, 'images'),
        fileDir: path.join(noteA, 'files'),
        mdDir: noteA,
    };
    const mdText = [
        '### こちらから提出する もの SSD',
        '[📎 追記_Solution Space_NMOJ_202607.docx](files/追記_Solution Space_NMOJ_202607.docx)',
        '[📎 PACE_Enablement_SolutionSpace_ja.pptx](files/PACE_Enablement_SolutionSpace_ja.pptx)',
        '[[test]](1786088806332.md)',
    ].join('\n');

    const { nodes } = runMdIntoOutlinerPaste({
        mdText, sourceContext: srcCtx, isCut: false,
        destOutDir: noteB, destPagesDir: noteB,
        destImagesDir: path.join(noteB, 'images'),
        destFilesDir: path.join(noteB, 'files'),
    });

    expect(nodes.length).toBe(4);
    // counterfactual: 旧 regex `[^)\s"]+` はスペース入り URL にマッチせず
    // nodes[1].filePath が undefined（テキスト node）になり RED
    expect(nodes[1].filePath).toBeTruthy();
    expect(fs.existsSync(path.join(noteB, nodes[1].filePath!))).toBe(true);
    expect(fs.readFileSync(path.join(noteB, nodes[1].filePath!), 'utf8')).toBe('DOCX');
    // スペースなしも従来どおり
    expect(nodes[2].filePath).toBeTruthy();
    expect(fs.existsSync(path.join(noteB, nodes[2].filePath!))).toBe(true);
    // subpage も従来どおり
    expect(nodes[3].isPage).toBe(true);
    expect(fs.existsSync(path.join(noteB, `${nodes[3].pageId}.md`))).toBe(true);
});

test('TC-XP-11 (bugfix 同根) スペース入り画像/📎 が md→md 複製（copyMdPasteAssets）でも脱落しない', () => {
    const root = mkTmp();
    const noteA = path.join(root, 'noteA');
    const noteB = path.join(root, 'noteB');
    writeF(noteA, 'images/my pic.png', 'PNG');
    writeF(noteA, 'files/my doc.docx', 'DOCX');
    fs.mkdirSync(noteB, { recursive: true });
    const { rewrittenMarkdown } = require('../../src/shared/paste-asset-handler').copyMdPasteAssets({
        markdown: '![p](images/my pic.png)\n[📎 my doc.docx](files/my doc.docx)',
        sourceMdDir: noteA,
        sourceImageDir: path.join(noteA, 'images'),
        sourceFileDir: path.join(noteA, 'files'),
        destImageDir: path.join(noteB, 'images'),
        destFileDir: path.join(noteB, 'files'),
        destMdDir: noteB,
    });
    // counterfactual: 旧 regex では両方とも抽出されず dest が空 + リンク無変換で RED
    expect(fs.readdirSync(path.join(noteB, 'images')).some(f => f.endsWith('my pic.png'))).toBe(true);
    expect(fs.readdirSync(path.join(noteB, 'files'))).toContain('my doc.docx');
    expect(rewrittenMarkdown).not.toContain('](images/my pic.png)');
});
