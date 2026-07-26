/**
 * outliner ヘッダー S3 sync ボタン削除の番人（sprint 20260721-112357-remove-outliner-header-s3sync）。
 *
 * per-outliner sync（outliner ツールバーの sync ボタン）を全経路削除し、左サイドパネル sync に
 * 一本化した。この spec は「削除された（orphan が残っていない）」+「左サイドパネル sync は不変」を検証する。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const src = (p: string) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');

// TC-RM-01: 生成 HTML / webview に outliner-s3-sync-btn が存在しない
test('TC-RM-01 outliner ヘッダーに s3 sync ボタンが無い', () => {
    // 生成器ソース（notesWebviewContent）に button クラスが無い
    expect(src('src/notesWebviewContent.ts')).not.toContain('outliner-s3-sync-btn');
    // webview JS からも消えている
    expect(src('src/webview/outliner.js')).not.toContain('outliner-s3-sync-btn');
    // CSS からも消えている
    expect(src('src/webview/outliner.css')).not.toContain('outliner-s3-sync-btn');
    // 再生成された standalone HTML にも無い
    expect(src('test/html/standalone-notes.html')).not.toContain('outliner-s3-sync-btn');
    expect(src('test/html/standalone-outliner.html')).not.toContain('outliner-s3-sync-btn');
    // 注: 進捗 overlay（outliner-s3-sync-overlay）は左サイドパネル sync 用に残す（TC-RM-04 参照）
});

// TC-RM-02: header sync の webview→host 配線が存在しない（orphan なし）
test('TC-RM-02 header sync の配線が残っていない', () => {
    // bridge メソッド無し
    expect(src('src/shared/notes-host-bridge.js')).not.toContain('outlinerS3SyncRequest');
    // message-handler の case + interface 無し
    expect(src('src/shared/notes-message-handler.ts')).not.toContain('outlinerS3SyncRequest');
    expect(src('src/shared/notes-message-handler.ts')).not.toContain('outlinerS3Sync');
    // provider の handler / machinery 無し
    const prov = src('src/notesEditorProvider.ts');
    expect(prov).not.toContain('handleOutlinerS3Sync');
    expect(prov).not.toContain('OutlinerS3SyncCoordinator');
    expect(prov).not.toContain('pathBelongsToSyncingOutliner');
    // engine ファイルが削除されている
    expect(fs.existsSync(path.join(__dirname, '../../src/outliner-s3-sync.ts'))).toBe(false);
});

// TC-RM-03: 左サイドパネル sync は不変（回帰なし）
test('TC-RM-03 左サイドパネル sync 経路は残っている', () => {
    // 左サイドパネルのメニュー配線
    const panel = src('src/shared/notes-file-panel.js');
    expect(panel).toMatch(/s3Sync|notesS3/);
    // bridge / handler の左サイドパネル sync メッセージ
    const bridge = src('src/shared/notes-host-bridge.js');
    expect(bridge).toContain('notesS3Sync');
    // コア関数
    const core = src('src/notes-s3-sync.ts');
    expect(core).toContain('s3Sync');
    expect(core).toContain('s3RemoteDeleteAndUpload');
    expect(core).toContain('s3LocalDeleteAndDownload');
    // per-file 転送エンジン
    const perFile = src('src/s3-per-file-sync.ts');
    expect(perFile).toContain('syncDirectoryBidirectional');
    expect(perFile).toContain('walkLocalDir');
    // 共有 utils（左サイドパネル sync が使う）
    const utils = src('src/outliner-s3-sync-utils.ts');
    expect(utils).toContain('parseBucketPath');
    expect(utils).toContain('decideSyncDirection');
    expect(utils).toContain('getAwsEnv');
});

// TC-RM-04: 左サイドパネル双方向 Sync 後の outliner 再描画ハンドラが残っている（過剰削除の番人）
test('TC-RM-04 左サイドパネル sync の再描画ハンドラ（sync-applied 受信）が残る', () => {
    const out = src('src/webview/outliner.js');
    // 送出側（左サイドパネル sync）が使う 3 メッセージの受信 case が残っている
    expect(out).toContain("case 'sync-applied'");
    expect(out).toContain("case 'sync-lock'");
    expect(out).toContain("case 'sync-progress'");
    // model 再描画関数が残り、model 再構築 + renderTree する
    expect(out).toMatch(/function\s+applySyncedData\s*\(\s*newData\s*\)/);
    const m = out.match(/function\s+applySyncedData\s*\(\s*newData\s*\)\s*\{([\s\S]*?)\n {4}\}/);
    expect(m, 'applySyncedData 本体').toBeTruthy();
    expect(m![1]).toContain('new OutlinerModel(newData)');
    expect(m![1]).toContain('renderTree()');
    // 送出側（provider）が sync-applied を送る（送受信対称）
    expect(src('src/notesEditorProvider.ts')).toContain("type: 'sync-applied'");
    // overlay DOM は左サイドパネル sync 用に残る
    expect(src('src/notesWebviewContent.ts')).toContain('outliner-s3-sync-overlay');
    // ただし header ボタン専用の sync-button-state/visibility 受信は消えている
    expect(out).not.toContain("case 'sync-button-state'");
    expect(out).not.toContain("case 'sync-button-visibility'");
});
