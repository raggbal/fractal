// Internationalization support - Static require map version
//
// esbuild バンドル対応（sprint 20260802-212934-aws-sdk-migration / R-1）:
//   旧実装は `require(path.join(__dirname, '..', 'locales', `${locale}.js`))` の
//   variable require で out/locales/*.js を実行時 disk 読みしていた。esbuild で
//   src/extension.ts → out/extension.js に一本化すると messages.ts も畳み込まれ
//   __dirname が out/ になり `../locales` が repo 直下の存在しない locales/ を指して
//   ロケール全滅（英語 fallback）になる。→ 静的 require マップ（LOCALE_LOADERS）に
//   置換し、esbuild が locale モジュールをバンドルに畳み込むようにする。
//   相対パスは src/i18n/messages.ts から src/i18n/locales/*.ts への TS ソース相対
//   （`./locales/<locale>`）。build-locales.js は src/i18n/locales/*.ts を
//   out/locales/*.js にコンパイルする（非バンドル経路の互換のため据え置き）が、
//   バンドル経路はこの静的 require で解決される。

// Type definitions
export interface Messages {
  // FR-FLV (sprint 20260817-053313): folder link / folder view（host 通知・ダイアログ）
  folderLinkAddLabel: string;
  folderLinkRelinkLabel: string;
  folderLinkRenamePrompt: string;
  folderLinkDuplicate: string;
  folderLinkSelfReference: string;
  folderLinkInvalid: string;
  folderLinkBroken: string;
  folderViewOpenFailed: string;
  folderViewNewMarkdownPrompt: string;
  folderViewNewFolderPrompt: string;
  folderViewInvalidName: string;
  folderViewNameConflict: string;
  folderViewOperationFailed: string;
  folderViewMoveIntoSelf: string;
  folderViewMoveExdev: string;
  folderViewNoFolderDrop: string;
  folderViewMoveInUnsupported: string;
  folderViewTrashFailed: string;
  folderViewMovePartialFail: string;
  notesExternalDropFailed: string;
  openMarkdownFirst: string;
  numberOfRows: string;
  numberOfColumns: string;
  enterValidNumber: string;
  // PDF export (sprint 20260802-075012-md-pdf-export). Interpolated messages
  // (Done/Failed/CssSkipped) は trailing-separator 方式で末尾に `+ value` 連結する
  // (既存 messages の imageDirSet 等と同じ / design system.md: toast(pdfExportDone + dest))。
  pdfExportNoTarget: string;
  pdfExportBrowserNotFound: string;
  pdfExportProgress: string;
  pdfExportDone: string;
  pdfExportFailed: string;
  pdfExportCssSkipped: string;
  imageDirChanged: string;
  fileModifiedExternally: string;
  // 移行ゲート + 移行完了 toast + 翻訳系エラー (sprint 20260813-073112-host-message-i18n)。
  // migrationDone* の interpolation は trailing-separator 方式 (pdfExportDone と同じ):
  // `t('migrationDoneBackup') + backupPath + t('migrationDoneRecovery')` のように値を挟んで連結する。
  mgTitle: string;
  mgDesc: string;
  mgSummaryPages: string;
  mgSummaryImages: string;
  mgSummaryFiles: string;
  mgMigrate: string;
  mgMigrating: string;
  mgFailed: string;
  mgUnknownError: string;
  mgRetry: string;
  migrationDoneBackup: string;
  migrationDoneRecovery: string;
  migrationDoneUnresolved: string;
  translateSaveFailedPagesDir: string;
  translateSaveFailedParse: string;
  translateSaveFailed: string;
  translateSaveNoOutFile: string;
  translateSaved: string;
  terminologyUpdateFailed: string;
  terminologyUpdated: string;
  terminologyUploading: string;
  terminologyFileNotSet: string;
  terminologyNameNotSet: string;
  terminologyCredentialsNotSet: string;
  reload: string;
  ignore: string;
  enterUrl: string;
  enterLinkText: string;
  enterImageDir: string;
  imageDirCleared: string;
  forceRelativeNo: string;
  forceRelativeYes: string;
  forceRelativePrompt: string;
  forceRelativeTitle: string;
  imageDirSet: string;
  relativePathOn: string;
  failedToCopyImage: string;
  failedToSaveImage: string;
  imageFileNotFound: string;
  failedToProcessImage: string;
  selectImage: string;
  selectFileToCompare: string;
  // File attachment
  enterFileDir: string;
  fileDirSet: string;
  fileDirCleared: string;
  failedToSaveFile: string;
  failedToProcessFile: string;
  fileNotFound: string;
  fileNotFoundOrUnsafe: string;
  // FR-MV-01: Move Other Note
  notesMoveNoOtherNote: string;
  notesMoveOtherNotePick: string;
  notesMoveFailed: string;
  notesMoveDone: string;
  forceRelativeFileNo: string;
  forceRelativeFileYes: string;
  forceRelativeFilePrompt: string;
  forceRelativeFileTitle: string;
  // v12: D&D file import
  dropFolderRejected: string;
  dropFileTooLarge: string;
  dropImportFailed: string;
  // MD-45/46/47: drawio
  drawioFilenamePromptTitle: string;
  drawioFilenamePromptPlaceholder: string;
  // Theme migration (sprint 20260509-185557-minimal-settings-foundation)
  themeMigrationNotice: string;
}

