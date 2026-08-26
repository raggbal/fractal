/**
 * external-md-watcher — standalone md（AnyMarkdownEditorProvider）の外部変更検知 seam。
 *
 * FR-LV-01 (sprint 20260806-165116): 素の FSW onDidChange 単独購読では
 * Claude Code 等の atomic rename 保存（temp 書き → rename・新 inode）を取りこぼす
 * （rename は FSW では onDidCreate で上がる / workspace 外では FSW 自体が fire しない）。
 * createHybridFileWatcher（FSW onDidChange + onDidCreate + fs.watchFile 1s polling）へ
 * 差し替え、onDidCreate も同一ハンドラで購読する。
 *
 * resolveCustomTextEditor の巨大クロージャから切り出した export seam（依存注入）。
 * unit は fake vscode/fs を注入して behavioral に駆動する（先例: test/unit/hybrid-watcher.spec.ts）。
 *
 * ⚠️ 先頭に isApplyingEdit 系の early-return ガードを置かないこと（設計 §1 で明示禁止）。
 * fs.watchFile はエッジトリガ（再配送なし）のため、ここでイベントを捨てると次の
 * disk 変化まで永久に反映されない。自己保存由来の発火は onExternalChange 側の
 * 差分チェック（newContent !== currentContent）が no-op に吸収する。
 */
import { createHybridFileWatcher } from './drawioWatcher';
import { recordSelfWrite, isRecentSelfWrite } from './self-write-registry';

export interface ExternalMdWatcherHandle {
    dispose(): void;
}

/**
 * FR-LV-06 (sprint 20260825-055613 / ADRL-0098): standalone md の外部変更照合ボディ。
 * editorProvider.resolveCustomTextEditor の onFsEvent inline クロージャから 1:1 抽出した seam
 * （designer_failures 2026-08-07: counterfactual TC には seam が前提）。
 * 挙動差分は自己書き込み台帳の照合/記録の追加のみ:
 * - disk 内容が台帳にあれば no-op（自己保存の残響 — doc 比較より先に判定。編集中は doc が
 *   disk より先行するため、差分チェックだけだと自己保存を外部編集と誤認して巻き戻す）
 * - 適用に成功した外部内容は記録（直後に自分が save する = 残響イベントも自己書き込み扱い）
 */
export async function reconcileStandaloneMd(deps: {
    filePath: string;
    vscodeNs: any;
    document: any;
    setIsApplying: (b: boolean) => void;
    /** convertImagePaths 等、webview へ渡す前の変換 */
    convertContent: (raw: string) => string;
    /** webview への update push（postMessage） */
    postUpdate: (content: string) => void;
    onApplied?: (content: string) => void;
}): Promise<void> {
    const { vscodeNs, document } = deps;
    try {
        const fileContent = await vscodeNs.workspace.fs.readFile(document.uri);
        const newContent = new TextDecoder().decode(fileContent);
        if (isRecentSelfWrite(deps.filePath, newContent)) { return; }
        const currentContent = document.getText();

        if (newContent !== currentContent) {
            // Sync VS Code document with file content (triggers onDidChangeTextDocument)
            deps.setIsApplying(true);
            const fullRange = new vscodeNs.Range(
                document.positionAt(0),
                document.positionAt(currentContent.length)
            );
            const edit = new vscodeNs.WorkspaceEdit();
            edit.replace(document.uri, fullRange, newContent);
            await vscodeNs.workspace.applyEdit(edit);
            // applyEdit 成功「後」に記録（throw 時に未適用内容が台帳に残ると外部編集が反映されない）
            recordSelfWrite(deps.filePath, newContent);
            deps.setIsApplying(false);

            // Save immediately to clear dirty state — file on disk is already up to date
            await document.save();

            // Notify webview directly (since isApplyingOwnEdit suppressed onDidChangeTextDocument)
            deps.postUpdate(deps.convertContent(newContent));
            if (deps.onApplied) { deps.onApplied(newContent); }
        }
    } catch (error) {
        deps.setIsApplying(false);
        console.error('[Any MD] Error reading file after external change:', error);
    }
}

/**
 * filePath の外部変更を検知し、debounce 後に onFsEvent を呼ぶ watcher を張る。
 * onDidChange（in-place 書き込み・kiro 等）と onDidCreate（atomic rename・Claude Code 等）の
 * 両方を同一ハンドラで購読する。二重発火（FSW + polling が同一変更を両方検知）は
 * 呼び出し側の差分チェックで no-op になる。
 */
export function setupExternalMdWatcher(deps: {
    filePath: string;
    vscodeNs: any;
    fsNs: any;
    /** FS イベント検知時に debounce(100ms) 後に呼ばれる。disk 読み・差分チェック・反映は呼び出し側の責務 */
    onFsEvent: () => void;
    debounceMs?: number;
}): ExternalMdWatcherHandle {
    const debounceMs = deps.debounceMs ?? 100;
    const hybrid = createHybridFileWatcher(deps.filePath, deps.vscodeNs, deps.fsNs);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
        if (timer) { clearTimeout(timer); }
        timer = setTimeout(() => {
            timer = null;
            deps.onFsEvent();
        }, debounceMs);
    };
    const changeSub = hybrid.onDidChange(fire);
    // onDidCreate は DrawioFileWatcher interface 上 optional（実装 createDrawioFileWatcher は常に提供）
    const createSub = hybrid.onDidCreate ? hybrid.onDidCreate(fire) : { dispose: () => { /* noop */ } };
    return {
        dispose() {
            if (timer) { clearTimeout(timer); timer = null; }
            try { changeSub.dispose(); } catch { /* ignore */ }
            try { createSub.dispose(); } catch { /* ignore */ }
            try { hybrid.dispose(); } catch { /* ignore */ }
        },
    };
}
