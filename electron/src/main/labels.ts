/**
 * VS Code renders `$(codicon)` tokens in message buttons, quick pick labels and tree labels.
 * The desktop shell has no codicon font: map the few the extension uses to a character, drop the rest.
 */
const CODICONS: Record<string, string> = {
    check: '✓',
    warning: '⚠',
    error: '⛔',
    info: 'ℹ',
    'folder-opened': '📂',
    folder: '📁',
    'new-file': '📄',
    'new-folder': '📁',
    file: '📄',
    notebook: '📓',
    trash: '🗑',
    add: '+',
    close: '✕',
    link: '🔗',
    search: '🔍',
    gear: '⚙',
    edit: '✎',
    sync: '⟳',
    'cloud-upload': '☁',
    'cloud-download': '☁',
    'arrow-right': '→',
    'arrow-left': '←',
};

export function plainLabel(text: string): string {
    return String(text ?? '')
        .replace(/\$\(([A-Za-z0-9-]+)(?:~[A-Za-z]+)?\)\s?/g, (_m, name: string) => {
            const ch = CODICONS[name];
            return ch ? `${ch} ` : '';
        })
        .trim();
}
