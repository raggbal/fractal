/**
 * aws-translate.ts — AWS CLI を使った翻訳エンジン
 *
 * child_process.spawn で aws translate translate-text を実行する。
 * AWS SDK v3 を使わない理由: optional peer dependency 問題で VSCode extension 環境では
 * 特定バージョンの middleware が解決できない (@aws/lambda-invoke-store 等)。
 * 既存の notes-s3-sync と同じ CLI 方式で統一。
 */

import { spawn } from 'child_process';

export interface TranslateOptions {
    text: string;
    sourceLang: string;
    targetLang: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
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
    env: NodeJS.ProcessEnv
): Promise<string> {
    return new Promise((resolve, reject) => {
        const args = [
            'translate', 'translate-text',
            '--source-language-code', sourceLang,
            '--target-language-code', targetLang,
            '--text', chunk,
            '--output', 'json',
        ];

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
    const { text, sourceLang, targetLang, accessKeyId, secretAccessKey, region } = opts;

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
        const translatedText = await translateChunk(text, sourceLang, targetLang, env);
        return { translatedText, sourceLang, targetLang };
    }

    const chunks = splitTextByParagraphs(text);
    const translatedChunks: string[] = [];

    for (const chunk of chunks) {
        const translated = await translateChunk(chunk, sourceLang, targetLang, env);
        translatedChunks.push(translated);
    }

    return {
        translatedText: translatedChunks.join('\n\n'),
        sourceLang,
        targetLang,
    };
}
