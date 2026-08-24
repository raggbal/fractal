/**
 * viewer-target.ts — file viewer の対象判定（唯一の判定点）
 *
 * sprint 20260815-075428-file-viewer-3panes / FR-FV-01 / ADRL-0066 決定 4。
 * sprint 20260823-165314-viewer-office-text-image / FR-FV-01 改訂 + FR-FV-16（ADRL-0093）:
 * kind を text/image/docx/xlsx/pptx の 3 群に拡張し、viewType を明示マップ化
 * （旧「未知 kind → fileViewerHtml へ寄せる」既定は svg 誤爆経路になるため廃止）。
 *
 * 全 open sink（vscode.env.openExternal を呼ぶ経路）はこの関数で viewer 対象を判定する —
 * 拡張子リストをインライン複製しない（「N 経路の一部にだけ配線」クラスの構造的防止）。
 *
 * スコープ外の明示: .mhtml / .xhtml / .md（既存 md editor の領分）/ macro 系（.docm/.xlsm/.pptm）/
 * OLE2 旧形式（.doc/.xls/.ppt）は null。.svg は image kind の `<img>` 経路限定で対象（ADRL-0091）。
 */

export type ViewerKind = 'html' | 'pdf' | 'text' | 'image' | 'docx' | 'xlsx' | 'pptx';

/** 50MB 超は viewer を開かず OS 既定アプリへフォールバック（FR-FV-07 — FR-TF-01/FR-DS-07(d) と同閾値） */
export const VIEWER_SIZE_LIMIT = 50 * 1024 * 1024;

// 対象拡張子 → kind（FR-FV-01 の表が正。ここが唯一の定義箇所 — INV-5）
const EXT_TO_KIND = new Map<string, ViewerKind>([
    ['.html', 'html'], ['.htm', 'html'],
    ['.pdf', 'pdf'],
    // text 群
    ['.txt', 'text'], ['.log', 'text'], ['.json', 'text'], ['.jsonl', 'text'], ['.xml', 'text'],
    ['.yaml', 'text'], ['.yml', 'text'], ['.csv', 'text'], ['.tsv', 'text'],
    ['.js', 'text'], ['.mjs', 'text'], ['.cjs', 'text'], ['.ts', 'text'], ['.tsx', 'text'], ['.jsx', 'text'],
    ['.py', 'text'], ['.rb', 'text'], ['.go', 'text'], ['.rs', 'text'], ['.java', 'text'],
    ['.c', 'text'], ['.h', 'text'], ['.cpp', 'text'], ['.hpp', 'text'], ['.cs', 'text'],
    ['.sh', 'text'], ['.sql', 'text'], ['.ini', 'text'], ['.toml', 'text'], ['.conf', 'text'],
    // image 群（.svg は `<img>` 経路限定 — ADRL-0091）
    ['.png', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'], ['.gif', 'image'], ['.webp', 'image'],
    ['.avif', 'image'], ['.bmp', 'image'], ['.ico', 'image'], ['.svg', 'image'],
    // office 群
    ['.docx', 'docx'], ['.xlsx', 'xlsx'], ['.pptx', 'pptx'],
]);

/**
 * @param filename ファイル名またはパス（basename の拡張子で判定・case-insensitive）
 * @returns ViewerKind | null（null = viewer 対象外 → 従来どおり openExternal）
 */
export function isViewerTarget(filename: string): ViewerKind | null {
    const name = String(filename || '');
    const dot = name.lastIndexOf('.');
    if (dot < 0) { return null; }
    const ext = name.slice(dot).toLowerCase();
    return EXT_TO_KIND.get(ext) || null;
}

// kind → customEditor viewType（FR-FV-16。priority は per-viewType のため office/text/image を分離）
const KIND_TO_VIEWTYPE: Record<ViewerKind, string> = {
    pdf: 'fractal.fileViewer',
    html: 'fractal.fileViewerHtml',
    docx: 'fractal.fileViewerOffice',
    xlsx: 'fractal.fileViewerOffice',
    pptx: 'fractal.fileViewerOffice',
    text: 'fractal.fileViewerText',
    image: 'fractal.fileViewerImage',
};

/**
 * kind → customEditor viewType（FR-FV-08「新しいタブで開く」の openWith 引数）。
 *
 * 置き場: viewer-target.ts（拡張子→kind と kind→viewType は同じ知識の表裏・3 provider から型付き import 可）。
 * **未知 kind は throw**（ADRL-0093 — 旧「fileViewerHtml へ寄せる」既定は html 面 iframe への
 * 誤爆経路になるため廃止。呼び出し側は isViewerTarget の非 null を渡す契約）。
 */
export function viewerViewType(kind: ViewerKind | string | undefined | null): string {
    const vt = kind ? KIND_TO_VIEWTYPE[kind as ViewerKind] : undefined;
    if (!vt) { throw new Error(`viewerViewType: unknown viewer kind: ${String(kind)}`); }
    return vt;
}
