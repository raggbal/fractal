#!/usr/bin/env node
/**
 * register-kirocrew.mjs — Kiro Crew の agent 定義（Kiro の custom agent の JSON）に fractal の MCP と skill を足す / 外す。
 * install.sh から呼ばれる。
 *
 * Kiro Crew の agent は mcpServers を自分の JSON に持ち（includeMcpJson: false）、custom agent なので skill も自動では
 * 読まない（resources に skill:// で書く — https://kiro.dev/docs/skills/）。そこで各 agent 定義に:
 *   - mcpServers.fractal = { command: <node>, args: [<server.mjs>] }
 *   - tools に "@fractal"
 *   - resources に "skill://~/.kiro/skills/fractal/SKILL.md"
 * を入れる（--remove で 3 つとも外す）。ほかの設定は触らない。書き換える前に <file>.bak を残す。
 * 新しく足すのは main（kirocrew）と worker（kirocrew-worker）の agent だけ。ほかの agent（guest・heartbeat・
 * skill-view の写し等）は、もう fractal を持っているときだけ path を直す（権限の狭い agent に勝手に書き込みの tool を足さない）。
 * mcpServers を持たない JSON（Kiro Crew の agent 定義でないもの）は触らない。
 *
 * Usage: register-kirocrew.mjs <server.mjs> --node <node> <agent.json>...
 *        register-kirocrew.mjs --remove <agent.json>...
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SKILL_RESOURCE = 'skill://~/.kiro/skills/fractal/SKILL.md';
const ADD_TO = new Set(['kirocrew.json', 'kirocrew-worker.json']);
const TOOL = '@fractal';

const args = process.argv.slice(2);
const remove = args[0] === '--remove';
let server = null;
let nodeBin = process.execPath;
let files;
if (remove) {
    files = args.slice(1);
} else {
    server = args[0];
    const i = args.indexOf('--node');
    if (i >= 0) { nodeBin = args[i + 1]; }
    files = args.slice(1).filter((a, idx, arr) => a !== '--node' && arr[idx - 1] !== '--node');
}
if ((!remove && !server) || files.length === 0) {
    console.error('Usage: register-kirocrew.mjs <server.mjs> --node <node> <agent.json>... | register-kirocrew.mjs --remove <agent.json>...');
    process.exit(1);
}

let changed = 0;
for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    let data;
    try { data = JSON.parse(raw); } catch (e) {
        console.error(`skip: ${file} が JSON として読めない（${e.message}）`);
        continue;
    }
    if (!data || typeof data !== 'object' || !data.mcpServers || typeof data.mcpServers !== 'object') { continue; }
    const tools = Array.isArray(data.tools) ? data.tools : null;
    const hasFractal = !!data.mcpServers.fractal || (tools && tools.includes(TOOL));
    if (!remove && !hasFractal && !ADD_TO.has(path.basename(file))) { continue; }
    const resources = Array.isArray(data.resources) ? data.resources : (data.resources ? null : []);
    if (remove) {
        delete data.mcpServers.fractal;
        if (tools) { data.tools = tools.filter((t) => t !== TOOL); }
        if (Array.isArray(data.resources)) { data.resources = data.resources.filter((r) => r !== SKILL_RESOURCE); }
    } else {
        data.mcpServers.fractal = { command: nodeBin, args: [path.resolve(server)] };
        if (tools && !tools.includes(TOOL)) { tools.push(TOOL); }
        if (resources) {
            if (!resources.includes(SKILL_RESOURCE)) { resources.push(SKILL_RESOURCE); }
            data.resources = resources;
        }
    }
    const next = JSON.stringify(data, null, 2) + '\n';
    if (next === raw) { continue; }
    fs.writeFileSync(`${file}.bak`, raw);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
    changed++;
    console.log(file);
}
if (changed === 0) { console.log('(変更なし)'); }
