/**
 * TASK-28 — 送る系 / 複数選択の i18n（新規 7 キー × 7 locale）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / NFR-I18N-01 / §9）
 *
 * TC-I18N-01。
 *
 * 🔴 **キーの存在だけでは足りない**（generator_failures 2026-08-22 の実例:
 * `viewerFind` を `Messages` に登録したが消費側は `WebviewMessages` を読むため
 * **全 locale で英語固定**になった）。したがって
 *   ① `messages.ts` の**どの interface ブロックに宣言されているか**
 *   ② 各 locale ファイルの**どのオブジェクトに入っているか**（宣言順 = Messages → WebviewMessages）
 *   ③ **消費側のコードがどちらの器から読んでいるか**
 * の 3 点を突き合わせる。
 *
 * counterfactual: いずれか 1 キーを誤った interface に移すと RED。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '..', '..');
const LOCALES = ['en', 'ja', 'zh-cn', 'zh-tw', 'ko', 'es', 'fr'];

/** host `t()` が読む器（Messages）に置くキー。 */
// TC-SND-15b（再オープン TASK-46）: `.out` 未オープン通知は host t() が出すので Messages
const HOST_KEYS = ['sendToOutlinerDone', 'sendToLinkedfdDone', 'batchDndSummary', 'sendToOutlinerNoOutline'];
/** webview `label()`（`window.__outlinerMessages`）が読む器（WebviewMessages）に置くキー。 */
// TC-MSEL-31b（再オープン TASK-45）: `.out` 除外通知は note ツリー（webview）が出すので WebviewMessages
const WEBVIEW_KEYS = ['sendToOutlinerMenu', 'sendToLinkedfdMenu', 'sendToLinkedfdNoLinks', 'batchDndFoldersSkipped', 'batchDndOutSkipped', 'sendToOutlinerNoOutlines'];
const ALL_KEYS = [...HOST_KEYS, ...WEBVIEW_KEYS];

/** `messages.ts` を interface ブロックごとに切る。 */
function splitInterfaces(): { messages: string; webview: string } {
    const src = fs.readFileSync(path.join(REPO, 'src', 'i18n', 'messages.ts'), 'utf8');
    const mAt = src.indexOf('export interface Messages {');
    const wAt = src.indexOf('export interface WebviewMessages {');
    expect(mAt, 'Messages interface が無い').toBeGreaterThan(-1);
    expect(wAt, 'WebviewMessages interface が無い').toBeGreaterThan(-1);
    expect(wAt, 'WebviewMessages が Messages より前にある（前提が変わった）').toBeGreaterThan(mAt);
    // Messages ブロックの終端 = WebviewMessages の宣言直前
    return { messages: src.slice(mAt, wAt), webview: src.slice(wAt) };
}

/** locale ファイルを「Messages 側 / WebviewMessages 側」に切る。 */
function splitLocale(loc: string): { messages: string; webview: string } {
    const src = fs.readFileSync(path.join(REPO, 'src', 'i18n', 'locales', `${loc}.ts`), 'utf8');
    // 2 つのオブジェクトが順に並ぶ（Messages → WebviewMessages）。境界は 2 番目の export
    const exports = [...src.matchAll(/^export const \w+/gm)].map((m) => m.index ?? 0);
    expect(exports.length, `${loc}: export が 2 つ以上ない（構造が変わった）`).toBeGreaterThanOrEqual(2);
    return { messages: src.slice(exports[0], exports[1]), webview: src.slice(exports[1]) };
}

