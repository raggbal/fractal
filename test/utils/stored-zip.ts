/**
 * stored-zip.ts — テスト用の最小 zip（stored / method 0）合成ヘルパ
 * sprint 20260823-165314-viewer-office-text-image（OOXML fixture の spec 内生成 — 実バイナリを commit しない）
 */
export function storedZip(entries: Array<[string, Buffer | string]>): Buffer {
    const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
    for (const [name, content] of entries) {
        const nameBuf = Buffer.from(name);
        const data = typeof content === 'string' ? Buffer.from(content) : content;
        const loc = Buffer.alloc(30);
        loc.writeUInt32LE(0x04034b50, 0);
        loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(data.length, 22);
        loc.writeUInt16LE(nameBuf.length, 26);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
        locals.push(loc, nameBuf, data); centrals.push(cen, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}
