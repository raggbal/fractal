/**
 * settings-migration.spec.ts — 名前が変わった・外れた設定を新しい設定へ移す（ADRL-0141）
 *
 * TC-MIG-01: S3 用のキーだけ → aws* へ、古い S3 用は消す、リージョンは S3 用
 * TC-MIG-02: 翻訳用のキーだけ → aws* へ、リージョンは翻訳用
 * TC-MIG-03: S3 用と翻訳用が同じ → aws* へ、両方消す、リージョンは翻訳用を優先（用語集はリージョンごと）
 * TC-MIG-04: S3 用と翻訳用のキーが違う → S3 用を使い、翻訳用は残して知らせる
 * TC-MIG-05: 新しい設定がもうある範囲では上書きせず、古い設定だけ消す
 * TC-MIG-06: 用語集: ファイル（無ければ名前）→ translateTerminology、名前が変わるなら知らせる
 * TC-MIG-07: 翻訳の言語は globalState へ（もうあれば移さない）、pdfIncludeDefaultStyles は消す
 * TC-MIG-08: ユーザー / ワークスペースの範囲ごとに移す
 * TC-MIG-09: applySettingsMigration は新しい設定を書いてから古い設定を消す。書けなければ止まり、古い設定は残る
 */
import { test, expect } from '@playwright/test';
import { applySettingsMigration, planSettingsMigration, type MigrationScope } from '../../src/shared/settings-migration';

function plan(values: Record<string, unknown>, opts: { workspace?: Record<string, unknown>; hasLangs?: boolean } = {}) {
    const scopes: MigrationScope[] = opts.workspace ? ['global', 'workspace'] : ['global'];
    return planSettingsMigration((key, scope) => (scope === 'global' ? values : opts.workspace ?? {})[key], scopes, !!opts.hasLangs);
}

const sets = (p: ReturnType<typeof plan>) => p.updates.filter((u) => u.value !== undefined).map((u) => [u.key, u.value]);
const removes = (p: ReturnType<typeof plan>) => p.updates.filter((u) => u.value === undefined).map((u) => u.key).sort();

test('TC-MIG-01 S3 用のキーだけ', () => {
    const p = plan({ s3AccessKeyId: 'AK1', s3SecretAccessKey: 'SK1', s3Region: 'ap-northeast-1' });
    expect(sets(p)).toEqual([['awsAccessKeyId', 'AK1'], ['awsSecretAccessKey', 'SK1'], ['awsRegion', 'ap-northeast-1']]);
    expect(removes(p)).toEqual(['s3AccessKeyId', 's3Region', 's3SecretAccessKey']);
    expect(p.notices).toEqual([{ kind: 'aws' }]);
});

test('TC-MIG-02 翻訳用のキーだけ', () => {
    const p = plan({ transAccessKeyId: 'AK2', transSecretAccessKey: 'SK2', transRegion: 'eu-west-1' });
    expect(sets(p)).toEqual([['awsAccessKeyId', 'AK2'], ['awsSecretAccessKey', 'SK2'], ['awsRegion', 'eu-west-1']]);
    expect(removes(p)).toEqual(['transAccessKeyId', 'transRegion', 'transSecretAccessKey']);
});

test('TC-MIG-03 同じキー: 両方消す・リージョンは翻訳用', () => {
    const p = plan({
        s3AccessKeyId: 'AK', s3SecretAccessKey: 'SK', s3Region: 'ap-northeast-1',
        transAccessKeyId: 'AK', transSecretAccessKey: 'SK', transRegion: 'us-east-1',
    });
    expect(sets(p)).toEqual([['awsAccessKeyId', 'AK'], ['awsSecretAccessKey', 'SK'], ['awsRegion', 'us-east-1']]);
    expect(removes(p)).toEqual(['s3AccessKeyId', 's3Region', 's3SecretAccessKey', 'transAccessKeyId', 'transRegion', 'transSecretAccessKey']);
    expect(p.notices).toEqual([{ kind: 'aws' }]);
});

test('TC-MIG-04 違うキー: S3 用を使い、翻訳用は残して知らせる', () => {
    const p = plan({
        s3AccessKeyId: 'AK-OLD-S3', s3SecretAccessKey: 'SK-S3',
        transAccessKeyId: 'AK-OLD-TR', transSecretAccessKey: 'SK-TR', transRegion: 'us-west-2',
    });
    expect(sets(p)).toEqual([['awsAccessKeyId', 'AK-OLD-S3'], ['awsSecretAccessKey', 'SK-S3'], ['awsRegion', 'us-west-2']]);
    // ★ 翻訳用の秘密のキーを黙って消さない
    expect(removes(p)).toEqual(['s3AccessKeyId', 's3SecretAccessKey']);
    // 1 つになった・S3 用を残した・翻訳用は使われなくなる、を知らせる（キーは見分け用に先頭 4 字・末尾 4 字だけ）
    expect(p.notices).toEqual([{ kind: 'aws' }, { kind: 'awsTranslateKeysKept', s3Key: 'AK-O…D-S3', translateKey: 'AK-O…D-TR' }]);
    expect(JSON.stringify(p.notices)).not.toContain('SK-'); // 秘密のキーは載せない
});