test.describe('TC-I18N-01 7 キー × 7 locale + interface 帰属', () => {
    test('messages.ts の宣言が正しい interface ブロックに入っている', () => {
        const { messages, webview } = splitInterfaces();
        for (const k of HOST_KEYS) {
            expect(messages.includes(`${k}:`), `${k} が Messages に無い（host t() が読めない）`).toBe(true);
            expect(webview.includes(`${k}:`), `${k} が WebviewMessages にも宣言されている（二重宣言）`).toBe(false);
        }
        for (const k of WEBVIEW_KEYS) {
            expect(webview.includes(`${k}:`),
                `${k} が WebviewMessages に無い — 消費側は window.__outlinerMessages を読むので`
                + '全 locale で英語固定になる（generator_failures 2026-08-22 の失敗クラス）').toBe(true);
            expect(messages.includes(`${k}:`), `${k} が Messages にも宣言されている（二重宣言）`).toBe(false);
        }
    });

    test('7 locale すべてに 7 キーがあり、正しい器に入っている', () => {
        for (const loc of LOCALES) {
            const { messages, webview } = splitLocale(loc);
            for (const k of HOST_KEYS) {
                expect(messages.includes(`${k}:`), `${loc}: ${k} が Messages 側の定義に無い`).toBe(true);
            }
            for (const k of WEBVIEW_KEYS) {
                expect(webview.includes(`${k}:`), `${loc}: ${k} が WebviewMessages 側の定義に無い`).toBe(true);
            }
        }
    });

    test('プレースホルダが宣言どおり入っている（置換漏れで {count} が表示されるのを防ぐ）', () => {
        const need: Record<string, string[]> = {
            sendToOutlinerDone: ['{count}', '{skipped}'],
            sendToLinkedfdDone: ['{count}', '{name}', '{skipped}'],
            batchDndSummary: ['{count}', '{skipped}', '{failed}'],
            batchDndFoldersSkipped: ['{count}'],
        };
        for (const loc of LOCALES) {
            const src = fs.readFileSync(path.join(REPO, 'src', 'i18n', 'locales', `${loc}.ts`), 'utf8');
            for (const [key, holders] of Object.entries(need)) {
                const line = src.split('\n').find((l) => l.trim().startsWith(`${key}:`));
                expect(line, `${loc}: ${key} の行が無い`).toBeTruthy();
                for (const h of holders) {
                    expect(line!.includes(h), `${loc}: ${key} に ${h} が無い（置換が効かず素の文字列が出る）`).toBe(true);
                }
            }
        }
    });

    test('英語以外の locale が英語そのままになっていない（翻訳漏れの検出）', () => {
        const enSrc = fs.readFileSync(path.join(REPO, 'src', 'i18n', 'locales', 'en.ts'), 'utf8');
        const enLine = (k: string) => enSrc.split('\n').find((l) => l.trim().startsWith(`${k}:`)) || '';
        // 英語圏以外（ja / zh-cn / zh-tw / ko）は必ず非 ASCII を含むべき
        for (const loc of ['ja', 'zh-cn', 'zh-tw', 'ko']) {
            const src = fs.readFileSync(path.join(REPO, 'src', 'i18n', 'locales', `${loc}.ts`), 'utf8');
            for (const k of ALL_KEYS) {
                const line = src.split('\n').find((l) => l.trim().startsWith(`${k}:`)) || '';
                expect(line, `${loc}: ${k} の行が無い`).toBeTruthy();
                expect(line.trim(), `${loc}: ${k} が en と同一（翻訳漏れ）`).not.toBe(enLine(k).trim());
                // 固有名詞（Outliner / linkedfd）以外の部分に非 ASCII があること
                const stripped = line.replace(/Outliner|linkedfd/g, '');
                // eslint-disable-next-line no-control-regex
                expect(/[^\x00-\x7F]/.test(stripped), `${loc}: ${k} に訳文が入っていない: ${line.trim()}`).toBe(true);
            }
        }
    });
});

