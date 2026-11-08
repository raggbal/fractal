/**
 * The web clipper (chrome-extension/) against today's Fractal: it clips into a note made by Fractal's own
 * NotesFileManager (the current outline.note / .out format) through the clipper's real writer
 * (lib/clip-writer.js — the one the popup and the quick clip run), on a FileSystemDirectoryHandle over a temp
 * folder, and Fractal reads the result: the page md and its image are where Fractal's flat-layout.ts looks, the
 * md clip is a subpage link Fractal's parser recognizes, the clipped node draws as a page in the outliner, and
 * Fractal still loads the note. The destination list skips attachments and folder links.
 *
 * The notes come from the .fractal Fractal writes (src/shared/notes-registry.ts): the clipper reads it like Fractal
 * does (lib/fractal-list.js), works out where a folder the user allowed sits in it, and saves into the right note
 * (lib/folder-registry.js — the code the popup, the options page and the quick clip run). IDB is a Map here.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';
import { resolveImagesDir, resolvePageFilePath } from '../../src/shared/flat-layout';
import { createRegistryFile, parseRegistry, serializeRegistry, updateRegistryNotes, writeRegistryAtomic } from '../../src/shared/notes-registry';

/* eslint-disable @typescript-eslint/no-var-requires */
const writer = require(path.resolve(__dirname, '../../chrome-extension/lib/clip-writer.js'));
const registry = require(path.resolve(__dirname, '../../chrome-extension/lib/folder-registry.js'));
const linkParser = require(path.resolve(__dirname, '../../src/shared/markdown-link-parser.js'));
const fractalList = require(path.resolve(__dirname, '../../chrome-extension/lib/fractal-list.js'));

/** IDB of the extension (lib/idb.js) — a Map */
const idb = new Map<string, unknown>();
(globalThis as any).FractalIdb = {
    get: async (k: string) => idb.get(k),
    set: async (k: string, v: unknown) => void idb.set(k, v),
    delete: async (k: string) => void idb.delete(k),
};

