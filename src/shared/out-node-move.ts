/**
 * out-node-move — outliner node サブツリーを別 .out へ move する純関数群（FR-NM-03）。
 *
 * vscode / fs 非依存。2 つの .out json オブジェクト（src / target）を受けて、
 * 「サブツリー収集 → 新 id 採番 → target rootIds 先頭挿入 → src から削除」を行う。
 * 副作用（fs 読み書き・dir 解決）は notesEditorProvider 側が担い、本モジュールは
 * pure なので test/unit で単体検証できる（designer_failures: vscode 依存を純粋部分に切り出す）。
 */

/** .out json の node（既存 outliner-model.js と一致。children で親子・childIds は旧フィールド） */
export interface OutNode {
    id: string;
    parentId?: string | null;
    children: string[];
    text?: string;
    tags?: string[];
    isPage?: boolean;
    pageId?: string | null;
    collapsed?: boolean;
    checked?: boolean | null;
    subtext?: string;
    images?: string[];
    filePath?: string | null;
    [k: string]: unknown;
}

/** .out json（rootIds + nodes マップ） */
export interface OutDoc {
    version?: number;
    rootIds: string[];
    nodes: Record<string, OutNode>;
    [k: string]: unknown;
}

/**
 * node とその子孫の id を DFS で収集（自身含む）。outliner-model.getDescendantIds と同じ辿り方。
 */
export function collectSubtreeIds(doc: OutDoc, rootNodeId: string): string[] {
    const result: string[] = [];
    const node = doc.nodes?.[rootNodeId];
    if (!node) return result;
    result.push(rootNodeId);
    const stack: string[] = (node.children || []).slice();
    while (stack.length > 0) {
        const id = stack.pop()!;
        const child = doc.nodes?.[id];
        if (!child) continue;
        result.push(id);
        const kids = child.children || [];
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return result;
}

/**
 * 新しい node id を採番する。target の既存 id 集合と衝突しない値を返す。
 * webview 側の生成規則（'n' + base36 時刻 + ランダム）と衝突しない形にするが、
 * テストの決定性のため counter を注入できる（省略時は seed から連番）。
 */
export function makeIdAllocator(existingIds: Set<string>, seed: string): () => string {
    let counter = 0;
    return function allocate(): string {
        let id: string;
        do {
            id = 'n' + seed + counter.toString(36);
            counter++;
        } while (existingIds.has(id));
        existingIds.add(id);
        return id;
    };
}

export interface MoveResult {
    /** target に挿入した（複製後の）サブツリー root の新 id */
    newRootId: string;
    /** 旧 id → 新 id のマップ（アセット参照引き継ぎのデバッグ・検証用） */
    idMap: Record<string, string>;
}

/**
 * src .out の nodeId サブツリーを target .out の rootIds 先頭へ move する。
 * - src === target（同一 doc 参照 or 同一 outFileKey）の場合は呼び出し側で弾く前提（ここでは動作未定義）。
 * - アセット（pageId / images / filePath）の参照文字列はそのまま引き継ぐ（同一 note flat 共有 = 物理移動不要・1:1 所有付替え）。
 * - target と src を **in-place で変更**する（呼び出し側が変更後 doc を保存する）。
 *
 * @param src        移動元 .out doc（変更される: サブツリー削除）
 * @param target     移動先 .out doc（変更される: rootIds 先頭に複製サブツリー追加）
 * @param nodeId     移動する src のサブツリー root node id
 * @param idSeed     新 id 採番の seed（呼び出し側が時刻等を渡す。テストは固定値で決定的に）
 */
export function moveSubtreeToOtherOut(
    src: OutDoc,
    target: OutDoc,
    nodeId: string,
    idSeed: string,
): MoveResult | null {
    if (!src?.nodes?.[nodeId]) return null;
    target.nodes = target.nodes || {};
    target.rootIds = target.rootIds || [];

    const subtreeIds = collectSubtreeIds(src, nodeId);
    const existing = new Set<string>(Object.keys(target.nodes));
    const allocate = makeIdAllocator(existing, idSeed);

    // 旧 id → 新 id を先に全確定（親子の付け替えに使う）
    const idMap: Record<string, string> = {};
    for (const oldId of subtreeIds) idMap[oldId] = allocate();

    // 複製して target.nodes に登録（親子 children / parentId を新 id にリマップ）
    for (const oldId of subtreeIds) {
        const oldNode = src.nodes[oldId];
        const newNode: OutNode = { ...oldNode, id: idMap[oldId] };
        newNode.children = (oldNode.children || []).map((c) => idMap[c]).filter(Boolean);
        // サブツリー root の parentId は null（target の root 直下）、子は新親 id
        if (oldId === nodeId) {
            newNode.parentId = null;
        } else if (oldNode.parentId && idMap[oldNode.parentId]) {
            newNode.parentId = idMap[oldNode.parentId];
        } else {
            newNode.parentId = null;
        }
        // 旧 childIds（レガシー空フィールド）が残っていても children を正とする
        if ('childIds' in newNode) newNode.childIds = newNode.children.slice();
        target.nodes[idMap[oldId]] = newNode;
    }

    // target の rootIds 先頭に挿入（FR-NM-03: root 先頭）
    target.rootIds.unshift(idMap[nodeId]);

    // src から サブツリー削除: nodes から全 id 削除 + 親の children / rootIds から root を除去
    const srcNode = src.nodes[nodeId];
    const srcParentId = srcNode.parentId ?? null;
    if (srcParentId && src.nodes[srcParentId]) {
        src.nodes[srcParentId].children = (src.nodes[srcParentId].children || []).filter((c) => c !== nodeId);
        if ('childIds' in src.nodes[srcParentId]) {
            (src.nodes[srcParentId] as OutNode).childIds = (src.nodes[srcParentId].children || []).slice();
        }
    }
    src.rootIds = (src.rootIds || []).filter((r) => r !== nodeId);
    for (const oldId of subtreeIds) delete src.nodes[oldId];

    return { newRootId: idMap[nodeId], idMap };
}