test.describe('TC-I18N-01 消費側と器の一致（実コードとの突き合わせ）', () => {
    /** ファイル群の中で `<expr>.<key>` の形で読んでいる箇所を探す。 */
    function readsFrom(files: string[], key: string): string[] {
        const hits: string[] = [];
        for (const rel of files) {
            const abs = path.join(REPO, rel);
            if (!fs.existsSync(abs)) { continue; }
            const src = fs.readFileSync(abs, 'utf8');
            for (const line of src.split('\n')) {
                if (line.includes(`.${key}`) || line.includes(`'${key}'`)) { hits.push(`${rel}: ${line.trim()}`); }
            }
        }
        return hits;
    }

    const WEBVIEW_FILES = [
        'src/shared/notes-folder-view.js', 'src/shared/notes-file-panel.js', 'src/webview/outliner.js',
    ];
    const HOST_FILES = [
        'src/notesEditorProvider.ts', 'src/shared/folder-import-host.ts', 'src/shared/folder-export-host.ts',
    ];

    test('WebviewMessages のキーは webview ファイルから i18n オブジェクト経由で読まれている', () => {
        for (const k of WEBVIEW_KEYS) {
            const hits = readsFrom(WEBVIEW_FILES, k);
            expect(hits.length, `${k} を消費している webview コードが無い（dead key）`).toBeGreaterThan(0);
            // i18n オブジェクト経由（`i18n().key` / `i18n.key` / `var m = i18n()` の `m.key`）で
            // 読んでいる = webview の器。**`t('key')` 形（host）になっていない**ことが本質。
            expect(hits.some((h) => h.includes(`t('${k}')`)),
                `${k} が host t() 経由で読まれている（WebviewMessages にあるので undefined）: ${hits.join(' / ')}`)
                .toBe(false);
            // プロパティアクセス形であること（文字列キーの動的参照だと器の追跡ができない）
            expect(hits.some((h) => new RegExp('\\.' + k + '\\b').test(h)),
                `${k} がプロパティアクセスで読まれていない: ${hits.join(' / ')}`).toBe(true);
        }
    });

    test('Messages のキーは host ファイルから t() 経由で読まれている', () => {
        for (const k of HOST_KEYS) {
            const hits = readsFrom(HOST_FILES, k);
            expect(hits.length, `${k} を消費している host コードが無い（dead key）`).toBeGreaterThan(0);
            expect(hits.some((h) => h.includes(`t('${k}')`)),
                `${k} が t() 経由で読まれていない: ${hits.join(' / ')}`).toBe(true);
        }
    });

    test('WebviewMessages のキーが host t() で読まれていない（器の取り違えの検出）', () => {
        for (const k of WEBVIEW_KEYS) {
            const hits = readsFrom([...HOST_FILES, 'src/outlinerProvider.ts'], k);
            const viaT = hits.filter((h) => h.includes(`t('${k}')`));
            expect(viaT, `${k} が host t() で読まれている（WebviewMessages にあるので undefined になる）: ${viaT.join(' / ')}`)
                .toEqual([]);
        }
    });
});

/**
 * TC-MSEL-27 — `platformBatchDeps` の重複解消 + note ツリー複数選択用の文言分離
 * （TASK-39 / reviewer iteration 3 **QUAL3-3**（3 回目の byte-identical 複製）+ **QUAL3-4**（文言の転用））
 *
 * `platformBatchDeps` は note ツリー内の既存 item をフラットに複数選択して D&D する 4 経路で使われる。
 * ディスク上のフォルダ走査も階層深度も存在しないので、Import folder 専用文言
 * （"from this folder" / "20 levels deep"）を転用すると操作と表示が一致しない。
 *
 * 🔴 **閾値定数は共有を維持する**（第 3 の上限実装を作らない = 既存方針）。分けるのは文言だけ。
 */
