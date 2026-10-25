#!/usr/bin/env node
/**
 * register.mjs — mcp.json（Kiro / Cursor 形式: { "mcpServers": { ... } }）に fractal を足す / 外す。
 * install.sh から呼ばれる。ほかのサーバーの設定は触らない。書き換える前に <config>.bak を残す。
 *
 * Usage: register.mjs <mcp.json> <server.mjs> [--node <node のパス>]
 *        register.mjs <mcp.json> --remove
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const [config, ...rest] = process.argv.slice(2);
if (!config || rest.length === 0) {
    console.error('Usage: register.mjs <mcp.json> <server.mjs> [--node <path>] | register.mjs <mcp.json> --remove');
    process.exit(1);
}
const remove = rest[0] === '--remove';
const nodeIdx = rest.indexOf('--node');
const nodeBin = nodeIdx >= 0 ? rest[nodeIdx + 1] : process.execPath;

let data = {};
if (fs.existsSync(config)) {
    const raw = fs.readFileSync(config, 'utf-8');
    try {
        data = raw.trim() ? JSON.parse(raw) : {};
    } catch (e) {
        console.error(`Error: ${config} が JSON として読めないので触りません（${e.message}）`);
        process.exit(1);
    }
    fs.writeFileSync(`${config}.bak`, raw);
} else if (remove) {
    process.exit(0);
}
data.mcpServers ??= {};
if (remove) {
    if (!data.mcpServers.fractal) process.exit(0);
    delete data.mcpServers.fractal;
} else {
    data.mcpServers.fractal = { command: nodeBin, args: [path.resolve(rest[0])] };
}
fs.mkdirSync(path.dirname(config), { recursive: true });
const tmp = `${config}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
fs.renameSync(tmp, config);
