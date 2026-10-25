/**
 * fractal-mcp（spec 20261025-2350-fractal-mcp）: fractal skill 群を 1 つの MCP サーバー（stdio）にまとめたもの。
 *
 * server.mjs（公式 SDK の McpServer）を子プロセスで起動し、改行区切りの JSON-RPC で実際に話す（クライアントと同じ経路）。
 * tmp fixture note を都度生成。
 */
import { test, expect } from '@playwright/test';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const AI_SKILLS = path.resolve(__dirname, '../../ai_skills');
const serverMjs = path.join(AI_SKILLS, 'fractal-mcp', 'server.mjs');

let tmpRoot: string;
test.beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-mcp-'));
});
test.afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkFixtureNote(name: string): { dir: string; outPath: string } {
    const dir = fs.mkdtempSync(path.join(tmpRoot, name + '-'));
    const outPath = path.join(dir, 'fix.out');
    const node = (id: string, text: string, extra: object = {}) => ({
        id, parentId: null, children: [], text, tags: [], isPage: false, pageId: null,
        collapsed: false, checked: null, subtext: '', images: [], filePath: null, ...extra,
    });
    fs.writeFileSync(outPath, JSON.stringify({
        version: 1, title: 'Fixture', pageDir: '.', imageDir: './images', fileDir: './files',
        rootIds: ['nA', 'nC'],
        nodes: {
            nA: node('nA', 'りんごの親ノード'),
            nC: node('nC', 'タスク #work', { tags: ['#work'], checked: false }),
        },
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({
        version: 1, rootIds: ['fix'], items: { fix: { type: 'file', id: 'fix', title: 'Fixture' } },
    }, null, 2));
    return { dir, outPath };
}

/** server.mjs と JSON-RPC で話す最小クライアント */
class Client {
    private proc: ChildProcessWithoutNullStreams;
    private buf = '';
    private nextId = 1;
    private waiting = new Map<number, (msg: any) => void>();
    readonly stray: string[] = [];

    constructor() {
        this.proc = spawn(process.execPath, [serverMjs], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.proc.stdout.setEncoding('utf-8');
        this.proc.stdout.on('data', (chunk: string) => {
            this.buf += chunk;
            let nl: number;
            while ((nl = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, nl);
                this.buf = this.buf.slice(nl + 1);
                const msg = JSON.parse(line); // JSON 以外が stdout に出たらここで落ちる
                const cb = this.waiting.get(msg.id);
                if (cb) { this.waiting.delete(msg.id); cb(msg); } else this.stray.push(line);
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
    /** JSON-RPC の error 応答も { isError: true } にそろえて返す */
    async call(name: string, args: object = {}) {
        const r = await this.request('tools/call', { name, arguments: args });
        if (r.error) return { isError: true, content: [{ type: 'text', text: String(r.error.message) }] };
        return { isError: !!r.result.isError, content: r.result.content as { type: string; text: string }[] };
    }
    close() { this.proc.stdin.end(); this.proc.kill(); }
}

test.describe('fractal-mcp', () => {
    let c: Client;
    test.beforeEach(async () => { c = new Client(); await c.init(); });
    test.afterEach(() => c.close());

    test('AC-1 initialize → tools/list で 9 本の tool が inputSchema つきで返る', async () => {
        const c2 = new Client();
        const init = await c2.init();
        expect(init.result.protocolVersion).toBe('2025-06-18');   // クライアントが求めた版で返す
        expect(init.result.capabilities.tools).toBeDefined();
        expect(init.result.serverInfo.name).toBe('fractal');
        const list = await c2.request('tools/list');
        const names = list.result.tools.map((t: any) => t.name).sort();
        expect(names).toEqual([
            'fractal_add', 'fractal_attach', 'fractal_doctor', 'fractal_list_folders', 'fractal_list_notes',
            'fractal_modify', 'fractal_search', 'fractal_structure', 'fractal_summary',
        ]);
        for (const t of list.result.tools) {
            expect(t.inputSchema.type).toBe('object');
            expect(t.description.length).toBeGreaterThan(10);
        }
        // notification（initialized）には応答しない
        expect(c2.stray).toEqual([]);
        c2.close();
    });

    test('AC-2 fractal_search が fixture の note から該当ノードを JSON で返す', async () => {
        const { dir } = mkFixtureNote('search');
        const r = await c.call('fractal_search', { query: 'りんご', folders: [dir], noCache: true });
        expect(r.isError).toBe(false);
        const json = JSON.parse(r.content[0].text);
        const hits = json.results.filter((x: any) => x.kind === 'outline-node');
        expect(hits.length).toBe(1);
        expect(JSON.stringify(hits[0])).toContain('りんご');
        // tags だけでも引ける（query 省略）
        const r2 = await c.call('fractal_search', { tags: ['work'], folders: [dir], noCache: true });
        expect(r2.isError).toBe(false);
        expect(JSON.parse(r2.content[0].text).results.filter((x: any) => x.kind === 'outline-node').length).toBe(1);
    });

    test('AC-3 fractal_add で足し fractal_modify で書き換えると .out に反映され fractal_summary に出る', async () => {
        const { outPath } = mkFixtureNote('edit');
        const add = await c.call('fractal_add', { note: outPath, text: '追加したノード', parent: 'nA' });
        expect(add.isError, add.content[0].text).toBe(false);
        let data = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        const added = Object.values<any>(data.nodes).find((n) => n.text === '追加したノード');
        expect(added).toBeTruthy();
        expect(added.parentId).toBe('nA');

        // dryRun は書き込まない
        const dry = await c.call('fractal_modify', { note: outPath, target: added.id, op: 'set-text', text: '書き換えた', dryRun: true });
        expect(dry.isError).toBe(false);
        expect(JSON.parse(fs.readFileSync(outPath, 'utf-8')).nodes[added.id].text).toBe('追加したノード');

        const mod = await c.call('fractal_modify', { note: outPath, target: added.id, op: 'set-text', text: '書き換えた' });
        expect(mod.isError, mod.content[0].text).toBe(false);
        const chk = await c.call('fractal_modify', { note: outPath, target: 'nC', op: 'check' });
        expect(chk.isError).toBe(false);
        data = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        expect(data.nodes[added.id].text).toBe('書き換えた');
        expect(data.nodes.nC.checked).toBe(true);

        const sum = await c.call('fractal_summary', { note: outPath });
        expect(sum.isError).toBe(false);
        expect(sum.content[0].text).toContain('書き換えた');
        expect(sum.content[0].text).toContain('りんごの親ノード');

        // doctor は exit 1/2（警告・エラーあり）でも結果として返す
        const doc = await c.call('fractal_doctor', { noteDir: path.dirname(outPath) });
        expect(doc.isError).toBe(false);
        expect(() => JSON.parse(doc.content[0].text)).not.toThrow();
    });

    test('AC-4 不正な呼び出しは isError / JSON-RPC エラーで返り、サーバーは応答し続ける', async () => {
        const { outPath } = mkFixtureNote('err');
        const unknown = await c.call('fractal_nope');
        expect(unknown.isError).toBe(true);

        const missing = await c.call('fractal_modify', { note: outPath, op: 'check' });
        expect(missing.isError).toBe(true);
        expect(missing.content[0].text).toContain('target');

        // "-" 始まりのパスは CLI がフラグと取り違えるので拒否
        const dash = await c.call('fractal_add', { note: outPath, md: ['--note'] });
        expect(dash.isError).toBe(true);
        expect(dash.content[0].text).toContain('"-"');
        expect(Object.keys(JSON.parse(fs.readFileSync(outPath, 'utf-8')).nodes)).toEqual(['nA', 'nC']);

        const wrongType = await c.call('fractal_search', { query: 'x', maxResults: 'ten' });
        expect(wrongType.isError).toBe(true);

        const badEnum = await c.call('fractal_modify', { note: outPath, target: 'nA', op: 'explode' });
        expect(badEnum.isError).toBe(true);

        const noQuery = await c.call('fractal_search', { folders: [path.dirname(outPath)] });
        expect(noQuery.isError).toBe(true);

        // 子プロセスの失敗（存在しないノード）は stderr つきの isError
        const fail = await c.call('fractal_modify', { note: outPath, target: 'ないノード', op: 'delete' });
        expect(fail.isError).toBe(true);
        expect(fail.content[0].text).toContain('fractal-modify.mjs');
        expect(JSON.parse(fs.readFileSync(outPath, 'utf-8')).rootIds).toEqual(['nA', 'nC']);

        const nomethod = await c.request('resources/nope');
        expect(nomethod.error.code).toBe(-32601);
        c.raw('{not json');

        // それでも応答し続ける
        const ping = await c.request('ping');
        expect(ping.result).toEqual({});
        const ok = await c.call('fractal_summary', { note: outPath });
        expect(ok.isError).toBe(false);
    });

    test('AC-5 fractal_structure が文書を返し、旧 fractal-* skill の dir は無く install.sh は skill として配置しない', async () => {
        const r = await c.call('fractal_structure');
        expect(r.isError).toBe(false);
        expect(r.content[0].text).toBe(fs.readFileSync(path.join(AI_SKILLS, 'fractal-mcp', 'structure.md'), 'utf-8'));
        expect(r.content[0].text).toContain('outline.note');
        expect(r.content[0].text).not.toMatch(/^name: /m); // SKILL.md の frontmatter を持ち込んでいない

        for (const s of ['fractal-structure', 'fractal-search', 'fractal-edit', 'fractal-doctor', 'fractal-summary']) {
            expect(fs.existsSync(path.join(AI_SKILLS, s)), s).toBe(false);
        }
        expect(fs.existsSync(path.join(AI_SKILLS, 'fractal-mcp', 'SKILL.md'))).toBe(false);
        const installSh = fs.readFileSync(path.join(AI_SKILLS, 'install.sh'), 'utf-8');
        const skills = installSh.match(/^SKILLS="([^"]+)"/m)![1].split(' ');
        expect(skills.filter((s) => s.startsWith('fractal-'))).toEqual([]);
        const legacy = installSh.match(/^LEGACY_SKILLS="([^"]+)"/m)![1].split(' ');
        for (const s of ['fractal-structure', 'fractal-search', 'fractal-edit', 'fractal-doctor', 'fractal-summary', 'fractal-mcp']) expect(legacy).toContain(s);
        // register-fractal.mjs（doc-md 等）は fractal-mcp/scripts の fractal-md.mjs を引く
        for (const s of ['doc-md', 'arxiv-md', 'pptx-pages-md', 'youtube-md', 'web-crawler-md', 'aws-doc-maker']) {
            const src = fs.readFileSync(path.join(AI_SKILLS, s, 'scripts', 'register-fractal.mjs'), 'utf-8');
            expect(src, s).toContain("'..', '..', 'fractal-mcp', 'scripts', 'fractal-md.mjs'");
            expect(src, s).not.toContain('fractal-edit');
        }
        expect(fs.existsSync(path.join(AI_SKILLS, 'fractal-mcp', 'scripts', 'fractal-md.mjs'))).toBe(true);
    });
});

test.describe('fractal-mcp register.mjs', () => {
    test('AC-5 register.mjs は mcp.json の他のサーバーを残して fractal を足し / 外す', async () => {
        const { execFileSync } = await import('child_process');
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'reg-'));
        const cfg = path.join(dir, 'mcp.json');
        fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }));
        const reg = path.join(AI_SKILLS, 'fractal-mcp', 'register.mjs');
        execFileSync(process.execPath, [reg, cfg, serverMjs, '--node', '/usr/bin/node']);
        let data = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
        expect(data.mcpServers.other).toEqual({ command: 'x', args: [] });
        expect(data.mcpServers.fractal).toEqual({ command: '/usr/bin/node', args: [serverMjs] });
        expect(fs.existsSync(cfg + '.bak')).toBe(true);
        execFileSync(process.execPath, [reg, cfg, '--remove']);
        data = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
        expect(data.mcpServers.fractal).toBeUndefined();
        expect(data.mcpServers.other).toBeDefined();
        // 壊れた JSON は触らない
        fs.writeFileSync(cfg, '{broken');
        expect(() => execFileSync(process.execPath, [reg, cfg, serverMjs], { stdio: 'pipe' })).toThrow();
        expect(fs.readFileSync(cfg, 'utf-8')).toBe('{broken');
    });
});
