/**
 * settings-migration.ts — 設定の整理（1.4.2・ADRL-0141）で名前が変わった・外れた設定を、起動時に 1 回だけ移す。
 *
 * - AWS: S3 用（s3AccessKeyId / s3SecretAccessKey / s3Region）と翻訳用（trans*）→ awsAccessKeyId / awsSecretAccessKey / awsRegion。
 *   キーは S3 用（無ければ翻訳用）。リージョンは翻訳を使っていれば翻訳用（用語集はリージョンごと。S3 はバケットのリージョンを
 *   追いかける）、無ければ S3 用。翻訳用のキーが S3 用と違えば翻訳用の設定は消さずに残し、知らせる。
 * - 用語集: translateTerminologyFile（無ければ translateTerminologyName）→ translateTerminology。名前はファイル名から作るように
 *   なったので、前の名前と違えば知らせる（アップロードし直す）。
 * - 翻訳の言語: translateSourceLang / translateTargetLang → globalState（translate-langs.ts）。
 * - pdfIncludeDefaultStyles は消す（既定の印刷用 CSS はいつも入る）。
 * 新しい設定がもうある範囲（ユーザー / ワークスペース）では上書きしない。古い設定は package.json に deprecated で残してある
 * （VS Code は登録の無い設定を update で消せない）。vscode 非依存（設定は ConfigLike）。
 */
import { terminologyNameFromFile } from './translate-terminology';
import type { TranslateLangs } from './translate-langs';

export type MigrationScope = 'global' | 'workspace';

/** 移す・消す古い設定（package.json に deprecated で残す） */
export const LEGACY_SETTING_KEYS = [
    's3AccessKeyId', 's3SecretAccessKey', 's3Region',
    'transAccessKeyId', 'transSecretAccessKey', 'transRegion',
    'translateSourceLang', 'translateTargetLang',
    'translateTerminologyFile', 'translateTerminologyName',
    'pdfIncludeDefaultStyles',
] as const;

export type MigrationNotice =
    | { kind: 'aws' }
    | { kind: 'awsTranslateKeysKept' }
    | { kind: 'terminologyRenamed'; name: string };

export interface MigrationPlan {
    /** 順に書く（value undefined = 消す）。新しい設定を先に書き、古い設定はその後で消す */
    updates: Array<{ key: string; value: unknown; scope: MigrationScope }>;
    /** globalState の翻訳の言語にする（まだ無いとき） */
    translateLangs?: TranslateLangs;
    notices: MigrationNotice[];
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

/**
 * value(key, scope) = その範囲に書かれている値（無ければ undefined）。hasTranslateLangs = globalState にもう翻訳の言語がある。
 * scopes = 移す範囲（ユーザーの設定・開いているワークスペースの設定）。
 */
export function planSettingsMigration(
    value: (key: string, scope: MigrationScope) => unknown,
    scopes: MigrationScope[],
    hasTranslateLangs: boolean
): MigrationPlan {
    const plan: MigrationPlan = { updates: [], notices: [] };
    const removes: MigrationPlan['updates'] = [];
    const notice = (n: MigrationNotice) => {
        if (!plan.notices.some((x) => x.kind === n.kind)) {
            plan.notices.push(n);
        }
    };
    for (const scope of scopes) {
        const v = (key: string) => value(key, scope);
        const set = (key: string, val: unknown) => plan.updates.push({ key, value: val, scope });
        const remove = (...keys: string[]) => {
            for (const key of keys) {
                if (v(key) !== undefined) {
                    removes.push({ key, value: undefined, scope });
                }
            }
        };

        // AWS
        const s3 = { id: str(v('s3AccessKeyId')), secret: str(v('s3SecretAccessKey')), region: str(v('s3Region')) };
        const tr = { id: str(v('transAccessKeyId')), secret: str(v('transSecretAccessKey')), region: str(v('transRegion')) };
        const s3Keys = !!(s3.id && s3.secret);
        const trKeys = !!(tr.id && tr.secret);
        let keptTranslate = false;
        if (v('awsAccessKeyId') === undefined && v('awsSecretAccessKey') === undefined && (s3Keys || trKeys)) {
            const src = s3Keys ? s3 : tr;
            set('awsAccessKeyId', src.id);
            set('awsSecretAccessKey', src.secret);
            notice({ kind: 'aws' });
            keptTranslate = s3Keys && trKeys && (tr.id !== s3.id || tr.secret !== s3.secret);
        }
        if (v('awsRegion') === undefined) {
            const region = (trKeys && tr.region) || s3.region || tr.region;
            if (region) {
                set('awsRegion', region);
            }
        }
        remove('s3AccessKeyId', 's3SecretAccessKey', 's3Region');
        if (keptTranslate) {
            notice({ kind: 'awsTranslateKeysKept' });
        } else {
            remove('transAccessKeyId', 'transSecretAccessKey', 'transRegion');
        }

        // 用語集
        const file = str(v('translateTerminologyFile'));
        const name = str(v('translateTerminologyName'));
        if (v('translateTerminology') === undefined && (file || name)) {
            set('translateTerminology', file || name);
            if (file && name && name !== terminologyNameFromFile(file)) {
                notice({ kind: 'terminologyRenamed', name: terminologyNameFromFile(file) });
            }
        }
        remove('translateTerminologyFile', 'translateTerminologyName');

        // 翻訳の言語（globalState は 1 つ: ユーザーの設定の値を優先）
        const source = str(v('translateSourceLang'));
        const target = str(v('translateTargetLang'));
        if (!hasTranslateLangs && !plan.translateLangs && (source || target)) {
            plan.translateLangs = { sourceLang: source || 'en', targetLang: target || 'ja' };
        }
        remove('translateSourceLang', 'translateTargetLang', 'pdfIncludeDefaultStyles');
    }
    plan.updates.push(...removes);
    return plan;
}

/** vscode.WorkspaceConfiguration の使う部分（getConfiguration('fractal')） */
export interface ConfigLike {
    inspect(key: string): { globalValue?: unknown; workspaceValue?: unknown } | undefined;
    update(key: string, value: unknown, target: number): Thenable<void> | Promise<void>;
}

/** vscode.ConfigurationTarget */
const TARGET: Record<MigrationScope, number> = { global: 1, workspace: 2 };

/** 計画を作って書く。書けなかったら throw（古い設定は、新しい設定を書き終えるまで消さない） */
export async function applySettingsMigration(
    config: ConfigLike,
    scopes: MigrationScope[],
    translateLangs: { has(): boolean; set(langs: TranslateLangs): Promise<void> }
): Promise<MigrationPlan> {
    const plan = planSettingsMigration((key, scope) => {
        const i = config.inspect(key);
        return scope === 'global' ? i?.globalValue : i?.workspaceValue;
    }, scopes, translateLangs.has());
    for (const u of plan.updates) {
        await config.update(u.key, u.value, TARGET[u.scope]);
    }
    if (plan.translateLangs) {
        await translateLangs.set(plan.translateLangs);
    }
    return plan;
}
