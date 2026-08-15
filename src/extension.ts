import * as vscode from 'vscode';
import * as path from 'path';
import { AnyMarkdownEditorProvider } from './editorProvider';
import { OutlinerProvider } from './outlinerProvider';
import { NotesFolderProvider } from './notesFolderProvider';
import { NotesEditorProvider } from './notesEditorProvider';
import { registerFileViewer } from './fileViewerProvider';
import { initLocale, t } from './i18n/messages';
import { runNotesCleanup } from './notesCleanupCommand';
import { importTerminology, resolveTerminologyPath } from './shared/aws-translate';
import { execFile as cpExecFile } from 'child_process';
import { runExportMdToPdf, PdfExportDeps, ExecResult } from './shared/pdf-export-host';

interface FractalLinkParams {
    noteFolderName: string;
    outFileId?: string;
    nodeId?: string;
    pageId?: string;
    mdFileId?: string;
}

function parseFractalLink(url: string): FractalLinkParams | null {
    // FR-B11: 文法の単一真実 = src/shared/inapp-link-utils.js（生成側 webview と共有、
    // parse は最長一致順 page → md → node → out。2 実装非対称を防ぐため委譲する）
    const { parseFractalLink: parseShared } = require('./shared/inapp-link-utils');
    return parseShared(url);
}

