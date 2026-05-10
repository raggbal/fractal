/**
 * v0.207.40: Outliner S3 sync の競合 dialog (custom webview)
 *
 * 標準 vscode.window.showWarningMessage は「1 個 primary blue + 残り secondary gray」
 * という制約があり、user 要望「両 button を色付き + 色違い + 順序固定」を満たせない。
 *
 * このため webview panel ベースの custom dialog を実装。
 *
 *  - Upload button: orange (固定位置 = 上)
 *  - Download button: blue (固定位置 = 下)
 *  - Cancel button: gray (固定位置 = 最下)
 *  - 推奨側に「★ 推奨」 tag を表示
 */
import * as vscode from 'vscode';

export type SyncConflictChoice = 'upload' | 'download' | 'cancel';

export interface SyncConflictDialogOptions {
    title: string;             // 例: "Outliner sync (xxx.out): 内容が違います"
    localLabel: string;        // 例: "1136B  2026/5/10 23:35:05"
    s3Label: string;           // 例: "1191B  2026/5/11  0:03:33"
    recommended: 'upload' | 'download';
}

export async function showSyncConflictDialog(opts: SyncConflictDialogOptions): Promise<SyncConflictChoice> {
    const panel = vscode.window.createWebviewPanel(
        'fractal.syncConflict',
        opts.title,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: false,
        }
    );

    panel.webview.html = renderHtml(opts);

    return new Promise<SyncConflictChoice>((resolve) => {
        let resolved = false;
        const finish = (choice: SyncConflictChoice) => {
            if (resolved) return;
            resolved = true;
            try { panel.dispose(); } catch { /* ignore */ }
            resolve(choice);
        };

        const sub = panel.webview.onDidReceiveMessage((m: { type: string }) => {
            if (m.type === 'choice-upload') finish('upload');
            else if (m.type === 'choice-download') finish('download');
            else if (m.type === 'choice-cancel') finish('cancel');
        });

        panel.onDidDispose(() => {
            try { sub.dispose(); } catch { /* ignore */ }
            // 未選択で dispose された場合は cancel
            if (!resolved) finish('cancel');
        });
    });
}

function renderHtml(opts: SyncConflictDialogOptions): string {
    const recommendDl = opts.recommended === 'download';
    const uploadClass = recommendDl ? 'btn-upload' : 'btn-upload recommended';
    const downloadClass = recommendDl ? 'btn-download recommended' : 'btn-download';
    const escape = (s: string): string => s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Sync Conflict</title>
<style>
    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        margin: 0;
        padding: 32px 28px;
        max-width: 640px;
        margin-left: auto;
        margin-right: auto;
    }
    h1 {
        font-size: 16px;
        margin: 0 0 16px;
        color: var(--vscode-foreground);
    }
    .info {
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        padding: 12px 16px;
        margin: 12px 0;
        font-family: 'SF Mono', Monaco, Menlo, monospace;
        font-size: 12px;
        line-height: 1.6;
    }
    .info .row { display: flex; gap: 12px; }
    .info .label { font-weight: 600; min-width: 60px; color: var(--vscode-descriptionForeground); }
    .hint {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        margin: 12px 0;
        line-height: 1.5;
    }
    .actions-row {
        display: flex;
        flex-direction: row;
        gap: 12px;
        margin-top: 32px;  /* 推奨 ribbon が button 上に飛び出るため余白 */
    }
    .actions-row button { flex: 1; }
    .actions-cancel {
        margin-top: 12px;
    }
    button {
        padding: 12px 16px;
        font-size: 13px;
        font-weight: 600;
        border: 1px solid transparent;
        border-radius: 6px;
        cursor: pointer;
        font-family: inherit;
        text-align: center;
        position: relative;
        transition: filter 0.15s, box-shadow 0.15s, transform 0.1s;
        line-height: 1.4;
    }
    button:hover:not(:disabled) { filter: brightness(1.08); }
    button:active:not(:disabled) { filter: brightness(0.95); transform: translateY(1px); }
    button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .btn-upload {
        background: #4A90E2;
        color: #fff;
        border-color: #2F6EBF;
    }
    .btn-download {
        background: #E07A4F;
        color: #fff;
        border-color: #B85D34;
    }
    .btn-cancel {
        width: 100%;
        background: var(--vscode-button-secondaryBackground, #3A3D41);
        color: var(--vscode-button-secondaryForeground, #ddd);
        border-color: var(--vscode-button-secondaryBorder, transparent);
    }
    /* 推奨マーク (button 上右の浮上 ribbon 風) */
    .recommended {
        position: relative;
        box-shadow: 0 0 0 3px #FFD93B, 0 4px 12px rgba(255, 217, 59, 0.4);
        border-color: #FFD93B !important;
    }
    .recommended::before {
        content: '★ おすすめ';
        position: absolute;
        top: -10px;
        left: 50%;
        transform: translateX(-50%);
        background: #FFD93B;
        color: #1a1a1a;
        font-size: 11px;
        font-weight: 800;
        padding: 2px 10px;
        border-radius: 12px;
        letter-spacing: 0.5px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        white-space: nowrap;
    }
</style>
</head>
<body>
<h1>⚠️ ${escape(opts.title)}</h1>

<div class="info">
    <div class="row"><span class="label">Local:</span><span>${escape(opts.localLabel)}</span></div>
    <div class="row"><span class="label">S3:</span><span>${escape(opts.s3Label)}</span></div>
</div>

<div class="hint">
    Local と S3 で内容が違います (size 差あり)。<br>
    mtime のみで判定すると予期せず data loss が起きるため、毎回確認します。<br>
    どちらを採用しますか? (反対側は破棄されます)
</div>

<div class="actions-row">
    <button class="${uploadClass}" data-choice="upload">
        ⬆ Local を S3 に<br>アップロード
    </button>
    <button class="${downloadClass}" data-choice="download">
        ⬇ S3 を local に<br>ダウンロード
    </button>
</div>
<div class="actions-cancel">
    <button class="btn-cancel" data-choice="cancel">
        Cancel (sync 中断)
    </button>
</div>

<script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-choice]').forEach((btn) => {
        btn.addEventListener('click', () => {
            vscode.postMessage({ type: 'choice-' + btn.dataset.choice });
        });
    });
</script>
</body>
</html>`;
}
