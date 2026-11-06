/**
 * Small helpers for the shim's own JSON files (globalState.json, settings.json):
 * atomic replace (write a temp file in the same folder, fsync, rename) and one write at a time per
 * file, so a crash leaves either the old or the new content — never a torn file.
 */
import * as fs from 'fs';
import * as path from 'path';

let tmpCounter = 0;

export function writeFileAtomicSync(filePath: string, data: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeFileSync(fd, data, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(tmp, filePath);
    } catch (err) {
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* ignore */
        }
        throw err;
    }
}

export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
    const handle = await fs.promises.open(tmp, 'w');
    try {
        await handle.writeFile(data, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await fs.promises.rename(tmp, filePath);
    } catch (err) {
        await fs.promises.unlink(tmp).catch(() => undefined);
        throw err;
    }
}

/** Serializes async writes to one file; `flush()` resolves when every queued write has finished. */
export class WriteQueue {
    private tail: Promise<void> = Promise.resolve();

    enqueue(job: () => Promise<void>): Promise<void> {
        const run = this.tail.then(job, job);
        // keep the chain alive even if this job fails; the caller still sees the rejection
        this.tail = run.catch(() => undefined);
        return run;
    }

    flush(): Promise<void> {
        return this.tail;
    }
}

export type ReadJsonResult =
    | { kind: 'missing' }
    | { kind: 'ok'; value: unknown; text: string }
    | { kind: 'invalid'; error: string; text: string };

export function readJsonFileSync(filePath: string, parse: (text: string) => unknown = JSON.parse): ReadJsonResult {
    let text: string;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { kind: 'missing' };
        }
        return { kind: 'invalid', error: String((err as Error).message || err), text: '' };
    }
    if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
    }
    if (text.trim() === '') {
        return { kind: 'ok', value: {}, text };
    }
    try {
        return { kind: 'ok', value: parse(text), text };
    } catch (err) {
        return { kind: 'invalid', error: String((err as Error).message || err), text };
    }
}
