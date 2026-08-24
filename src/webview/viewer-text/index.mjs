/**
 * viewer-text/index.mjs — text viewer（MOD-TextViewer / FR-TXV-01..04）
 *
 * 読み取り専用の等幅テキスト表示 + 行番号。chunk 描画（先頭同期 + idle 追記）で 10MB 級でも
 * UI フリーズなし（NFR-VEX-03）。find は全文文字列走査（描画状態非依存）— ヒットが未描画 chunk
 * なら該当行まで先行描画して着地する。DOM は createElement + textContent のみ（INV-2）。
 */
import { sniffAndDecodeText } from '../viewer-common/text-sniff.mjs';

export const CHUNK_LINES = 5000;
const FIND_LIMIT = 1000;

function ensureStyle(doc) {
    if (doc.getElementById('fv-text-style')) { return; }
    const style = doc.createElement('style');
    style.id = 'fv-text-style';
    style.textContent = [
        '.fv-text { font-family: var(--vscode-editor-font-family, ui-monospace, monospace);',
        '  font-size: var(--vscode-editor-font-size, 13px); line-height: 1.5; padding: 8px 0;',
        '  color: var(--fv-text, var(--vscode-editor-foreground, #333)); }',
        '.fv-line { display: flex; }',
        // 行番号は実 DOM 行単位 = 折り返し行には番号が付かない（FR-TXV-01）
        '.fv-ln { flex: 0 0 auto; min-width: 5ch; text-align: right; padding: 0 12px 0 8px;',
        '  user-select: none; color: var(--vscode-editorLineNumber-foreground, #999); }',
        '.fv-lt { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; word-break: break-all;',
        '  padding-right: 12px; }',
        '.fv-find-hit { background: rgba(255, 213, 79, 0.6); }',
        '.fv-find-current { background: rgba(255, 150, 50, 0.95); }',
    ].join('\n');
    doc.head.appendChild(style);
}

