/**
 * Main-process log: <userData>/logs/main.log (one line per entry, ISO time + level) and the console.
 * Rotated once at start when over 5 MB (main.log → main.log.1). Newlines inside a message are kept
 * readable by indenting continuation lines, so one entry cannot pose as another.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import type { ShimLogger } from '../vscode-shim/adapters';

const MAX_BYTES = 5 * 1024 * 1024;

export interface FileLogger extends ShimLogger {
    readonly file: string;
    close(): void;
}

function format(args: unknown[]): string {
    return args
        .map((a) => {
            if (typeof a === 'string') {
                return a;
            }
            if (a instanceof Error) {
                return a.stack || a.message;
            }
            return util.inspect(a, { depth: 4, breakLength: 160 });
        })
        .join(' ')
        .replace(/\r?\n/g, '\n    ');
}

export function createFileLogger(dir: string, alsoConsole = true): FileLogger {
    const file = path.join(dir, 'main.log');
    let stream: fs.WriteStream | null = null;
    try {
        fs.mkdirSync(dir, { recursive: true });
        try {
            if (fs.statSync(file).size > MAX_BYTES) {
                fs.renameSync(file, `${file}.1`);
            }
        } catch {
            /* no log yet */
        }
        stream = fs.createWriteStream(file, { flags: 'a' });
        stream.on('error', () => {
            stream = null;
        });
    } catch {
        stream = null;
    }
    const write = (level: 'info' | 'warn' | 'error', args: unknown[]) => {
        const line = `${new Date().toISOString()} [${level}] ${format(args)}\n`;
        try {
            stream?.write(line);
        } catch {
            /* logging never throws */
        }
        if (alsoConsole) {
            try {
                // eslint-disable-next-line no-console
                (level === 'info' ? console.log : level === 'warn' ? console.warn : console.error)(...args);
            } catch {
                /* EPIPE when stdout is closed */
            }
        }
    };
    return {
        file,
        info: (...a) => write('info', a),
        warn: (...a) => write('warn', a),
        error: (...a) => write('error', a),
        close: () => {
            try {
                stream?.end();
            } catch {
                /* ignore */
            }
            stream = null;
        },
    };
}
