/** Fractal List — .fractal（Fractal の note の一覧: { version: 1, notes: [<note フォルダの絶対パス>] }）から
 *  クリッパーの note を作る部品（DOM・chrome.*・IDB に依存しない。node から require できる）。
 *
 *  ブラウザは .fractal に書かれたパスを開けない（File System Access はユーザーが選んだフォルダだけ）。
 *  そこで「許可したフォルダ」（access root = 選ばれたフォルダの handle と、それが .fractal のどのパスか）を持ち、
 *  note のパスがその下にあれば handle をたどって開く。handle は自分の絶対パスを教えないので、どのパスかは
 *  選ばれたフォルダの名前を note のパスの途中に探し、その下に note（outline.note）が実際にあるかで決める。
 */
(function (global) {
    'use strict';

    const VERSION = 1; // 本体 src/shared/notes-registry.ts の REGISTRY_VERSION

    /** パスの正規化（本体 normalizeNotes の path.resolve 相当）: '\' → '/'、'.'・'..'・重複 '/'・末尾 '/' を畳む */
    function normalizePath(p) {
        const s = String(p || '').replace(/\\/g, '/');
        const out = [];
        for (const seg of s.split('/')) {
            if (!seg || seg === '.') continue;
            if (seg === '..') {
                if (out.length && !/^[A-Za-z]:$/.test(out[out.length - 1])) out.pop();
                continue;
            }
            out.push(seg);
        }
        return (s.startsWith('/') ? '/' : '') + out.join('/');
    }

    function baseName(p) {
        const segs = normalizePath(p).split('/');
        return segs[segs.length - 1] || '';
    }

    /** .fractal の本文を読む（本体 parseRegistry と同じ判定）。{ ok: true, notes } / { ok: false, error } */
    function parseFractalList(text) {
        let raw;
        try {
            raw = JSON.parse(text);
        } catch {
            return { ok: false, error: 'Invalid JSON.' };
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Not a .fractal notes list.' };
        if (typeof raw.version !== 'number') return { ok: false, error: 'Not a .fractal notes list (no version).' };
        if (raw.version !== VERSION) return { ok: false, error: 'Unsupported version ' + raw.version + '.' };
        if (!Array.isArray(raw.notes) || raw.notes.some((n) => typeof n !== 'string')) {
            return { ok: false, error: 'Not a .fractal notes list (notes must be a list of paths).' };
        }
        const notes = [];
        for (const n of raw.notes) {
            const p = normalizePath(n);
            if (p && !notes.includes(p)) notes.push(p);
        }
        return { ok: true, notes: notes };
    }

    /** p が base と同じか、その下なら base からの相対パス（'' = 同じ）。違えば null */
    function relUnder(base, p) {
        const b = normalizePath(base);
        const q = normalizePath(p);
        if (q === b) return '';
        const prefix = b.endsWith('/') ? b : b + '/';
        return b && q.startsWith(prefix) ? q.slice(prefix.length) : null;
    }

    /** note のパスの途中で、名前が folderName のフォルダのパス（= 選ばれたフォルダの候補）。深い順 */
    function candidateBases(folderName, notePath) {
        const segs = normalizePath(notePath).split('/');
        const out = [];
        for (let i = segs.length; i >= 1; i--) {
            if (segs[i - 1] === folderName) out.push(segs.slice(0, i).join('/'));
        }
        return out;
    }

    /** 許可したフォルダ（{ path, handle }）のうち、note のパスを含む一番深いもの。無ければ null */
    function rootFor(roots, notePath) {
        let best = null;
        for (const r of roots || []) {
            if (relUnder(r.path, notePath) === null) continue;
            if (!best || normalizePath(r.path).length > normalizePath(best.path).length) best = r;
        }
        return best;
    }

    /** handle から相対パスのフォルダをたどる（作らない）。無ければ throw */
    async function dirAt(handle, rel) {
        let cur = handle;
        for (const seg of String(rel || '').split('/').filter((s) => s)) {
            cur = await cur.getDirectoryHandle(seg);
        }
        return cur;
    }

    /** handle の下の rel に note（outline.note のあるフォルダ）があるか */
    async function hasNoteAt(handle, rel) {
        try {
            await (await dirAt(handle, rel)).getFileHandle('outline.note');
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 選ばれたフォルダが .fractal のどのパスかを決める。名前が合う候補のうち、その下に実際にある note が一番多いもの。
     * 返り値: { path, notes: [その下にある note のパス] } / { path: null, notes: [], reason: 'none' | 'ambiguous' }
     * （none = .fractal のどの note も入っていない、ambiguous = 同じだけ当てはまる候補が 2 つ以上）
     */
    async function resolvePickedFolder(handle, notePaths) {
        const found = new Map(); // 候補のパス → その下で見つかった note
        for (const p of notePaths || []) {
            for (const base of candidateBases(handle.name, p)) {
                if (!(await hasNoteAt(handle, relUnder(base, p)))) continue;
                if (!found.has(base)) found.set(base, []);
                found.get(base).push(p);
            }
        }
        const ranked = Array.from(found, ([path, notes]) => ({ path: path, notes: notes }))
            .sort((a, b) => b.notes.length - a.notes.length);
        if (ranked.length === 0) return { path: null, notes: [], reason: 'none' };
        if (ranked.length > 1 && ranked[1].notes.length === ranked[0].notes.length) {
            return { path: null, notes: [], reason: 'ambiguous' };
        }
        return ranked[0];
    }

    /** 1 つのフォルダとして許可するには広すぎるか（ルート・ドライブ・/Users・ホーム。ホーム直下の
     *  Desktop / Documents / Downloads も Chrome がフォルダごとは選ばせない） */
    function isTooBroad(p) {
        const n = normalizePath(p);
        if (n.split('/').filter((s) => s).length < 2) return true;
        return /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(\/(Desktop|Documents|Downloads))?$/.test(n);
    }

    function commonAncestor(a, b) {
        const x = normalizePath(a).split('/');
        const y = normalizePath(b).split('/');
        let i = 0;
        while (i < x.length && i < y.length && x[i] === y[i]) i++;
        return x.slice(0, i).join('/') || (normalizePath(a).startsWith('/') ? '/' : '');
    }

    /** まだ開けない note をまとめて許可できるフォルダの案（共通の親。広すぎるなら分ける。note 1 つならそのフォルダ） */
    function suggestFolders(notePaths) {
        const sorted = Array.from(new Set((notePaths || []).map(normalizePath).filter((p) => p))).sort();
        const out = [];
        let cur = null;
        for (const p of sorted) {
            if (cur !== null) {
                const c = commonAncestor(cur, p);
                if (!isTooBroad(c)) {
                    cur = c;
                    continue;
                }
                out.push(cur);
            }
            cur = p;
        }
        if (cur !== null) out.push(cur);
        return out;
    }

    const api = {
        normalizePath: normalizePath,
        baseName: baseName,
        parseFractalList: parseFractalList,
        relUnder: relUnder,
        candidateBases: candidateBases,
        rootFor: rootFor,
        dirAt: dirAt,
        hasNoteAt: hasNoteAt,
        resolvePickedFolder: resolvePickedFolder,
        isTooBroad: isTooBroad,
        suggestFolders: suggestFolders
    };

    global.FractalList = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
