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
     * @param {object[]} mdItems   tree-md payload の items（`{ id, filePath?, seq? }`）
     * @param {object[]} fileItems tree-file payload の items（`{ id, seq? }`）
     * @returns {{kind:'md'|'file', id:string, filePath:string|null}[]} seq 昇順（同値は md → file → 配列順）
     */
    function mergeTreeItemsBySeq(mdItems, fileItems) {
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
        buf.sort(function (a, b) { return a.seq !== b.seq ? a.seq - b.seq : a.ord - b.ord; });
        var out = [];
        for (var j = 0; j < buf.length; j++) { out.push({ kind: buf[j].kind, id: buf[j].id, filePath: buf[j].filePath }); }
        return out;
    }

    window.__batchPayload = {
        extractBatchItems: extractBatchItems,
        extractBatchIds: extractBatchIds,
        mergeTreeItemsBySeq: mergeTreeItemsBySeq,
    };
})();
