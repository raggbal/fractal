/**
 * spec 20261027-1900-fractal-skill-plugin — 使い方の skill（skills/fractal）が MCP の実際の tool と食い違わない。
 * - SKILL.md の frontmatter（name / description）
 * - SKILL.md に出てくる fractal_* がすべて tools/list にあり、tools/list の tool はすべて SKILL.md に出てくる
 * - 廃止した fractal_md_edit を案内していない
 * - references/structure.md は mcp/structure.md の写し（mcp/build.mjs がコピー）
 */
import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SKILL = path.join(ROOT, 'agent-capability', 'plugin', 'skills', 'fractal', 'SKILL.md');

async function listTools(): Promise<string[]> {
    const proc = spawn(process.execPath, [path.join(ROOT, 'agent-capability', 'mcp', 'dist', 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const tools = await new Promise<string[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('tools/list timeout')), 15000);
        proc.stdout.setEncoding('utf-8');
        proc.stdout.on('data', (chunk: string) => {
            buf += chunk;
            for (const line of buf.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const m = JSON.parse(line);
                    if (m.id === 2) { clearTimeout(timer); resolve(m.result.tools.map((t: any) => t.name)); }
                } catch { /* 途中の行 */ }
            }
        });
        const send = (o: object) => proc.stdin.write(JSON.stringify(o) + '\n');
        send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    });
    proc.kill();
    return tools;
}

test('AC-1 skill の tool 名が MCP の tools/list と一致し、references は structure.md の写し', async () => {
    const body = fs.readFileSync(SKILL, 'utf8');
    const fm = body.match(/^---\n([\s\S]*?)\n---/);
    expect(fm, 'frontmatter が無い').toBeTruthy();
    expect(fm![1]).toMatch(/^name: fractal$/m);
    expect(fm![1]).toMatch(/^description: .{40,}/m);

    const tools = await listTools();
    const mentioned = [...new Set(body.match(/fractal_[a-z_]+/g) || [])];
    for (const t of mentioned) expect(tools, `SKILL.md の ${t} が tools/list に無い`).toContain(t);
    for (const t of tools) expect(mentioned, `tools/list の ${t} が SKILL.md に無い`).toContain(t);
    expect(body).not.toContain('fractal_md_edit');

    const ref = fs.readFileSync(path.join(ROOT, 'agent-capability', 'plugin', 'skills', 'fractal', 'references', 'structure.md'), 'utf8');
    expect(ref, 'references/structure.md が mcp/structure.md と違う（node mcp/build.mjs で更新）').toBe(fs.readFileSync(path.join(ROOT, 'agent-capability', 'mcp', 'structure.md'), 'utf8'));
});