test.describe('TC-MSEL-27 platformBatchDeps の重複ゼロ + フォルダ非依存文言（TASK-39）', () => {
    const BATCH_KEYS = ['batchTransferConfirm', 'batchTransferTooMany'];
    const PROVIDER = path.join(REPO, 'src', 'notesEditorProvider.ts');

    test('🔴 confirmLarge の modal 実装が複製されていない（QUAL3-3 の番人）', () => {
        // ⚠️ **i18n key の字面の出現回数では数えない**（許可: test_update / TASK-41）:
        // 旧実装は `importFolderConfirmProceed` の出現回数 = 1 を assert していたが、これは
        // ① 説明コメント中の字面 ② 型注釈の union も 1 件として拾うため、
        // 正しい実装（ボタン文言を key で受ける 2 引数化 = DSN-15 の修正）と両立しなかった。
        // 数えたいのは「modal を出す実装が複製されていないか」なので、**実装の字面**
        // （showWarningMessage + modal オプション）をコメント除去して数える。
        const code = fs.readFileSync(PROVIDER, 'utf8')
            .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
        const n = (code.match(/showWarningMessage\([\s\S]{0,200}?\{ modal: true \}/g) || []).length;
        expect(n,
            `件数確認 modal の実装が ${n} 箇所にある（1 箇所であるべき）— `
            + 'folderMoveDeps と platformBatchDeps で confirmLarge が複製されている').toBe(1);
    });

    test('🔴 platformBatchDeps が folderMoveDeps から導出されている（独立リテラルでない）', () => {
        const src = fs.readFileSync(PROVIDER, 'utf8');
        // ⚠️ 宣言そのものに anchor する（`platformBatchDeps` の字面はコメントにも出るため
        //    単純な indexOf だと窓が宣言に届かない）
        const at = src.indexOf('const platformBatchDeps = {');
        expect(at, 'platformBatchDeps が無い').toBeGreaterThan(-1);
        const decl = src.slice(at, at + 600);
        expect(/\.\.\.folderMoveDeps|=\s*folderMoveDeps/.test(decl),
            'platformBatchDeps が folderMoveDeps を再利用していない（独立リテラルの複製）').toBe(true);
    });

    test('🔴 note ツリー複数選択の文言が Import folder 専用文言を使っていない（QUAL3-4）', () => {
        const src = fs.readFileSync(PROVIDER, 'utf8');
        // ⚠️ 宣言そのものに anchor する（`platformBatchDeps` の字面はコメントにも出るため
        //    単純な indexOf だと窓が宣言に届かない）
        const at = src.indexOf('const platformBatchDeps = {');
        const decl = src.slice(at, at + 600);
        // key 名が宣言内に現れること（`t('key')` 直呼び / 共有 modal ヘルパへの key 渡しの両形を許す
        // — 重複解消で modal 本体がヘルパに移るので `t()` の字面は宣言に無い）
        for (const k of BATCH_KEYS) {
            expect(decl.includes(`'${k}'`),
                `platformBatchDeps が ${k} を使っていない（フォルダ概念の無い操作に `
                + 'importFolder* の文言を転用している）').toBe(true);
        }
        expect(/'importFolder(Confirm|TooMany)'/.test(decl),
            'platformBatchDeps がまだ importFolderConfirm / importFolderTooMany を使っている').toBe(false);
        // 逆側（fv⇄tree = 実際に linkedfd のフォルダが絡む経路）は importFolder* のまま
        const fmAt = src.indexOf('const folderMoveDeps: FolderMoveDeps = {');
        const fmDecl = src.slice(fmAt, fmAt + 3000);
        expect(/'importFolderConfirm'/.test(fmDecl),
            'folderMoveDeps 側の文言まで差し替わっている（fv⇄tree は実フォルダなので現行文言が正しい）')
            .toBe(true);
    });

    test('🔴 新 key の文言に "folder" / 階層深度が含まれない（操作と表示の一致）', () => {
        const en = fs.readFileSync(path.join(REPO, 'src', 'i18n', 'locales', 'en.ts'), 'utf8');
        const line = (k: string) => en.split('\n').find((l) => l.trim().startsWith(`${k}:`)) || '';
        expect(/folder/i.test(line('batchTransferConfirm')),
            'batchTransferConfirm に "folder" が入っている（この操作にフォルダは無い）').toBe(false);
        expect(/folder/i.test(line('batchTransferTooMany')),
            'batchTransferTooMany に "folder" が入っている').toBe(false);
        expect(/level|deep|depth/i.test(line('batchTransferTooMany')),
            'batchTransferTooMany に階層深度が入っている（フラットな item 集合に深さの概念は無い）').toBe(false);
        // 件数プレースは残す（modal 本文が「N 件」を出せないと意味がない）
        expect(line('batchTransferConfirm').includes('{count}'),
            'batchTransferConfirm に {count} が無い').toBe(true);
    });

    test('新 key が 7 locale すべてにあり Messages 側（host t()）に入っている', () => {
        const { messages, webview } = splitInterfaces();
        for (const k of BATCH_KEYS) {
            expect(messages.includes(`${k}:`), `${k} が Messages に無い（host t() が読めない）`).toBe(true);
            expect(webview.includes(`${k}:`), `${k} が WebviewMessages にも宣言されている（二重宣言）`).toBe(false);
        }
        for (const loc of LOCALES) {
            const { messages: locMsg } = splitLocale(loc);
            for (const k of BATCH_KEYS) {
                expect(locMsg.includes(`${k}:`), `${loc}: ${k} が Messages 側の定義に無い`).toBe(true);
            }
        }
        // 英語圏以外は訳文が入っている（翻訳漏れの検出 — 既存 TC-I18N-01 と同じ規律）
        const enSrc = fs.readFileSync(path.join(REPO, 'src', 'i18n', 'locales', 'en.ts'), 'utf8');
        const enLine = (k: string) => (enSrc.split('\n').find((l) => l.trim().startsWith(`${k}:`)) || '').trim();
        for (const loc of ['ja', 'zh-cn', 'zh-tw', 'ko']) {
            const src = fs.readFileSync(path.join(REPO, 'src', 'i18n', 'locales', `${loc}.ts`), 'utf8');
            for (const k of BATCH_KEYS) {
                const line = (src.split('\n').find((l) => l.trim().startsWith(`${k}:`)) || '').trim();
                expect(line, `${loc}: ${k} の行が無い`).toBeTruthy();
                expect(line, `${loc}: ${k} が en と同一（翻訳漏れ）`).not.toBe(enLine(k));
                // eslint-disable-next-line no-control-regex
                expect(/[^\x00-\x7F]/.test(line), `${loc}: ${k} に訳文が入っていない: ${line}`).toBe(true);
            }
        }
    });

    test('🔴 閾値定数は Import folder と共有のまま（第 3 の上限実装を作っていない）', () => {
        const fi = fs.readFileSync(path.join(REPO, 'src', 'shared', 'folder-import.ts'), 'utf8');
        // checkBatchLimit が FOLDER_IMPORT_* 定数を使い続けている
        expect(fi.includes('FOLDER_IMPORT_MAX_FILES'), 'FOLDER_IMPORT_MAX_FILES が消えた').toBe(true);
        expect(fi.includes('FOLDER_IMPORT_CONFIRM_THRESHOLD'),
            'FOLDER_IMPORT_CONFIRM_THRESHOLD が消えた').toBe(true);
        const provider = fs.readFileSync(PROVIDER, 'utf8');
        // provider 側に独自の閾値リテラルを作っていない
        expect(/const\s+\w*(MAX_FILES|CONFIRM_THRESHOLD)\w*\s*=\s*\d/.test(provider),
            'provider に独自の閾値定数が生えている（第 3 の上限実装）').toBe(false);
    });
});

/**
 * TC-MSEL-27b — 確認 modal の**実行ボタン**文言も操作に一致する
 * （TASK-41 / reviewer iteration 4 **DSN-15**）
 *
 * 🔴 **TC-MSEL-27 の穴を埋めるのが目的**: TC-MSEL-27 は `importFolderConfirmProceed` の
 * **出現回数**（= 重複解消できたか）しか見ておらず、その 1 箇所が**正しい語を指しているか**を
 * 1 件も assert していなかった。結果 TASK-39 は本文だけ `batchTransferConfirm` に差し替え、
 * ボタンは `importFolderConfirmProceed` 固定のまま → note ツリー複数選択の modal が
 * 本文「Transfer 201 items?」／ボタン「取り込む」の非対称になっていた（7 locale すべて Import 系）。
 *
 * 教訓（generator_failures 2026-09-03）: **文言修正の番人は出現回数でなく文言の内容で書く**。
 * 「重複が 1 箇所になった」assert は、その 1 箇所が間違った語を指していても green。
 *
 * 🔴 counterfactual: `confirmLargeWith` の第 2 引数を消して
 * `t('importFolderConfirmProceed')` 固定に戻すと RED。
 */
test.describe('TC-MSEL-27b 確認 modal の実行ボタン文言（TASK-41 / DSN-15）', () => {
    const PROVIDER = path.join(REPO, 'src', 'notesEditorProvider.ts');
    /** ⚠️ anchor は宣言そのものに取る（固定長スライスは対象が伸びると静かに外れる — iter4 で実際に外れた）。 */
    function declOf(src: string, anchor: string, len = 700): string {
        const at = src.indexOf(anchor);
        expect(at, `${anchor} が provider に無い`).toBeGreaterThan(-1);
        return src.slice(at, at + len);
    }

    test('🔴 confirmLargeWith がボタン文言も key で受ける（本文だけの引数化になっていない）', () => {
        const src = fs.readFileSync(PROVIDER, 'utf8');
        const helper = declOf(src, 'const confirmLargeWith =');
        // ボタン文言が固定の t('importFolderConfirmProceed') でハードコードされていない
        expect(/t\('importFolderConfirmProceed'\)/.test(helper),
            'confirmLargeWith が実行ボタンを importFolderConfirmProceed に固定している '
            + '（Transfer 操作の modal に Import ボタンが出る = DSN-15）').toBe(false);
        // 引数で受けた key を t() に通している（proceedKey 相当の第 2 引数が実在する）
        expect(/proceedKey/.test(helper),
            'confirmLargeWith に proceedKey 引数が無い（ボタン文言が可変になっていない）').toBe(true);
    });

    test('🔴 platformBatchDeps のボタンが batchTransferConfirmProceed を使う', () => {
        const src = fs.readFileSync(PROVIDER, 'utf8');
        const decl = declOf(src, 'const platformBatchDeps = {');
        expect(decl.includes("'batchTransferConfirmProceed'"),
            'note ツリー複数選択の modal のボタンが batchTransferConfirmProceed を使っていない').toBe(true);
        expect(decl.includes("'importFolderConfirmProceed'"),
            'note ツリー複数選択の modal に Import 系のボタン文言が残っている').toBe(false);
    });

    test('🔴 folderMoveDeps 側（実フォルダが絡む fv⇄tree）は Import 系のボタンを維持', () => {
        const src = fs.readFileSync(PROVIDER, 'utf8');
        const decl = declOf(src, 'const folderMoveDeps: FolderMoveDeps = {', 3000);
        expect(decl.includes("'importFolderConfirmProceed'"),
            'folderMoveDeps 側のボタン文言まで差し替わっている（fv⇄tree は実フォルダなので Import が正しい）')
            .toBe(true);
    });

    test('🔴 batchTransferConfirmProceed の文言が「Import」系でなく操作に一致する', () => {
        const en = fs.readFileSync(path.join(REPO, 'src', 'i18n', 'locales', 'en.ts'), 'utf8');
        const line = (en.split('\n').find((l) => l.trim().startsWith('batchTransferConfirmProceed:')) || '').trim();
        expect(line, 'batchTransferConfirmProceed の行が en.ts に無い').toBeTruthy();
        expect(/import/i.test(line),
            `batchTransferConfirmProceed が Import 系の語のまま: ${line}`).toBe(false);
        expect(/folder/i.test(line),
            `batchTransferConfirmProceed に "folder" が入っている: ${line}`).toBe(false);
    });

    test('batchTransferConfirmProceed が 7 locale すべてにあり Messages 側で訳文が入っている', () => {
        const { messages, webview } = splitInterfaces();
        expect(messages.includes('batchTransferConfirmProceed:'),
            'batchTransferConfirmProceed が Messages に無い（host t() が読めない）').toBe(true);
        expect(webview.includes('batchTransferConfirmProceed:'),
            'batchTransferConfirmProceed が WebviewMessages にも宣言されている（二重宣言）').toBe(false);
        for (const loc of LOCALES) {
            const { messages: locMsg } = splitLocale(loc);
            expect(locMsg.includes('batchTransferConfirmProceed:'),
                `${loc}: batchTransferConfirmProceed が Messages 側の定義に無い`).toBe(true);
        }
        // 英語圏以外は訳文が入っている（翻訳漏れの検出 — 既存 TC-I18N-01 と同じ規律）
        const enSrc = fs.readFileSync(path.join(REPO, 'src', 'i18n', 'locales', 'en.ts'), 'utf8');
        const enLine = (enSrc.split('\n')
            .find((l) => l.trim().startsWith('batchTransferConfirmProceed:')) || '').trim();
        for (const loc of ['ja', 'zh-cn', 'zh-tw', 'ko']) {
            const src = fs.readFileSync(path.join(REPO, 'src', 'i18n', 'locales', `${loc}.ts`), 'utf8');
            const line = (src.split('\n')
                .find((l) => l.trim().startsWith('batchTransferConfirmProceed:')) || '').trim();
            expect(line, `${loc}: batchTransferConfirmProceed の行が無い`).toBeTruthy();
            expect(line, `${loc}: batchTransferConfirmProceed が en と同一（翻訳漏れ）`).not.toBe(enLine);
            // eslint-disable-next-line no-control-regex
            expect(/[^\x00-\x7F]/.test(line),
                `${loc}: batchTransferConfirmProceed に訳文が入っていない: ${line}`).toBe(true);
        }
    });

    test('🔴 modal の判定ロジックは 1 箇所のまま（QUAL3-3 の重複解消を壊していない）', () => {
        // ⚠️ **コメント行を除いて数える**: 素の出現回数で数えると自分の説明コメント中の字面まで
        // 拾って偽 RED になる（iteration 5 で実際に踏んだ）。数えたいのは実コードの重複だけ。
        const code = fs.readFileSync(PROVIDER, 'utf8')
            .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
        const n = (code.match(/answer === proceed/g) || []).length;
        expect(n, `confirmLarge の判定が ${n} 箇所にある（1 箇所であるべき）— `
            + 'ボタン文言の key 化で modal 実装を再度複製してしまっている').toBe(1);
    });

    test('🔴 実行ボタンの key を t() へ渡す箇所が 1 箇所だけ（modal 実装の再複製を検出）', () => {
        // 同上（コメント除去して実コードだけを数える）。型注釈の union は行頭 `//` ではないので
        // 残るが、`t(<key>)` 形の呼び出しは実装 1 箇所に限る。
        const code = fs.readFileSync(PROVIDER, 'utf8')
            .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
        const n = (code.match(/t\(proceedKey\)/g) || []).length;
        expect(n, `ボタン文言の t() 呼び出しが ${n} 箇所（1 箇所であるべき）`).toBe(1);
    });
});
