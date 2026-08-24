/**
 * viewer-common/blob-registry.mjs — Blob URL 台帳（kind インスタンス毎）
 *
 * INV-3: url() は createObjectURL の直後に Set へ登録する（パース途中の失敗時でも revoke 対象）。
 * destroy 経路（cleanupRegistry）から revokeAll() が呼ばれる。
 */

export function createBlobRegistry() {
    const urls = new Set();
    let closed = false;
    return {
        /** blob → objectURL（生成直後に登録。revokeAll 後の遅延到着分は即 revoke — 破棄後 leak 防止） */
        url(blob) {
            const u = URL.createObjectURL(blob);
            if (closed) {
                try { URL.revokeObjectURL(u); } catch { /* noop */ }
                return u;
            }
            urls.add(u);
            return u;
        },
        size() { return urls.size; },
        revokeAll() {
            closed = true;
            for (const u of urls) {
                try { URL.revokeObjectURL(u); } catch { /* 二重 revoke 等は無視 */ }
            }
            urls.clear();
        },
    };
}
