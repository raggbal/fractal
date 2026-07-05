/**
 * mindmap-export-prepare — Mindmap エクスポートの純粋部分 (vscode 非依存)。
 *
 * payload → 書き出しバイト列 + 既定ファイル名 + 既定保存先の解決。
 * vscode を import しないため Node 単体テスト可能 (TC-226 の検証対象)。
 * vscode glue (SaveDialog + writeFile) は mindmap-export-host.ts が担う。
 */

import { safeResolveUnderDir } from './path-safety';

export type MindmapExportFormat = 'png' | 'svg' | 'opml' | 'markdown';

export interface MindmapExportMessage {
    type: 'exportMindmap';
    format: MindmapExportFormat;
    payload: string;       // png: data URL / svg,opml,markdown: text
    suggestedName?: string;
}

export const EXT_BY_FORMAT: Record<MindmapExportFormat, string> = {
    png: 'png',
    svg: 'svg',
    opml: 'opml',
    markdown: 'md'
};

export const FILTERS_BY_FORMAT: Record<MindmapExportFormat, Record<string, string[]>> = {
    png: { Images: ['png'] },
    svg: { 'SVG Image': ['svg'] },
    opml: { OPML: ['opml'] },
    markdown: { Markdown: ['md'] }
};

export interface PreparedExport {
    bytes: Uint8Array;
    defaultName: string;
    defaultPath: string | null;   // baseDir 配下に safeResolveUnderDir で解決 (traversal 防止)
}

/**
 * 純粋部分 (副作用なし): payload → 書き出しバイト列 + 既定ファイル名 + 既定保存先の解決。
 * @returns null = 未知フォーマット。
 */
export function prepareExport(
    message: MindmapExportMessage,
    baseDir: string
): PreparedExport | null {
    const format = message.format;
    if (!EXT_BY_FORMAT[format]) {
        return null;
    }
    const ext = EXT_BY_FORMAT[format];
    // suggestedName のパス区切りを除去 (traversal / サブディレクトリ化を防ぐ)
    const rawName = (message.suggestedName || 'mindmap').replace(/[/\\]/g, '_');
    const defaultName = `${rawName}.${ext}`;

    let bytes: Uint8Array;
    if (format === 'png') {
        // data:image/png;base64,XXXX → binary
        const comma = message.payload.indexOf(',');
        const b64 = comma >= 0 ? message.payload.slice(comma + 1) : message.payload;
        bytes = Buffer.from(b64, 'base64');
    } else {
        bytes = Buffer.from(message.payload, 'utf8');
    }

    let defaultPath: string | null = null;
    if (baseDir) {
        defaultPath = safeResolveUnderDir(baseDir, defaultName);
    }
    return { bytes, defaultName, defaultPath };
}
