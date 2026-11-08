/**
 * The web clipper (chrome-extension/) against today's Fractal: it clips into a note made by Fractal's own
 * NotesFileManager (the current outline.note / .out format) through the clipper's real writer
 * (lib/clip-writer.js — the one the popup and the quick clip run), on a FileSystemDirectoryHandle over a temp
 * folder, and Fractal reads the result: the page md and its image are where Fractal's flat-layout.ts looks, the
 * md clip is a subpage link Fractal's parser recognizes, the clipped node draws as a page in the outliner, and
 * Fractal still loads the note. The destination list skips attachments and folder links.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';
import { resolveImagesDir, resolvePageFilePath } from '../../src/shared/flat-layout';

/* eslint-disable @typescript-eslint/no-var-requires */
const writer = require(path.resolve(__dirname, '../../chrome-extension/lib/clip-writer.js'));
const registry = require(path.resolve(__dirname, '../../chrome-extension/lib/folder-registry.js'));
const linkParser = require(path.resolve(__dirname, '../../src/shared/markdown-link-parser.js'));

/** FileSystemDirectoryHandle / FileSystemFileHandle over a real folder — the subset the clipper uses. */
class FileHandle {
    constructor(readonly file: string) {}
    get name(): string {
        return path.basename(this.file);
    }
    async getFile(): Promise<{ text(): Promise<string> }> {
        const buf = fs.readFileSync(this.file);
        return { text: async () => buf.toString('utf8') };
    }
    async createWritable(): Promise<{ write(d: unknown): Promise<void>; close(): Promise<void> }> {
        const chunks: Buffer[] = [];
        return {
            write: async (d: unknown) => {
                chunks.push(typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d as Uint8Array));
            },
            close: async () => fs.writeFileSync(this.file, Buffer.concat(chunks)),
        };
    }
}
class DirHandle {
    constructor(readonly dir: string) {}
    get name(): string {
        return path.basename(this.dir);
    }
    async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle> {
        const p = path.join(this.dir, name);
        if (!fs.existsSync(p)) {
            if (!opts?.create) throw new DOMException(`${name} not found`, 'NotFoundError');
            fs.mkdirSync(p);
        }
        return new DirHandle(p);
    }
    async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle> {
        const p = path.join(this.dir, name);
        if (!fs.existsSync(p)) {
            if (!opts?.create) throw new DOMException(`${name} not found`, 'NotFoundError');
            fs.writeFileSync(p, '');
        }
        return new FileHandle(p);
    }
}

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const EXTRACTED = {
    title: 'How to keep notes',
    url: 'https://example.com/notes',
    byline: 'Sam',
    siteName: 'Example',
    markdown: `Keep them close to the work.\n\n![chart](${PNG_1PX})\n`,
};
const LABELS = { source: 'Source', author: 'Author', site: 'Site' };

/** A note made by Fractal: an outliner, a markdown page, and (as Fractal's tree has them now) an attachment and a folder link. */
function makeNote(): { dir: string; outPath: string; outId: string; mdId: string } {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-clipper-')));
    const fm = new NotesFileManager(dir);
    fm.loadStructure();
    const outPath = fm.createFile('Clips');
    const mdId = path.basename(fm.createMarkdownFile('Reading list'), '.md');
    fm.dispose();
    const notePath = path.join(dir, 'outline.note');
    const note = JSON.parse(fs.readFileSync(notePath, 'utf8'));
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'files', 'spec.pdf'), '%PDF-1.4\n');
    note.items.fattach = { type: 'file', id: 'fattach', title: 'spec.pdf', ext: 'file', filename: 'spec.pdf' };
    note.items.flink = { type: 'file', id: 'flink', title: 'Shared docs', ext: 'folder', folderPath: dir };
    note.rootIds.push('fattach', 'flink');
    fs.writeFileSync(notePath, JSON.stringify(note, null, 2));
    return { dir, outPath, outId: path.basename(outPath, '.out'), mdId };
}

