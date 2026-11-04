#!/usr/bin/env node
/**
 * unregister-legacy.mjs — 以前 install.sh が mcp.json（Kiro 形式: { "mcpServers": { ... } }）に書いた fractal の登録を外す。
 * Kiro は Power（agent-capability/plugin）で入れるようになったので、残っていると同じ tool が二重に出る。
 * ほかのサーバーの設定は触らない。書き換える前に <config>.bak を残し、tmp に書いて rename する。
 *
 * Usage: unregister-legacy.mjs <mcp.json>
 */
import * as fs from 'node:fs';

const [config] = process.argv.slice(2);
if (!config) {
    console.error('Usage: unregister-legacy.mjs <mcp.json>');
    process.exit(1);
}
if (!fs.existsSync(config)) process.exit(0);
const raw = fs.readFileSync(config, 'utf-8');
let data;
try {
    data = raw.trim() ? JSON.parse(raw) : {};
} catch (e) {
    console.error(`Error: ${config} が JSON として読めないので触りません（${e.message}）`);
    process.exit(1);
}
if (!data.mcpServers?.fractal) process.exit(0);
delete data.mcpServers.fractal;
fs.writeFileSync(`${config}.bak`, raw);
const tmp = `${config}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
fs.renameSync(tmp, config);
console.log('removed');
