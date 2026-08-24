/*
 * fractal original（sprint 20260823-165314 / ADR-0010 — 省略スタブ）。
 * upstream chart.js（echarts 向けデータ抽出）は移植しない（FR-PPV-04: チャートはプレースホルダ縮退）。
 * 呼び出し側契約: getChartInfo → null で「チャート要素は種別のみのプレースホルダ」に落ちる …のではなく
 * null だと要素ごと消えるため、最小の { type, data, colors } を返して type:'chart' 要素を残す。
 */
export function getChartInfo(plotArea, warpObj) {
    // plotArea の子タグ名から chartType を推定（barChart / lineChart / pieChart 等）— 表示はプレースホルダ
    let type = 'unknown';
    if (plotArea && typeof plotArea === 'object') {
        for (const key of Object.keys(plotArea)) {
            const m = /^c:(\w+Chart)$/.exec(key);
            if (m) { type = m[1]; break; }
        }
    }
    return { type, data: null, colors: [] };
}
