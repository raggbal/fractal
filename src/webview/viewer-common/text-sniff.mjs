/**
 * viewer-common/text-sniff.mjs — バイナリ sniff + テキストデコード（webview 版）
 *
 * 出自: src/shared/doc-text-extract.ts sniffAndDecodeText の写経移植（Buffer → Uint8Array/TextDecoder）。
 * 判定順は正典の不変条件と 1:1:
 *  ① UTF-8 BOM ② UTF-16LE BOM ③ UTF-16BE BOM ④ 先頭 8KB NUL → null（バイナリ） ⑤ fallback UTF-8。
 * BOM 判定が NUL 検査より必ず先（UTF-16 の ASCII は NUL を含む）。BOM strip は decode 前の subarray。
 * TextDecoder は utf-16be ネイティブ対応のため swap 不要（正典 Node 版との差分はこの 1 点のみ）。
 */

const SNIFF_SIZE = 8192;                          // 正典と同値
const TEXT_DECODE_INPUT_CLAMP = 4 * 1024 * 1024;  // 正典と同値

export function sniffAndDecodeText(bytes) {
    const clamp = (b) => b.length > TEXT_DECODE_INPUT_CLAMP
        ? { b: b.subarray(0, TEXT_DECODE_INPUT_CLAMP), truncated: true }
        : { b, truncated: false };
    const evenLen = (b) => (b.length % 2 === 0 ? b : b.subarray(0, b.length - 1)); // 奇数長 tail 切り捨て

    // 分岐 1: UTF-8 BOM
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        const { b, truncated } = clamp(bytes.subarray(3));
        return { text: new TextDecoder('utf-8').decode(b), truncated };
    }
    // 分岐 2: UTF-16LE BOM
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        const { b, truncated } = clamp(bytes.subarray(2));
        return { text: new TextDecoder('utf-16le').decode(evenLen(b)), truncated };
    }
    // 分岐 3: UTF-16BE BOM
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        const { b, truncated } = clamp(bytes.subarray(2));
        return { text: new TextDecoder('utf-16be').decode(evenLen(b)), truncated };
    }
    // 分岐 4: BOM なし → 先頭 8KB の NUL 検査
    const sniffLen = Math.min(bytes.length, SNIFF_SIZE);
    for (let i = 0; i < sniffLen; i++) {
        if (bytes[i] === 0x00) { return null; }
    }
    // 分岐 5: fallback UTF-8
    const { b, truncated } = clamp(bytes);
    return { text: new TextDecoder('utf-8').decode(b), truncated };
}