export interface WebviewMessages {
  // FR-FLV (sprint 20260817-053313): folder link / folder view（webview UI）
  folderLinkAdd: string;
  folderLinkRelink: string;
  folderLinkRemove: string;
  folderLinkBroken: string;
  folderViewOpenFailed: string;
  folderViewSearchPlaceholder: string;
  folderViewRefresh: string;
  notesShowHiddenFiles: string;
  folderViewTruncated: string;
  folderViewNoMatch: string;
  folderViewEmpty: string;
  folderViewNewMarkdown: string;
  folderViewNewFolder: string;
  folderViewNoFolderDrop: string;
  folderViewMoveInUnsupported: string;
  closeOutline: string;
  openOutline: string;
  openInTextEditor: string;
  toggleSourceMode: string;
  copyPath: string;
  bold: string;
  italic: string;
  strikethrough: string;
  heading1: string;
  heading2: string;
  heading3: string;
  heading4: string;
  heading5: string;
  heading6: string;
  unorderedList: string;
  orderedList: string;
  taskList: string;
  blockquote: string;
  inlineCode: string;
  textColor: string;
  textColorNone: string;
  codeBlock: string;
  // FR-B10: codeblock 折り返しトグルボタンの tooltip
  codeBlockWrap?: string;
  insertLink: string;
  insertImage: string;
  setImageDir: string;
  setFileDir: string;
  insertTable: string;
  horizontalRule: string;
  mermaidBlock: string;
  mathBlock: string;
  searchPlaceholder: string;
  replacePlaceholder: string;
  searchPrev: string;
  searchNext: string;
  toggleReplace: string;
  closeSearch: string;
  replace: string;
  replaceAll: string;
  caseSensitive: string;
  wholeWord: string;
  regex: string;
  addColLeft: string;
  addColRight: string;
  deleteCol: string;
  addRowAbove: string;
  addRowBelow: string;
  deleteRow: string;
  tableToggleHeader: string;
  tableMergeCells: string;
  tableUnmergeCells: string;
  tableFilterRows: string;
  // Status bar
  words: string;
  characters: string;
  lines: string;
  linesCount: string;
  livePreviewMode: string;
  sourceMode: string;
  relativePath: string;
  externalChangeToast: string;
  undo: string;
  redo: string;
  // Image directory source labels
  imageDirLabel: string;
  // Save directory picker (standalone md 限定 per-file 保存先)
  saveDirChoose: string;
  saveDirReset: string;
  recentFilesLabel: string;
  toggleRecent: string;
  imageDirSourceFile: string;
  imageDirSourceSettings: string;
  imageDirSourceDefault: string;
  // File directory source labels
  fileDirLabel: string;
  fileDirSourceFile: string;
  fileDirSourceSettings: string;
  fileDirSourceDefault: string;
  // Resource access range (FR-RR-05)
  resourceAccessOutOfRange: string;
  resourceAccessOutOfRangeCount: string;
  resourceAccessOpenSettings: string;
  // Notes left panel
  notesTabNotes: string;
  notesTabSearch: string;
  notesNewFolder: string;
  notesOpenInNewTab: string;
  // FR-OCM-01 (sprint 20260818-183407): outliner 統合パスコピー
  outlinerCopyPath: string;
  outlinerDuplicate: string;
  // FR-MDM-01/02/03 (sprint 20260818-183407): md リンク context menu
  mdCopyLinkPath: string;
  mdCopyFullPath: string;
  mdDuplicateLink: string;
  // FR-FTM-01/02 (sprint 20260818-183407): tree +file / New link folder
  notesNewLinkFolder: string;
  notesAddFile: string;
  notesDuplicateItem: string;
  // FR-MLG-03 (sprint 20260818-183407): notes タブ context menu / aria / タイトル
  tabOpenInStandalone: string;
  tabOpenInOsDefaultApp: string;
  tabDuplicate: string;
  tabCloseOthers: string;
  tabCloseAria: string;
  tabNewAria: string;
  tabUntitled: string;
  notesNewOutline: string;
  notesToday: string;
  notesCollapsePanel: string;
  notesSearchPlaceholder: string;
  notesMatchCase: string;
  notesWholeWord: string;
  notesUseRegex: string;
  notesSearching: string;
  notesResults: string;
  notesSearchExploreResults: string;
  notesSearchOutlinerResults: string;
  notesSearchMarkdownResults: string;
  notesSearchFilesResults: string;
  notesSearchReferencedBy: string;
  notesRename: string;
  notesOpen: string;
  notesRevealInFinder: string;
  notesAttachTooLarge: string;
  notesDelete: string;
  notesDeleteFolder: string;
  notesUntitled: string;
  notesS3Save: string;
  notesS3Sync: string;
  notesS3RemoteDeleteUpload: string;
  notesS3LocalDeleteDownload: string;
  notesS3Cancel: string;
  notesS3Continue: string;
  // MD-47: Insert Drawio Diagram (Cmd+/ palette)
  insertDrawioDiagram?: string;
  // TBE-14: Outliner Table editor (TASK-B7 + TASK-B5/B6 + TASK-C2)
  outlinerSwitchToTable?: string;
  outlinerSwitchToOutliner?: string;
  tableAddColumn?: string;
  tableRemoveColumn?: string;
  tableConfirmRemoveColumn?: string;
  tableSearchOrCreate?: string;
  tableCreateOption?: string;
  tableColumnNameLabel?: string;
  tableColumnTypeLabel?: string;
  tableColumnTypeText?: string;
  tableColumnTypeMultiselect?: string;
  tableColumnTypeOutliner?: string;
  tableSearchPlaceholder?: string;
  // Task mode toggle / filter / archive (search bar buttons)
  taskModeOn?: string;
  taskModeOff?: string;
  taskFilterAllShown?: string;
  taskFilterActiveShown?: string;
  archiveCompleted?: string;
  archiveNoneFound?: string;
  archiveNotSupported?: string;
  // Task scope popup (shown when enabling task mode)
  taskScopePopupTitle?: string;
  taskScopeTopOnly?: string;
  taskScopeAll?: string;
  // FR-B06b: cmd 長押しショートカット HUD のカテゴリ見出し（本体リストは英語固定・見出しのみ i18n）
  shortcutHudTitleMd?: string;
  shortcutHudTitleOutliner?: string;
  shortcutHudTitleMindmap?: string;
  shortcutHudTitleTable?: string;
  shortcutCatEditing?: string;
  shortcutCatNavigation?: string;
  shortcutCatSearch?: string;
  shortcutCatTask?: string;
  shortcutCatOther?: string;
  // FR-FV-08: file viewer ツールバーのアクション（webview は window.__outlinerMessages 経由で読む）
  viewerOpenInNewTab: string;
  viewerCopyPath: string;
  viewerCopyInAppLink: string;
  viewerExportFile: string;
  viewerCopyInAppLinkFailed: string;
  viewerAllowScripts: string;
  viewerOpenExternal: string;
  viewerFind: string;
  viewerOpenInStandalone: string;
  viewerZoomIn: string;
  viewerZoomOut: string;
  viewerExpand: string;
  viewerClose: string;
}