/** FileSystemDirectoryHandle / FileSystemFileHandle over a real folder — the subset the clipper uses. */
class FileHandle {
    readonly kind = 'file';
    constructor(readonly file: string, public perm: PermissionState = 'granted') {}
    async queryPermission(): Promise<PermissionState> {
        return this.perm;
    }
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
    readonly kind = 'directory';
    constructor(readonly dir: string, public perm: PermissionState = 'granted') {}
    async queryPermission(): Promise<PermissionState> {
        return this.perm;
    }
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

/** Notes made by Fractal under a temp "home", and the .fractal that lists them (written by Fractal's own code). */
function makeNotesHome(): { tmp: string; work: string; alpha: string; beta: string; gamma: string; listFile: string } {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-clipper-list-')));
    const work = path.join(tmp, 'Users', 'me', 'workspace', 'fractal');
    const mk = (dir: string, outTitle: string) => {
        fs.mkdirSync(dir, { recursive: true });
        const fm = new NotesFileManager(dir);
        fm.loadStructure();
        fm.createFile(outTitle);
        fm.dispose();
        return dir;
    };
    const alpha = mk(path.join(work, 'alpha'), 'Alpha clips');
    const beta = mk(path.join(work, 'beta'), 'Beta clips');
    const gamma = mk(path.join(tmp, 'Users', 'me', 'Documents', 'gamma'), 'Gamma clips');
    // a folder with the same name as the parent and a note's name, but not a note: the clipper must not take it for one
    fs.mkdirSync(path.join(tmp, 'repos', 'fractal', 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'Users', 'me', '.fractal'), { recursive: true });
    const listFile = createRegistryFile(path.join(tmp, 'Users', 'me', '.fractal'), 'default', [alpha, beta, gamma]);
    return { tmp, work, alpha, beta, gamma, listFile };
}

function outIdIn(noteDir: string): string {
    return path.basename(fs.readdirSync(noteDir).find((f) => f.endsWith('.out'))!, '.out');
}

test.describe('web clipper × the .fractal notes list', () => {
    test.beforeEach(() => idb.clear());

    test('TC-CC-04 the clipper reads a .fractal the way Fractal does', () => {
        const inputs = [
            serializeRegistry({ version: 1, notes: ['/a/b', '/a/b/', '/a/./c', '/a/x/../d', '/a//e'] }),
            serializeRegistry({ version: 1, notes: ['/n'], name: 'kept-unknown-key' }),
            '{"version":1,"notes":[]}',
            'not json',
            '[]',
            '{"notes":["/a"]}',
            '{"version":2,"notes":["/a"]}',
            '{"version":1,"notes":[1]}',
            '{"version":1}',
        ];
        for (const text of inputs) {
            const fractal = parseRegistry(text);
            const clipper = fractalList.parseFractalList(text);
            expect(clipper.ok, text).toBe(fractal.ok);
            if (fractal.ok) expect(clipper.notes, text).toEqual(fractal.doc.notes);
        }
    });

    test('TC-CC-05 a folder the user allows is placed in the .fractal by its name and the notes inside it', async () => {
        const h = makeNotesHome();
        try {
            const notes = [h.alpha, h.beta, h.gamma];
            // the parent of the notes → both notes in it
            expect(await fractalList.resolvePickedFolder(new DirHandle(h.work), notes)).toEqual({ path: h.work, notes: [h.alpha, h.beta] });
            // a note folder itself
            expect(await fractalList.resolvePickedFolder(new DirHandle(h.alpha), notes)).toEqual({ path: h.alpha, notes: [h.alpha] });
            // another folder named "fractal" with an "alpha" in it that is not a note → none
            expect((await fractalList.resolvePickedFolder(new DirHandle(path.join(h.tmp, 'repos', 'fractal')), notes)).reason).toBe('none');
            // two notes with the same folder name: picking one of them can't tell which → ambiguous; its parent can
            const one = path.join(h.tmp, 'one', 'n');
            const two = path.join(h.tmp, 'two', 'n');
            for (const d of [one, two]) {
                fs.mkdirSync(d, { recursive: true });
                const fm = new NotesFileManager(d);
                fm.loadStructure();
                fm.dispose();
            }
            expect((await fractalList.resolvePickedFolder(new DirHandle(one), [one, two])).reason).toBe('ambiguous');
            expect(await fractalList.resolvePickedFolder(new DirHandle(path.dirname(one)), [one, two])).toEqual({ path: path.dirname(one), notes: [one] });
        } finally {
            fs.rmSync(h.tmp, { recursive: true, force: true });
        }
    });

    test('TC-CC-06 choose the .fractal, allow the parent folder once, and a clip lands in the note picked; a note Fractal adds later shows up by itself', async () => {
        const h = makeNotesHome();
        try {
            await registry.setFractalList(new FileHandle(h.listFile));
            let list = await registry.readFractalList();
            expect(list).toMatchObject({ name: 'default.fractal', state: 'ok', notes: [h.alpha, h.beta, h.gamma] });
            let notes = await registry.listNotes(list);
            expect(notes.map((n: { permHandle: unknown }) => n.permHandle)).toEqual([null, null, null]); // nothing allowed yet
            // what to allow, on the paths as they are on a Mac (the temp home is not at /Users/<name>): not the home itself
            const asOnMac = (p: string) => p.slice(h.tmp.length);
            expect(fractalList.suggestFolders(notes.map((n: { path: string }) => asOnMac(n.path)))).toEqual([asOnMac(h.gamma), asOnMac(h.work)]);

            const r = await registry.addAccessRoot(new DirHandle(h.work), list.notes);
            expect(r).toEqual({ path: h.work, notes: [h.alpha, h.beta] });
            notes = await registry.listNotes(list);
            expect(notes.map((n: { id: string; rel: string | null }) => [n.id, n.rel])).toEqual([[h.alpha, 'alpha'], [h.beta, 'beta'], [h.gamma, null]]);

            // the clip goes into beta (the note found by its id, the way a preset / the quick clip finds it)
            const betaOut = path.join(h.beta, outIdIn(h.beta) + '.out');
            const alphaBefore = fs.readFileSync(path.join(h.alpha, outIdIn(h.alpha) + '.out'), 'utf8');
            const note = await registry.findNote(h.beta);
            const saved = await writer.clipToOutliner(await registry.noteHandle(note), outIdIn(h.beta), EXTRACTED, { labels: LABELS });
            const out = JSON.parse(fs.readFileSync(betaOut, 'utf8'));
            expect(out.nodes[saved.nodeId]).toMatchObject({ text: EXTRACTED.title, isPage: true });
            expect(fs.existsSync(resolvePageFilePath(betaOut, saved.pageId, h.beta, { pageDir: out.pageDir }))).toBe(true);
            expect(fs.readFileSync(path.join(h.alpha, outIdIn(h.alpha) + '.out'), 'utf8')).toBe(alphaBefore); // the other note is untouched
            const fm = new NotesFileManager(h.beta);
            expect(Object.keys(fm.loadStructure().items)).toContain(outIdIn(h.beta));
            fm.dispose();

            // Fractal adds a note under the allowed folder: the next read has it, and it can be saved to with no new grant
            const delta = path.join(h.work, 'delta');
            fs.mkdirSync(delta);
            const fm2 = new NotesFileManager(delta);
            fm2.loadStructure();
            fm2.dispose();
            updateRegistryNotes(h.listFile, (n) => [...n, delta]);
            list = await registry.readFractalList();
            expect(list.notes).toEqual([h.alpha, h.beta, h.gamma, delta]);
            const d = (await registry.listNotes(list)).find((n: { id: string }) => n.id === delta);
            expect(d.rel).toBe('delta');
            expect((await registry.noteHandle(d)).dir).toBe(delta);

            // a note no longer in the .fractal is not a destination any more
            updateRegistryNotes(h.listFile, (n) => n.filter((p) => p !== h.beta));
            await registry.readFractalList();
            expect(await registry.findNote(h.beta)).toBeNull();
        } finally {
            fs.rmSync(h.tmp, { recursive: true, force: true });
        }
    });

    test('TC-CC-07 a .fractal that cannot be read keeps the last list (and is not overwritten); a bad file is not taken', async () => {
        const h = makeNotesHome();
        try {
            const fh = new FileHandle(h.listFile);
            await registry.setFractalList(fh);
            fs.writeFileSync(h.listFile, '{ broken');
            let list = await registry.readFractalList();
            expect(list).toMatchObject({ state: 'error', notes: [h.alpha, h.beta, h.gamma] });
            expect((idb.get('fractalList') as { notes: string[] }).notes).toEqual([h.alpha, h.beta, h.gamma]);
            writeRegistryAtomic(h.listFile, { version: 1, notes: [h.alpha] });
            fh.perm = 'prompt'; // the permission ran out (e.g. Chrome restarted)
            list = await registry.readFractalList();
            expect(list).toMatchObject({ state: 'permission', notes: [h.alpha, h.beta, h.gamma] });
            fh.perm = 'granted';
            expect((await registry.readFractalList()).notes).toEqual([h.alpha]);
            // choosing a file that is not a .fractal leaves the setting as it was
            const bad = path.join(h.tmp, 'other.fractal');
            fs.writeFileSync(bad, '{"version":1,"notes":"x"}');
            await expect(registry.setFractalList(new FileHandle(bad))).rejects.toThrow();
            expect((idb.get('fractalList') as { name: string }).name).toBe('default.fractal');
        } finally {
            fs.rmSync(h.tmp, { recursive: true, force: true });
        }
    });

    test('TC-CC-08 notes registered one by one before move over to the .fractal, with their presets and last selection', async () => {
        const h = makeNotesHome();
        try {
            const zeta = path.join(h.tmp, 'elsewhere', 'zeta');
            fs.mkdirSync(zeta, { recursive: true });
            idb.set('notesFolders', [
                { id: 'f1', name: 'alpha', handle: new DirHandle(h.alpha) },
                { id: 'f2', name: 'zeta', handle: new DirHandle(zeta) }, // not in the .fractal → stays
                { id: 'f3', name: 'beta', handle: new DirHandle(h.beta, 'prompt') }, // no permission now → stays, untouched
            ]);
            idb.set('presets', [
                { id: 'p1', name: 'A', folderId: 'f1', targetId: 'o1', targetKind: 'out' },
                { id: 'p2', name: 'Z', folderId: 'f2', targetId: 'o2', targetKind: 'out' },
            ]);
            idb.set('lastSelection', { folderId: 'f1', outId: 'o1' });
            await registry.setFractalList(new FileHandle(h.listFile));
            const list = await registry.readFractalList();

            expect(await registry.adoptLegacyFolders(list.notes)).toBe(1);
            expect((await registry.listAccessRoots()).map((r: { path: string }) => r.path)).toEqual([h.alpha]);
            expect((idb.get('presets') as { folderId: string }[]).map((p) => p.folderId)).toEqual([h.alpha, 'f2']);
            expect(idb.get('lastSelection')).toEqual({ folderId: h.alpha, targetId: 'o1', targetKind: 'out' });
            expect((idb.get('notesFolders') as { id: string }[]).map((f) => f.id)).toEqual(['f2', 'f3']);
            const notes = await registry.listNotes(list);
            expect(notes.map((n: { id: string; source: string }) => [n.id, n.source])).toEqual([
                [h.alpha, 'list'], [h.beta, 'list'], [h.gamma, 'list'], ['f2', 'legacy'], ['f3', 'legacy'],
            ]);
            expect((await registry.noteHandle(await registry.findNote(h.alpha))).dir).toBe(h.alpha);

            // once the parent is allowed, beta (granted again) moves over without adding a second folder
            await registry.addAccessRoot(new DirHandle(h.work), list.notes);
            (idb.get('notesFolders') as { id: string; handle: DirHandle }[]).find((f) => f.id === 'f3')!.handle.perm = 'granted';
            expect(await registry.adoptLegacyFolders(list.notes)).toBe(1);
            expect((await registry.listAccessRoots()).map((r: { path: string }) => r.path)).toEqual([h.alpha, h.work]);
            expect((idb.get('notesFolders') as { id: string }[]).map((f) => f.id)).toEqual(['f2']);
        } finally {
            fs.rmSync(h.tmp, { recursive: true, force: true });
        }
    });

    test('TC-CC-09 the folder to allow: the common parent, split where it would be the home or too broad', () => {
        expect(fractalList.suggestFolders(['/Users/me/workspace/fractal/a', '/Users/me/workspace/fractal/b'])).toEqual(['/Users/me/workspace/fractal']);
        expect(fractalList.suggestFolders(['/Users/me/notes/a'])).toEqual(['/Users/me/notes/a']);
        expect(fractalList.suggestFolders(['/Users/me/a', '/Users/me/b'])).toEqual(['/Users/me/a', '/Users/me/b']);
        expect(fractalList.suggestFolders(['/Users/me/Documents/a', '/Users/me/Documents/b'])).toEqual(['/Users/me/Documents/a', '/Users/me/Documents/b']);
        expect(fractalList.suggestFolders(['C:\\Users\\me\\w\\a', 'C:\\Users\\me\\w\\b'])).toEqual(['C:/Users/me/w']);
        expect(fractalList.isTooBroad('/')).toBe(true);
        expect(fractalList.isTooBroad('/Users/me')).toBe(true);
        expect(fractalList.isTooBroad('/Users/me/workspace')).toBe(false);
    });
});
