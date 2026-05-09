/**
 * SettingsProvider — エディタ設定の読み書きを抽象化するインターフェース
 *
 * VSCode: vscode.workspace.getConfiguration('fractal') をラップ
 * Electron: electron-store ベースの実装 (フェーズ3)
 */

/**
 * Theme mode (3 mode system, replaces previous 7 themes — MD-34 撤廃)
 * - 'light': pastel light minimal
 * - 'dark': pastel dark minimal
 * - 'auto': follow prefers-color-scheme (light → light, dark → dark)
 */
export type ModernTheme = 'light' | 'dark' | 'auto';

export interface EditorSettings {
    theme: ModernTheme;
    fontSize: number;
    toolbarMode: 'full' | 'simple';
    language: 'default' | 'en' | 'ja' | 'zh-TW' | 'zh-CN' | 'ko' | 'es' | 'fr';
    imageDefaultDir: string;
    forceRelativeImagePath: boolean;
    enableDebugLogging: boolean;
}

export const DEFAULT_SETTINGS: EditorSettings = {
    theme: 'auto',
    fontSize: 14,
    toolbarMode: 'simple',
    language: 'default',
    imageDefaultDir: '',
    forceRelativeImagePath: false,
    enableDebugLogging: false,
};

export interface SettingsProvider {
    get<K extends keyof EditorSettings>(key: K): EditorSettings[K];
    getAll(): EditorSettings;
    onChange(callback: () => void): { dispose(): void };
}

// 旧 enum (本 sprint で撤廃される 7 themes) のうち light-like なもの。
// 注意: 'dark' は modern enum と重複するので含めない (modern pass-through で処理)
//       'night' は単独 if で先処理
const LIGHT_LIKE_LEGACY = ['github', 'sepia', 'minimal', 'things', 'perplexity'] as const;

/**
 * 旧 enum (`github` `sepia` `night` `dark` `minimal` `perplexity` `things`) →
 * 新 enum (`light` `dark` `auto`) への migration helper.
 *
 * 不明値 → `auto` (typo で意図せず light 固定されるリスク回避、PL-05 default `auto` と整合)
 * tecval/PoC との divergence: PoC patch では `light` fallback、design §3.6 が `auto` 採用 (session-log HIGH-2)
 */
export function migrateLegacyTheme(raw: string | undefined | null): ModernTheme {
    if (!raw) return 'auto';
    // modern values pass-through
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
    // legacy 'night' → dark (唯一の dark-like legacy)
    if (raw === 'night') return 'dark';
    // light-like legacy → light
    if ((LIGHT_LIKE_LEGACY as readonly string[]).includes(raw)) return 'light';
    // unknown value (typo 等) → auto (safer fallback than light)
    return 'auto';
}