// Supported locales
const SUPPORTED_LOCALES = ['en', 'ja', 'zh-tw', 'zh-cn', 'ko', 'es', 'fr'];

// Locale aliases
const LOCALE_ALIASES: Record<string, string> = {
  'zh-hant': 'zh-tw',
  'zh-hans': 'zh-cn',
  'zh': 'zh-cn',
};

// Current state
let currentLocale: string = 'en';
let currentMessages: { messages: Messages; webviewMessages: WebviewMessages } | null = null;
let fallbackMessages: { messages: Messages; webviewMessages: WebviewMessages } | null = null;

/**
 * Resolve locale to a supported one
 */
function resolveLocale(lang: string): string {
  const lower = lang.toLowerCase();
  
  // Exact match
  if (SUPPORTED_LOCALES.includes(lower)) {
    return lower;
  }
  
  // Alias match
  if (LOCALE_ALIASES[lower]) {
    return LOCALE_ALIASES[lower];
  }
  
  // Base language match (e.g., 'ja-JP' -> 'ja')
  const base = lower.split('-')[0];
  if (SUPPORTED_LOCALES.includes(base)) {
    return base;
  }
  
  return 'en';
}

/**
 * Resolve effective language from configured language and system language
 * @param configLang - 設定値 ('default' or 具体的なロケール)
 * @param systemLang - システム言語 (VSCode: vscode.env.language, Electron: app.getLocale())
 */