export default {
    async mount(ctx) {
        const { body, state, label } = ctx;
        const doc = body.ownerDocument;
        const win = doc.defaultView || window;
        ensureStyle(doc);

        const resp = await win.fetch(ctx.fileUri);
        if (!resp.ok) { throw new Error(`fetch failed: ${resp.status}`); }
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const sniffed = sniffAndDecodeText(bytes);

        let generation = 0; // destroy / 再 mount で chunk pump を中断する世代トークン

        if (!sniffed) {
            // バイナリ（FR-TXV-02）: 明示メッセージ + OS で開く（既存失敗 UI と同形）
            const err = doc.createElement('div');
            err.className = 'viewer-error fv-text-binary';
            err.textContent = label('viewerBinaryFile', 'Cannot display as text');
            const btn = doc.createElement('button');
            btn.className = 'viewer-open-external-fallback';
            btn.textContent = label('viewerOpenExternal', 'Open in OS default app');
            btn.addEventListener('click', () => {
                ctx.postMessage({ type: 'openExternalFallback', fileUri: ctx.fileUri, filePath: ctx.filePath || null });
            });
            err.appendChild(doc.createElement('br'));
            err.appendChild(btn);
            body.appendChild(err);
            return { destroy() { generation++; } };
        }

        const fullText = sniffed.text;
        // 行オフセット index（\n 区切り。表示時に行末 \r を落とす）
        const offsets = [0];
        for (let i = 0; i < fullText.length; i++) {
            if (fullText.charCodeAt(i) === 10) { offsets.push(i + 1); }
        }
        const totalLines = offsets.length;
        const lineAt = (n) => {
            const start = offsets[n];
            const end = n + 1 < totalLines ? offsets[n + 1] - 1 : fullText.length;
            let s = fullText.slice(start, end);
            if (s.endsWith('\r')) { s = s.slice(0, -1); }
            return s;
        };

        const container = doc.createElement('div');
        container.className = 'fv-text';
        body.appendChild(container);
        const lnWidth = String(totalLines).length + 1;

        let renderedLines = 0;
        function renderTo(target) {
            const upTo = Math.min(target, totalLines);
            if (upTo <= renderedLines) { return; }
            const frag = doc.createDocumentFragment();
            for (let n = renderedLines; n < upTo; n++) {
                const line = doc.createElement('div');
                line.className = 'fv-line';
                const ln = doc.createElement('span');
                ln.className = 'fv-ln';
                ln.style.minWidth = lnWidth + 'ch';
                ln.textContent = String(n + 1);
                const lt = doc.createElement('span');
                lt.className = 'fv-lt';
                lt.textContent = lineAt(n);
                line.appendChild(ln);
                line.appendChild(lt);
                frag.appendChild(line);
            }
            container.appendChild(frag);
            renderedLines = upTo;
        }

        // 先頭 chunk は同期（即表示）・残りは idle 追記（FR-TXV-03）
        renderTo(CHUNK_LINES);
        // テスト観測用 beacon（TC-TXV-03 の構造 assert — idle 追記とレースしない同期時点の値）
        win.__fvTextInitialLines = renderedLines;
        const gen = ++generation;
        const idle = win.requestIdleCallback ? win.requestIdleCallback.bind(win) : ((cb) => win.setTimeout(cb, 16));
        (function pump() {
            if (generation !== gen) { return; }
            if (renderedLines >= totalLines) { return; }
            idle(() => {
                if (generation !== gen) { return; }
                renderTo(renderedLines + CHUNK_LINES);
                pump();
            });
        })();

        // ── find（FR-TXV-04 / FR-FV-21）: 全文走査 + 現在ヒットの span 強調 ──
        const lower = fullText.toLowerCase();
        let hits = [];
        let current = -1;
        let marked = null; // { lineEl, ltEl } — unwrap 用
        function unmark() {
            if (!marked) { return; }
            const lt = marked;
            lt.textContent = lt.__fvOriginal != null ? lt.__fvOriginal : lt.textContent;
            delete lt.__fvOriginal;
            marked = null;
        }
        function lineOfOffset(off) {
            let lo = 0, hi = totalLines - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (offsets[mid] <= off) { lo = mid; } else { hi = mid - 1; }
            }
            return lo;
        }
        function highlightCurrent(query) {
            unmark();
            const hit = hits[current];
            if (hit == null) { return; }
            const line = lineOfOffset(hit);
            renderTo(line + 1); // 未描画 chunk 内ヒットの先行描画（FR-TXV-04）
            const lineEl = container.children[line];
            if (!lineEl) { return; }
            const lt = lineEl.querySelector('.fv-lt');
            const col = hit - offsets[line];
            const text = lt.textContent;
            lt.__fvOriginal = text;
            lt.textContent = '';
            lt.appendChild(doc.createTextNode(text.slice(0, col)));
            const span = doc.createElement('span');
            span.className = 'fv-find-hit fv-find-current';
            span.textContent = text.slice(col, col + query.length);
            lt.appendChild(span);
            lt.appendChild(doc.createTextNode(text.slice(col + query.length)));
            marked = lt;
            if (typeof span.scrollIntoView === 'function') { span.scrollIntoView({ block: 'center' }); }
        }
        let lastQuery = '';
        state.findExec = (q) => {
            unmark();
            hits = [];
            current = -1;
            lastQuery = String(q || '');
            if (!lastQuery) { if (state.findUi) { state.findUi.onCount(0, 0); } return; }
            const needle = lastQuery.toLowerCase();
            let idx = lower.indexOf(needle);
            while (idx !== -1 && hits.length < FIND_LIMIT) {
                hits.push(idx);
                idx = lower.indexOf(needle, idx + needle.length);
            }
            if (hits.length > 0) { current = 0; highlightCurrent(lastQuery); }
            if (state.findUi) { state.findUi.onCount(hits.length ? current + 1 : 0, hits.length); }
        };
        state.findStep = (dir) => {
            if (!hits.length) { return; }
            current = (current + dir + hits.length) % hits.length;
            highlightCurrent(lastQuery);
            if (state.findUi) { state.findUi.onCount(current + 1, hits.length); }
        };
        state.findClear = () => { unmark(); hits = []; current = -1; lastQuery = ''; };

        // findQuery の one-shot 消費（検索ヒット経由の open — FR-FV-22。text は locHint なし）
        if (ctx.findQuery && state.findUi) {
            const fq = ctx.findQuery;
            ctx.findQuery = null; // 消費（one-shot — 以降の手動 find はユーザー操作のみ）
            state.findUi.openWith(fq);
        }

        return { destroy() { generation++; } };
    },
};
