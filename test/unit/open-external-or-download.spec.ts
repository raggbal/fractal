/**
 * TC-DLF-01 — 非 viewer file open の remote ダウンロード縮退（sprint 20260822-051129 TASK-14）
 */
import { test, expect } from '@playwright/test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { openFileExternalOrDownload } = require('../../src/shared/open-external-or-download');

test('TC-DLF-01 desktop=openExternal / remote=triggerFileDownload（ensureResourceRoot 併用）', async () => {
    // desktop
    {
        const calls: any[] = [];
        await openFileExternalOrDownload({
            isRemote: false,
            openExternal: (p: string) => { calls.push(['ext', p]); },
            toWebviewUri: (p: string) => 'wv://' + p,
            postMessage: (m: any) => { calls.push(['msg', m]); },
        }, '/x/report.xlsx');
        expect(calls).toEqual([['ext', '/x/report.xlsx']]);
    }
    // remote
    {
        const calls: any[] = [];
        const roots: string[] = [];
        await openFileExternalOrDownload({
            isRemote: true,
            openExternal: (p: string) => { calls.push(['ext', p]); },
            toWebviewUri: (p: string) => 'wv://' + p,
            postMessage: (m: any) => { calls.push(['msg', m]); },
            ensureResourceRoot: (d: string) => { roots.push(d); },
        }, '/x/report.xlsx');
        expect(calls).toEqual([['msg', { type: 'triggerFileDownload', fileUri: 'wv:///x/report.xlsx', fileName: 'report.xlsx' }]]);
        expect(roots).toEqual(['/x']);
    }
});
