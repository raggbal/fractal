/**
 * translate-sdk-client.ts — AWS Translate の I/O 層を AWS SDK v3 でラップする
 *
 * 旧実装の aws CLI 子プロセス起動を廃し、@aws-sdk/client-translate の
 * client.send(Command) に差し替えた薄いラッパ。
 *
 * 現行 CLI 実装（src/shared/aws-translate.ts）との 1:1 対応:
 *   translateChunk() の spawn (:168-205)     → translateTextSdk()
 *   importTerminology() の spawn (:332-363)   → importTerminologySdk()
 *
 * 責務は「CLI 引数 ↔ SDK Command input のマッピング」に限る。
 * チャンク分割・segment protection・CSV/TMX 拡張子判定・10MB 上限・
 * resolveTerminologyPath は呼び出し側（aws-translate.ts）に残す（ここには置かない）。
 *
 * - vscode 非依存
 * - client は引数注入（unit で mock 可能）
 * - fail-fast: SDK が投げる例外はそのまま透過（握りつぶさない）
 */

import {
    TranslateClient,
    TranslateTextCommand,
    ImportTerminologyCommand,
} from '@aws-sdk/client-translate';

export interface TranslateSdkConfig {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
}

/**
 * 静的キー + region で TranslateClient を生成する。
 * 現行 CLI の env 注入（AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION）
 * に相当。credentials は client 生成時に渡す（send 時の env 注入は不要）。
 */
export function createTranslate(config: TranslateSdkConfig): TranslateClient {
    return new TranslateClient({
        region: config.region,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });
}

export interface TranslateTextSdkOptions {
    text: string;
    sourceLang: string;
    targetLang: string;
    /** v0.207.25: Custom Terminology を使う場合の登録済み名。透過。 */
    terminologyName?: string;
}

/**
 * 単一チャンクを翻訳する（translateChunk の spawn を置換）。
 *
 * CLI 引数 → SDK Command input（aws-translate.ts:168-205）:
 *   --source-language-code <sourceLang>  → SourceLanguageCode
 *   --target-language-code <targetLang>  → TargetLanguageCode
 *   --text <chunk>                       → Text
 *   --terminology-names <name>           → TerminologyNames: [name]（terminologyName 指定時のみ）
 *   result.TranslatedText                → 返り値
 *
 * terminologyName 未指定時は TerminologyNames キー自体を input に含めない
 * （CLI で --terminology-names を push しないのと同等）。
 */
export async function translateTextSdk(
    client: TranslateClient,
    opts: TranslateTextSdkOptions,
): Promise<string> {
    const out = await client.send(new TranslateTextCommand({
        SourceLanguageCode: opts.sourceLang,
        TargetLanguageCode: opts.targetLang,
        Text: opts.text,
        ...(opts.terminologyName ? { TerminologyNames: [opts.terminologyName] } : {}),
    }));
    return out.TranslatedText ?? '';
}

export interface ImportTerminologySdkOptions {
    name: string;
    /** ファイルの生バイト列。CSV/TMX 判定・10MB 上限・読込は呼び出し側の責務。 */
    fileBytes: Uint8Array;
    format: 'CSV' | 'TMX';
}

/**
 * Custom Terminology を import する（importTerminology の spawn を置換）。
 *
 * CLI 引数 → SDK Command input（aws-translate.ts:332-363）:
 *   --name <name>                      → Name
 *   --merge-strategy OVERWRITE         → MergeStrategy: 'OVERWRITE'（既存名は上書き更新）
 *   --terminology-data Format=CSV|TMX  → TerminologyData.Format
 *   --data-file fileb://<path>         → TerminologyData.File: Uint8Array（生バイト）
 *   result.TerminologyProperties.Name / .TermCount → 返り値 { name, termCount? }
 *
 * CSV/TMX 判定（拡張子）・10MB 上限・ファイル読込は呼び出し側に残すため、
 * ここには置かない（fileBytes / format を受け取るだけ）。
 */
export async function importTerminologySdk(
    client: TranslateClient,
    opts: ImportTerminologySdkOptions,
): Promise<{ name: string; termCount?: number }> {
    const out = await client.send(new ImportTerminologyCommand({
        Name: opts.name,
        MergeStrategy: 'OVERWRITE',
        TerminologyData: {
            Format: opts.format,
            File: opts.fileBytes,
        },
    }));
    const tp = out.TerminologyProperties;
    return { name: tp?.Name ?? opts.name, termCount: tp?.TermCount };
}