export function activate(context: vscode.ExtensionContext) {
    // Initialize localization
    const config = vscode.workspace.getConfiguration('fractal');
    initLocale(config.get<string>('language', 'default'), vscode.env.language);
    
    console.log('Fractal is now active!');

    // Register the custom editor provider
    const provider = new AnyMarkdownEditorProvider(context);
    
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'fractal.editor',
            provider,
            {
                webviewOptions: {
                    // Note: retainContextWhenHidden can cause issues after extension updates
                    // because VSCode may try to restore old webview state with new extension code.
                    // We handle this by always clearing webview.html first in resolveCustomTextEditor.
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        )
    );

    // Register the outliner provider for .out files
    const outlinerProvider = new OutlinerProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'fractal.outliner',
            outlinerProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        )
    );

    // Register the file viewer (read-only .pdf/.html — FR-FV-02, sprint 20260815-075428)
    registerFileViewer(context);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.openEditor', async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.document.languageId === 'markdown') {
                await vscode.commands.executeCommand(
                    'vscode.openWith',
                    activeEditor.document.uri,
                    'fractal.editor'
                );
            } else {
                vscode.window.showInformationMessage(t('openMarkdownFirst'));
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.insertTable', async () => {
            const rows = await vscode.window.showInputBox({
                prompt: t('numberOfRows'),
                value: '3',
                validateInput: (value) => {
                    const num = parseInt(value);
                    return isNaN(num) || num < 1 ? t('enterValidNumber') : null;
                }
            });
            if (!rows) return;

            const cols = await vscode.window.showInputBox({
                prompt: t('numberOfColumns'),
                value: '3',
                validateInput: (value) => {
                    const num = parseInt(value);
                    return isNaN(num) || num < 1 ? t('enterValidNumber') : null;
                }
            });
            if (!cols) return;

            const table = generateMarkdownTable(parseInt(rows), parseInt(cols));
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                editor.edit(editBuilder => {
                    editBuilder.insert(editor.selection.active, table);
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.insertToc', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                editor.edit(editBuilder => {
                    editBuilder.insert(editor.selection.active, '[TOC]\n');
                });
            }
        })
    );

    // fractal.exportToPdf は notesEditorProvider / outlinerProvider が構築済みになる
    // 位置（Notes セクションの後）で登録する（3 provider の getActivePanelForPdf を deps 注入）。

    // Undo/Redo commands - forwarded to webview to bypass VSCode's native undo
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.undo', () => {
            provider.sendUndo();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.redo', () => {
            if (!provider.sendRedo()) {
                // Fallback to built-in redo when our custom editor is not active
                vscode.commands.executeCommand('redo');
            }
        })
    );

    // Toggle source mode - forwarded to webview
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.toggleSourceMode', () => {
            provider.sendToggleSourceMode();
        })
    );

    // v10: Translate command - trigger translation from keyboard shortcut
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.translate', () => {
            provider.sendTranslate();
        })
    );

    // v0.207.25: Custom Terminology を Amazon Translate に upload (CSV/TMX)
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.updateTranslateTerminology', async () => {
            const config = vscode.workspace.getConfiguration('fractal');
            const rawPath = config.get<string>('translateTerminologyFile', '').trim();
            const name = config.get<string>('translateTerminologyName', '').trim();
            const accessKeyId = config.get<string>('transAccessKeyId', '').trim();
            const secretAccessKey = config.get<string>('transSecretAccessKey', '').trim();
            const region = config.get<string>('transRegion', 'us-east-1').trim();

            if (!rawPath) {
                vscode.window.showErrorMessage(t('terminologyFileNotSet'));
                return;
            }
            if (!name) {
                vscode.window.showErrorMessage(t('terminologyNameNotSet'));
                return;
            }
            if (!accessKeyId || !secretAccessKey) {
                vscode.window.showErrorMessage(t('terminologyCredentialsNotSet'));
                return;
            }

            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const filePath = resolveTerminologyPath(rawPath, wsRoot);

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: t('terminologyUploading') },
                async () => {
                    try {
                        const result = await importTerminology({
                            name, filePath, accessKeyId, secretAccessKey, region,
                        });
                        const cnt = typeof result.termCount === 'number' ? ` (${result.termCount} terms)` : '';
                        vscode.window.showInformationMessage(t('terminologyUpdated') + `"${result.name}"${cnt}`);
                    } catch (err: any) {
                        const msg = err?.message || String(err);
                        vscode.window.showErrorMessage(t('terminologyUpdateFailed') + msg);
                    }
                }
            );
        })
    );

    // --- Notes (Activity Bar + WebviewPanel) ---
    const notesFolderProvider = new NotesFolderProvider(context);
    const notesEditorProvider = new NotesEditorProvider(context);
    // FR-NT-03 / FR-MV-01: editor provider が Notes Folder ツリーを更新・列挙できるよう配線
    notesEditorProvider.setFolderProvider(notesFolderProvider);

    // FR-PDF-01/05/07: md → PDF エクスポート（design/system.md §5）。
    // 3 provider の getActivePanelForPdf を thunk で deps 注入し、対象解決→HTML 回収
    // →dialog→core→spawn→掃除の編成は runExportMdToPdf に委譲。
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.exportToPdf', () => {
            const deps: PdfExportDeps = {
                getTargets: () => [
                    provider.getActivePanelForPdf(),
                    notesEditorProvider.getActivePanelForPdf(),
                    outlinerProvider.getActivePanelForPdf(),
                ],
                showSaveDialog: async (opts) => {
                    const uri = await vscode.window.showSaveDialog({
                        defaultUri: opts.defaultPath ? vscode.Uri.file(opts.defaultPath) : undefined,
                        filters: opts.filters,
                    });
                    return uri ? { fsPath: uri.fsPath } : undefined;
                },
                withProgress: (opts, task) =>
                    vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: opts.title,
                            cancellable: opts.cancellable,
                        },
                        (progress, token) =>
                            task(progress as any, {
                                get isCancellationRequested() {
                                    return token.isCancellationRequested;
                                },
                                onCancellationRequested: (cb: () => void) =>
                                    token.onCancellationRequested(cb),
                            })
                    ),
                getConfig: (key) => vscode.workspace.getConfiguration('fractal').get(key),
                notify: {
                    info: (m) => vscode.window.showInformationMessage(m),
                    warn: (m) => vscode.window.showWarningMessage(m),
                    error: (m) => vscode.window.showErrorMessage(m),
                },
                t: (key) => t(key as any),
                execFile: (file, args, execOpts, onChild) =>
                    new Promise<ExecResult>((resolve) => {
                        const child = cpExecFile(
                            file,
                            args,
                            { timeout: execOpts.timeout },
                            (err, _stdout, stderr) => {
                                resolve({
                                    code: err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0,
                                    stderr: stderr ? String(stderr) : (err ? String((err as any).message || err) : ''),
                                });
                            }
                        );
                        if (onChild) onChild(() => child.kill());
                    }),
                workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                debugLog: (s) => console.log('[PDF export]', s),
            };
            void runExportMdToPdf(deps);
        })
    );

    context.subscriptions.push(
        vscode.window.createTreeView('notesExplorer', {
            treeDataProvider: notesFolderProvider,
            dragAndDropController: notesFolderProvider,
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.addNotesFolder', () => {
            notesFolderProvider.addFolder();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.removeNotesFolder', (item) => {
            notesFolderProvider.removeFolder(item);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.openNotesFolder', (folderPath: string) => {
            notesEditorProvider.openNotesFolder(folderPath);
        })
    );

    // notes-flat-storage (2026-07-07): 旧レイアウト（<outId>/ / _notes_md/）を
    // 共有フラット（md=Note 直下、images/files=共有）へ移行する手動コマンド。
    // dry-run 提示 → 承認 → validate → execute（アトミック / 失敗時ロールバック）。
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.migrateToFlatLayout', async (item?: { folderPath?: string }) => {
            const flatMigrate = await import('./shared/flat-migrate');
            // 対象 Note フォルダを決定（ツリー item.folderPath > 登録フォルダから選択）
            let target = item && item.folderPath;
            if (!target) {
                const folders = notesFolderProvider.getFolders();
                if (folders.length === 0) {
                    vscode.window.showInformationMessage('No notes folders registered.');
                    return;
                }
                const pick = await vscode.window.showQuickPick(
                    folders.map(f => ({ label: path.basename(f), description: f, folderPath: f })),
                    { title: 'Migrate to flat layout: select a notes folder' }
                );
                if (!pick) return;
                target = pick.folderPath;
            }
            try {
                const plan = flatMigrate.planMigration(target);
                const s = flatMigrate.summarizePlan(plan);
                if (s.total === 0) {
                    vscode.window.showInformationMessage('Already flat — nothing to migrate.');
                    return;
                }
                const proceed = await vscode.window.showWarningMessage(
                    `Migrate to flat layout?\n\nPages: ${s.pages}, Images: ${s.images}, Files: ${s.files} (total ${s.total})` +
                    (s.conflicts > 0 ? `\n⚠️ ${s.conflicts} name collision(s) — will abort validation.` : ''),
                    { modal: true },
                    'Migrate'
                );
                if (proceed !== 'Migrate') return;
                const v = flatMigrate.validatePlan(plan);
                if (!v.ok) {
                    vscode.window.showErrorMessage(`Migration aborted (no files moved):\n${v.reasons.slice(0, 5).join('\n')}`);
                    return;
                }
                const res = flatMigrate.executePlan(plan);
                if (res.rolledBack) {
                    vscode.window.showErrorMessage(`Migration failed and was rolled back (old layout restored): ${res.error ?? ''}`);
                } else {
                    vscode.window.showInformationMessage(`Migrated ${res.executedMoves} item(s) to flat layout. Reopen the note to see changes.`);
                }
            } catch (e) {
                vscode.window.showErrorMessage(`Migration error: ${String((e as Error).message || e)}`);
            }
        })
    );

    // In-app link navigation command
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.navigateInAppLink', async (linkUrl: string) => {
            const parsed = parseFractalLink(linkUrl);
            if (!parsed) {
                vscode.window.showErrorMessage('Invalid in-app link format');
                return;
            }
            const folders = notesFolderProvider.getFolders();
            const folderPath = folders.find(f => path.basename(f) === parsed.noteFolderName);
            if (!folderPath) {
                vscode.window.showErrorMessage(`Notes folder "${parsed.noteFolderName}" not found. Register it in the Notes panel first.`);
                return;
            }
            if (parsed.pageId) {
                // Page link: open md in CURRENT note's sidepanel (no note/outliner switch)
                // Resolve file path from target note's folder, then open in current panel
                const pagePath = notesEditorProvider.resolvePagePath(folderPath, parsed.outFileId!, parsed.pageId!);
                if (pagePath) {
                    notesEditorProvider.openPageInCurrentPanel(pagePath);
                } else {
                    vscode.window.showWarningMessage('Page file not found');
                }
            } else {
                // Node / out / md link: navigate to note then delegate
                // (FR-B11: out link = nodeId なしで outliner を開くだけ / md link = mdFileId 経由で
                //  main pane に md を開く。分岐は navigateToLink 側)
                await notesEditorProvider.openNotesFolder(folderPath);
                setTimeout(() => {
                    notesEditorProvider.navigateToLink(folderPath, parsed);
                }, 500);
            }
        })
    );

    // Outliner scope commands - forwarded to webview
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.scopeIn', () => {
            outlinerProvider.sendScopeIn();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.scopeOut', () => {
            outlinerProvider.sendScopeOut();
        })
    );

    // v0.207.34: Cmd+\ で右サイドパネル (notes 左 file panel / md outline panel) を toggle
    // 全 provider に dispatch — 各 provider は activeWebviewPanel に message を post する
    // (`when` 句で keybinding 側を 1 context に絞っているので、実際に発火するのは 1 つ)
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.toggleSidebar', () => {
            provider.sendToggleSidebar();
            outlinerProvider.sendToggleSidebar();
            notesEditorProvider.sendToggleSidebar();
        })
    );

    // New outliner file
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.newOutliner', async () => {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter outliner file name (without .out extension)',
                placeHolder: 'my-notes',
                validateInput: (value) => {
                    if (!value || !value.trim()) { return 'File name is required'; }
                    if (/[/\\:*?"<>|]/.test(value)) { return 'Invalid characters in file name'; }
                    return null;
                }
            });
            if (!name) { return; }

            const folders = vscode.workspace.workspaceFolders;
            let targetDir: vscode.Uri;
            if (folders && folders.length > 0) {
                targetDir = folders[0].uri;
            } else {
                const selected = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    title: 'Select folder for outliner file'
                });
                if (!selected || !selected[0]) { return; }
                targetDir = selected[0];
            }

            const fileName = name.trim().endsWith('.out') ? name.trim() : `${name.trim()}.out`;
            const fileUri = vscode.Uri.joinPath(targetDir, fileName);

            try {
                await vscode.workspace.fs.stat(fileUri);
                vscode.window.showWarningMessage(`File "${fileName}" already exists.`);
                return;
            } catch {
                // File doesn't exist — good
            }

            // Notes mode と同じ命名規則で初期化:
            //   pageDir = ./<basename>, fileDir = ./<basename>/files, imageDir = ./<basename>/images
            // (全アセットを <basename>/ 配下に集約する self-contained 構造)
            const basename = name.trim().replace(/\.out$/, '');
            const emptyData = JSON.stringify({
                version: 1,
                pageDir: `./${basename}`,
                fileDir: `./${basename}/files`,
                imageDir: `./${basename}/images`,
                rootIds: [],
                nodes: {}
            }, null, 2);
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(emptyData, 'utf8'));
            await vscode.commands.executeCommand('vscode.openWith', fileUri, 'fractal.outliner');
        })
    );

    // Open markdown file in standard text editor
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.openAsText', async (uri?: vscode.Uri) => {
            // Get URI from argument (context menu) or active editor
            let targetUri = uri;
            if (!targetUri) {
                const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
                if (activeTab && activeTab.input && (activeTab.input as any).uri) {
                    targetUri = (activeTab.input as any).uri;
                }
            }
            
            if (targetUri) {
                // Open with default text editor
                await vscode.commands.executeCommand('vscode.openWith', targetUri, 'default');
            } else {
                vscode.window.showWarningMessage(t('openMarkdownFirst'));
            }
        })
    );

    // Compare markdown files as text
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.compareAsText', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            
            let file1Uri: vscode.Uri | undefined;
            let file2Uri: vscode.Uri | undefined;
            
            // Check if multiple files are selected (2 files)
            if (uris && uris.length === 2) {
                // Two files selected - skip file dialog
                file1Uri = uris[0];
                file2Uri = uris[1];
            } else {
                // Single file or no selection - use original behavior
                file1Uri = uri;
                if (!file1Uri) {
                    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
                    if (activeTab && activeTab.input && (activeTab.input as any).uri) {
                        file1Uri = (activeTab.input as any).uri;
                    }
                }
                
                if (!file1Uri) {
                    vscode.window.showWarningMessage(t('openMarkdownFirst'));
                    return;
                }

                // Let user select file to compare with
                const compareFileUri = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: {
                        'Markdown': ['md', 'markdown']
                    },
                    title: t('selectFileToCompare')
                });

                if (compareFileUri && compareFileUri[0]) {
                    file2Uri = compareFileUri[0];
                }
            }
            
            if (!file1Uri || !file2Uri) {
                return;
            }
            
            // Read both files
            const content1 = fs.readFileSync(file1Uri.fsPath, 'utf8');
            const content2 = fs.readFileSync(file2Uri.fsPath, 'utf8');
            
            const fileName1 = path.basename(file1Uri.fsPath);
            const fileName2 = path.basename(file2Uri.fsPath);
            
            // Create temp files with .txt extension (won't trigger custom editor)
            // Use timestamp to avoid conflicts
            const timestamp = Date.now();
            const tempDir = os.tmpdir();
            const tempFile1 = path.join(tempDir, `anymd-compare-${timestamp}-1-${fileName1}.txt`);
            const tempFile2 = path.join(tempDir, `anymd-compare-${timestamp}-2-${fileName2}.txt`);
            
            fs.writeFileSync(tempFile1, content1, 'utf8');
            fs.writeFileSync(tempFile2, content2, 'utf8');
            
            const tempUri1 = vscode.Uri.file(tempFile1);
            const tempUri2 = vscode.Uri.file(tempFile2);
            
            // Open diff view
            const title = `${fileName1} ↔ ${fileName2}`;
            await vscode.commands.executeCommand('vscode.diff', tempUri1, tempUri2, title);
            
            // Note: Temp files are left in temp directory and will be cleaned up by OS
            // Attempting to track and delete them caused issues with the diff view
        })
    );

    // Clean unused files in Note (全 note 一気モード)
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.cleanUnusedFilesInNote', async () => {
            const folders = notesFolderProvider.getFolders();
            await runNotesCleanup({ mainFolderPaths: folders });
        })
    );

    // Clean unused files in Current Note (自ノート限定モード)
    context.subscriptions.push(
        vscode.commands.registerCommand('fractal.cleanUnusedFilesInCurrentNote', async () => {
            const activeMainFolderPath = notesEditorProvider.getActiveMainFolderPath();
            if (!activeMainFolderPath) {
                vscode.window.showWarningMessage('No active Notes editor found. Open a note first.');
                return;
            }
            await runNotesCleanup({ mainFolderPaths: [activeMainFolderPath] });
        })
    );
}

function generateMarkdownTable(rows: number, cols: number): string {
    let table = '|';
    for (let c = 0; c < cols; c++) {
        table += ` Header ${c + 1} |`;
    }
    table += '\n|';
    for (let c = 0; c < cols; c++) {
        table += ' --- |';
    }
    for (let r = 0; r < rows - 1; r++) {
        table += '\n|';
        for (let c = 0; c < cols; c++) {
            table += ` Cell |`;
        }
    }
    table += '\n';
    return table;
}

export function deactivate() {}
