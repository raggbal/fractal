/**
 * spec 20261027-1900-fractal-skill-plugin D7 — Kiro Crew の agent 定義に fractal の MCP と skill を入れる（register-kirocrew.mjs）。
 * 新しく足すのは main / worker だけ、既に fractal を持つ agent は path を直す、ほかの agent（guest 等）は触らない、--remove で外す。
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '../../agent-capability/mcp/register-kirocrew.mjs');
const SKILL = 'skill://~/.kiro/skills/fractal/SKILL.md';

function agent(dir: string, name: string, extra: Record<string, unknown> = {}): string {
    const f = path.join(dir, `${name}.json`);
    fs.writeFileSync(f, JSON.stringify({ name, tools: ['fs_read'], resources: ['file://.kiro/steering/**/*.md'], mcpServers: { other: { command: 'x' } }, ...extra }, null, 2));
    return f;
}
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('AC-3 Kiro Crew: main / worker に MCP + skill を足し、既存の fractal は path を直し、guest は触らず、--remove で外す', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirocrew-'));
    const main = agent(dir, 'kirocrew');
    const worker = agent(dir, 'kirocrew-worker');
    const guest = agent(dir, 'kirocrew-guest');
    const view = agent(dir, 'kirocrew-skill-view-abc', { tools: ['fs_read', '@fractal'], mcpServers: { other: { command: 'x' }, fractal: { command: 'node', args: ['/old/ai_skills/fractal-mcp/server.mjs'] } } });
    const notAgent = path.join(dir, 'kirocrew-notes.json');
    fs.writeFileSync(notAgent, '{"foo":1}');
    const guestBefore = fs.readFileSync(guest, 'utf8');
    const server = path.join(dir, 'server.mjs');

    execFileSync(process.execPath, [SCRIPT, server, '--node', '/usr/bin/node', main, worker, guest, view, notAgent]);
    for (const f of [main, worker, view]) {
        const d = read(f);
        expect(d.mcpServers.fractal, f).toEqual({ command: '/usr/bin/node', args: [server] });
        expect(d.mcpServers.other, 'ほかのサーバーは触らない').toEqual({ command: 'x' });
        expect(d.tools.filter((t: string) => t === '@fractal').length).toBe(1);
        expect(d.resources).toContain(SKILL);
        expect(d.resources).toContain('file://.kiro/steering/**/*.md');
        expect(fs.existsSync(`${f}.bak`)).toBe(true);
    }
    expect(fs.readFileSync(guest, 'utf8'), 'guest には足さない').toBe(guestBefore);
    expect(fs.readFileSync(notAgent, 'utf8')).toBe('{"foo":1}');

    // 2 回目は変更なし（冪等）
    const out = execFileSync(process.execPath, [SCRIPT, server, '--node', '/usr/bin/node', main, worker], { encoding: 'utf8' });
    expect(out).toContain('変更なし');

    execFileSync(process.execPath, [SCRIPT, '--remove', main, view]);
    for (const f of [main, view]) {
        const d = read(f);
        expect(d.mcpServers.fractal).toBeUndefined();
        expect(d.tools).not.toContain('@fractal');
        expect(d.resources).not.toContain(SKILL);
        expect(d.mcpServers.other).toEqual({ command: 'x' });
    }
});
