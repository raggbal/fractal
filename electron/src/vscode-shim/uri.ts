/**
 * vscode.Uri = the `vscode-uri` package (Microsoft's own URI implementation, the one VS Code uses),
 * so file()/parse()/fsPath/path/toString()/with() and the webview resource strings are byte-identical
 * to VS Code. VS Code's internal URI class also has a static joinPath(); vscode-uri keeps it in
 * Utils, so it is attached here (non-enumerable, posix join on .path that normalizes '..' and does
 * not decode — the same as VS Code).
 */
import { URI, Utils } from 'vscode-uri';

export type Uri = URI;

type UriStatic = typeof URI & {
    joinPath(base: URI, ...pathSegments: string[]): URI;
};

if (typeof (URI as Partial<UriStatic>).joinPath !== 'function') {
    Object.defineProperty(URI, 'joinPath', {
        value: function joinPath(base: URI, ...pathSegments: string[]): URI {
            if (!base || !URI.isUri(base)) {
                throw new Error('[UriError]: cannot call joinPath on URI without path');
            }
            return Utils.joinPath(base, ...pathSegments);
        },
        enumerable: false,
        configurable: true,
        writable: true,
    });
}

export const Uri: UriStatic = URI as UriStatic;

/** Accepts a Uri, a file path string, or UriComponents-like `{ fsPath }` and returns an absolute fs path. */
export function toFsPath(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (value && typeof value === 'object') {
        if (URI.isUri(value)) {
            return value.scheme === 'file' ? value.fsPath : undefined;
        }
        const fsPath = (value as { fsPath?: unknown }).fsPath;
        if (typeof fsPath === 'string') {
            return fsPath;
        }
    }
    return undefined;
}

export function isUri(value: unknown): value is URI {
    return URI.isUri(value);
}
