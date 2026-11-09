"""VS Code の撮影用プロファイル（--user-data-dir）を作り直す。

  python3 -I vscode_profile.py <user-data-dir> <settings.json> <.fractal>

settings.json を User/ に置き、Fractal の globalState（state.vscdb の 'imaken.fractal'）に作業フォルダの .fractal を
登録して有効にする。notesDefaultFractalCreated を立てておくので、拡張機能は本物の ~/.fractal/default.fractal を作らない・読まない。
"""
import json
import os
import shutil
import sqlite3
import sys

ud, settings, registry = sys.argv[1], sys.argv[2], sys.argv[3]
shutil.rmtree(ud, ignore_errors=True)
os.makedirs(os.path.join(ud, 'User', 'globalStorage'))
shutil.copyfile(settings, os.path.join(ud, 'User', 'settings.json'))
state = {
    'notesDefaultFractalCreated': True,
    'notesRegistries': [registry],
    'activeNotesRegistry': registry,
    'lastNotesRegistry': registry,
}
db = sqlite3.connect(os.path.join(ud, 'User', 'globalStorage', 'state.vscdb'))
db.execute('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
db.execute('INSERT INTO ItemTable (key, value) VALUES (?, ?)', ('imaken.fractal', json.dumps(state)))
db.commit()
db.close()