test('TC-MIG-05 新しい設定がもうあれば上書きしない', () => {
    const p = plan({ awsAccessKeyId: 'NEW', awsSecretAccessKey: 'NEWSK', awsRegion: 'sa-east-1', s3AccessKeyId: 'OLD', s3SecretAccessKey: 'OLDSK', s3Region: 'ap-south-1' });
    expect(sets(p)).toEqual([]);
    expect(removes(p)).toEqual(['s3AccessKeyId', 's3Region', 's3SecretAccessKey']);
    expect(p.notices).toEqual([]);
    // 何も無ければ何もしない
    expect(plan({}).updates).toEqual([]);
});

test('TC-MIG-06 用語集', () => {
    const both = plan({ translateTerminologyFile: '~/terms/My Glossary.csv', translateTerminologyName: 'old-name' });
    expect(sets(both)).toEqual([['translateTerminology', '~/terms/My Glossary.csv']]);
    expect(removes(both)).toEqual(['translateTerminologyFile', 'translateTerminologyName']);
    expect(both.notices).toEqual([{ kind: 'terminologyRenamed', name: 'My-Glossary' }]);

    const same = plan({ translateTerminologyFile: '/t/glossary.csv', translateTerminologyName: 'glossary' });
    expect(same.notices).toEqual([]); // 名前が変わらなければ知らせない

    const nameOnly = plan({ translateTerminologyName: 'registered-in-console' });
    expect(sets(nameOnly)).toEqual([['translateTerminology', 'registered-in-console']]);
    expect(removes(nameOnly)).toEqual(['translateTerminologyName']);
});

test('TC-MIG-07 翻訳の言語・pdfIncludeDefaultStyles', () => {
    const p = plan({ translateSourceLang: 'ja', translateTargetLang: 'en', pdfIncludeDefaultStyles: false });
    expect(p.translateLangs).toEqual({ sourceLang: 'ja', targetLang: 'en' });
    expect(sets(p)).toEqual([]);
    expect(removes(p)).toEqual(['pdfIncludeDefaultStyles', 'translateSourceLang', 'translateTargetLang']);
    // globalState にもうあれば移さない（消すだけ）
    const has = plan({ translateSourceLang: 'ja' }, { hasLangs: true });
    expect(has.translateLangs).toBeUndefined();
    expect(removes(has)).toEqual(['translateSourceLang']);
});

test('TC-MIG-08 範囲ごと（ユーザー / ワークスペース）', () => {
    const p = plan({ s3AccessKeyId: 'G', s3SecretAccessKey: 'GS' }, { workspace: { transAccessKeyId: 'W', transSecretAccessKey: 'WS', awsRegion: 'eu-north-1', transRegion: 'eu-west-3' } });
    expect(p.updates.filter((u) => u.value !== undefined)).toEqual([
        { key: 'awsAccessKeyId', value: 'G', scope: 'global' },
        { key: 'awsSecretAccessKey', value: 'GS', scope: 'global' },
        { key: 'awsAccessKeyId', value: 'W', scope: 'workspace' },
        { key: 'awsSecretAccessKey', value: 'WS', scope: 'workspace' },
    ]);
    expect(p.updates.filter((u) => u.value === undefined)).toEqual([
        { key: 's3AccessKeyId', value: undefined, scope: 'global' },
        { key: 's3SecretAccessKey', value: undefined, scope: 'global' },
        { key: 'transAccessKeyId', value: undefined, scope: 'workspace' },
        { key: 'transSecretAccessKey', value: undefined, scope: 'workspace' },
        { key: 'transRegion', value: undefined, scope: 'workspace' },
    ]);
});

test('TC-MIG-09 新しい設定を先に書き、書けなければ止まる（古い設定は残る）', async () => {
    const store: Record<string, unknown> = { s3AccessKeyId: 'AK', s3SecretAccessKey: 'SK', translateSourceLang: 'fr' };
    const written: Array<[string, unknown, number]> = [];
    let langs: unknown;
    const config = {
        inspect: (key: string) => ({ globalValue: store[key] }),
        update: async (key: string, value: unknown, target: number) => {
            written.push([key, value, target]);
            if (value === undefined) {
                delete store[key];
            } else {
                store[key] = value;
            }
        },
    };
    const result = await applySettingsMigration(config, ['global'], { has: () => false, set: async (l) => { langs = l; } });
    expect(written.map((w) => w[0])).toEqual(['awsAccessKeyId', 'awsSecretAccessKey', 's3AccessKeyId', 's3SecretAccessKey', 'translateSourceLang']);
    expect(written.every((w) => w[2] === 1)).toBe(true); // ConfigurationTarget.Global
    expect(store).toEqual({ awsAccessKeyId: 'AK', awsSecretAccessKey: 'SK' });
    expect(langs).toEqual({ sourceLang: 'fr', targetLang: 'ja' });
    expect(result.notices).toEqual([{ kind: 'aws' }]);

    // 書けない（settings.json が壊れている）: 新しいキーの 1 つ目で止まり、古いキーは消さない
    const broken: Record<string, unknown> = { s3AccessKeyId: 'AK', s3SecretAccessKey: 'SK' };
    const tried: string[] = [];
    await expect(applySettingsMigration({
        inspect: (key: string) => ({ globalValue: broken[key] }),
        update: async (key: string) => {
            tried.push(key);
            throw new Error('Unable to write into user settings');
        },
    }, ['global'], { has: () => false, set: async () => undefined })).rejects.toThrow('Unable to write');
    expect(tried).toEqual(['awsAccessKeyId']);
    expect(broken).toEqual({ s3AccessKeyId: 'AK', s3SecretAccessKey: 'SK' });
});
