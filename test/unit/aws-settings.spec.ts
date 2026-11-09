/**
 * aws-settings.spec.ts — AWS の認証とリージョン（ADRL-0141）
 *
 * TC-AWS-01: 設定 fractal.aws* を読む（前後の空白を落とす・文字以外は空）
 * TC-AWS-02: キーが両方 → 設定のキー / 両方空 → AWS CLI と同じ探し方（credentials を渡さない）/ 片方だけ → AwsSettingsError
 * TC-AWS-03: リージョンの順: 設定 → AWS_REGION → AWS_DEFAULT_REGION → ~/.aws/config のプロファイル → us-east-1
 * TC-AWS-04: ~/.aws/config の読み方（[default] / [profile x]・コメント・ほかの section の region を拾わない）
 * TC-AWS-05: キーが空なら S3Client・TranslateClient が AWS CLI と同じく ~/.aws のプロファイルの認証を使う
 *            （AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE を一時ファイルに向ける。本物の ~/.aws は読まない・ネットワークに出ない）
 * TC-AWS-06: どこにも認証が無ければ「見つからない」の文（SDK の総称の文は付けない）、片方だけなら「両方入れる」の文
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    awsClientOptions, awsCredentialSource, awsErrorMessage, AwsSettingsError, iniValue, profileRegion, readAwsSettings, resolveAwsRegion,
} from '../../src/shared/aws-settings';
import { createS3 } from '../../src/shared/s3-sdk-client';
import { createTranslate } from '../../src/shared/translate-sdk-client';

function tmpDir(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aws-settings-')));
}

/** process.env の AWS_* を一時的に差し替える（SDK は呼ばれた時の process.env を読む） */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
    const keys = Object.keys(process.env).filter((k) => k.startsWith('AWS_'));
    const saved: Record<string, string | undefined> = {};
    for (const k of new Set([...keys, ...Object.keys(vars)])) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    for (const [k, v] of Object.entries(vars)) {
        if (v !== undefined) {
            process.env[k] = v;
        }
    }
    try {
        await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = v;
            }
        }
    }
}

test('TC-AWS-01 readAwsSettings は fractal.aws* を読み、前後の空白を落とす', () => {
    const table: Record<string, unknown> = { awsAccessKeyId: '  AKIAEXAMPLE ', awsSecretAccessKey: 'SECRET', awsRegion: 42 };
    expect(readAwsSettings((k) => table[k])).toEqual({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'SECRET', region: '' });
    expect(readAwsSettings(() => undefined)).toEqual({ accessKeyId: '', secretAccessKey: '', region: '' });
});

