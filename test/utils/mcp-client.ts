/**
 * fractal MCP（mcp/dist/server.mjs = bundle）と stdio の JSON-RPC で話す最小クライアント（テスト用）。
 * 削除は FRACTAL_TRASH_DIR（env で渡す）へ退避させる。
 */
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';

export const MCP_SERVER = path.resolve(__dirname, '../../mcp/dist/server.mjs');

export class McpTestClient {
    private proc: ChildProcessWithoutNullStreams;
    private buf = '';
    private nextId = 1;
    private waiting = new Map<number, (msg: any) => void>();
    readonly stray: string[] = [];

    constructor(env?: NodeJS.ProcessEnv) {
        this.proc = spawn(process.execPath, [MCP_SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
        this.proc.stdout.setEncoding('utf-8');
        this.proc.stdout.on('data', (chunk: string) => {
            this.buf += chunk;
            let nl: number;
            while ((nl = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, nl);
                this.buf = this.buf.slice(nl + 1);
                const msg = JSON.parse(line); // JSON 以外が stdout に出たらここで落ちる
                const cb = this.waiting.get(msg.id);
                if (cb) { this.waiting.delete(msg.id); cb(msg); } else { this.stray.push(line); }
            }
        });
    }
    raw(line: string) { this.proc.stdin.write(line + '\n'); }
    request(method: string, params?: object): Promise<any> {
        const id = this.nextId++;
        return new Promise((resolve) => {
            this.waiting.set(id, resolve);
            this.raw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        });
    }
    notify(method: string) { this.raw(JSON.stringify({ jsonrpc: '2.0', method })); }
    async init() {
        const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
        this.notify('notifications/initialized');
        return r;
    }
    /** tools/call。JSON-RPC の error 応答も { isError: true } にそろえる。text が JSON なら json に入れる */
    async call(name: string, args: object = {}): Promise<{ isError: boolean; content: { type: string; text: string }[]; text: string; json: any }> {
        const r = await this.request('tools/call', { name, arguments: args });
        if (r.error) {
            const text = String(r.error.message);
            return { isError: true, content: [{ type: 'text', text }], text, json: null };
        }
        const content = r.result.content as { type: string; text: string }[];
        const text = content.map((c) => c.text).join('\n');
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* text のまま */ }
        return { isError: !!r.result.isError, content, text, json };
    }
    close() { this.proc.stdin.end(); this.proc.kill(); }
}
