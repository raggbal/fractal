/**
 * spec 20261104-0524-codex-plugin-drop-kirocrew D6 — Kiro は Power で入れるので、以前 install.sh が
 * ~/.kiro/settings/mcp.json に書いた fractal の登録は外す（残ると tool が二重に出る）。ほかのサーバーは触らない。
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '../../agent-capability/scripts/unregister-legacy.mjs');
const run = (cfg: string) => execFileSync(process.execPath, [SCRIPT, cfg], { encoding: 'utf-8' }).trim();

test('AC-6 以前の fractal の登録だけを外し、ほかは触らず、冪等で、読めない JSON は書き換えない', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-legacy-'));
    const cfg = path.join(dir, 'mcp.json');
    const other = { command: 'other-mcp', args: ['--x'] };
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { fractal: { command: 'node', args: ['/old/server.mjs'] }, other } }));

    expect(run(cfg)).toBe('removed');
    expect(JSON.parse(fs.readFileSync(cfg, 'utf-8'))).toEqual({ mcpServers: { other } });
    expect(fs.existsSync(`${cfg}.bak`)).toBe(true);

    // 2 回目は何もしない（.bak も上書きしない）
    const bak = fs.readFileSync(`${cfg}.bak`, 'utf-8');
    expect(run(cfg)).toBe('');
    expect(fs.readFileSync(`${cfg}.bak`, 'utf-8')).toBe(bak);

    // 無いファイルは作らない
    expect(run(path.join(dir, 'none.json'))).toBe('');
    expect(fs.existsSync(path.join(dir, 'none.json'))).toBe(false);

    // 読めない JSON は exit 1 で触らない
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{ "mcpServers": { "fractal": ');
    expect(() => run(broken)).toThrow();
    expect(fs.readFileSync(broken, 'utf-8')).toBe('{ "mcpServers": { "fractal": ');
});
