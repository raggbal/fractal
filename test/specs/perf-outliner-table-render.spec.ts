/**
 * Outliner Table Editor — Performance benchmark (TASK-D2 / NFR-01).
 *
 * 1000 行 × 4 列 (outliner + text + multiselect × 2) を合成し、
 * Table editor の初期レンダ時間を計測する。閾値 1500ms (NFR-01)。
 *
 * PoC `bh02-perf.html` / `bh02-run-perf.mjs` の合成データ生成を sprint 化。
 * PoC では plain HTML で 92.5ms (1000 行 × 3 列) の実測値を獲得済 — 本番
 * Table editor は cell ごとに OutlinerCell.renderInlineText を回すため
 * オーバーヘッドが乗るが、それでも余裕がある想定。
 *
 * design: design/system.md §8.2 / NFR-01 (大規模 outline でも 1.5s 以内に初期レンダ)
 * testcases: TC-401 (perf benchmark)
 */
import { test, expect, Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

/**
 * 1000 行 × 4 列の合成 .out を組み立てる。
 *
 * - 全 1000 行は root レベル (TASK-B4 row recycling と同条件)
 * - depth は意味なし (root のみ) — virtual scroll 無し worst case
 * - text cell + multiselect × 2 (master 6 options)
 */
function buildSyntheticOutTableData(rowCount: number) {
    const statuses = ['Todo', 'In Progress', 'Done', 'Blocked'];
    const tagOptionIds = ['opt_urgent', 'opt_bug', 'opt_feature', 'opt_chore'];
    const priorityOptionIds = ['opt_p1', 'opt_p2', 'opt_p3'];
    const tagPatterns: string[][] = [
        ['opt_urgent'], ['opt_bug'], ['opt_urgent', 'opt_bug'], [], ['opt_feature'], ['opt_urgent', 'opt_feature']
    ];
    const priorityPatterns: string[][] = [
        ['opt_p1'], ['opt_p2'], ['opt_p3'], []
    ];

    const rootIds: string[] = [];
    const nodes: Record<string, any> = {};
    for (let i = 0; i < rowCount; i++) {
        const id = 'n' + i;
        rootIds.push(id);
        nodes[id] = {
            id,
            parentId: null,
            children: [],
            text: 'Task #' + i + ': sample item with **bold** and *italic* and #tag content',
            tags: [],
            columnValues: {
                col_status: statuses[i % statuses.length],
                col_tags: tagPatterns[i % tagPatterns.length],
                col_priority: priorityPatterns[i % priorityPatterns.length]
            }
        };
    }

    return {
        title: 'PERF-1000',
        rootIds,
        nodes,
        columns: [
            { id: 'col_outliner', type: 'outliner', name: 'Outline', order: 0 },
            { id: 'col_status', type: 'text', name: 'Status', order: 1 },
            {
                id: 'col_tags',
                type: 'multiselect',
                name: 'Tags',
                order: 2,
                options: [
                    { id: 'opt_urgent', label: 'urgent', color: 'red' },
                    { id: 'opt_bug', label: 'bug', color: 'orange' },
                    { id: 'opt_feature', label: 'feature', color: 'green' },
                    { id: 'opt_chore', label: 'chore', color: 'zinc' }
                ]
            },
            {
                id: 'col_priority',
                type: 'multiselect',
                name: 'Priority',
                order: 3,
                options: [
                    { id: 'opt_p1', label: 'P1', color: 'red' },
                    { id: 'opt_p2', label: 'P2', color: 'yellow' },
                    { id: 'opt_p3', label: 'P3', color: 'blue' }
                ]
            }
        ]
    };
}

/**
 * Table editor を init し、初期レンダ完了 (合計 = JS + layout + paint) までの
 * ms を performance.now で測定して返す。
 */
async function measureInitialRender(page: Page, data: any): Promise<{ totalMs: number; rowCount: number; }> {
    // standalone-outliner-table.html は load 時に空 init を実行している。
    // まずページを開いて __testApi の準備を待つ。
    await page.goto('/standalone-outliner-table.html');
    await page.waitForFunction(() => (window as any).__testApi);

    const result = await page.evaluate(async (d) => {
        const w = window as any;
        // 計測対象: __testApi.initOutlinerTable + DOM 確定 (rAF×2 で paint 確定)
        const t0 = performance.now();
        w.__testApi.initOutlinerTable(d);
        // microtask flush
        await Promise.resolve();
        const t1 = performance.now();
        // raf x2 で layout / paint 完了を待つ
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        // forced layout
        const root = document.getElementById('app') || document.body;
        const _bbox = root ? root.getBoundingClientRect() : null;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const t2 = performance.now();
        const rowCount = document.querySelectorAll('.otable-row').length;
        return { jsMs: t1 - t0, totalMs: t2 - t0, rowCount, bboxHeight: _bbox ? _bbox.height : 0 };
    }, data);

    // log to test report
    // eslint-disable-next-line no-console
    console.log(`[perf] rows=${result.rowCount} jsMs=${result.jsMs.toFixed(1)} totalMs=${result.totalMs.toFixed(1)}`);
    return { totalMs: result.totalMs, rowCount: result.rowCount };
}

// ---------------------------------------------------------------------------
// TC-401 / NFR-01: 1000 行 × 4 列の初期レンダが 1500ms 以内
// ---------------------------------------------------------------------------
test('TC-401 NFR-01: 1000-row × 4-col initial render < 1500ms', async ({ page }) => {
    const data = buildSyntheticOutTableData(1000);
    const { totalMs, rowCount } = await measureInitialRender(page, data);
    expect(rowCount).toBe(1000);
    expect(totalMs).toBeLessThan(1500);
});

// ---------------------------------------------------------------------------
// 補助: 500 行 × 4 列 (より高速、回帰検出用)
// ---------------------------------------------------------------------------
test('NFR-01 ref: 500-row × 4-col initial render < 800ms', async ({ page }) => {
    const data = buildSyntheticOutTableData(500);
    const { totalMs, rowCount } = await measureInitialRender(page, data);
    expect(rowCount).toBe(500);
    expect(totalMs).toBeLessThan(800);
});
