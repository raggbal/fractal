/**
 * batch-payload — 複数選択 D&D の payload 正規化（共有ヘルパ）
 * sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-MSEL-02/04 / design §4-1
 *
 * 🔴 **各面にコピーせず 1 実装を共有する**（`menu-placement.js` と同じ方針）:
 * reviewer iteration 1 QUAL-3 が、`treeBatchIds`（outliner.js）と `batchIdsOf`
 * （notes-folder-view.js）が **関数名以外 byte 一致**の 8 行を別名で複製していたことを検出した。
 * 同 sprint の `menu-placement.js` 冒頭が「同型の字面コピーで両方とも負値ガードを欠いていた実績が
 * ある」と名指し警告している失敗クラスそのものだったため、共有ヘルパへ寄せた。
 *
 * 後方互換（§4-1）: `{ v:1, items:[…] }`（複数）と `{ id:'abc' }` / `{ relPath:'a.txt' }`（単一・旧）の
 * 両方を受ける。旧形式を 1 件として読むので **既存の単一 drop TC が無変更で green のまま**になる。
 *
 * 登録は **6 点**（本番 3 面 + ハーネス 3 本）— 1 つ漏れると面単位で silent no-op:
 *   src/notesWebviewContent.ts / src/outlinerWebviewContent.ts / src/webviewContent.ts
 *   test/build-standalone-notes.js / test/build-standalone-outliner.js / test/build-standalone.js
 */
