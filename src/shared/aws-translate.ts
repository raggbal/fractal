/**
 * aws-translate.ts — Amazon Translate を使った翻訳エンジン
 *
 * I/O 層は translate-sdk-client（AWS SDK v3 の薄いラッパ）に委譲する。
 * このファイルはチャンク分割・segment protection（コードブロック保護）・
 * Custom Terminology のファイル解決/形式判定/サイズ上限といった編成ロジックを担う。
 * credentials は SDK client 生成時に渡す（実行時の env 注入なし）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTranslate, translateTextSdk, importTerminologySdk } from './translate-sdk-client';

type TranslateClient = ReturnType<typeof createTranslate>;

export interface TranslateOptions {
    text: string;
    sourceLang: string;
    targetLang: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    /** v0.207.25: Custom Terminology を使う場合の名前 (Amazon Translate に登録済) */
    terminologyName?: string;
}

export interface TranslateResult {
    translatedText: string;
    sourceLang: string;
    targetLang: string;
}

export const TRANSLATE_LANGUAGES = [
    { code: 'ja', label: '日本語' },
    { code: 'en', label: 'English' },
    { code: 'zh', label: '中文' },
    { code: 'ko', label: '한국어' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
    { code: 'es', label: 'Español' },
    { code: 'pt', label: 'Português' },
    { code: 'it', label: 'Italiano' },
    { code: 'ru', label: 'Русский' },
    { code: 'ar', label: 'العربية' },
    { code: 'hi', label: 'हिन्दी' },
    { code: 'th', label: 'ไทย' },
    { code: 'vi', label: 'Tiếng Việt' },
];

const MAX_BYTES_PER_REQUEST = 10000;

function getByteLength(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}

/**
 * v0.207.31: コードブロックを完全に翻訳経路から分離する segment 方式
 *
 * 旧 placeholder 方式 (v0.207.30) は Unicode 括弧が AWS Translate に削られて復元不能になり、
 * 中身がそのまま `XCB000` として表示される問題があった (例: `CB002` のように "X" まで失われる)。
 *
 * 新方式: text を [translate, preserve, translate, preserve, ...] の segment 列に分割し、
 * preserve segment は AWS Translate に**送らずそのまま結果に含める**。
 *
 * 保護対象:
 * 1. fenced code block (```...```) - 言語タグ付き含む
 * 2. inline code (`...`) - 1 行限定、内部に ` を含まない
 * 3. block math ($$...$$)
 * 4. HTML comment (<!--...-->)
 *
 * インデント 4 スペースの code block / inline math ($...$, 通貨記号と紛らわしい) は対象外。
 */
const PROTECTED_PATTERN = /(```[\s\S]*?```|\$\$[\s\S]*?\$\$|<!--[\s\S]*?-->|`[^`\n]+`)/g;

export interface TranslationSegment {
    type: 'translate' | 'preserve';
    content: string;
}

export function splitProtectedSegments(text: string): TranslationSegment[] {
    const segments: TranslationSegment[] = [];
    let lastIdx = 0;
    PROTECTED_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PROTECTED_PATTERN.exec(text)) !== null) {
        if (m.index > lastIdx) {
            segments.push({ type: 'translate', content: text.slice(lastIdx, m.index) });
        }
        segments.push({ type: 'preserve', content: m[0] });
        lastIdx = PROTECTED_PATTERN.lastIndex;
    }
    if (lastIdx < text.length) {
        segments.push({ type: 'translate', content: text.slice(lastIdx) });
    }
    return segments;
}

function splitTextByParagraphs(text: string): string[] {
    const chunks: string[] = [];
    const paragraphs = text.split('\n\n');
    let currentChunk = '';

    for (const paragraph of paragraphs) {
        const testChunk = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph;

        if (getByteLength(testChunk) > MAX_BYTES_PER_REQUEST) {
            if (currentChunk) {
                chunks.push(currentChunk);
                currentChunk = '';
            }

            if (getByteLength(paragraph) > MAX_BYTES_PER_REQUEST) {
                const sentences = paragraph.split(/(?<=[。.])\s*/);
                let sentenceChunk = '';

                for (const sentence of sentences) {
                    const testSentence = sentenceChunk ? `${sentenceChunk} ${sentence}` : sentence;
                    if (getByteLength(testSentence) > MAX_BYTES_PER_REQUEST) {
                        if (sentenceChunk) {
                            chunks.push(sentenceChunk);
                        }
                        chunks.push(sentence);
                        sentenceChunk = '';
                    } else {
                        sentenceChunk = testSentence;
                    }
                }

                if (sentenceChunk) {
                    currentChunk = sentenceChunk;
                }
            } else {
                currentChunk = paragraph;
            }
        } else {
            currentChunk = testChunk;
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk);
    }

    return chunks;
}

/**
 * Amazon Translate で単一チャンクを翻訳（SDK client 経由）。
 * segment protection・チャンク分割の編成は呼び出し側（translateText / translateSegmentText）に残す。
 */
async function translateChunk(
    client: TranslateClient,
    chunk: string,
    sourceLang: string,
    targetLang: string,
    terminologyName?: string
): Promise<string> {
    return await translateTextSdk(client, {
        text: chunk,
        sourceLang,
        targetLang,
        terminologyName,
    });
}

export async function translateText(opts: TranslateOptions): Promise<TranslateResult> {
    const { text, sourceLang, targetLang, accessKeyId, secretAccessKey, region, terminologyName } = opts;

    if (!accessKeyId || !secretAccessKey) {
        throw new Error('AWS credentials are required');
    }

    const client = createTranslate({ accessKeyId, secretAccessKey, region });

    // v0.207.31: コードブロックを segment 単位で翻訳経路から完全分離
    const segments = splitProtectedSegments(text);
    const out: string[] = [];
    for (const seg of segments) {
        if (seg.type === 'preserve') {
            out.push(seg.content);
            continue;
        }
        // 空白のみは翻訳しない (Amazon Translate が余計な変換するのを防ぐ)
        if (!seg.content.trim()) {
            out.push(seg.content);
            continue;
        }
        out.push(await translateSegmentText(client, seg.content, sourceLang, targetLang, terminologyName));
    }
    return { translatedText: out.join(''), sourceLang, targetLang };
}

/**
 * 1 segment の text を翻訳。MAX_BYTES を超えたら paragraph 分割。
 */
async function translateSegmentText(
    client: TranslateClient,
    text: string,
    sourceLang: string,
    targetLang: string,
    terminologyName?: string
): Promise<string> {
    if (getByteLength(text) <= MAX_BYTES_PER_REQUEST) {
        return await translateChunk(client, text, sourceLang, targetLang, terminologyName);
    }
    const chunks = splitTextByParagraphs(text);
    const translatedChunks: string[] = [];
    for (const chunk of chunks) {
        translatedChunks.push(await translateChunk(client, chunk, sourceLang, targetLang, terminologyName));
    }
    return translatedChunks.join('\n\n');
}

/**
 * v0.207.25: Custom Terminology のファイルパスを解決 (絶対 / ~ / 相対)
 *
 * @param rawPath user の設定値 (絶対 / ~ / 相対 / 相対のみ)
 * @param workspaceRoot relative path のベース (workspace root 等)
 */
export function resolveTerminologyPath(rawPath: string, workspaceRoot?: string): string {
    if (!rawPath) return '';
    let p = rawPath.trim();
    // home dir 展開 (~/foo or ~)
    if (p.startsWith('~')) {
        p = path.join(os.homedir(), p.slice(1));
    }
    if (path.isAbsolute(p)) return p;
    // 相対 path: workspace root か cwd ベース
    const base = workspaceRoot || process.cwd();
    return path.resolve(base, p);
}

export interface ImportTerminologyOptions {
    name: string;
    filePath: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
}

/**
 * v0.207.25: Amazon Translate に Custom Terminology を import する
 *
 * 既存名と同じ name を渡すと Amazon Translate 上で merge OVERWRITE され上書き更新される。
 * format は拡張子で判定 (.csv → CSV、.tmx / .xml → TMX)。
 * ファイル存在チェック・10MB 上限・CSV/TMX 判定は本関数（呼び出し側）に残し、
 * 生バイト（Uint8Array）を translate-sdk-client の importTerminologySdk に渡す。
 */
export async function importTerminology(opts: ImportTerminologyOptions): Promise<{ name: string; termCount?: number }> {
    const { name, filePath, accessKeyId, secretAccessKey, region } = opts;
    if (!name) throw new Error('Terminology name is required');
    if (!filePath) throw new Error('Terminology file path is required');
    if (!fs.existsSync(filePath)) {
        throw new Error(`Terminology file not found: ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) {
        throw new Error(`Terminology file too large (${stat.size} bytes, max 10 MB)`);
    }

    const ext = path.extname(filePath).toLowerCase();
    let format: 'CSV' | 'TMX';
    if (ext === '.csv') format = 'CSV';
    else if (ext === '.tmx' || ext === '.xml') format = 'TMX';
    else throw new Error(`Unsupported terminology file extension: ${ext} (use .csv or .tmx)`);

    if (!accessKeyId || !secretAccessKey) {
        throw new Error('AWS credentials are required');
    }

    const fileBytes = new Uint8Array(fs.readFileSync(filePath));
    const client = createTranslate({ accessKeyId, secretAccessKey, region });
    return await importTerminologySdk(client, { name, fileBytes, format });
}
