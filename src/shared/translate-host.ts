/**
 * translate-host.ts — webview の翻訳の依頼（translateContent）を受けて訳し、結果を返す（3 つの editor 共通・ADRL-0141）
 *
 * markdown の editor（editorProvider）・outliner（outlinerProvider）・Notes（notes-message-handler）が呼ぶ。
 * 認証は設定 fractal.aws*（キーが空なら AWS CLI と同じ）、用語集は fractal.translateTerminology。
 * 応答（translateResult / translateError）は要求の sidePanelFilePath をそのまま返す（FR-TR-02: サイドパネルの md の要求は
 * サイドパネルへ、メインの要求はメインへ戻る）。vscode 非依存（設定・通知は deps）。
 */
import { t } from '../i18n/messages';
import { awsCredentialSource, awsErrorMessage, AwsSettingsError, readAwsSettings } from './aws-settings';
import { parseTerminologySetting } from './translate-terminology';
import type { TranslateOptions, TranslateResult } from './aws-translate';

export interface TranslateRequestMessage {
    markdown: string;
    sourceLang: string;
    targetLang: string;
    sidePanelFilePath?: string;
}

export interface TranslateHostDeps {
    /** 設定 fractal.<key> */
    getConfig(key: string): unknown;
    /** 相対パスの用語集ファイルの基準 */
    workspaceRoot?: string;
    /** aws-translate の translateText（テストでは差し替える） */
    translate(opts: TranslateOptions): Promise<TranslateResult>;
    post(message: Record<string, unknown>): void;
    /** 失敗を通知にも出す（markdown の editor・outliner。Notes は webview の表示だけ） */
    notifyError?(message: string): void;
    notifyInfo?(message: string): void;
}

export function awsErrorTexts(): { notFound: string; keysIncomplete: string } {
    return { notFound: t('awsCredentialsNotFound'), keysIncomplete: t('awsKeysIncomplete') };
}

export async function handleTranslateRequest(message: TranslateRequestMessage, deps: TranslateHostDeps): Promise<void> {
    const sidePanelFilePath = message.sidePanelFilePath;
    try {
        const aws = readAwsSettings((k) => deps.getConfig(k));
        if (awsCredentialSource(aws) === 'invalid') {
            throw new AwsSettingsError('fractal.awsAccessKeyId / awsSecretAccessKey: only one of them is set');
        }
        const terminology = parseTerminologySetting(deps.getConfig('translateTerminology'), deps.workspaceRoot);
        const result = await deps.translate({
            ...aws,
            text: message.markdown,
            sourceLang: message.sourceLang,
            targetLang: message.targetLang,
            terminologyName: terminology.name,
        });
        if (result.terminologyMissing) {
            deps.notifyInfo?.(t('translateTerminologyMissing').replace('{name}', result.terminologyMissing));
        }
        deps.post({
            type: 'translateResult',
            translatedMarkdown: result.translatedText,
            sourceLang: result.sourceLang,
            targetLang: result.targetLang,
            sidePanelFilePath,
        });
    } catch (err: unknown) {
        const errMsg = awsErrorMessage(err, awsErrorTexts());
        console.error('[Translate] Error:', errMsg, (err as { stack?: string } | null)?.stack || '');
        deps.notifyError?.(`${t('translateFailed')}${errMsg}`);
        deps.post({ type: 'translateError', message: errMsg, sidePanelFilePath });
    }
}