test('TC-AWS-02 キーが両方 → 設定のキー、両方空 → AWS CLI と同じ探し方、片方だけ → まちがい', () => {
    const env = { AWS_REGION: 'eu-west-1' };
    const both = { accessKeyId: 'AK', secretAccessKey: 'SK', region: '' };
    expect(awsCredentialSource(both)).toBe('settings');
    expect(awsClientOptions(both, env, '/nonexistent')).toEqual({ region: 'eu-west-1', credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' } });

    const none = { accessKeyId: '', secretAccessKey: '', region: 'ap-northeast-1' };
    expect(awsCredentialSource(none)).toBe('aws-cli');
    const opts = awsClientOptions(none, env, '/nonexistent');
    expect(opts).toEqual({ region: 'ap-northeast-1' });
    expect('credentials' in opts).toBe(false); // ★ credentials を渡さない = SDK の既定の探し方

    for (const half of [{ accessKeyId: 'AK', secretAccessKey: '', region: '' }, { accessKeyId: '', secretAccessKey: 'SK', region: '' }]) {
        expect(awsCredentialSource(half)).toBe('invalid');
        expect(() => awsClientOptions(half, env, '/nonexistent')).toThrow(AwsSettingsError);
    }
});

test('TC-AWS-03 リージョンは 設定 → AWS_REGION → AWS_DEFAULT_REGION → プロファイル → us-east-1', () => {
    const home = tmpDir();
    fs.mkdirSync(path.join(home, '.aws'));
    fs.writeFileSync(path.join(home, '.aws', 'config'), '[default]\nregion = ap-southeast-2\n');
    expect(resolveAwsRegion('ca-central-1', { AWS_REGION: 'eu-west-1' }, home)).toBe('ca-central-1');
    expect(resolveAwsRegion('', { AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'eu-west-2' }, home)).toBe('eu-west-1');
    expect(resolveAwsRegion('', { AWS_DEFAULT_REGION: 'eu-west-2' }, home)).toBe('eu-west-2');
    expect(resolveAwsRegion('', {}, home)).toBe('ap-southeast-2');
    expect(resolveAwsRegion('', {}, path.join(home, 'nobody'))).toBe('us-east-1');
});

test('TC-AWS-04 ~/.aws/config: [default] と [profile x]、コメント、AWS_CONFIG_FILE・AWS_PROFILE', () => {
    const text = [
        '# comment',
        '[default]',
        'output = json',
        '; region = xx-ignored-1',
        'region=us-west-2',
        '',
        '[profile work]',
        'sso_session = corp',
        'region = ap-northeast-1',
        '',
        '[sso-session corp]',
        'sso_region = eu-central-1',
    ].join('\n');
    expect(iniValue(text, ['default'], 'region')).toBe('us-west-2');
    expect(iniValue(text, ['profile work'], 'region')).toBe('ap-northeast-1');
    expect(iniValue(text, ['profile none'], 'region')).toBe('');
    expect(iniValue(text, ['sso-session corp'], 'region')).toBe(''); // sso_region は region ではない

    const dir = tmpDir();
    const file = path.join(dir, 'config');
    fs.writeFileSync(file, text);
    expect(profileRegion({ AWS_CONFIG_FILE: file }, '/nonexistent')).toBe('us-west-2');
    expect(profileRegion({ AWS_CONFIG_FILE: file, AWS_PROFILE: 'work' }, '/nonexistent')).toBe('ap-northeast-1');
    expect(profileRegion({ AWS_CONFIG_FILE: file, AWS_PROFILE: 'none' }, '/nonexistent')).toBe('');
});

test('TC-AWS-05 キーが空なら S3・Translate の client は ~/.aws のプロファイルの認証を使う（AWS CLI と同じ）', async () => {
    const dir = tmpDir();
    const credentials = path.join(dir, 'credentials');
    const config = path.join(dir, 'config');
    fs.writeFileSync(credentials, '[fractal-test]\naws_access_key_id = AKIAPROFILEEXAMPLE\naws_secret_access_key = profile-secret\n');
    fs.writeFileSync(config, '[profile fractal-test]\nregion = ap-northeast-3\n');
    await withEnv({
        AWS_SHARED_CREDENTIALS_FILE: credentials,
        AWS_CONFIG_FILE: config,
        AWS_PROFILE: 'fractal-test',
        AWS_EC2_METADATA_DISABLED: 'true',
    }, async () => {
        const settings = { accessKeyId: '', secretAccessKey: '', region: '' };
        for (const client of [createS3(settings), createTranslate(settings)]) {
            const creds = await (client.config.credentials as () => Promise<{ accessKeyId: string; secretAccessKey: string }>)();
            expect(creds.accessKeyId).toBe('AKIAPROFILEEXAMPLE');
            expect(creds.secretAccessKey).toBe('profile-secret');
            expect(await client.config.region()).toBe('ap-northeast-3');
        }
        // キーがあれば、プロファイルではなくそのキー
        const own = createTranslate({ accessKeyId: 'AKIAOWN', secretAccessKey: 'own-secret', region: 'us-west-1' });
        const ownCreds = await (own.config.credentials as () => Promise<{ accessKeyId: string }>)();
        expect(ownCreds.accessKeyId).toBe('AKIAOWN');
        expect(await own.config.region()).toBe('us-west-1');
    });
});

test('TC-AWS-06 認証が見つからない・キーが片方だけのときの文', async () => {
    const texts = { notFound: 'NOT-FOUND', keysIncomplete: 'BOTH-KEYS' };
    const dir = tmpDir();
    const empty = path.join(dir, 'empty');
    fs.writeFileSync(empty, '');
    await withEnv({ AWS_SHARED_CREDENTIALS_FILE: empty, AWS_CONFIG_FILE: empty, AWS_EC2_METADATA_DISABLED: 'true' }, async () => {
        const client = createTranslate({ accessKeyId: '', secretAccessKey: '', region: 'us-east-1' });
        let caught: unknown;
        try {
            await (client.config.credentials as () => Promise<unknown>)();
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeTruthy();
        expect(awsErrorMessage(caught, texts)).toBe('NOT-FOUND');
    });
    // SSO の期限切れなど、SDK の文に意味があるときは後ろに付ける
    const expired = Object.assign(new Error('The SSO session associated with this profile has expired.'), { name: 'CredentialsProviderError' });
    expect(awsErrorMessage(expired, texts)).toBe('NOT-FOUND The SSO session associated with this profile has expired.');
    expect(awsErrorMessage(new AwsSettingsError('x'), texts)).toBe('BOTH-KEYS');
    expect(awsErrorMessage(new Error('AccessDenied'), texts)).toBe('AccessDenied');
});
