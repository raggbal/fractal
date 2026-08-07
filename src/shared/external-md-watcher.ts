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

export interface ExternalMdWatcherHandle {
    dispose(): void;
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
