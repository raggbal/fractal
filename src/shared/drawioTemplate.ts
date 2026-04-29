/**
 * drawio (diagrams.net) で開ける `.drawio.svg` テンプレート定数。
 *
 * `.drawio.svg` は dual-format ファイル: SVG として描画されつつ、
 * `<svg ... content="<mxfile>...">` 属性に編集用の mxfile XML を XML-escape
 * して埋め込む。drawio Desktop / hediet.vscode-drawio はファイルを開いた時
 * content 属性から mxfile を復元、保存時に新しい mxfile を再書き込みする。
 *
 * Reference: PoC `.harness/poc/.../code/scripts/empty-drawio-svg.js`,
 *            PoC `.harness/poc/.../code/sandbox/template-placeholder.drawio.svg`
 */

function escapeXmlAttr(xml: string): string {
    return xml
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * mxfile XML（完全空 mxCell id=0/1 のみ）。
 * GUI で開いて即編集を始める用途には十分だが、CLI export round-trip では
 * 落ちる可能性がある（PoC observation）。fallback として保持。
 */
export const MXFILE_EMPTY: string = (
    '<mxfile host="fractal" modified="2026-04-27T00:00:00.000Z" agent="fractal" version="24.0.0">' +
        '<diagram name="Page-1" id="empty">' +
            '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">' +
                '<root>' +
                    '<mxCell id="0"/>' +
                    '<mxCell id="1" parent="0"/>' +
                '</root>' +
            '</mxGraphModel>' +
        '</diagram>' +
    '</mxfile>'
);

/**
 * mxfile XML（"Placeholder" rect を 1 個含む最小実用テンプレート）。
 * CLI export round-trip でも OK、GUI で開いて即編集を始められる。
 * Cmd+/ Insert Drawio Diagram ではこちらを採用する。
 */
export const MXFILE_WITH_PLACEHOLDER: string = (
    '<mxfile host="fractal" modified="2026-04-27T00:00:00.000Z" agent="fractal" version="24.0.0">' +
        '<diagram name="Page-1" id="empty">' +
            '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">' +
                '<root>' +
                    '<mxCell id="0"/>' +
                    '<mxCell id="1" parent="0"/>' +
                    '<mxCell id="2" value="" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#cccccc;fontSize=11;fontColor=#999999;align=center;" vertex="1" parent="1">' +
                        '<mxGeometry x="0" y="0" width="120" height="80" as="geometry"/>' +
                    '</mxCell>' +
                '</root>' +
            '</mxGraphModel>' +
        '</diagram>' +
    '</mxfile>'
);

/**
 * mxfile XML を embed した dual-format `.drawio.svg` 文字列を生成する。
 * width/height は placeholder rect と一致させた 120x80 をデフォルトとする。
 */
export function buildDrawioSvg(mxfileXml: string, opts?: { width?: number; height?: number }): string {
    const w = opts?.width ?? 120;
    const h = opts?.height ?? 80;
    const content = escapeXmlAttr(mxfileXml);
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" ' +
        `width="${w}" height="${h}" viewBox="-0.5 -0.5 ${w} ${h}" ` +
        `content="${content}">\n` +
        `  <rect x="0" y="0" width="${w}" height="${h}" fill="#f5f5f5" stroke="#ccc"/>\n` +
        `  <text x="${w / 2}" y="${h / 2 + 4}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#999">empty diagram</text>\n` +
        '</svg>\n'
    );
}

/**
 * Cmd+/ Insert Drawio Diagram で書き出す `.drawio.svg` の標準内容。
 */
export function buildPlaceholderDrawioSvg(): string {
    return buildDrawioSvg(MXFILE_WITH_PLACEHOLDER);
}

/**
 * 多重拡張子（.drawio.svg / .drawio.png）対応の衝突回避ファイル名。
 * `foo.drawio.svg` → `foo-1.drawio.svg`（`foo.drawio-1.svg` ではない）。
 *
 * @param exists path -> ファイル存在チェック
 * @param originalName 元のファイル名（拡張子込み）
 */
export function buildUniqueDrawioName(
    originalName: string,
    exists: (name: string) => boolean
): string {
    if (!exists(originalName)) return originalName;

    const lower = originalName.toLowerCase();
    let suffix: string;
    let base: string;
    if (lower.endsWith('.drawio.svg')) {
        suffix = originalName.slice(originalName.length - '.drawio.svg'.length);
        base = originalName.slice(0, originalName.length - suffix.length);
    } else if (lower.endsWith('.drawio.png')) {
        suffix = originalName.slice(originalName.length - '.drawio.png'.length);
        base = originalName.slice(0, originalName.length - suffix.length);
    } else {
        // fallback: 単一拡張子
        const dot = originalName.lastIndexOf('.');
        if (dot >= 0) {
            base = originalName.slice(0, dot);
            suffix = originalName.slice(dot);
        } else {
            base = originalName;
            suffix = '';
        }
    }
    let counter = 1;
    while (true) {
        const newName = `${base}-${counter}${suffix}`;
        if (!exists(newName)) return newName;
        counter++;
    }
}
