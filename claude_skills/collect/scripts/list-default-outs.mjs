#!/usr/bin/env node
/**
 * list-default-outs.mjs
 *
 * Inspect the FRACTAL_DEFAULT_OUT environment variable and print a JSON array
 * describing each `.out` path it contains, so the calling skill can show
 * titles to the user (typically via AskUserQuestion) when there are multiple
 * candidates.
 *
 * This is the single source of truth for FRACTAL_DEFAULT_OUT parsing — the
 * per-skill register-fractal.mjs files do NOT consult this env. The /collect
 * skill resolves the env and forwards an explicit `--to-fractal-out <path>`
 * to its sub-skills.
 *
 * Behavior:
 *   - env unset / empty → exit 0, prints "[]"
 *   - one path  → prints a single-element array (caller can auto-pick)
 *   - many paths → prints all; caller is expected to ask the user
 *
 * Output schema (stdout, JSON):
 *   [
 *     { "path": "/abs/path/foo.out", "title": "Foo notes", "exists": true },
 *     ...
 *   ]
 *
 * Usage:
 *   node list-default-outs.mjs
 *
 * No flags. Read-only — safe to call freely.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function expandUser(p) {
    if (!p) return p;
    if (p === '~') return os.homedir();
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return p;
}

function parseDefaultOuts() {
    const raw = process.env.FRACTAL_DEFAULT_OUT || '';
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => {
            let abs = path.resolve(expandUser(p));
            if (!abs.endsWith('.out')) abs += '.out';
            return abs;
        });
}

function readOutTitle(outPath) {
    try {
        const d = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        return d.title || path.basename(outPath, '.out');
    } catch {
        return path.basename(outPath, '.out');
    }
}

const paths = parseDefaultOuts();
const result = paths.map((p) => ({
    path: p,
    title: fs.existsSync(p) ? readOutTitle(p) : null,
    exists: fs.existsSync(p),
}));

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
