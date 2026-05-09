/**
 * aws-translate.ts — AWS CLI を使った翻訳エンジン
 *
 * child_process.spawn で aws translate translate-text を実行する。
 * AWS SDK v3 を使わない理由: optional peer dependency 問題で VSCode extension 環境では
 * 特定バージョンの middleware が解決できない (@aws/lambda-invoke-store 等)。
 * 既存の notes-s3-sync と同じ CLI 方式で統一。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
 * AWS CLI が利用可能か確認
 */
export async function checkAwsCli(): Promise<boolean> {
    return new Promise((resolve) => {
        const proc = spawn('aws', ['--version'], { stdio: 'pipe' });
        proc.on('error', () => resolve(false));
        proc.on('close', (code) => resolve(code === 0));
    });
}

/**
 * aws translate translate-text を実行して単一チャンクを翻訳
 */
async function translateChunk(
    chunk: string,
    sourceLang: string,
    targetLang: string,
    env: NodeJS.ProcessEnv,
    terminologyName?: string
): Promise<string> {
    return new Promise((resolve, reject) => {
        const args = [
            'translate', 'translate-text',
            '--source-language-code', sourceLang,
            '--target-language-code', targetLang,
            '--text', chunk,
            '--output', 'json',
        ];
        // v0.207.25: terminology name 指定で Custom Terminology を使う
        if (terminologyName) {
            args.push('--terminology-names', terminologyName);
        }

        const proc = spawn('aws', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('error', (err) => {
            reject(new Error(`Failed to spawn aws CLI: ${err.message}. Is AWS CLI installed? https://aws.amazon.com/cli/`));
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`aws translate failed (exit ${code}): ${stderr.trim() || stdout.trim()}`));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                resolve(result.TranslatedText || '');
            } catch (err: any) {
                reject(new Error(`Failed to parse aws translate output: ${err.message}`));
            }
        });
    });
}

export async function translateText(opts: TranslateOptions): Promise<TranslateResult> {
    const { text, sourceLang, targetLang, accessKeyId, secretAccessKey, region, terminologyName } = opts;

    if (!accessKeyId || !secretAccessKey) {
        throw new Error('AWS credentials are required');
    }

    const hasCli = await checkAwsCli();
    if (!hasCli) {
        throw new Error('AWS CLI is not installed. Please install it from https://aws.amazon.com/cli/');
    }

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        AWS_ACCESS_KEY_ID: accessKeyId,
        AWS_SECRET_ACCESS_KEY: secretAccessKey,
        AWS_DEFAULT_REGION: region,
    };

    const textByteLength = getByteLength(text);

    if (textByteLength <= MAX_BYTES_PER_REQUEST) {
        const translatedText = await translateChunk(text, sourceLang, targetLang, env, terminologyName);
        return { translatedText, sourceLang, targetLang };
    }

    const chunks = splitTextByParagraphs(text);
    const translatedChunks: string[] = [];

    for (const chunk of chunks) {
        const translated = await translateChunk(chunk, sourceLang, targetLang, env, terminologyName);
        translatedChunks.push(translated);
    }

    return {
        translatedText: translatedChunks.join('\n\n'),
        sourceLang,
        targetLang,
    };
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
 * v0.207.25: aws translate import-terminology を実行
 *
 * 既存名と同じ name を渡すと Amazon Translate 上で merge OVERWRITE され上書き更新される。
 * format は拡張子で判定 (.csv → CSV、.tmx / .xml → TMX)。
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

    const hasCli = await checkAwsCli();
    if (!hasCli) {
        throw new Error('AWS CLI is not installed. Please install it from https://aws.amazon.com/cli/');
    }

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        AWS_ACCESS_KEY_ID: accessKeyId,
        AWS_SECRET_ACCESS_KEY: secretAccessKey,
        AWS_DEFAULT_REGION: region,
    };

    return new Promise((resolve, reject) => {
        const args = [
            'translate', 'import-terminology',
            '--name', name,
            '--merge-strategy', 'OVERWRITE',
            '--terminology-data', `Format=${format}`,
            '--data-file', `fileb://${filePath}`,
            '--output', 'json',
        ];

        const proc = spawn('aws', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', (err) => {
            reject(new Error(`Failed to spawn aws CLI: ${err.message}`));
        });
        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`aws translate import-terminology failed (exit ${code}): ${stderr.trim() || stdout.trim()}`));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                const tp = result?.TerminologyProperties;
                resolve({ name: tp?.Name || name, termCount: tp?.TermCount });
            } catch (err: any) {
                resolve({ name }); // parse 失敗でも import 自体は OK だったので成功扱い
            }
        });
    });
}
