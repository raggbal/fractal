/**
 * Webview resource requests → a local file, or null (the protocol handler answers 404).
 * Pure Node (no Electron) so it is unit-tested directly (AC-3).
 *
 * resolveResourceRequest(urlPath, allowedRoots):
 *   1. urlPath is the URL's path (percent-encoded, e.g. new URL(req.url).pathname); anything after
 *      '?' or '#' is ignored.
 *   2. Percent-decode (a malformed escape → null), reject NUL, require an absolute path.
 *   3. Reject any '..' segment — also when it was encoded (%2e%2e, ..%2f) — before normalizing.
 *   4. realpath the target (missing → null) and require a regular file (directories → null).
 *   5. The real path must lie strictly inside the realpath of one of the roots (Uri or path;
 *      roots that do not exist are skipped), compared NFC-normalized with path.relative, so a
 *      symlink inside a root that points outside it is rejected, and "/root-x" never matches "/root".
 *   Returns the real path to serve.
 */
import * as fs from 'fs';
import * as path from 'path';
import { WEBVIEW_FILE_RESOURCE_HOST } from './webview';

export type ResourceRoot = string | { fsPath: string; scheme?: string };

function rootPath(root: ResourceRoot): string | undefined {
    if (typeof root === 'string') {
        return root;
    }
    if (root && typeof root === 'object' && typeof root.fsPath === 'string') {
        if (root.scheme !== undefined && root.scheme !== 'file') {
            return undefined;
        }
        return root.fsPath;
    }
    return undefined;
}

function realpathOrNull(p: string): string | null {
    try {
        return fs.realpathSync.native(p);
    } catch {
        return null;
    }
}

function isStrictlyInside(child: string, parent: string): boolean {
    const rel = path.relative(parent.normalize('NFC'), child.normalize('NFC'));
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

export function resolveResourceRequest(urlPath: string, allowedRoots: ReadonlyArray<ResourceRoot>): string | null {
    if (typeof urlPath !== 'string' || urlPath.length === 0) {
        return null;
    }
    const raw = urlPath.split(/[?#]/, 1)[0];
    let decoded: string;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return null;
    }
    if (decoded.includes('\0')) {
        return null;
    }
    if (!path.isAbsolute(decoded)) {
        return null;
    }
    if (decoded.split(/[\\/]/).some((seg) => seg === '..')) {
        return null;
    }
    const requested = path.normalize(decoded);
    const real = realpathOrNull(requested);
    if (!real) {
        return null;
    }
    let st: fs.Stats;
    try {
        st = fs.statSync(real);
    } catch {
        return null;
    }
    if (!st.isFile()) {
        return null;
    }
    for (const root of allowedRoots ?? []) {
        const p = rootPath(root);
        if (!p || !path.isAbsolute(p)) {
            continue;
        }
        const realRoot = realpathOrNull(p);
        if (realRoot && isStrictlyInside(real, realRoot)) {
            return real;
        }
    }
    return null;
}

/**
 * For the https handler: the path of a request to VS Code's webview resource host
 * (https://file+.vscode-resource.vscode-cdn.net/<path>), or null for any other URL.
 */
export function webviewResourcePath(url: string): string | null {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return null;
    }
    if (u.protocol !== 'https:') {
        return null;
    }
    let host = u.hostname.toLowerCase();
    try {
        host = decodeURIComponent(host);
    } catch {
        return null;
    }
    if (host !== WEBVIEW_FILE_RESOURCE_HOST) {
        return null;
    }
    return u.pathname;
}

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.heic': 'image/heic',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.bcmap': 'application/octet-stream',
    '.pfb': 'application/octet-stream',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
};

/** Content-Type for a served file (module scripts and cross-origin CSS need the right type). */
export function contentTypeFor(filePath: string): string {
    return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
