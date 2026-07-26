import type * as vscode from 'vscode';

// getNonce をここに inline する（webviewContent.ts から import すると vscode の実行時依存を引き込み、
// vscode 非依存の unit テストで gate HTML を検証できなくなるため。中身は webviewContent.ts:9 と同一）。
function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * FR-MG-02 / FR-MG-05: 起動時フラット移行ゲートの webview HTML。
 *
 * old layout の note フォルダを開いたとき、本体の代わりにこの画面を出す（notesEditorProvider.openNotesFolder）。
 * self-contained（最小インライン CSS/JS、CSP nonce 準拠）。webview→host は notes パネル直の
 * acquireVsCodeApi().postMessage({type:'runFlatMigration'})（handleNotesMessage の switch が受ける）。
 * 失敗時は host が {type:'migrationFailed', reasons[]} を postMessage → この画面の JS が理由 + 再試行を出す。
 */
export interface MigrationGateSummary {
    pages: number;
    images: number;
    files: number;
    total: number;
}

export function getNotesMigrationGateContent(
    webview: vscode.Webview,
    _extensionUri: vscode.Uri,
    summary: MigrationGateSummary,
    folderName: string
): string {
    const nonce = getNonce();
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Migrate to flat layout</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #ddd);
    display: flex; align-items: center; justify-content: center; height: 100vh;
  }
  .mg-card {
    max-width: 460px; padding: 32px 36px; text-align: center;
    background: var(--vscode-editorWidget-background, rgba(255,255,255,0.04));
    border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
    border-radius: 10px;
  }
  .mg-icon { font-size: 32px; margin-bottom: 8px; }
  .mg-title { font-size: 17px; font-weight: 700; margin: 0 0 6px; }
  .mg-folder { font-size: 12px; opacity: 0.7; margin: 0 0 16px; word-break: break-all; }
  .mg-desc { font-size: 13px; line-height: 1.6; margin: 0 0 16px; }
  .mg-summary {
    display: inline-flex; gap: 16px; margin: 0 0 22px; padding: 10px 16px;
    background: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.05));
    border-radius: 6px; font-size: 13px;
  }
  .mg-summary b { font-size: 16px; display: block; }
  button {
    font-size: 14px; font-weight: 600; padding: 9px 24px; border: none; border-radius: 6px; cursor: pointer;
    background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
  }
  button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  button:disabled { opacity: 0.5; cursor: default; }
  .mg-fail {
    display: none; margin-top: 18px; padding: 12px 14px; text-align: left;
    background: var(--vscode-inputValidation-errorBackground, rgba(200,50,50,0.15));
    border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    border-radius: 6px; font-size: 12px; line-height: 1.5;
  }
  .mg-fail.is-shown { display: block; }
  .mg-fail ul { margin: 6px 0 0; padding-left: 18px; }
  .mg-spin { margin-top: 14px; font-size: 12px; opacity: 0.7; display: none; }
  .mg-spin.is-shown { display: block; }
</style>
</head>
<body>
  <div class="mg-card">
    <div class="mg-icon">📦</div>
    <h1 class="mg-title">このノートを新レイアウトに移行します</h1>
    <p class="mg-folder">${esc(folderName)}</p>
    <p class="mg-desc">このノートは旧レイアウトです。ノートを開く前に、ページ・画像・ファイルを新しいフラット構成へ移行します。</p>
    <div class="mg-summary">
      <span>ページ<b>${summary.pages}</b></span>
      <span>画像<b>${summary.images}</b></span>
      <span>ファイル<b>${summary.files}</b></span>
    </div>
    <div>
      <button id="mg-migrate" type="button">移行する</button>
    </div>
    <div class="mg-spin" id="mg-spin">移行中… しばらくお待ちください</div>
    <div class="mg-fail" id="mg-fail">
      <div>⚠️ 移行できませんでした:</div>
      <ul id="mg-fail-reasons"></ul>
    </div>
  </div>
<script nonce="${nonce}">
  (function () {
    var vscode = acquireVsCodeApi();
    var btn = document.getElementById('mg-migrate');
    var spin = document.getElementById('mg-spin');
    var fail = document.getElementById('mg-fail');
    var reasonsEl = document.getElementById('mg-fail-reasons');
    function runMigration() {
      btn.disabled = true;
      fail.classList.remove('is-shown');
      spin.classList.add('is-shown');
      // webview→host: notes パネル直の type ベース postMessage（handleNotesMessage の switch が受ける）
      vscode.postMessage({ type: 'runFlatMigration' });
    }
    btn.addEventListener('click', runMigration);
    // FR-MG-05: 失敗時 host が migrationFailed を返す → 理由 + 再試行を出す（本体は出さない）。
    window.addEventListener('message', function (e) {
      var m = e.data;
      if (!m || m.type !== 'migrationFailed') { return; }
      spin.classList.remove('is-shown');
      reasonsEl.innerHTML = '';
      var reasons = (m.reasons && m.reasons.length) ? m.reasons : ['不明なエラー'];
      for (var i = 0; i < reasons.length; i++) {
        var li = document.createElement('li');
        li.textContent = String(reasons[i]);
        reasonsEl.appendChild(li);
      }
      fail.classList.add('is-shown');
      btn.disabled = false;
      btn.textContent = '再試行';
    });
  })();
</script>
</body>
</html>`;
}
