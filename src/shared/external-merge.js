/**
 * 外部変更の 3-way マージ（spec 20261027-1700-mcp-full-ops D3 の拡張機能側 / AC-6）
 *
 * ADRL-0045 の「保留照合（deferred reconcile）」の中で使う。外部（MCP・AI CLI 等）が
 * .out / outline.note / md を書き換えたとき、UI が持っている古い内容で丸ごと上書きしない。
 * UI の内容は「基準（UI が最後に読んだ / 書いた中身）からの変更」として扱い、disk の最新に重ねる。
 *
 * 規則（正典。host の NotesFileManager / md manager と webview の outliner.js / editor.js が同じ関数を呼ぶ）:
 *  - 片方だけが変えたところは、変えた側を取る。両方が同じに変えたらそれ。
 *  - 両方が別の値に変えたところ（本当の衝突）は UI（ours）を取る。ただし本文は消さない:
 *      .out の text / subtext → UI の内容をそのノードに残し、外部の内容は直後の兄弟ノード
 *        （id = 元 id + '-ext' + 内容の hash。同じ衝突を何度通しても 1 つ）に残す。
 *      md の行 → UI の行のあとに外部の行を並べる（両方残す）。
 *  - 片方が消し、もう片方が変えたもの（ノード・項目）は残す（消さない側に倒す）。
 *  - 子の並び（rootIds / children / childIds）は、UI の並びを土台に、外部が消したものを消し、
 *    外部が足したものを外部での直前の要素の後ろに入れる。
 *
 * 単一真実の共有方式（whole-word.js / inapp-link-utils.js と同じ UMD）:
 *  - host ts: require('./external-merge')
 *  - webview: notesWebviewContent.ts（本番 inline）+ test/build-standalone-notes.js（ハーネス）で
 *    window.ExternalMerge として outliner-model.js の前に読み込む
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.ExternalMerge = api;
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // ── 比較 ──

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    /** 「無い」と同じ扱いの値（serialize の既定値の省略・'' / [] / false の表記差を同じとみなす） */
    function isEmptyish(v) {
        if (v === undefined || v === null || v === '' || v === false) { return true; }
        if (Array.isArray(v)) { return v.length === 0; }
        if (isPlainObject(v)) { return Object.keys(v).length === 0; }
        return false;
    }

    function deepEqual(a, b) {
        if (a === b) { return true; }
        if (isEmptyish(a) && isEmptyish(b)) { return true; }
        if (Array.isArray(a) || Array.isArray(b)) {
            if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) { return false; }
            for (var i = 0; i < a.length; i++) {
                if (!deepEqual(a[i], b[i])) { return false; }
            }
            return true;
        }
        if (isPlainObject(a) && isPlainObject(b)) {
            var keys = unionKeys([a, b]);
            for (var k = 0; k < keys.length; k++) {
                if (!deepEqual(a[keys[k]], b[keys[k]])) { return false; }
            }
            return true;
        }
        return false;
    }

    function unionKeys(objs) {
        var seen = {};
        var out = [];
        for (var i = 0; i < objs.length; i++) {
            var o = objs[i];
            if (!isPlainObject(o)) { continue; }
            for (var k in o) {
                if (Object.prototype.hasOwnProperty.call(o, k) && !seen[k]) {
                    seen[k] = true;
                    out.push(k);
                }
            }
        }
        return out;
    }

    function clone(v) {
        return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    }

    /** 1 つの値の 3-way。conflict = 両方が別の値に変えた */
    function merge3Value(b, o, t) {
        if (deepEqual(o, b)) { return { v: t, conflict: false }; }
        if (deepEqual(t, b)) { return { v: o, conflict: false }; }
        if (deepEqual(o, t)) { return { v: o, conflict: false }; }
        return { v: o, conflict: true };
    }

    /** 文字列の短い hash（衝突コピーの id を決めるため。暗号用途ではない） */
    function shortHash(s) {
        var h = 5381;
        for (var i = 0; i < s.length; i++) {
            h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        }
        return (h >>> 0).toString(36);
    }

    // ── id の並び ──

    /**
     * id 配列の 3-way。UI（ours）の並びを土台に、外部（theirs）が消したものを消し、
     * 外部が足したものを外部での直前の要素の後ろに入れる。
     */
    function mergeIdList(base, ours, theirs) {
        base = Array.isArray(base) ? base : [];
        ours = Array.isArray(ours) ? ours : [];
        theirs = Array.isArray(theirs) ? theirs : [];
        if (deepEqual(ours, base)) { return theirs.slice(); }
        if (deepEqual(theirs, base)) { return ours.slice(); }
        var inBase = toSet(base);
        var inTheirs = toSet(theirs);
        var inOurs = toSet(ours);
        var result = [];
        for (var i = 0; i < ours.length; i++) {
            var id = ours[i];
            if (inBase[id] && !inTheirs[id]) { continue; } // 外部が消した
            result.push(id);
        }
        for (var j = 0; j < theirs.length; j++) {
            var tid = theirs[j];
            if (inBase[tid] || inOurs[tid]) { continue; } // 外部が足したものだけ
            var pos = 0;
            for (var k = j - 1; k >= 0; k--) {
                var idx = result.indexOf(theirs[k]);
                if (idx !== -1) { pos = idx + 1; break; }
            }
            result.splice(pos, 0, tid);
        }
        return result;
    }

    function toSet(arr) {
        var s = {};
        for (var i = 0; i < arr.length; i++) { s[arr[i]] = true; }
        return s;
    }

    // ── 木（.out の nodes / outline.note の items）共通 ──

    /**
     * id → 項目 の map の 3-way（項目そのものの扱い）。
     * mergeEntry(b, o, t) が両方にある項目の中身を合成する。
     */
    function mergeEntries(bMap, oMap, tMap, mergeEntry) {
        bMap = isPlainObject(bMap) ? bMap : {};
        oMap = isPlainObject(oMap) ? oMap : {};
        tMap = isPlainObject(tMap) ? tMap : {};
        var out = {};
        var ids = unionKeys([bMap, oMap, tMap]);
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            var inB = Object.prototype.hasOwnProperty.call(bMap, id);
            var inO = Object.prototype.hasOwnProperty.call(oMap, id);
            var inT = Object.prototype.hasOwnProperty.call(tMap, id);
            if (inO && inT) {
                out[id] = inB ? mergeEntry(bMap[id], oMap[id], tMap[id], id) : clone(oMap[id]);
            } else if (inO) {
                // 外部が消した（または UI だけが足した）。UI が変えていれば残す
                if (!inB || !deepEqual(oMap[id], bMap[id])) { out[id] = clone(oMap[id]); }
            } else if (inT) {
                // UI が消した（または外部だけが足した）。外部が変えていれば残す
                if (!inB || !deepEqual(tMap[id], bMap[id])) { out[id] = clone(tMap[id]); }
            }
        }
        return out;
    }

    // ── .out ──

    var OUT_TEXT_FIELDS = ['text', 'subtext'];

    /**
     * .out データ（parse 済み object）の 3-way マージ。
     * @returns {{ data: object, conflicts: string[] }} conflicts = 本文が衝突したノード id
     */
    function mergeOutData(base, ours, theirs) {
        base = isPlainObject(base) ? base : {};
        ours = isPlainObject(ours) ? ours : {};
        theirs = isPlainObject(theirs) ? theirs : {};
        var conflicts = [];
        var conflictCopies = [];
        var out = {};

        // top-level（title / taskMode / viewMode / columns / pageDir ...）
        var keys = unionKeys([base, ours, theirs]);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k === 'nodes' || k === 'rootIds') { continue; }
            var r = merge3Value(base[k], ours[k], theirs[k]);
            if (r.v !== undefined) { out[k] = clone(r.v); }
        }

        var bNodes = toNodeMap(base.nodes);
        var oNodes = toNodeMap(ours.nodes);
        var tNodes = toNodeMap(theirs.nodes);
        var nodes = mergeEntries(bNodes, oNodes, tNodes, function (b, o, t, id) {
            var node = {};
            var fields = unionKeys([b, o, t]);
            var textConflict = false;
            for (var f = 0; f < fields.length; f++) {
                var name = fields[f];
                var v;
                if (name === 'children') {
                    v = mergeIdList(b.children, o.children, t.children);
                } else {
                    var mr = merge3Value(b[name], o[name], t[name]);
                    v = mr.v;
                    if (mr.conflict && OUT_TEXT_FIELDS.indexOf(name) !== -1) { textConflict = true; }
                }
                if (v !== undefined) { node[name] = clone(v); }
            }
            if (textConflict) {
                conflicts.push(id);
                conflictCopies.push({ id: id, theirs: t });
            }
            return node;
        });

        // 消された親の下に残ったノード（どちらかが変えた）→ 親も残す
        resurrectAncestors(nodes, [oNodes, tNodes, bNodes], 'parentId');

        var rootIds = mergeIdList(base.rootIds, ours.rootIds, theirs.rootIds);
        normalizeOutTree(nodes, rootIds);

        // 本文の衝突: 外部の内容を直後の兄弟に残す（id は内容で決める = 何度通しても 1 つ）
        for (var c = 0; c < conflictCopies.length; c++) {
            var cc = conflictCopies[c];
            var src = nodes[cc.id];
            if (!src) { continue; }
            var t = cc.theirs || {};
            var copyId = cc.id + '-ext' + shortHash(String(t.text || '') + '\u0000' + String(t.subtext || ''));
            if (nodes[copyId]) { continue; }
            nodes[copyId] = {
                id: copyId,
                parentId: src.parentId === undefined ? null : src.parentId,
                children: [],
                text: t.text || '',
                subtext: t.subtext || '',
                tags: Array.isArray(t.tags) ? t.tags.slice() : [],
            };
            var list = src.parentId && nodes[src.parentId] ? nodes[src.parentId].children : rootIds;
            var at = list.indexOf(cc.id);
            list.splice(at === -1 ? list.length : at + 1, 0, copyId);
        }

        out.rootIds = rootIds;
        out.nodes = nodes;
        return { data: out, conflicts: conflicts };
    }

    function toNodeMap(nodes) {
        if (Array.isArray(nodes)) {
            var m = {};
            for (var i = 0; i < nodes.length; i++) {
                if (nodes[i] && nodes[i].id) { m[nodes[i].id] = nodes[i]; }
            }
            return m;
        }
        return isPlainObject(nodes) ? nodes : {};
    }

    /** 残ったノードの親が消えていたら、どこかの版から親を戻す（子を宙に浮かせない） */
    function resurrectAncestors(map, sources, parentKey) {
        var ids = Object.keys(map);
        for (var i = 0; i < ids.length; i++) {
            var cur = map[ids[i]];
            var guard = 0;
            while (cur && cur[parentKey] && !map[cur[parentKey]] && guard++ < 1000) {
                var pid = cur[parentKey];
                var found = null;
                for (var s = 0; s < sources.length; s++) {
                    if (sources[s][pid]) { found = sources[s][pid]; break; }
                }
                if (!found) { break; }
                map[pid] = clone(found);
                cur = map[pid];
            }
        }
    }

    /**
     * .out の木を整える: 各ノードはちょうど 1 つの並び（rootIds か親の children）にだけ入る。
     * parentId（3-way 済み）を正とし、並びにいないものは末尾に足し、いないはずの所からは外す。
     */
    function normalizeOutTree(nodes, rootIds) {
        var id;
        // 親が無い・循環 → root へ
        for (id in nodes) {
            if (!Object.prototype.hasOwnProperty.call(nodes, id)) { continue; }
            var n = nodes[id];
            if (n.parentId && !nodes[n.parentId]) { n.parentId = null; }
        }
        for (id in nodes) {
            if (!Object.prototype.hasOwnProperty.call(nodes, id)) { continue; }
            var seen = {};
            var cur = nodes[id];
            while (cur && cur.parentId) {
                if (seen[cur.id]) { nodes[id].parentId = null; break; }
                seen[cur.id] = true;
                cur = nodes[cur.parentId];
            }
        }
        var placed = {};
        var filterList = function (list, ownerId) {
            var res = [];
            for (var i = 0; i < list.length; i++) {
                var cid = list[i];
                var node = nodes[cid];
                if (!node || placed[cid]) { continue; }
                var pid = node.parentId || null;
                if (pid !== ownerId) { continue; }
                placed[cid] = true;
                res.push(cid);
            }
            return res;
        };
        var newRoot = filterList(rootIds, null);
        rootIds.length = 0;
        Array.prototype.push.apply(rootIds, newRoot);
        for (id in nodes) {
            if (!Object.prototype.hasOwnProperty.call(nodes, id)) { continue; }
            nodes[id].children = filterList(Array.isArray(nodes[id].children) ? nodes[id].children : [], id);
        }
        for (id in nodes) {
            if (!Object.prototype.hasOwnProperty.call(nodes, id) || placed[id]) { continue; }
            var p = nodes[id].parentId;
            if (p && nodes[p]) { nodes[p].children.push(id); } else { nodes[id].parentId = null; rootIds.push(id); }
            placed[id] = true;
        }
    }

    /** JSON 文字列どうしの .out マージ。theirs が読めなければ null（呼び出し側は従来どおり） */
    function mergeOutJson(baseStr, oursStr, theirsStr) {
        var t = safeParse(theirsStr);
        var o = safeParse(oursStr);
        if (!t || !o) { return null; }
        var b = safeParse(baseStr) || {};
        var r = mergeOutData(b, o, t);
        return { json: JSON.stringify(r.data, null, 2), data: r.data, conflicts: r.conflicts };
    }

    function safeParse(s) {
        if (typeof s !== 'string') { return null; }
        try {
            var v = JSON.parse(s);
            return isPlainObject(v) ? v : null;
        } catch (e) {
            return null;
        }
    }

    /** 2 つの .out データが中身として同じか（表記差・既定値の省略は同じとみなす） */
    function sameOutData(a, b) {
        return deepEqual(a, b);
    }

    // ── outline.note ──

    /**
     * outline.note 構造の 3-way マージ。UI が触っていない項目（外部が足した md 等）は落とさない。
     * @returns {object} 合成した構造
     */
    function mergeNoteStructure(base, ours, theirs) {
        base = isPlainObject(base) ? base : {};
        ours = isPlainObject(ours) ? ours : {};
        theirs = isPlainObject(theirs) ? theirs : {};
        var out = {};
        var keys = unionKeys([base, ours, theirs]);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k === 'items' || k === 'rootIds') { continue; }
            var r = merge3Value(base[k], ours[k], theirs[k]);
            if (r.v !== undefined) { out[k] = clone(r.v); }
        }
        var bItems = isPlainObject(base.items) ? base.items : {};
        var oItems = isPlainObject(ours.items) ? ours.items : {};
        var tItems = isPlainObject(theirs.items) ? theirs.items : {};
        var items = mergeEntries(bItems, oItems, tItems, function (b, o, t) {
            var item = {};
            var fields = unionKeys([b, o, t]);
            for (var f = 0; f < fields.length; f++) {
                var name = fields[f];
                var v = name === 'childIds'
                    ? mergeIdList(b.childIds, o.childIds, t.childIds)
                    : merge3Value(b[name], o[name], t[name]).v;
                if (v !== undefined) { item[name] = clone(v); }
            }
            return item;
        });
        var rootIds = mergeIdList(base.rootIds, ours.rootIds, theirs.rootIds);

        // 各項目の親（どの並びに入るか）を 3-way で決める
        var parentOf = function (s) {
            var m = {};
            var sItems = isPlainObject(s.items) ? s.items : {};
            (Array.isArray(s.rootIds) ? s.rootIds : []).forEach(function (id) { if (!(id in m)) { m[id] = null; } });
            Object.keys(sItems).forEach(function (fid) {
                var it = sItems[fid];
                if (it && it.type === 'folder' && Array.isArray(it.childIds)) {
                    it.childIds.forEach(function (cid) { if (!(cid in m)) { m[cid] = fid; } });
                }
            });
            return m;
        };
        var pB = parentOf(base);
        var pO = parentOf(ours);
        var pT = parentOf(theirs);
        var wantParent = {};
        Object.keys(items).forEach(function (id) {
            var b = id in pB ? pB[id] : undefined;
            var o = id in pO ? pO[id] : undefined;
            var t = id in pT ? pT[id] : undefined;
            var p;
            if (o === undefined) { p = t; } else if (t === undefined) { p = o; } else { p = (o === b) ? t : o; }
            if (p === undefined) { p = null; }
            if (p !== null && !(items[p] && items[p].type === 'folder')) { p = null; }
            wantParent[id] = p;
        });
        // 循環（フォルダが自分の子孫に入る）→ root へ
        Object.keys(wantParent).forEach(function (id) {
            var seen = {};
            var cur = id;
            while (cur !== null && cur !== undefined) {
                if (seen[cur]) { wantParent[id] = null; break; }
                seen[cur] = true;
                cur = wantParent[cur];
            }
        });
        var placed = {};
        var filterList = function (list, owner) {
            var res = [];
            for (var j = 0; j < list.length; j++) {
                var cid = list[j];
                if (!items[cid] || placed[cid] || wantParent[cid] !== owner) { continue; }
                placed[cid] = true;
                res.push(cid);
            }
            return res;
        };
        rootIds = filterList(rootIds, null);
        Object.keys(items).forEach(function (id) {
            if (items[id].type === 'folder') {
                items[id].childIds = filterList(Array.isArray(items[id].childIds) ? items[id].childIds : [], id);
            }
        });
        Object.keys(items).forEach(function (id) {
            if (placed[id]) { return; }
            var p = wantParent[id];
            if (p !== null && items[p] && items[p].type === 'folder') { items[p].childIds.push(id); } else { rootIds.push(id); }
            placed[id] = true;
        });
        out.rootIds = rootIds;
        out.items = items;
        return out;
    }

    // ── md（行単位の diff3） ──

    var LCS_CELL_LIMIT = 4000000;

    /** a の各行が b のどの行に対応するか（LCS）。対応なしは -1 */
    function lcsMatch(a, b) {
        var m = new Array(a.length);
        for (var x = 0; x < a.length; x++) { m[x] = -1; }
        var pre = 0;
        while (pre < a.length && pre < b.length && a[pre] === b[pre]) { m[pre] = pre; pre++; }
        var suf = 0;
        while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
            m[a.length - 1 - suf] = b.length - 1 - suf;
            suf++;
        }
        var a0 = pre, n = a.length - suf - pre;
        var b0 = pre, mm = b.length - suf - pre;
        if (n <= 0 || mm <= 0 || n * mm > LCS_CELL_LIMIT) { return m; }
        var w = mm + 1;
        var L = new Uint32Array((n + 1) * w);
        for (var i = n - 1; i >= 0; i--) {
            for (var j = mm - 1; j >= 0; j--) {
                L[i * w + j] = (a[a0 + i] === b[b0 + j])
                    ? L[(i + 1) * w + j + 1] + 1
                    : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
            }
        }
        var ii = 0, jj = 0;
        while (ii < n && jj < mm) {
            if (a[a0 + ii] === b[b0 + jj]) { m[a0 + ii] = b0 + jj; ii++; jj++; }
            else if (L[(ii + 1) * w + jj] >= L[ii * w + jj + 1]) { ii++; }
            else { jj++; }
        }
        return m;
    }

    function sameLines(x, y) {
        if (x.length !== y.length) { return false; }
        for (var i = 0; i < x.length; i++) { if (x[i] !== y[i]) { return false; } }
        return true;
    }

    /**
     * 行単位の 3-way マージ（diff3）。改行は LF に揃えてから比べる。
     * 衝突した塊は UI（ours）の行のあとに外部（theirs）の行を並べる（両方残す）。
     * @returns {{ text: string, conflicts: number }}
     */
    function mergeText(base, ours, theirs) {
        var norm = function (s) { return String(s == null ? '' : s).replace(/\r\n/g, '\n'); };
        var bs = norm(base), os = norm(ours), ts = norm(theirs);
        if (os === bs || os === ts) { return { text: ts, conflicts: 0 }; }
        if (ts === bs) { return { text: os, conflicts: 0 }; }
        var o = bs.split('\n'), a = os.split('\n'), b = ts.split('\n');
        var mA = lcsMatch(o, a), mB = lcsMatch(o, b);
        var out = [];
        var conflicts = 0;
        var io = 0, ia = 0, ib = 0;
        for (;;) {
            while (io < o.length && mA[io] === ia && mB[io] === ib) {
                out.push(o[io]); io++; ia++; ib++;
            }
            var jx = io;
            while (jx < o.length && !(mA[jx] !== -1 && mB[jx] !== -1)) { jx++; }
            var ea = jx < o.length ? mA[jx] : a.length;
            var eb = jx < o.length ? mB[jx] : b.length;
            var oc = o.slice(io, jx), ac = a.slice(ia, ea), bc = b.slice(ib, eb);
            if (oc.length || ac.length || bc.length) {
                if (sameLines(ac, oc)) { Array.prototype.push.apply(out, bc); }
                else if (sameLines(bc, oc)) { Array.prototype.push.apply(out, ac); }
                else if (sameLines(ac, bc)) { Array.prototype.push.apply(out, ac); }
                else {
                    conflicts++;
                    Array.prototype.push.apply(out, ac);
                    Array.prototype.push.apply(out, bc);
                }
            }
            if (jx >= o.length) { break; }
            io = jx; ia = ea; ib = eb;
        }
        return { text: out.join('\n'), conflicts: conflicts };
    }

    return {
        mergeOutData: mergeOutData,
        mergeOutJson: mergeOutJson,
        sameOutData: sameOutData,
        mergeNoteStructure: mergeNoteStructure,
        mergeText: mergeText,
        mergeIdList: mergeIdList,
        deepEqual: deepEqual,
    };
});
