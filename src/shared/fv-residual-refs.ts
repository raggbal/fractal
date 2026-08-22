/**
 * fv-residual-refs — linkedfd 残留参照スキャナ（NFR-ACD-02 — sprint 20260822-051129 / FR-ACD-01）。
 *
 * fv 起点 md 移動の削除フェーズで「source に残る他 md がまだ参照している資産」を温存するための
 * 参照集合を作る。既存 collectSurvivingMdLinkRefs（notes-asset-mover.ts）は note 直下一段のみ走査
 * （サブフォルダ盲点 — ADRL-0082 が v1 温存の理由に挙げた実体）のため流用せず新設。
 *
 * - linkedfd root 配下の .md を再帰走査し、各 md の画像/📎 参照 + subpage/md リンクを md 基準で
 *   resolve して絶対パス集合にする（参照の種別は問わない — 「誰かが指しているものは消さない」安全側）
 * - excludeMdAbs（移動した md + 削除予定 closure md）は走査対象外
 * - dotfile dir（.git 等）・symlink は非走査（fv 一覧と同じ規律 = NFR-FLV-01）
 * - 上限（既定 maxFiles=2000 / maxDepth=20）超過 → aborted=true（呼び出し側は削除見送り = 安全側）
 *
 * path/fs のみ（vscode 非依存 — unit 直 require 可）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { extractAllAssetRefs } from './paste-asset-handler';

export interface FvResidualLimits {
    maxFiles?: number;  // 走査する md 数の上限（既定 2000）
    maxDepth?: number;  // 再帰深さ上限（既定 20）
}

export function collectFvSurvivingAssetRefs(
    rootAbs: string,
    excludeMdAbs: Set<string>,
    limits?: FvResidualLimits
): { refs: Set<string>; aborted: boolean } {
    const maxFiles = limits?.maxFiles ?? 2000;
    const maxDepth = limits?.maxDepth ?? 20;
    const excl = new Set(Array.from(excludeMdAbs).map((p) => path.resolve(p)));
    const refs = new Set<string>();
    let scanned = 0;
    let aborted = false;

    function walk(dirAbs: string, depth: number): void {
        if (aborted) { return; }
        if (depth > maxDepth) { aborted = true; return; }
        let dirents: fs.Dirent[];
        try { dirents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
        for (const d of dirents) {
            if (aborted) { return; }
            const name = String(d.name);
            if (name.startsWith('.')) { continue; }   // dotfile dir/file 非走査（fv 一覧と同じ規律）
            if (d.isSymbolicLink()) { continue; }      // symlink 非追従（NFR-FLV-01）
            const abs = path.join(dirAbs, name);
            if (d.isDirectory()) { walk(abs, depth + 1); continue; }
            if (!d.isFile() || !/\.md$/i.test(name)) { continue; }
            if (excl.has(path.resolve(abs))) { continue; }
            if (++scanned > maxFiles) { aborted = true; return; }
            let body = '';
            try { body = fs.readFileSync(abs, 'utf8'); } catch { continue; }
            const r = extractAllAssetRefs(body);
            const mdDir = path.dirname(abs);
            for (const ref of [...r.images, ...r.files, ...r.mdLinks]) {
                if (!ref || /^(https?:|data:|file:|fractal:|vscode-)/i.test(ref)) { continue; }
                const target = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(mdDir, ref.split(/[?#]/)[0]);
                refs.add(target);
            }
        }
    }
    walk(path.resolve(rootAbs), 0);
    return { refs, aborted };
}
