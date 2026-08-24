/*
 * fractal original（sprint 20260823-165314 / ADR-0010 — 依存置換）。
 * jszip 互換の薄い façade: `zip.file(name).async('string'|'arraybuffer'|'base64'|'uint8array')`。
 * 実体は viewer-common/zip.mjs（zip 三重ガード込み — ADRL-0094）。移植コード（pptxtojson.mjs /
 * readXmlFile.mjs / fill.mjs）は無改造でこの façade を消費する。
 * 不在エントリは jszip 同様 null を返す（呼び出し側の .async が TypeError → 各所の catch が吸収）。
 */
import { openZip } from '../viewer-common/zip.mjs';

function toBase64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

export async function createZipFacade(buf) {
    const zip = await openZip(buf);
    const dec = new TextDecoder('utf-8');
    return {
        file(name) {
            if (!zip.entries().has(name)) { return null; }
            return {
                async async(type) {
                    const bytes = await zip.readEntry(name);
                    switch (type) {
                        case 'string': return dec.decode(bytes);
                        case 'arraybuffer': return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                        case 'base64': return toBase64(bytes);
                        default: return bytes;
                    }
                },
            };
        },
        entries() { return zip.entries(); },
    };
}
