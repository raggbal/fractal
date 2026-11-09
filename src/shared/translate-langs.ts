/**
 * translate-langs.ts — 翻訳の言語（翻訳の画面で最後に選んだもの）を globalState に覚える（ADRL-0141）
 *
 * 以前は設定 fractal.translateSourceLang / translateTargetLang に書き戻していた（利用者が直す設定ではないので外した。
 * 古い値は settings-migration.ts が 1 回だけここへ移す）。開いている画面は onDidChangeTranslateLangs でそろえる。
 * vscode 非依存（globalState は activate で initTranslateLangs に渡す）。
 */

export interface TranslateLangs {
    sourceLang: string;
    targetLang: string;
}

export const TRANSLATE_LANGS_KEY = 'translateLangs';
export const DEFAULT_TRANSLATE_LANGS: TranslateLangs = { sourceLang: 'en', targetLang: 'ja' };

export interface MementoLike {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

let memento: MementoLike | undefined;
const listeners = new Set<(langs: TranslateLangs) => void>();

export function initTranslateLangs(m: MementoLike): void {
    memento = m;
}

function lang(v: unknown, fallback: string): string {
    return typeof v === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$|^auto$/.test(v) ? v : fallback;
}

export function getTranslateLangs(): TranslateLangs {
    const v = memento?.get<Partial<TranslateLangs>>(TRANSLATE_LANGS_KEY);
    return {
        sourceLang: lang(v?.sourceLang, DEFAULT_TRANSLATE_LANGS.sourceLang),
        targetLang: lang(v?.targetLang, DEFAULT_TRANSLATE_LANGS.targetLang),
    };
}

export async function setTranslateLangs(langs: TranslateLangs): Promise<void> {
    const next = {
        sourceLang: lang(langs.sourceLang, DEFAULT_TRANSLATE_LANGS.sourceLang),
        targetLang: lang(langs.targetLang, DEFAULT_TRANSLATE_LANGS.targetLang),
    };
    await memento?.update(TRANSLATE_LANGS_KEY, next);
    for (const f of Array.from(listeners)) {
        try {
            f(next);
        } catch (err) {
            console.error('[Translate] langs listener failed:', err);
        }
    }
}

export function onDidChangeTranslateLangs(f: (langs: TranslateLangs) => void): { dispose(): void } {
    listeners.add(f);
    return { dispose: () => { listeners.delete(f); } };
}
