/**
 * aws-settings.ts — AWS（S3 同期・Amazon Translate）の認証とリージョン（ADRL-0141）
 *
 * 設定は S3 と翻訳で共通の 3 つ: fractal.awsAccessKeyId / awsSecretAccessKey / awsRegion。
 * - キーが両方あれば、そのキーで認証する。両方空なら SDK の既定の探し方（AWS CLI と同じ: 環境変数 →
 *   ~/.aws の credentials / config のプロファイル（AWS_PROFILE、無ければ default。SSO・credential_process・
 *   ロールの引き受けも）→ コンテナ・EC2 のロール）。片方だけは設定のまちがい（AwsSettingsError）。
 * - リージョン: 設定 → AWS_REGION → AWS_DEFAULT_REGION → ~/.aws/config のプロファイルの region → us-east-1。
 * vscode 非依存（設定は呼び出し側が読んで渡す）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface AwsSettings {
    accessKeyId: string;
    secretAccessKey: string;
    /** 空 = AWS CLI の設定（resolveAwsRegion） */
    region: string;
}

export const DEFAULT_AWS_REGION = 'us-east-1';

/** 設定 fractal.aws*（get は getConfiguration('fractal').get） */
export function readAwsSettings(get: (key: string) => unknown): AwsSettings {
    const s = (key: string) => {
        const v = get(key);
        return typeof v === 'string' ? v.trim() : '';
    };
    return { accessKeyId: s('awsAccessKeyId'), secretAccessKey: s('awsSecretAccessKey'), region: s('awsRegion') };
}

/** 設定のまちがい（キーが片方だけ） */
export class AwsSettingsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AwsSettingsError';
    }
}

/** どこで認証するか: 設定のキー / AWS CLI と同じ探し方 / 設定のまちがい（キーが片方だけ） */
export type AwsCredentialSource = 'settings' | 'aws-cli' | 'invalid';

export function awsCredentialSource(s: AwsSettings): AwsCredentialSource {
    if (s.accessKeyId && s.secretAccessKey) {
        return 'settings';
    }
    return s.accessKeyId || s.secretAccessKey ? 'invalid' : 'aws-cli';
}

/** SDK の client（S3Client・TranslateClient）に渡す設定。credentials が無ければ SDK が AWS CLI と同じ順に探す */
export interface AwsClientOptions {
    region: string;
    credentials?: { accessKeyId: string; secretAccessKey: string };
}

export function awsClientOptions(s: AwsSettings, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): AwsClientOptions {
    const source = awsCredentialSource(s);
    if (source === 'invalid') {
        throw new AwsSettingsError('Set both fractal.awsAccessKeyId and fractal.awsSecretAccessKey, or leave both empty to use your AWS CLI credentials.');
    }
    const region = resolveAwsRegion(s.region, env, home);
    return source === 'settings' ? { region, credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } } : { region };
}

export function resolveAwsRegion(setting: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
    const fromSetting = (setting || '').trim();
    if (fromSetting) {
        return fromSetting;
    }
    const fromEnv = (env.AWS_REGION || env.AWS_DEFAULT_REGION || '').trim();
    if (fromEnv) {
        return fromEnv;
    }
    return profileRegion(env, home) || DEFAULT_AWS_REGION;
}

/** ~/.aws/config（AWS_CONFIG_FILE）の、使うプロファイル（AWS_PROFILE、無ければ default）の region。無ければ '' */
export function profileRegion(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
    const configured = (env.AWS_CONFIG_FILE || '').trim();
    const file = configured ? expandHome(configured, home) : path.join(home, '.aws', 'config');
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
    const profile = (env.AWS_PROFILE || '').trim() || 'default';
    const sections = profile === 'default' ? ['default', 'profile default'] : [`profile ${profile}`];
    return iniValue(text, sections, 'region');
}

function expandHome(p: string, home: string): string {
    return p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p;
}

/** INI（~/.aws/config の書式）の sections のどれかにある key の値 */
export function iniValue(text: string, sections: string[], key: string): string {
    let inSection = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) {
            continue;
        }
        const head = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
        if (head) {
            inSection = sections.includes(head[1].replace(/\s+/g, ' '));
            continue;
        }
        if (!inSection) {
            continue;
        }
        const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
        if (kv && kv[1].trim() === key) {
            return kv[2].trim();
        }
    }
    return '';
}

function errorText(err: unknown): string {
    const m = (err as { message?: unknown } | null)?.message;
    return typeof m === 'string' && m ? m : String(err ?? '');
}

/** SDK が認証を見つけられなかったか（設定のキーも AWS CLI の認証も無い・SSO の期限切れなど） */
export function isAwsCredentialsMissing(err: unknown): boolean {
    const name = (err as { name?: unknown } | null)?.name;
    return name === 'CredentialsProviderError' || /could not load credentials/i.test(errorText(err));
}

/**
 * 利用者に出すエラーの文。キーが片方だけなら texts.keysIncomplete、認証が見つからなければ texts.notFound
 * （SSO の期限切れなどは SDK の文を後ろに付ける。「どこにも無い」の総称の文は付けない）、それ以外は SDK の文。
 */
export function awsErrorMessage(err: unknown, texts: { notFound: string; keysIncomplete: string }): string {
    if (err instanceof AwsSettingsError) {
        return texts.keysIncomplete;
    }
    const message = errorText(err);
    if (!isAwsCredentialsMissing(err)) {
        return message;
    }
    return /could not load credentials from any providers/i.test(message) ? texts.notFound : `${texts.notFound} ${message}`;
}