test.describe('web clipper × the current Fractal note format', () => {
    test('TC-CC-01 the destination list has the outliner and the md page, not the attachment or the folder link', () => {
        const n = makeNote();
        try {
            const note = JSON.parse(fs.readFileSync(path.join(n.dir, 'outline.note'), 'utf8'));
            expect(note.items.fattach.ext).toBe('file'); // the fixture really has Fractal's attachment / folder link items
            expect(note.items.flink.ext).toBe('folder');
            const targets = registry.extractTargets(note);
            const kinds = Object.fromEntries(targets.map((t: { id: string; kind: string }) => [t.id, t.kind]));
            expect(kinds).toEqual({ [n.outId]: 'out', [n.mdId]: 'md' }); // in the tree's order; no fattach / flink
        } finally {
            fs.rmSync(n.dir, { recursive: true, force: true });
        }
    });

    test('TC-CC-02 a clip into the outliner: the page md and its image are where Fractal reads them, and Fractal loads the note', async ({ page }) => {
        const n = makeNote();
        try {
            const before = JSON.parse(fs.readFileSync(n.outPath, 'utf8'));
            const steps: string[] = [];
            const r = await writer.clipToOutliner(new DirHandle(n.dir), n.outId, EXTRACTED, { labels: LABELS, onStatus: (k: string) => steps.push(k) });
            expect(steps).toEqual(['popup_loading_out', 'popup_saving_page_md', 'popup_saving_images', 'popup_writing_out']);

            const out = JSON.parse(fs.readFileSync(n.outPath, 'utf8'));
            expect(out.rootIds[0]).toBe(r.nodeId);
            expect(out.rootIds.slice(1)).toEqual(before.rootIds); // the existing nodes stay, after the clip
            expect(out.nodes[r.nodeId]).toMatchObject({ text: EXTRACTED.title, isPage: true, pageId: r.pageId, parentId: null });

            // the page md is the file Fractal opens for this node (flat-layout.ts — the canonical resolution)
            const hints = { pageDir: out.pageDir, imageDir: out.imageDir, fileDir: out.fileDir };
            const pageFile = resolvePageFilePath(n.outPath, r.pageId, n.dir, hints);
            expect(fs.existsSync(pageFile), pageFile).toBe(true);
            const md = fs.readFileSync(pageFile, 'utf8');
            expect(md.startsWith(`# ${EXTRACTED.title}\n`)).toBe(true);
            expect(md).toContain(`Source: [${EXTRACTED.url}](${EXTRACTED.url})`);
            // the data: image is a file in the images folder Fractal uses for this .out, linked relatively
            const m = /!\[chart\]\((images\/[^)]+\.png)\)/.exec(md);
            expect(m, md).not.toBeNull();
            expect(fs.existsSync(path.join(resolveImagesDir(n.outPath, n.dir, hints), path.basename(m![1])))).toBe(true);

            // Fractal still loads the note with the clipped .out
            const fm = new NotesFileManager(n.dir);
            const structure = fm.loadStructure();
            fm.dispose();
            expect(Object.keys(structure.items)).toContain(n.outId);

            // and the outliner draws the clipped node as a page
            await page.goto('/standalone-outliner.html');
            await page.waitForFunction(() => (window as any).__testApi?.ready);
            await page.evaluate((d) => (window as any).__testApi.initOutliner(d), out);
            const node = page.locator(`.outliner-node[data-id="${r.nodeId}"]`);
            await expect(node.locator('.outliner-text')).toHaveText(EXTRACTED.title);
            await expect(node.locator('.outliner-page-icon')).toHaveCount(1);
        } finally {
            fs.rmSync(n.dir, { recursive: true, force: true });
        }
    });

    test('TC-CC-03 a clip into a md page: a new md next to it and a subpage link Fractal recognizes', async () => {
        const n = makeNote();
        try {
            const fm = new NotesFileManager(n.dir);
            fm.loadStructure();
            const mdPath = fm.getMdFilePath(n.mdId);
            fm.dispose();
            expect(mdPath).toBe(path.join(n.dir, `${n.mdId}.md`)); // where the clipper looks for the md page

            const r = await writer.clipToMd(new DirHandle(n.dir), n.mdId, EXTRACTED, { labels: LABELS });
            const target = fs.readFileSync(mdPath, 'utf8');
            expect(target.startsWith('# Reading list')).toBe(true);
            const links = linkParser.parseMarkdownLinks(target);
            expect(links.filter((l: { isSubpage: boolean }) => l.isSubpage).map((l: { url: string; text?: string }) => l.url)).toEqual([r.newMdName]);
            const clipped = fs.readFileSync(path.join(n.dir, r.newMdName), 'utf8');
            expect(clipped.startsWith(`# ${EXTRACTED.title}\n`)).toBe(true);
            const img = /!\[chart\]\((images\/[^)]+\.png)\)/.exec(clipped);
            expect(img, clipped).not.toBeNull();
            expect(fs.existsSync(path.join(n.dir, img![1]))).toBe(true);
        } finally {
            fs.rmSync(n.dir, { recursive: true, force: true });
        }
    });
});
