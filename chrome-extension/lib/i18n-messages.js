/** Fractal Web Clipper — i18n 辞書 (EN/JA)。
 *  sprint 20260727-065214 / ADRL-0001: デフォルト英語・popup/options で切替。
 *  キー命名: popup_* / options_* / bg_* / core_*。
 *  {name} 形式のプレースホルダは lib/i18n.js の t() が置換する。
 *  ★ en / ja のキー集合は完全一致に保つ (TC-CI-05 が番人)。
 */
(function(global) {
    'use strict';

    var EN = {
        // ── popup.html ──
        popup_no_note_registered: '⚠️ No Note registered',
        popup_open_settings: '⚙️ Open Settings',
        popup_preset_label: 'Preset',
        popup_dest_label: 'Destination (Outliner / Markdown)',
        popup_select_note_first: '(select a Note first)',
        popup_settings_link: '⚙️ Settings',
        // ── popup.js ──
        popup_permission_needed: '(Note permission required)',
        popup_write_permission_denied: '❌ Could not get write permission for {name}',
        popup_outline_read_failed: '❌ Failed to read outline.note: {message}',
        popup_no_out_md_found: '(no .out / .md found)',
        popup_loading_out: 'Loading .out…',
        popup_saving_page_md: 'Saving page MD…',
        popup_saving_images: 'Saving {count} images…',
        popup_writing_out: 'Writing .out…',
        popup_loading_target_md: 'Loading target md…',
        popup_saving_new_md: 'Saving new md…',
        popup_appending_subpage_link: 'Appending subpage link…',
        popup_processing: 'Processing…',
        popup_note_write_permission_denied: 'Could not get write permission for the Note',
        popup_converting_markdown: 'Converting page to Markdown…',
        popup_clip_done: '✅ Clip done: {title} → {dest}',
        popup_manual_select: '(manual select…)',
        // ── options.html ──
        options_note_hint: 'Register one or more Fractal Notes (directories containing .out files and outline.note). Names are shown using the Note title. Permissions persist, so you will not be asked every time.',
        options_no_notes: '(none — add with "Add Note…" above)',
        options_preset_heading: 'Destination Presets',
        options_preset_hint: 'Register frequently used destinations (Note + Outliner/Markdown) as presets. The preset marked ★ becomes the initial selection in the popup and the destination for quick clip (Alt+Shift+F).',
        options_select_note: '(select a Note)',
        options_preset_name_placeholder: 'Preset name (optional)',
        options_add_preset: '＋ Add',
        options_footer_hint: 'You can also pick the destination every time in the popup when you click the toolbar icon (preset or manual selection).',
        options_language_heading: 'Language',
        // ── options.js ──
        options_reauth_needed: '⚠️ Re-permission required',
        options_reauth_button: 'Re-authorize',
        options_permission_denied: '❌ Permission was not granted',
        options_confirm_unregister: 'Unregister "{name}"? (the folder itself is not deleted)',
        options_registered: '✅ Registered {name}',
        options_note_permission_needed: '(Note permission required)',
        options_read_failed: '(read failed)',
        options_no_presets: '(no presets)',
        options_default_radio_title: 'Set as default (popup initial selection + quick clip)',
        options_select_note_and_dest: '❌ Select a Note and a destination',
        options_preset_added: '✅ Added',
        // ── background.js ──
        bg_clip_in_progress: '📥 Clipping…\n{title}',
        bg_not_configured_title: 'Not configured',
        bg_not_configured_body: 'Register your Notes folder in Options',
        bg_no_folder_banner: '❌ No Notes folder registered\nClick the icon to pick one in the popup, or register in Options',
        bg_no_selection_title: 'No destination',
        bg_no_selection_body: 'Click the icon to open the popup and pick a destination (first time only)',
        bg_no_dest_banner: '❌ No destination\nClick the icon to pick one, or set a default preset in Options',
        bg_folder_not_found_title: 'Folder not found',
        bg_folder_not_found_body: 'Click the icon to reselect',
        bg_reauth_title: 'Re-permission required',
        bg_reauth_body: 'Click the icon to open the popup and grant permission',
        bg_reauth_banner: '❌ Folder permission expired\nClick the icon and re-authorize from the popup',
        bg_clip_done_title: '✅ Clip done ({sec}s)',
        bg_clip_done_banner: '✅ Clip done ({sec}s)\n→ {dest}\n{title}',
        bg_clip_failed_title: 'Clip failed',
        bg_clip_failed_banner: '❌ Clip failed\n{message}',
        // ── clipper-core (生成 MD ラベル。core は labels 引数で受ける — FR-CI-05) ──
        core_label_source: 'Source',
        core_label_author: 'Author',
        core_label_site: 'Site'
    };

    var JA = {
        popup_no_note_registered: '⚠️ Note が未登録です',
        popup_open_settings: '⚙️ 設定を開く',
        popup_preset_label: '保存先プリセット',
        popup_dest_label: '保存先 (Outliner / Markdown)',
        popup_select_note_first: '(まず Note を選択)',
        popup_settings_link: '⚙️ 設定',
        popup_permission_needed: '(Note の許可が必要)',
        popup_write_permission_denied: '❌ {name} の書き込み許可が得られませんでした',
        popup_outline_read_failed: '❌ outline.note 読み取り失敗: {message}',
        popup_no_out_md_found: '(.out / .md が見つかりません)',
        popup_loading_out: '.out 読み込み中…',
        popup_saving_page_md: 'page MD 保存中…',
        popup_saving_images: '画像 {count} 件を保存中…',
        popup_writing_out: '.out 書き込み中…',
        popup_loading_target_md: '対象 md 読み込み中…',
        popup_saving_new_md: '新規 md 保存中…',
        popup_appending_subpage_link: 'subpage リンク追記中…',
        popup_processing: '処理中…',
        popup_note_write_permission_denied: 'Note への書き込み許可が得られませんでした',
        popup_converting_markdown: 'ページを Markdown に変換中…',
        popup_clip_done: '✅ Clip 完了: {title} → {dest}',
        popup_manual_select: '(手動選択…)',
        options_note_hint: 'Fractal の Note（複数 .out + outline.note を持つディレクトリ）を複数登録できます。名前は Note のタイトルで表示されます。許可は永続化され毎回聞かれません。',
        options_no_notes: '(未登録 — 上の「Add Note…」で追加)',
        options_preset_heading: '保存先プリセット',
        options_preset_hint: 'よく使う保存先（Note + Outliner/Markdown）をプリセット登録できます。★ を付けたプリセットが popup の初期選択と quick clip (Alt+Shift+F) の保存先になります。',
        options_select_note: '(Note を選択)',
        options_preset_name_placeholder: 'プリセット名 (省略可)',
        options_add_preset: '＋ 追加',
        options_footer_hint: '保存先の選択は、ツールバー icon を click した時の popup でも毎回行えます（プリセット or 手動選択）。',
        options_language_heading: '言語',
        options_reauth_needed: '⚠️ 要再許可',
        options_reauth_button: '再許可',
        options_permission_denied: '❌ 許可されませんでした',
        options_confirm_unregister: '"{name}" を登録解除しますか? (フォルダ自体は削除されません)',
        options_registered: '✅ {name} を登録',
        options_note_permission_needed: '(Note の許可が必要)',
        options_read_failed: '(読み取り失敗)',
        options_no_presets: '(プリセット未登録)',
        options_default_radio_title: 'default に設定（popup 初期選択 + quick clip）',
        options_select_note_and_dest: '❌ Note と保存先を選択してください',
        options_preset_added: '✅ 追加しました',
        bg_clip_in_progress: '📥 Clip 処理中…\n{title}',
        bg_not_configured_title: '未設定',
        bg_not_configured_body: 'Options で Notes フォルダを登録してください',
        bg_no_folder_banner: '❌ Notes フォルダ未登録\nicon click で popup を開いて選択するか、Options で登録',
        bg_no_selection_title: '未選択',
        bg_no_selection_body: 'icon click で popup を開いて保存先を選んでください (初回のみ)',
        bg_no_dest_banner: '❌ 保存先なし\nicon click で保存先を選択するか、Options で default preset を設定',
        bg_folder_not_found_title: 'Folder not found',
        bg_folder_not_found_body: 'icon click で再選択してください',
        bg_reauth_title: '要再許可',
        bg_reauth_body: 'icon click で popup を開いて許可してください',
        bg_reauth_banner: '❌ folder 許可が失効\nicon click で popup から再許可してください',
        bg_clip_done_title: '✅ Clip 完了 ({sec}s)',
        bg_clip_done_banner: '✅ Clip 完了 ({sec}s)\n→ {dest}\n{title}',
        bg_clip_failed_title: 'Clip 失敗',
        bg_clip_failed_banner: '❌ Clip 失敗\n{message}',
        core_label_source: '元ページ',
        core_label_author: '著者',
        core_label_site: 'サイト'
    };

    global.FractalI18nMessages = { en: EN, ja: JA };

    // node（unit テスト）から require できるように
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = global.FractalI18nMessages;
    }
})(typeof self !== 'undefined' ? self : globalThis);
