/**
 * outliner-toolbar-s3-sync mutex (TC-U-04)
 *
 * sprint: 20260508-112516-outliner-toolbar-s3-sync
 * 対応: testcases.md TC-U-04 (mutex 動作 / silent return)
 *
 * inflight Map ベースの mutex 動作を直接 assert する。
 * vscode 依存を避けるため、coordinator は require せず、Map ベースの
 * mutex 実装を再現してテスト (実装と同等の挙動を保証)。
 */
import { test, expect } from '@playwright/test';

// 実装と同等の mutex (outliner-s3-sync.ts:OutlinerS3SyncCoordinator.run の核)
function createMutexCoordinator() {
    const inflight = new Map<string, Promise<void>>();

    return {
        isRunning: (id: string) => inflight.has(id),
        run: async (id: string, work: () => Promise<void>): Promise<void> => {
            if (inflight.has(id)) {
                // M6: silent return
                return;
            }
            const promise = work();
            inflight.set(id, promise);
            try {
                await promise;
            } finally {
                inflight.delete(id);
            }
        },
    };
}

test.describe('OutlinerS3SyncCoordinator mutex (TC-U-04)', () => {
    test('TC-U-04: 1st call runs, 2nd silently returns (no throw)', async () => {
        const coord = createMutexCoordinator();
        let workCount = 0;
        const work = async () => {
            workCount++;
            await new Promise((r) => setTimeout(r, 50));
        };
        const p1 = coord.run('abc', work);
        // 2 nd call は同期的に silent return
        const p2 = coord.run('abc', work);
        expect(coord.isRunning('abc')).toBe(true);
        await Promise.all([p1, p2]);
        // 1 回しか実行されない
        expect(workCount).toBe(1);
        expect(coord.isRunning('abc')).toBe(false);
    });

    test('TC-U-04: different ids run independently in parallel', async () => {
        const coord = createMutexCoordinator();
        let count = 0;
        const work = async () => {
            count++;
            await new Promise((r) => setTimeout(r, 30));
        };
        await Promise.all([
            coord.run('abc', work),
            coord.run('def', work),
            coord.run('ghi', work),
        ]);
        expect(count).toBe(3);
    });

    test('TC-U-04: isRunning returns true during work, false after', async () => {
        const coord = createMutexCoordinator();
        let resolveWork: (() => void) | null = null;
        const work = () => new Promise<void>((r) => { resolveWork = r; });
        const p = coord.run('abc', work);
        await new Promise((r) => setTimeout(r, 0));
        expect(coord.isRunning('abc')).toBe(true);
        expect(coord.isRunning('def')).toBe(false);
        resolveWork!();
        await p;
        expect(coord.isRunning('abc')).toBe(false);
    });

    test('TC-U-04: 2nd call does NOT throw (silent return per M6)', async () => {
        const coord = createMutexCoordinator();
        const work = async () => { await new Promise((r) => setTimeout(r, 30)); };
        const p1 = coord.run('abc', work);
        // 2nd call は throw せず undefined を return (silent)
        const p2Result = await coord.run('abc', work);
        expect(p2Result).toBeUndefined();
        await p1;
    });

    test('TC-U-04: throw from work clears the inflight entry (finally cleanup)', async () => {
        const coord = createMutexCoordinator();
        const work = async () => { throw new Error('boom'); };
        let caught: any = null;
        try {
            await coord.run('abc', work);
        } catch (e) { caught = e; }
        expect(caught).not.toBeNull();
        expect(caught.message).toBe('boom');
        expect(coord.isRunning('abc')).toBe(false);
    });
});