function resolveEffectiveLanguage(configLang: string, systemLang: string): string {
  if (!configLang || configLang === 'default') {
    return systemLang;
  }
  return configLang;
}

// Static require map（R-2/R-1 対策）: locale ごとにモジュールを丸ごと返す静的 loader。
// esbuild は静的文字列 require を辿ってバンドルに畳み込むため、実行時 disk 読み
// （旧 variable require）と違いバンドル環境でも locale が解決される。
// 返り値契約 `{ messages, webviewMessages }`（2 フィールド）は不変。
// SUPPORTED_LOCALES と 1:1（en/ja/zh-tw/zh-cn/ko/es/fr を全列挙）。
const LOCALE_LOADERS: Record<string, () => { messages: Messages; webviewMessages: WebviewMessages }> = {
  'en': () => require('./locales/en'),
  'ja': () => require('./locales/ja'),
  'zh-tw': () => require('./locales/zh-tw'),
  'zh-cn': () => require('./locales/zh-cn'),
  'ko': () => require('./locales/ko'),
  'es': () => require('./locales/es'),
  'fr': () => require('./locales/fr'),
};

/**
 * Load locale from the static require map.
 *
 * 旧実装の require.cache 削除（hot-reload 用）は除去した。静的 require はバンドルに
 * 畳み込まれ require.cache 操作が効かない（削除しても同一モジュールが再解決される）。
 * 設定変更時（initLocale 再呼び出し）は LOCALE_LOADERS を再度呼ぶだけで同一モジュール
 * 参照が返り、locale データは不変なので挙動は同等（旧 hot-reload は「同じ locale ファイルを
 * 再読込」するだけで、実データが動的に変わることはないため機能欠落なし）。
 */
function loadLocale(locale: string): { messages: Messages; webviewMessages: WebviewMessages } | null {
  try {
    const loader = LOCALE_LOADERS[locale];
    if (!loader) {
      console.error(`[Any MD] Unknown locale '${locale}' (not in LOCALE_LOADERS)`);
      return null;
    }
    const localeModule = loader();
    return {
      messages: localeModule.messages,
      webviewMessages: localeModule.webviewMessages,
    };
  } catch (error) {
    console.error(`[Any MD] Failed to load locale '${locale}':`, error);
    return null;
  }
}

/**
 * Initialize locale (called on activation and settings change)
 * @param configLang - 設定値 ('default' or 具体的なロケール)
 * @param systemLang - システム言語 (VSCode: vscode.env.language, Electron: app.getLocale())
 */
export function initLocale(configLang: string, systemLang: string): void {
  const lang = resolveEffectiveLanguage(configLang, systemLang);
  currentLocale = resolveLocale(lang);
  
  // Load fallback (English) first
  if (!fallbackMessages) {
    fallbackMessages = loadLocale('en');
    if (!fallbackMessages) {
      console.error('[Any MD] Failed to load fallback locale (en)');
    }
  }
  
  // Load current locale
  if (currentLocale === 'en') {
    currentMessages = fallbackMessages;
  } else {
    currentMessages = loadLocale(currentLocale);
    if (!currentMessages) {
      console.warn(`[Any MD] Falling back to English`);
      currentMessages = fallbackMessages;
      currentLocale = 'en';
    }
  }
  
  console.log(`[Any MD] Language: ${currentLocale} (configured: ${lang})`);
}

/**
 * Get translated message for extension
 */
export function t(key: keyof Messages): string {
  const messages = currentMessages?.messages || fallbackMessages?.messages;
  return messages?.[key] || key;
}

/**
 * Get current locale
 */
export function getLocale(): string {
  return currentLocale;
}

/**
 * Get webview messages for current locale
 */
export function getWebviewMessages(): WebviewMessages {
  const msgs = currentMessages?.webviewMessages || fallbackMessages?.webviewMessages || {} as WebviewMessages;
  console.log(`[Any MD] getWebviewMessages: locale=${currentLocale} bold="${msgs.bold}" outlinerMakePage="${(msgs as any).outlinerMakePage}"`);
  return msgs;
}

/**
 * Get list of supported locales
 */
export function getSupportedLocales(): string[] {
  return [...SUPPORTED_LOCALES];
}
