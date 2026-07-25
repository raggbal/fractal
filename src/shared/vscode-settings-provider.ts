/**
 * VSCode SettingsProvider — vscode.workspace.getConfiguration をラップ
 */
import * as vscode from 'vscode';
import {
    EditorSettings,
    SettingsProvider,
    DEFAULT_SETTINGS,
    ModernTheme,
    migrateLegacyTheme,
} from './settings-provider';
import { t } from '../i18n/messages';

// Module-level flag — extension activation 中の重複表示を防ぐ
// (再 reload 後の重複は globalState 'fractal.themeMigrationDone' で防ぐ)
let hasShownMigrationNotice = false;

/**
 * Resolve current theme via migration helper.
 * 旧 enum (`things` 等) が来たら 1 回 warning + 永続化 + globalState フラグ更新。
 *
 * 設計: design/system.md §3.7
 *
 * @param context ExtensionContext (globalState 永続化用)
 * @returns 'light' | 'dark' | 'auto'
 */
export function getCurrentTheme(context: vscode.ExtensionContext): ModernTheme {
    const config = vscode.workspace.getConfiguration('fractal');
    const raw = config.get<string>('theme', 'auto')!;
    const migrated = migrateLegacyTheme(raw);

    if (raw !== migrated) {
        const alreadyDone = context.globalState.get<boolean>('fractal.themeMigrationDone', false);
        if (!alreadyDone && !hasShownMigrationNotice) {
            hasShownMigrationNotice = true;
            // 既存 t() API は placeholder interpolation 機能なし、call site で .replace() で interpolate
            // (design/system.md §3.7.1, generator_failures 2026-05-08 教訓)
            const template = t('themeMigrationNotice');
            const message = template
                .replace('{old}', raw)
                .replace('{new}', migrated);
            vscode.window.showInformationMessage(message);
            config.update('theme', migrated, vscode.ConfigurationTarget.Global)
                .then(undefined, () => { /* swallow update errors */ });
            context.globalState.update('fractal.themeMigrationDone', true);
        }
    }

    return migrated;
}

export class VSCodeSettingsProvider implements SettingsProvider {
    private get config() {
        return vscode.workspace.getConfiguration('fractal');
    }

    get<K extends keyof EditorSettings>(key: K): EditorSettings[K] {
        if (key === 'theme') {
            const raw = this.config.get<string>('theme', DEFAULT_SETTINGS.theme as string)!;
            return migrateLegacyTheme(raw) as EditorSettings[K];
        }
        return this.config.get<EditorSettings[K]>(key, DEFAULT_SETTINGS[key])!;
    }

    getAll(): EditorSettings {
        return {
            theme: this.get('theme'),
            fontSize: this.get('fontSize'),
            toolbarMode: this.get('toolbarMode'),
            language: this.get('language'),
            enableDebugLogging: this.get('enableDebugLogging'),
        };
    }

    onChange(callback: () => void): { dispose(): void } {
        const disposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('fractal')) {
                callback();
            }
        });
        return disposable;
    }

    /**
     * VSCode のシステム言語を返す
     */
    getSystemLanguage(): string {
        return vscode.env.language;
    }
}