(function () {
    'use strict';

    /**
     * payload を item 配列に正規化する（新旧両形式）。
     *
     * @param {object|null} payload `{ v:1, items:[…] }` または単一オブジェクト
     * @returns {object[]} item 配列（`null` / `undefined` の要素は落とす）
     */
    function extractBatchItems(payload) {
        if (!payload) { return []; }
        var list = Array.isArray(payload.items) ? payload.items : [payload];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (list[i]) { out.push(list[i]); }
        }
        return out;
    }

    /**
     * payload から `id` を持つ item の id だけを取り出す（tree item 系が使う）。
     *
     * @param {object|null} payload
     * @returns {string[]} id 配列（描画順 = payload の順序）
     */
    function extractBatchIds(payload) {
        var items = extractBatchItems(payload);
        var ids = [];
        for (var i = 0; i < items.length; i++) {
            if (items[i].id) { ids.push(items[i].id); }
        }
        return ids;
    }

    /**
     * 種別混在（md + file）の複数選択を **1 本の配列に結合**する（design §4-2 rev2 / TASK-45）。
     *
     * 受け手が両 MIME を別々の batch で送ると件数ゲート（NFR-MSEL-02）が種別ごとのサブ配列でしか
     * 判定されない（150 + 150 = 300 件が無確認で通る）ため、送り手が各 item に付けた `seq`
     * （選択順 index）で結合し、**結合 bridge を 1 回**呼ぶ材料にする。`seq` を持たない旧形式は
     * 配列順で末尾に補う（後方互換）。
     *
     * @param {object[]} mdItems     tree-md payload の items（`{ id, filePath?, seq? }`）
     * @param {object[]} fileItems   tree-file payload の items（`{ id, seq? }`）
     * @param {object[]} [folderItems] tree-folder payload の items（`{ id, seq? }`。FR-FDP-01 / TASK-03 で追加）
     * @param {object[]} [outItems] `.out` の items（`{ id, filePath?, seq? }`。W10: ツリーの clipboard だけが使う。D&D は載せない）
     * @returns {{kind:'md'|'file'|'folder'|'out', id:string, filePath:string|null}[]} seq 昇順（同値は md → file → folder → out → 配列順）
     */
    function mergeTreeItemsBySeq(mdItems, fileItems, folderItems, outItems) {
        var buf = [];
        var push = function (list, kind) {
            for (var i = 0; i < (list || []).length; i++) {
                var it = list[i];
                if (!it || !it.id) { continue; }
                buf.push({
                    kind: kind, id: it.id, filePath: it.filePath || null,
                    seq: (typeof it.seq === 'number') ? it.seq : Number.MAX_SAFE_INTEGER,
                    ord: buf.length,
                });
            }
        };
        push(mdItems, 'md');
        push(fileItems, 'file');
        push(folderItems, 'folder');   // FR-FDP-01（TASK-03）: 3 種目。未指定なら push が空扱いで従来と同一
        push(outItems, 'out');         // W10: 4 種目（ツリーの clipboard 専用）。未指定なら従来と同一
        buf.sort(function (a, b) { return a.seq !== b.seq ? a.seq - b.seq : a.ord - b.ord; });
        var out = [];
        for (var j = 0; j < buf.length; j++) { out.push({ kind: buf[j].kind, id: buf[j].id, filePath: buf[j].filePath }); }
        return out;
    }

    /**
     * W10/W11: clipboard の payload は `text/html` の先頭タグの data 属性に encodeURIComponent(JSON) で埋める
     * （OS clipboard に custom MIME を載せられないため。outliner の `data-outliner-clipboard` と同じ方式）。
     * 受け手 4 面（md / outliner / ツリー / linkedfd）が同じ読み方をするための共有ヘルパ。
     *
     * @param {string} html  clipboard の text/html
     * @param {string} attr  属性名（`data-fractal-tree-clip` 等）
     * @returns {object|null} 壊れていれば null（受け手は「payload 無し」として扱う）
     */
    function readHtmlClipMeta(html, attr) {
        if (!html || !attr || html.indexOf(attr + '=') === -1) { return null; }
        var m = html.match(new RegExp(attr + '="([^"]*)"'));
        if (!m) { return null; }
        try { return JSON.parse(decodeURIComponent(m[1])); } catch (e) { return null; }
    }

    /** readHtmlClipMeta の対。`<div attr="…">行<br>行</div>`（行は外部アプリ向けの表示用に escape して並べる） */
    function buildHtmlClip(attr, meta, lines) {
        var esc = function (s) {
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        };
        return '<div ' + attr + '="' + encodeURIComponent(JSON.stringify(meta)) + '">'
            + (lines || []).map(esc).join('<br>') + '</div>';
    }

    /**
     * W1/W4: md の範囲選択ドラッグ（📎 = x-fractal-md-filelink / subpage = x-fractal-md-subpage）を
     * **選択順の 1 本の配列**に戻す（mergeTreeItemsBySeq の md リンク版）。
     *
     * 送り手（editor.js の dragstart）は種類ごとの MIME に `{ v:1, sourceMdPath, items:[{href,title?,seq}] }` を積む。
     * 受け手が MIME ごとに別々の batch を送ると件数ゲートが種類ごとに割れ、並びも種類順になるので、
     * `seq`（選択の中の文書順）で結合して **受け手 1 つにつき bridge 1 回**の材料にする。
     * 単一（旧形式 `{ href, sourceMdPath }`）は 1 件として読む（extractBatchItems と同じ後方互換）。
     *
     * @param {object|null} filePayload    x-fractal-md-filelink の payload
     * @param {object|null} subpagePayload x-fractal-md-subpage の payload
     * @returns {{sourceMdPath:string, items:{kind:'file'|'subpage', href:string, title?:string}[]}}
     *          items は seq 昇順（同値は file → subpage → 配列順）。href の無い item は落とす
     */
    function mergeMdLinksBySeq(filePayload, subpagePayload) {
        var buf = [];
        var push = function (payload, kind) {
            var list = extractBatchItems(payload);
            for (var i = 0; i < list.length; i++) {
                var it = list[i];
                if (!it || !it.href) { continue; }
                var o = { kind: kind, href: String(it.href) };
                if (typeof it.title === 'string') { o.title = it.title; }
                buf.push({ item: o, seq: (typeof it.seq === 'number') ? it.seq : Number.MAX_SAFE_INTEGER, ord: buf.length });
            }
        };
        push(filePayload, 'file');
        push(subpagePayload, 'subpage');
        buf.sort(function (a, b) { return a.seq !== b.seq ? a.seq - b.seq : a.ord - b.ord; });
        var out = [];
        for (var j = 0; j < buf.length; j++) { out.push(buf[j].item); }
        var src = (filePayload && filePayload.sourceMdPath) || (subpagePayload && subpagePayload.sourceMdPath) || '';
        return { sourceMdPath: String(src), items: out };
    }

    window.__batchPayload = {
        extractBatchItems: extractBatchItems,
        extractBatchIds: extractBatchIds,
        mergeTreeItemsBySeq: mergeTreeItemsBySeq,
        mergeMdLinksBySeq: mergeMdLinksBySeq,
        readHtmlClipMeta: readHtmlClipMeta,
        buildHtmlClip: buildHtmlClip,
        /** W10: ツリーの clipboard の属性名（送り手 = notes-file-panel.js / 受け手 = 4 面） */
        TREE_CLIP_ATTR: 'data-fractal-tree-clip',
    };
})();
