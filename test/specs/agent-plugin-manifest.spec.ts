/**
 * spec 20261104-0524-codex-plugin-drop-kirocrew D1 / D5 — plugin（agent-capability/plugin）は Claude Code と Codex で共有する。
 * - Claude Code は .claude-plugin/plugin.json と .mcp.json（${CLAUDE_PLUGIN_ROOT}）を読む
 * - Codex と Kiro（Power）は Agent Plugins の plugin.json と mcp.json（${PLUGIN_ROOT}）を読む（Codex は .mcp.json の ${CLAUDE_PLUGIN_ROOT} を展開しない）
 * 2 つの manifest の name・version・description と、2 つの MCP 設定が起動する server がずれないこと。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const PLUGIN = path.resolve(__dirname, '../../agent-capability/plugin');
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(PLUGIN, rel), 'utf-8'));

test('AC-1 Agent Plugins の manifest・MCP 設定が Claude Code のものと一致する', () => {
    const agent = read('plugin.json');
    const claude = read('.claude-plugin/plugin.json');
    expect(agent.$schema).toMatch(/^https:\/\/agent-plugins\.org\/schemas\/1\.\d+\.\d+\/plugin\.schema\.json$/);
    for (const k of ['name', 'version', 'description']) expect(agent[k], k).toBe(claude[k]);
    // Kiro は manifest の知らない field を無視し、name は小文字・数字・. と - だけ（Kiro 1.4 の AgentPluginLoader）
    const allowed = ['$schema', 'name', 'displayName', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
    for (const k of Object.keys(agent)) expect(allowed, k).toContain(k);
    expect(agent.name).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
    expect(fs.existsSync(path.join(PLUGIN, 'skills', 'fractal', 'SKILL.md'))).toBe(true);

    const agentMcp = read('mcp.json');
    const claudeMcp = read('.mcp.json');
    expect(agentMcp.$schema).toMatch(/^https:\/\/agent-plugins\.org\/schemas\/1\.\d+\.\d+\/mcp\.schema\.json$/);
    // Agent Plugins の MCP 設定は $schema と mcpServers 以外を持てない（Kiro / Codex は MCP を丸ごと無効にする）
    expect(Object.keys(agentMcp).sort()).toEqual(['$schema', 'mcpServers']);
    expect(Object.keys(agentMcp.mcpServers)).toEqual(Object.keys(claudeMcp.mcpServers));
    for (const [name, s] of Object.entries<any>(agentMcp.mcpServers)) {
        const c = claudeMcp.mcpServers[name];
        expect(s.type).toBe('stdio');
        expect(s.command).toBe(c.command);
        expect(s.args).toEqual(c.args.map((a: string) => a.replace('${CLAUDE_PLUGIN_ROOT}', '${PLUGIN_ROOT}')));
        expect(s.args.join(' ')).toContain('${PLUGIN_ROOT}/server/server.mjs');
    }
});
