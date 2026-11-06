/**
 * workspace.fs for file: URIs on top of fs.promises, with the semantics of VS Code's file service:
 * - readFile → Uint8Array (a Buffer); rejects FileNotFound / FileIsADirectory.
 * - writeFile → overwrites in place and creates missing parent folders (mkdirp).
 * - delete → rejects FileNotFound when missing; non-empty folders need `recursive`; `useTrash` moves to
 *   the OS trash through the injected trash adapter (Electron shell.trashItem).
 * - rename / copy → reject FileExists unless `overwrite`; create the target's parent folders.
 * - createDirectory → mkdirp. stat → { type (bitmask incl. SymbolicLink), ctime, mtime, size }.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Uri } from './uri';
import { FileSystemError, FileType } from './types';

export interface TrashFn {
    (fsPath: string): Promise<void>;
}

function requireFileUri(uri: Uri): string {
    if (!uri || typeof uri !== 'object' || typeof (uri as Uri).scheme !== 'string') {
        throw new FileSystemError('Invalid argument: uri', 'Unknown');
    }
    if (uri.scheme !== 'file') {
        throw FileSystemError.Unavailable(`No file system provider found for resource '${uri.toString()}'`);
    }
    return uri.fsPath;
}

function codeOf(err: unknown): string | undefined {
    return err && typeof err === 'object' ? (err as NodeJS.ErrnoException).code : undefined;
}

/** Maps a Node errno error to a FileSystemError (keeps the original as `cause`). */
export function toFileSystemError(err: unknown, uri: Uri, action: string): FileSystemError {
    const code = codeOf(err);
    const detail = err instanceof Error ? err.message : String(err);
    const message = `Unable to ${action} '${uri.fsPath}' (${detail})`;
    let fsErr: FileSystemError;
    switch (code) {
        case 'ENOENT':
            fsErr = new FileSystemError(message, 'FileNotFound');
            break;
        case 'EEXIST':
            fsErr = new FileSystemError(message, 'FileExists');
            break;
        case 'ENOTDIR':
            fsErr = new FileSystemError(message, 'FileNotADirectory');
            break;
        case 'EISDIR':
            fsErr = new FileSystemError(message, 'FileIsADirectory');
            break;
        case 'EACCES':
        case 'EPERM':
            fsErr = new FileSystemError(message, 'NoPermissions');
            break;
        default:
            fsErr = new FileSystemError(message, 'Unknown');
    }
    (fsErr as { cause?: unknown }).cause = err;
    return fsErr;
}

async function exists(p: string): Promise<boolean> {
    try {
        await fs.promises.lstat(p);
        return true;
    } catch {
        return false;
    }
}

export interface FileStat {
    type: number;
    ctime: number;
    mtime: number;
    size: number;
    permissions?: number;
}

export class ShimFileSystem {
    constructor(private readonly trash: TrashFn) {}

    async stat(uri: Uri): Promise<FileStat> {
        const p = requireFileUri(uri);
        let lst: fs.Stats;
        try {
            lst = await fs.promises.lstat(p);
        } catch (err) {
            throw toFileSystemError(err, uri, 'resolve nonexistent file');
        }
        let st = lst;
        let type = 0;
        if (lst.isSymbolicLink()) {
            type |= FileType.SymbolicLink;
            try {
                st = await fs.promises.stat(p);
            } catch {
                // dangling symlink: VS Code reports SymbolicLink | Unknown
                return { type, ctime: lst.birthtimeMs, mtime: lst.mtimeMs, size: lst.size };
            }
        }
        if (st.isFile()) {
            type |= FileType.File;
        } else if (st.isDirectory()) {
            type |= FileType.Directory;
        }
        let permissions: number | undefined;
        try {
            await fs.promises.access(p, fs.constants.W_OK);
        } catch {
            permissions = 1; // FilePermission.Readonly
        }
        const out: FileStat = { type, ctime: st.birthtimeMs, mtime: st.mtimeMs, size: st.size };
        if (permissions !== undefined) {
            out.permissions = permissions;
        }
        return out;
    }

