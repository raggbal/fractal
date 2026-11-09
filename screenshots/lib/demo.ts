/**
 * 撮影用の note（screenshots/data/notes）を作業フォルダへコピーして、アプリが開ける形にする。
 * data の outline.note の history（Recent）は note のフォルダからの相対パスで持ち、コピーしたときに絶対パスに直す。
 * 撮影はいつもコピーで行う（アプリが書き換えても data は変わらない）。本物の note・~/.fractal は使わない。
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const SHOTS_DIR = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(SHOTS_DIR, '..');
export const DATA_DIR = path.join(SHOTS_DIR, 'data');

export const NOTE_NAMES = ['projects', 'webapp1'] as const;
export type NoteName = (typeof NOTE_NAMES)[number];

/** 作業フォルダ（SHOTS_WORK、既定 /private/tmp/fractal-shots）。撮った元の画像・失敗したときの画面もここに残る */
export function workDir(): string {
    const dir = process.env.SHOTS_WORK || '/tmp/fractal-shots';
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync(dir);
}

/** 仕上がりの置き場（SHOTS_OUT を付けると、リポジトリの代わりにそこへ書く） */
export function outputDir(repoDir: string): string {
    const dir = process.env.SHOTS_OUT ? path.resolve(process.env.SHOTS_OUT) : path.join(REPO_ROOT, repoDir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function rmrf(p: string): void {
    fs.rmSync(p, { recursive: true, force: true });
}

/** data の note を dest/<name> へコピーする（前のコピーは消す）。返り値は note のフォルダ */
export function copyDemoNotes(dest: string): Record<NoteName, string> {
    const notes = {} as Record<NoteName, string>;
    for (const name of NOTE_NAMES) {
        const dir = path.join(dest, name);
        rmrf(dir);
        fs.cpSync(path.join(DATA_DIR, 'notes', name), dir, { recursive: true });
        const notePath = path.join(dir, 'outline.note');
        const note = JSON.parse(fs.readFileSync(notePath, 'utf8')) as { history?: Array<{ id: string }> };
        for (const h of note.history ?? []) {
            if (!path.isAbsolute(h.id)) {
                h.id = path.join(dir, h.id);
            }
        }
        fs.writeFileSync(notePath, JSON.stringify(note, null, 2) + '\n');
        notes[name] = dir;
    }
    return notes;
}

/** .fractal（note の一覧）を書く */
export function writeRegistry(file: string, noteDirs: string[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, notes: noteDirs }, null, 2) + '\n');
}

/** ホームページの「ファイルをサイドパネルに」: Team Tasks の This week に HTML のファイル（data/launch-dashboard.html）を付けたノードを足す */
export function attachDashboard(projectsDir: string): void {
    fs.mkdirSync(path.join(projectsDir, 'files'), { recursive: true });
    fs.copyFileSync(path.join(DATA_DIR, 'launch-dashboard.html'), path.join(projectsDir, 'files', 'launch-dashboard.html'));
    const tasksPath = path.join(projectsDir, 'msdemotasks001.out');
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    const week = tasks.rootIds[0];
    tasks.nodes.nfile001 = {
        id: 'nfile001', parentId: week, children: [], text: 'Launch dashboard.html', tags: [], isPage: false, pageId: null,
        collapsed: false, checked: null, subtext: '', images: [], filePath: 'files/launch-dashboard.html',
    };
    tasks.nodes[week].children.splice(2, 0, 'nfile001');
    fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2));
}

/** lib/image.py（Pillow）を呼ぶ */
export function image(...args: string[]): void {
    execFileSync('python3', ['-I', path.join(SHOTS_DIR, 'lib', 'image.py'), ...args], { stdio: 'inherit' });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** ウィンドウが指定の大きさになったか。macOS は画面（メニューバーと Dock を除いた所）に入らない高さを縮めるので、
 *  小さい画面では画像の大きさが変わる。SHOTS_ALLOW_SMALL=1 なら知らせるだけで、その大きさで撮る */
export function assertWindowSize(got: number[], want: { w: number; h: number }): void {
    if (got[0] === want.w && got[1] === want.h) {
        return;
    }
    const msg = `the window is ${got[0]} x ${got[1]}, not ${want.w} x ${want.h}: the screen is too small (hide the Dock, or use a bigger display)`;
    if (process.env.SHOTS_ALLOW_SMALL === '1') {
        console.warn(msg);
        return;
    }
    throw new Error(`${msg} — or set SHOTS_ALLOW_SMALL=1 to shoot at this size`);
}
