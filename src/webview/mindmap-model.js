/**
 * MindmapModel — Mindmap Mode の純データ操作
 *
 * Outliner の同一ツリーモデル (OutlinerModel) を共有し、mindmap 固有の
 * 設定 (MindmapSettings) / グループ (Boundary) / 関連線 (Relationship) /
 * 浮遊トピック (Floating Topic) を扱う純関数群。DOM 非依存。
 *
 * 型・フィールドの正典: .harness/sprint/.../design/system/data-model.md
 */

// eslint-disable-next-line no-unused-vars
var MindmapModel = (function() {
    'use strict';

    // --- ID 生成 (mindmap 専用 prefix。Node='n' / Folder='f' と衝突しない) ---

    function generateGroupId() {
        return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    function generateRelationshipId() {
        return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    // --- MindmapSettings ---

    /** top-level mindmap 設定の既定値 (data-model.md §2) */
    function defaultMindmapSettings() {
        return {
            layout: 'right',        // 'radial' | 'right' | 'left' | 'balanced'
            linkStyle: 'curved',    // 'curved' | 'straight' | 'elbow' | 'rounded-elbow'
            linkColor: null,        // null = テーマ既定
            linkWidth: 2,
            siblingSpacing: 16,
            levelSpacing: 80,
            groups: [],             // Boundary[]
            relationships: []       // Relationship[]
        };
    }

    /**
     * 与えられた settings を既定値で埋めて正規化する。
     * ロード時に data.mindmap を通して欠落フィールドを補完するのに使う。
     */
    function normalizeSettings(settings) {
        var def = defaultMindmapSettings();
        if (!settings || typeof settings !== 'object') { return def; }
        return {
            layout: settings.layout || def.layout,
            linkStyle: settings.linkStyle || def.linkStyle,
            linkColor: (settings.linkColor !== undefined) ? settings.linkColor : def.linkColor,
            linkWidth: (typeof settings.linkWidth === 'number') ? settings.linkWidth : def.linkWidth,
            siblingSpacing: (typeof settings.siblingSpacing === 'number') ? settings.siblingSpacing : def.siblingSpacing,
            levelSpacing: (typeof settings.levelSpacing === 'number') ? settings.levelSpacing : def.levelSpacing,
            groups: Array.isArray(settings.groups) ? settings.groups.slice() : [],
            relationships: Array.isArray(settings.relationships) ? settings.relationships.slice() : []
        };
    }

    /**
     * settings が全デフォルトかどうか (serialize 時に省略するため)。
     * groups / relationships が空 かつ その他が既定値なら true。
     */
    function isDefaultSettings(settings) {
        if (!settings) { return true; }
        var def = defaultMindmapSettings();
        return settings.layout === def.layout &&
            settings.linkStyle === def.linkStyle &&
            (settings.linkColor === null || settings.linkColor === undefined) &&
            settings.linkWidth === def.linkWidth &&
            settings.siblingSpacing === def.siblingSpacing &&
            settings.levelSpacing === def.levelSpacing &&
            (!settings.groups || settings.groups.length === 0) &&
            (!settings.relationships || settings.relationships.length === 0);
    }

    // --- node.mindmap の正規化 ---

    /**
     * node.mindmap が全デフォルト (fill/stroke/shape すべて null かつ x/y なし) なら
     * node.mindmap を削除する。.out を無駄に肥大させないため。
     * (columnValues が空 map のとき同様に扱うのと同じ方針)
     */
    function normalizeNodeMindmap(node) {
        if (!node || !node.mindmap) { return; }
        var m = node.mindmap;
        var isEmpty =
            (m.fill === null || m.fill === undefined) &&
            (m.stroke === null || m.stroke === undefined) &&
            (m.shape === null || m.shape === undefined) &&
            (m.x === null || m.x === undefined) &&
            (m.y === null || m.y === undefined);
        if (isEmpty) {
            delete node.mindmap;
        }
    }

    /** node.mindmap を保証して返す (無ければ作る) */
    function ensureNodeMindmap(node) {
        if (!node.mindmap) {
            node.mindmap = { fill: null, stroke: null, shape: null, x: null, y: null };
        }
        return node.mindmap;
    }

    // --- Floating Topic ---

    /**
     * Floating Topic 判定: 親を持たず (parentId==null)、rootIds にも属さず、
     * mindmap.x/y を持つ孤立ノード (data-model.md §4)。
     */
    function isFloatingTopic(model, nodeId) {
        var n = model.nodes[nodeId];
        if (!n) { return false; }
        if (n.parentId != null) { return false; }         // 親を持つ = 構造ノード
        if (model.rootIds.indexOf(nodeId) >= 0) { return false; } // root = 構造ノード
        return !!(n.mindmap && n.mindmap.x != null && n.mindmap.y != null);
    }

    function getFloatingTopicIds(model) {
        var ids = [];
        for (var id in model.nodes) {
            if (model.nodes.hasOwnProperty(id) && isFloatingTopic(model, id)) {
                ids.push(id);
            }
        }
        return ids;
    }

    /**
     * 構造ノード → Floating Topic 化 (#H4)。
     * 既存 addNode/moveNode は必ず rootIds に push するため専用実装が必要。
     * 親 children / rootIds から除去し、parentId=null + 座標をセット。
     * children はそのまま保持 (浮遊サブツリー)。
     */
    function detachToFloating(model, nodeId, x, y) {
        var node = model.nodes[nodeId];
        if (!node) { return false; }
        // 1. 現在の親 children から除去
        if (node.parentId != null && model.nodes[node.parentId]) {
            var sib = model.nodes[node.parentId].children;
            var i = sib.indexOf(nodeId);
            if (i >= 0) { sib.splice(i, 1); }
        }
        // 2. rootIds から除去
        var ri = model.rootIds.indexOf(nodeId);
        if (ri >= 0) { model.rootIds.splice(ri, 1); }
        // 3. parentId=null + 座標
        node.parentId = null;
        var mm = ensureNodeMindmap(node);
        mm.x = x;
        mm.y = y;
        return true;
    }

    /**
     * Floating Topic → 構造ノード復帰 (#H4)。
     * moveNode で構造へ戻し (rootIds push は正しい挙動)、座標を消す。
     */
    function attachFromFloating(model, nodeId, newParentId, afterId) {
        var node = model.nodes[nodeId];
        if (!node) { return false; }
        model.moveNode(nodeId, newParentId, afterId);
        if (node.mindmap) {
            node.mindmap.x = null;
            node.mindmap.y = null;
            normalizeNodeMindmap(node);
        }
        return true;
    }

    // --- Boundary (グループ) ---

    /**
     * グループ作成 (data-model.md §2)。settings.groups に Boundary を追加して返す。
     */
    function createGroup(settings, nodeIds, label, color) {
        var group = {
            id: generateGroupId(),
            nodeIds: (nodeIds || []).slice(),
            label: (label !== undefined && label !== null) ? label : '',
            color: (color !== undefined) ? color : null
        };
        settings.groups = settings.groups || [];
        settings.groups.push(group);
        return group;
    }

    function removeGroup(settings, groupId) {
        if (!settings.groups) { return; }
        settings.groups = settings.groups.filter(function(g) { return g.id !== groupId; });
    }

    function updateGroup(settings, groupId, patch) {
        if (!settings.groups) { return; }
        for (var i = 0; i < settings.groups.length; i++) {
            if (settings.groups[i].id === groupId) {
                if (patch.label !== undefined) { settings.groups[i].label = patch.label; }
                if (patch.color !== undefined) { settings.groups[i].color = patch.color; }
                if (patch.nodeIds !== undefined) { settings.groups[i].nodeIds = patch.nodeIds.slice(); }
                return settings.groups[i];
            }
        }
        return null;
    }

    // --- Relationship (関連線) ---

    function createRelationship(settings, fromNodeId, toNodeId, label, color) {
        var rel = {
            id: generateRelationshipId(),
            fromNodeId: fromNodeId,
            toNodeId: toNodeId,
            label: (label !== undefined && label !== null) ? label : '',
            color: (color !== undefined) ? color : null
        };
        settings.relationships = settings.relationships || [];
        settings.relationships.push(rel);
        return rel;
    }

    function removeRelationship(settings, relId) {
        if (!settings.relationships) { return; }
        settings.relationships = settings.relationships.filter(function(r) { return r.id !== relId; });
    }

    function updateRelationship(settings, relId, patch) {
        if (!settings.relationships) { return; }
        for (var i = 0; i < settings.relationships.length; i++) {
            if (settings.relationships[i].id === relId) {
                if (patch.label !== undefined) { settings.relationships[i].label = patch.label; }
                if (patch.color !== undefined) { settings.relationships[i].color = patch.color; }
                return settings.relationships[i];
            }
        }
        return null;
    }

    // --- 端点欠損クリーンアップ (FR-021-H5, data-model.md §2) ---

    /**
     * 削除ノードへの参照を group.nodeIds / relationships から除去する。
     * - relationship: from/to のいずれかが nodes に存在しなければ除去。
     * - group: nodeIds から存在しない ID を除去。member 0 件になった group は除去。
     * 「参照除去」のみで他ノードのデータは一切消さない → no-data-loss を侵さない。
     * @returns {boolean} 変更があったか
     */
    function cleanupDanglingRefs(model, settings) {
        if (!settings) { return false; }
        var changed = false;
        var exists = function(id) { return !!model.nodes[id]; };

        if (settings.relationships && settings.relationships.length) {
            var relBefore = settings.relationships.length;
            settings.relationships = settings.relationships.filter(function(r) {
                return exists(r.fromNodeId) && exists(r.toNodeId);
            });
            if (settings.relationships.length !== relBefore) { changed = true; }
        }

        if (settings.groups && settings.groups.length) {
            var nextGroups = [];
            for (var i = 0; i < settings.groups.length; i++) {
                var g = settings.groups[i];
                var filtered = (g.nodeIds || []).filter(exists);
                if (filtered.length !== (g.nodeIds || []).length) { changed = true; }
                if (filtered.length > 0) {
                    g.nodeIds = filtered;
                    nextGroups.push(g);
                } else {
                    changed = true; // member 0 → group 除去
                }
            }
            settings.groups = nextGroups;
        }

        return changed;
    }

    // --- public API ---
    return {
        generateGroupId: generateGroupId,
        generateRelationshipId: generateRelationshipId,
        defaultMindmapSettings: defaultMindmapSettings,
        normalizeSettings: normalizeSettings,
        isDefaultSettings: isDefaultSettings,
        normalizeNodeMindmap: normalizeNodeMindmap,
        ensureNodeMindmap: ensureNodeMindmap,
        isFloatingTopic: isFloatingTopic,
        getFloatingTopicIds: getFloatingTopicIds,
        detachToFloating: detachToFloating,
        attachFromFloating: attachFromFloating,
        createGroup: createGroup,
        removeGroup: removeGroup,
        updateGroup: updateGroup,
        createRelationship: createRelationship,
        removeRelationship: removeRelationship,
        updateRelationship: updateRelationship,
        cleanupDanglingRefs: cleanupDanglingRefs
    };
})();

// Node.js module exports (テスト用)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MindmapModel;
}