    async readDirectory(uri: Uri): Promise<[string, number][]> {
        const p = requireFileUri(uri);
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(p, { withFileTypes: true });
        } catch (err) {
            throw toFileSystemError(err, uri, 'read directory');
        }
        const out: [string, number][] = [];
        for (const e of entries) {
            let type = FileType.Unknown as number;
            if (e.isFile()) {
                type = FileType.File;
            } else if (e.isDirectory()) {
                type = FileType.Directory;
            } else if (e.isSymbolicLink()) {
                type = FileType.SymbolicLink;
                try {
                    const st = await fs.promises.stat(path.join(p, e.name));
                    type |= st.isDirectory() ? FileType.Directory : st.isFile() ? FileType.File : 0;
                } catch {
                    /* dangling link */
                }
            }
            out.push([e.name, type]);
        }
        return out;
    }

    async createDirectory(uri: Uri): Promise<void> {
        const p = requireFileUri(uri);
        try {
            await fs.promises.mkdir(p, { recursive: true });
        } catch (err) {
            throw toFileSystemError(err, uri, 'create folder');
        }
    }

    async readFile(uri: Uri): Promise<Uint8Array> {
        const p = requireFileUri(uri);
        try {
            return await fs.promises.readFile(p);
        } catch (err) {
            throw toFileSystemError(err, uri, 'read file');
        }
    }

    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
        const p = requireFileUri(uri);
        if (!(content instanceof Uint8Array)) {
            throw new FileSystemError('Invalid argument: content must be a Uint8Array', 'Unknown');
        }
        try {
            await fs.promises.mkdir(path.dirname(p), { recursive: true });
            await fs.promises.writeFile(p, content);
        } catch (err) {
            throw toFileSystemError(err, uri, 'write file');
        }
    }

    async delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
        const p = requireFileUri(uri);
        let st: fs.Stats;
        try {
            st = await fs.promises.lstat(p);
        } catch (err) {
            throw toFileSystemError(err, uri, 'delete nonexistent file');
        }
        const recursive = !!options?.recursive;
        if (options?.useTrash) {
            try {
                await this.trash(p);
            } catch (err) {
                throw toFileSystemError(err, uri, 'move to trash');
            }
            return;
        }
        try {
            if (st.isDirectory() && !st.isSymbolicLink()) {
                if (recursive) {
                    await fs.promises.rm(p, { recursive: true, force: false });
                } else {
                    await fs.promises.rmdir(p); // ENOTEMPTY when not empty (VS Code rejects too)
                }
            } else {
                await fs.promises.unlink(p);
            }
        } catch (err) {
            throw toFileSystemError(err, uri, 'delete file');
        }
    }

    async rename(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> {
        const from = requireFileUri(source);
        const to = requireFileUri(target);
        if (!(await exists(from))) {
            throw toFileSystemError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), source, 'move nonexistent file');
        }
        // A case-only rename on a case-insensitive volume (a.md → A.md) targets the same entry: allowed.
        const caseOnly = from !== to && from.toLowerCase() === to.toLowerCase();
        if (from !== to && !caseOnly && (await exists(to))) {
            if (!options?.overwrite) {
                throw FileSystemError.FileExists(`Unable to move '${from}' into '${to}' since a file would be overwritten.`);
            }
            await fs.promises.rm(to, { recursive: true, force: true });
        }
        try {
            await fs.promises.mkdir(path.dirname(to), { recursive: true });
            await fs.promises.rename(from, to);
        } catch (err) {
            throw toFileSystemError(err, target, 'move file');
        }
    }

    async copy(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> {
        const from = requireFileUri(source);
        const to = requireFileUri(target);
        if (!(await exists(from))) {
            throw toFileSystemError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), source, 'copy nonexistent file');
        }
        if (await exists(to)) {
            if (!options?.overwrite) {
                throw FileSystemError.FileExists(`Unable to copy '${from}' into '${to}' since a file would be overwritten.`);
            }
            await fs.promises.rm(to, { recursive: true, force: true });
        }
        try {
            await fs.promises.mkdir(path.dirname(to), { recursive: true });
            await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false });
        } catch (err) {
            throw toFileSystemError(err, target, 'copy file');
        }
    }

    isWritableFileSystem(scheme: string): boolean | undefined {
        return scheme === 'file' ? true : undefined;
    }
}
