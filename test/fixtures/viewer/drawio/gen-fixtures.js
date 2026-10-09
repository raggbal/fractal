// gen-fixtures.js — drawio viewer の E2E 用 fixture を生成する（生成物も commit する）
//
// sprint 20261009-130815-file-viewer-drawio / TASK-03（design/tdd.md の fixture 一覧）。
// 再生成: node test/fixtures/viewer/drawio/gen-fixtures.js
//
// 各図の目印ラベル（TC が iframe 内の svg からテキストで検出する）:
//   aws-plain       LAMBDA_LABEL / S3_LABEL / DDB_LABEL（mxgraph.aws4 のステンシル図形）
//   compressed      COMPRESSED_LABEL（deflateRaw + base64 + URI encode のページ）
//   three-pages     ONLY_ON_P1 / ONLY_ON_P2 / ONLY_ON_P3（ページ名 P1 / P2 / P3）
//   two-layers      BG_LABEL（Background）/ NET_LABEL（Network）
//   external        EXT_LABEL（https 画像 + Google Fonts + 数式 + 外部リンク）
//   desktop.drawio.svg / embedded.drawio.png  DESKTOP_LABEL / PNG_LABEL
//   fractal-template.drawio.svg  src/shared/drawioTemplate.ts の buildPlaceholderDrawioSvg() の出力そのもの

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = __dirname;
const ROOT = path.join(__dirname, '..', '..', '..', '..');

function cell(id, value, style, x, y, w = 120, h = 80, parent = '1') {
    return `<mxCell id="${id}" value="${value}" style="${style}" vertex="1" parent="${parent}"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
}
function model(cells, layers = [{ id: '1' }]) {
    const layerCells = layers.map((l) => `<mxCell id="${l.id}" ${l.name ? `value="${l.name}" ` : ''}parent="0"${l.visible === false ? ' visible="0"' : ''}/>`).join('');
    return `<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageWidth="850" pageHeight="1100"><root><mxCell id="0"/>${layerCells}${cells.join('')}</root></mxGraphModel>`;
}
function mxfile(pages) {
    return `<mxfile host="fractal-fixture" version="24.0.0">${pages.map((p, i) => `<diagram id="d${i}" name="${p.name}">${p.body}</diagram>`).join('')}</mxfile>`;
}
/** draw.io の Graph.compress と同じ: deflateRaw(encodeURIComponent(xml)) → base64 */
function compress(xml) {
    return zlib.deflateRawSync(Buffer.from(encodeURIComponent(xml), 'latin1')).toString('base64');
}
function escAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function write(name, data) {
    fs.writeFileSync(path.join(OUT, name), data);
    console.log(`  ✓ ${name}`);
}

const awsIcon = (res) => `sketch=0;outlineConnect=0;fontColor=#232F3E;fillColor=#ED7100;strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.${res};`;
const box = 'rounded=0;whiteSpace=wrap;html=1;';

// 1. aws-plain.drawio（非圧縮・AWS アイコン 3 個）
write('aws-plain.drawio', mxfile([{ name: 'AWS', body: model([
    cell('l', 'LAMBDA_LABEL', awsIcon('lambda'), 40, 40, 78, 78),
    cell('s', 'S3_LABEL', awsIcon('s3'), 200, 40, 78, 78),
    cell('d', 'DDB_LABEL', awsIcon('dynamodb'), 360, 40, 78, 78),
]) }]));

// 2. compressed.drawio（圧縮ページ）
write('compressed.drawio', mxfile([{ name: 'Compressed', body: compress(model([cell('c', 'COMPRESSED_LABEL', box, 40, 40)])) }]));

// 3. three-pages.drawio
write('three-pages.drawio', mxfile(['P1', 'P2', 'P3'].map((n) => ({ name: n, body: model([cell('x', `ONLY_ON_${n}`, box, 40, 40)]) }))));

// 4. two-layers.drawio（Background / Network）
write('two-layers.drawio', mxfile([{ name: 'Layers', body: model([
    cell('b', 'BG_LABEL', box, 40, 40, 120, 80, '1'),
    cell('n', 'NET_LABEL', box, 200, 40, 120, 80, 'net'),
], [{ id: '1', name: 'Background' }, { id: 'net', name: 'Network' }]) }]));

// 5. external.drawio（外部 URL 画像・Google Fonts・数式・外部リンク）
write('external.drawio', mxfile([{ name: 'External', body: model([
    cell('t', 'EXT_LABEL', box, 40, 40),
    cell('i', '', 'shape=image;imageAspect=0;aspect=fixed;image=https://external.test/a.png;', 200, 40, 80, 80),
    cell('f', 'FONT_LABEL', `${box}fontFamily=Roboto;fontSource=https%3A%2F%2Ffonts.googleapis.com%2Fcss%3Ffamily%3DRoboto;`, 40, 160),
    cell('m', '`x^2`', `${box}`, 200, 160),
    `<UserObject label="LINK_LABEL" link="https://external.test/" id="k"><mxCell style="${box}" vertex="1" parent="1"><mxGeometry x="360" y="40" width="120" height="80" as="geometry"/></mxCell></UserObject>`,
]).replace('<mxGraphModel ', '<mxGraphModel math="1" ') }]));

// 6. broken.drawio（XML 不正）
write('broken.drawio', '<mxfile><diagram name="Broken"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>');

// 7. desktop.drawio.svg（draw.io Desktop と同じく content 属性に mxfile を XML エスケープで埋め込む）
const desktopXml = mxfile([{ name: 'Desktop', body: model([cell('a', 'DESKTOP_LABEL', box, 40, 40)]) }]);
write('desktop.drawio.svg', `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="161px" height="81px" viewBox="-0.5 -0.5 161 81" content="${escAttr(desktopXml)}"><defs/><g><rect x="0" y="0" width="160" height="80" fill="#ffffff" stroke="#000000" pointer-events="all"/><text x="80" y="44" text-anchor="middle" font-size="12">DESKTOP_LABEL</text></g></svg>\n`);

// 8. fractal-template.drawio.svg（action panel が作るテンプレートそのもの）
const tpl = require(path.join(ROOT, 'out', 'shared', 'drawioTemplate.js'));
write('fractal-template.drawio.svg', tpl.buildPlaceholderDrawioSvg());

// 9. embedded.drawio.png（1x1 PNG + zTXt "mxfile" に zlib 圧縮した URI encode 済み mxfile）
function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
const pngXml = mxfile([{ name: 'Png', body: model([cell('p', 'PNG_LABEL', box, 40, 40)]) }]);
const ztxt = Buffer.concat([Buffer.from('mxfile\0\0', 'latin1'), zlib.deflateSync(Buffer.from(encodeURIComponent(pngXml), 'latin1'))]);
const idat = zlib.deflateSync(Buffer.from([0, 255, 255, 255]));
write('embedded.drawio.png', Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('zTXt', ztxt), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
]));

// 10. plain-renamed.drawio.svg（content 属性の無い普通の SVG）
write('plain-renamed.drawio.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect x="0" y="0" width="120" height="80" fill="#4a90d9"/></svg>\n');
