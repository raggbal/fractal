"""
JS対応 Webクローラー → Markdown変換

BFS + 並列ワーカーでページをレンダリングし、リンクを再帰的に辿ってクロール。
各ページのメインコンテンツをMarkdownに変換して保存する。

使い方:
  python crawl.py "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/concepts.html"
  python crawl.py "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/concepts.html" --limit 20
  python crawl.py "https://example.com" --scope "https://example.com/docs/*"
  python crawl.py "https://example.com" --resume
"""

import argparse
import asyncio
import base64
import json
import re
import sys
import time
from fnmatch import fnmatch
from pathlib import Path
from urllib.parse import urlparse, urldefrag, urlencode, parse_qs, unquote

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

# ブラウザ注入用JSライブラリ
# v0.207.50: turndown + GFM plugin + Fractal 独自 rule は html-md-converter.js に統合
# (https://github.com/raggbal/html-md-converter)
HTML_MD_CONVERTER_JS = (Path(__file__).parent / "html-md-converter.js").read_text(encoding="utf-8")
READABILITY_JS = (Path(__file__).parent / "readability.js").read_text(encoding="utf-8")


# ─── data:image URL → 実体ファイル化 ───

# Fractal の data-url-image-extractor.ts と同じ MIME → ext マッピング
_MIME_TO_EXT = {
    "png": "png", "jpeg": "jpg", "gif": "gif", "webp": "webp",
    "avif": "avif", "apng": "apng", "svg+xml": "svg", "svg": "svg",
}

# MD `![](...)` / HTML `src="..."` 内の data:image/... を捕捉
# Body は MD/HTML delimiter (`)` `"` 空白 `<` `>`) で停止。`'` は URL-encoded SVG 内で
# literal で登場するため含める（HTML src='...' のレアケースでは末尾が乱れる）
_DATA_URL_RE = re.compile(
    r'data:image/[a-zA-Z0-9+\-.]+(?:;[a-zA-Z0-9\-]+(?:=[^;,]*)?)*?(?:;base64)?,[^)"\s<>]+'
)
_BASE64_RE = re.compile(
    r'^data:image/([a-zA-Z0-9+\-.]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$'
)
_SVG_TEXT_RE = re.compile(
    r'^data:image/svg\+xml(?:;[^,]*)?,(.+)$'
)


def _mime_to_ext(mime: str) -> str:
    lower = (mime or "").lower()
    return _MIME_TO_EXT.get(lower, re.sub(r"[^a-z0-9]", "", lower) or "png")


def _parse_data_url(data_url: str):
    """data:image/... を decode して (ext, bytes) を返す。不正なら None。"""
    if not data_url.startswith("data:image/"):
        return None
    m = _BASE64_RE.match(data_url)
    if m:
        try:
            return (_mime_to_ext(m.group(1)), base64.b64decode(m.group(2)))
        except Exception:
            return None
    m = _SVG_TEXT_RE.match(data_url)
    if m:
        body = m.group(1)
        try:
            body = unquote(body)
        except Exception:
            pass
        return ("svg", body.encode("utf-8"))
    return None


def _next_unique_image_name(image_dir: Path, ext: str) -> str:
    """Fractal の generateUniqueFileName と同じ命名: <ts>.<ext>、衝突時 <ts>-<NNNN>.<ext>"""
    ts = int(time.time() * 1000)
    base = f"{ts}.{ext}"
    if not (image_dir / base).exists():
        return base
    counter = 1
    while True:
        name = f"{ts}-{counter:04d}.{ext}"
        if not (image_dir / name).exists():
            return name
        counter += 1


def extract_data_url_images(md: str, md_file_dir: Path, image_dir: Path) -> str:
    """MD 内の data:image/... を実体化し相対 path に書き換えた MD を返す。"""
    if "data:image/" not in md:
        return md
    image_dir.mkdir(parents=True, exist_ok=True)
    seen: dict[str, str] = {}

    def repl(m: re.Match) -> str:
        data_url = m.group(0)
        if data_url in seen:
            return seen[data_url]
        parsed = _parse_data_url(data_url)
        if not parsed:
            return data_url
        ext, buf = parsed
        name = _next_unique_image_name(image_dir, ext)
        (image_dir / name).write_bytes(buf)
        # md_file_dir からの相対 path
        try:
            rel = (image_dir / name).relative_to(md_file_dir)
            rel_str = str(rel).replace("\\", "/")
        except ValueError:
            # 相対不能なら絶対 path にフォールバック
            rel_str = str(image_dir / name)
        seen[data_url] = rel_str
        return rel_str

    return _DATA_URL_RE.sub(repl, md)


# ─── ユーティリティ ───

def log(msg: str):
    print(msg, flush=True)


def normalize_url(url: str) -> str:
    """URL正規化: フラグメント除去、クエリパラメータ除去、トレイリングスラッシュ統一。"""
    url, _ = urldefrag(url)
    parsed = urlparse(url)
    # クエリパラメータ除去（ページネーション等）
    normalized = parsed._replace(query="", fragment="").geturl()
    # トレイリングスラッシュ統一（パスが / で終わらない場合、.html等でなければ / を付与）
    if normalized.endswith("/") or re.search(r"\.\w+$", parsed.path):
        return normalized
    return normalized + "/"


def url_to_filename(url: str, base_path: str) -> str:
    parsed = urlparse(url)
    path = parsed.path
    if base_path and base_path in path:
        path = path[path.index(base_path) + len(base_path):]
    path = path.strip("/")
    if not path:
        path = "index"
    name = re.sub(r"\.html?$", "", path)
    name = name.replace("/", "_")
    name = re.sub(r"[^\w\-.]", "_", name)
    return f"{name}.md"


def is_in_scope(url: str, scope_patterns: list[str]) -> bool:
    for pattern in scope_patterns:
        if fnmatch(url, pattern):
            return True
    return False


async def safe_goto(page, url: str, timeout: int = 30000, idle_timeout: int = 8000):
    """ページ遷移: networkidleを短いタイムアウトで試み、超過時はDOMContentLoadedで続行。
    SPAはnetworkidleで正しく描画を待ち、広告の多いサイトはタイムアウト後に進む。"""
    try:
        response = await page.goto(url, wait_until="networkidle", timeout=idle_timeout)
    except PlaywrightTimeout:
        # networkidleがタイムアウト → ページ自体は読み込み中。DOMContentLoadedまで待つ。
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=timeout - idle_timeout)
        except PlaywrightTimeout:
            pass
        response = page  # goto のレスポンスは取れないが、ページ自体は使える
    return response


def infer_scope(start_url: str) -> list[str]:
    parsed = urlparse(start_url)
    path_dir = parsed.path.rsplit("/", 1)[0] if "/" in parsed.path else parsed.path
    base = f"{parsed.scheme}://{parsed.netloc}{path_dir}"
    return [base + "/*"]


async def convert_page_to_markdown(page) -> str:
    """メインコンテンツを抽出し、Turndownでmarkdownに変換する。
    Readabilityと視覚面積ベースを両方実行し、食い違いがあれば両方出力する。"""
    return await page.evaluate("""() => {
        const cleanupSel = 'script, style, nav, footer, header, .code-btn-container, ' +
            '[class*="cookie"], [class*="consent"], [class*="banner"], [id*="cookie"]';

        // ★ SVG の computed style を live DOM で inline 化してから以降の処理に進む。
        //   これをやらないと、Readability や cleanupSel で <style> が剥がされた後に
        //   class 依存の SVG (Mermaid 等) が真っ黒 / 無着色になる。
        try {
            if (typeof HtmlMdConverter !== 'undefined' && HtmlMdConverter.inlineSvgComputedStyles) {
                HtmlMdConverter.inlineSvgComputedStyles(document);
            }
        } catch(e) {}

        // ★ heading を wrap している <a> / heading-only wrapper <div> を unwrap。
        //   視覚面積ベース (aRoot) 経路では Readability は通らないが、AWS Workshop Studio
        //   の SectionHeading-module_headingLinkContainer のように「h2 が <a> で包まれた
        //   上に更に heading-only div で包まれている」構造だと Turndown の rule 7
        //   (normalizeLink) の判定をすり抜けて heading が壊れる場合があるので live DOM
        //   段階で unwrap する。articleToMarkdown 経路 (rRoot) は html-md-converter
        //   内部でも呼ばれるが、ここで呼んでおけば aRoot にも効く。
        try {
            if (typeof HtmlMdConverter !== 'undefined' && HtmlMdConverter.unwrapHeadingAnchors) {
                HtmlMdConverter.unwrapHeadingAnchors(document);
            }
        } catch(e) {}

        // Turndown インスタンス生成 (with Fractal-derived custom rules)

        // Normalize table rows with embedded newlines
        function normalizeMultiLineTableCells(text) {
            text = text.replace(/\\|\\s*<br>\\s*(?=\\|)/gi, '|\\n');
            var lines = text.split('\\n');
            var result = [];
            var separatorSeen = false;
            var inTable = false;
            for (var i = 0; i < lines.length; i++) {
                var trimmed = lines[i].trim();
                var isTableRow = trimmed.charAt(0) === '|' && trimmed.charAt(trimmed.length - 1) === '|' && trimmed.length > 2;
                if (isTableRow) {
                    var isSep = false;
                    var inner = trimmed.slice(1, -1);
                    var cells = inner.split('|');
                    if (cells.length > 0) {
                        isSep = true;
                        for (var c = 0; c < cells.length; c++) {
                            if (!/^\\s*:?-+:?\\s*$/.test(cells[c])) { isSep = false; break; }
                        }
                    }
                    if (isSep) {
                        if (separatorSeen && inTable) continue;
                        separatorSeen = true;
                    }
                    inTable = true;
                } else {
                    inTable = false;
                    separatorSeen = false;
                }
                result.push(lines[i]);
            }
            lines = result;
            result = [];
            var i2 = 0;
            while (i2 < lines.length) {
                var trimmed2 = lines[i2].trimEnd ? lines[i2].trimEnd() : lines[i2].replace(/\\s+$/, '');
                if (trimmed2.length > 1 && trimmed2.charAt(0) === '|' && trimmed2.charAt(trimmed2.length - 1) !== '|') {
                    var combined = trimmed2;
                    var j = i2 + 1;
                    var found = false;
                    while (j < lines.length && (j - i2) <= 50) {
                        var nextTrimmed = lines[j].trimEnd ? lines[j].trimEnd() : lines[j].replace(/\\s+$/, '');
                        if (nextTrimmed === '') { combined += '<br>'; j++; continue; }
                        combined += '<br>' + nextTrimmed;
                        j++;
                        if (nextTrimmed.charAt(nextTrimmed.length - 1) === '|') { found = true; break; }
                    }
                    if (found) {
                        combined = combined.replace(/(<br>)+/g, '<br>');
                        result.push(combined);
                        i2 = j;
                    } else {
                        result.push(lines[i2]);
                        i2++;
                    }
                } else {
                    result.push(lines[i2]);
                    i2++;
                }
            }
            return result.join('\\n');
        }

        // HTML要素 → クリーンアップ済みMarkdown (v0.207.50: html-md-converter で turndown 系を統合)
        function toMd(root) {
            const container = document.createElement('div');
            container.innerHTML = root.innerHTML;
            container.querySelectorAll(cleanupSel).forEach(el => el.remove());
            // unescape + tight-list post-process は html-md-converter 内で完了済
            let md = HtmlMdConverter.htmlToMarkdown(container.innerHTML);
            // 行をまたぐ table cell 整形 (html-md-converter には未統合の safety net)
            md = normalizeMultiLineTableCells(md);
            return md;
        }

        // テキストのみ抽出（比較用）
        function textOf(root) {
            const c = root.cloneNode(true);
            c.querySelectorAll(cleanupSel).forEach(e => e.remove());
            return (c.textContent || '').replace(/\\s+/g, ' ').trim();
        }

        // --- 候補1: Readability ---
        let rRoot = null;
        try {
            const clone = document.cloneNode(true);
            const article = new Readability(clone).parse();
            if (article && article.content && article.content.length > 500) {
                const tmp = document.createElement('div');
                tmp.innerHTML = article.content;
                rRoot = tmp;
            }
        } catch(e) {}

        // --- 候補2: 視覚面積ベース ---
        let aRoot = null;
        {
            const skip = new Set(['HTML','BODY','SCRIPT','STYLE','NOSCRIPT','SVG','IFRAME']);
            const navTags = new Set(['NAV','FOOTER','HEADER']);
            const navPat = /cookie|consent|banner|overlay|modal|popup/i;
            let best = null;
            let bestArea = 0;
            function scan(el, depth) {
                if (depth > 4) return;
                for (const child of el.children) {
                    if (skip.has(child.tagName)) continue;
                    if (navTags.has(child.tagName)) continue;
                    const cn = (child.className || '') + ' ' + (child.id || '');
                    if (navPat.test(cn)) continue;
                    const rect = child.getBoundingClientRect();
                    const area = rect.width * rect.height;
                    if (area > bestArea && rect.width > 200 && rect.height > 200) {
                        bestArea = area;
                        best = child;
                    }
                    scan(child, depth + 1);
                }
            }
            scan(document.body, 0);
            if (best) aRoot = best;
        }

        // --- 片方だけの場合 ---
        if (rRoot && !aRoot) return toMd(rRoot);
        if (!rRoot && aRoot) return toMd(aRoot);
        if (!rRoot && !aRoot) {
            // bodyフォールバック
            if (!document.body) return '';
            return toMd(document.body);
        }

        // --- 両方ある場合 ---
        // 視覚面積ベース (aRoot) を優先する。Readability (rRoot) は見出し階層
        // (<h2> など) を剥がすことがあり、同じ内容でも構造情報が失われるため。
        // aRoot は live DOM から直接取られるので heading / code / svg がそのまま残る。
        // ただし aRoot のテキストが著しく短く、rRoot にしかない内容が大半なら
        // rRoot を使う (面積ベース抽出が失敗して side-nav を拾ったケース等の保険)。
        const rText = textOf(rRoot);
        const aText = textOf(aRoot);
        if (aText.length < rText.length * 0.5) {
            // 面積ベースが短すぎる → Readability を優先
            return toMd(rRoot);
        }
        return toMd(aRoot);
    }""")


async def convert_listing_to_markdown(page) -> str:
    """ページネーション後のカード/記事リスト部分だけをMarkdownに変換する。
    全ページを再変換するのではなく、リスト項目（article, card等）のみ抽出。"""
    return await page.evaluate("""() => {
        // カード/記事要素を探す
        const selectors = [
            'article',
            '[class*="card"]',
            '[class*="result"]',
            '[class*="item"]',
        ];
        let items = [];
        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            if (els.length >= 2) {
                items = Array.from(els);
                break;
            }
        }
        if (items.length === 0) return '';

        // v0.207.50: カード要素 HTML を集めて html-md-converter で 1 ファイル変換
        const container = document.createElement('div');
        for (const item of items) {
            const clone = item.cloneNode(true);
            clone.querySelectorAll('script, style, svg, img').forEach(el => el.remove());
            container.appendChild(clone);
            container.appendChild(document.createElement('br'));
        }
        return HtmlMdConverter.htmlToMarkdown(container.innerHTML);
    }""")


async def extract_toc(page) -> list | None:
    """ページのサイドバー/ナビゲーションからTOCツリー構造を抽出する。"""
    return await page.evaluate("""() => {
        // ナビゲーション候補を幅広く探す（nav, aside, sidebar系クラス/ID）
        const candidates = document.querySelectorAll(
            'nav, aside, [role="navigation"], ' +
            '[class*="sidebar"], [class*="toc"], [class*="menu"], ' +
            '[id*="sidebar"], [id*="toc"], [id*="menu"], ' +
            '.sphinxsidebarwrapper, .md-sidebar, .book-menu'
        );
        // リンク数が最多の候補を選択
        let best = null;
        let maxLinks = 5;
        candidates.forEach(el => {
            const count = el.querySelectorAll('a[href]').length;
            if (count > maxLinks) { maxLinks = count; best = el; }
        });
        if (!best) return null;

        // 再帰パーサー: <li> 内の <a> とネスト <ul> を探す
        // JSフレームワーク対応: li > div > a, li > div > div > ul 等のラッパーも探索
        function parseList(ul) {
            const items = [];
            for (const li of ul.children) {
                if (li.tagName !== 'LI') continue;
                const a = li.querySelector(':scope > a[href]')
                    || li.querySelector(':scope > div a[href]')
                    || li.querySelector(':scope > span a[href]');
                if (!a) continue;
                // フラグメントのみリンク（ページ内目次）はURLを空にする
                const linkUrl = a.href;
                const currentBase = location.href.split('#')[0].split('?')[0];
                const linkBase = linkUrl.split('#')[0].split('?')[0];
                const isFragmentOnly = linkBase === currentBase && linkUrl.includes('#');
                const node = { title: a.textContent.trim(), url: isFragmentOnly ? '' : linkUrl };
                // 子リストを探す（直下 or ラッパー div 内 or role="group" 内）
                const subUl = li.querySelector(':scope > ul, :scope > ol')
                    || li.querySelector(':scope > div > ul, :scope > div > ol')
                    || li.querySelector(':scope > div > div > ul')
                    || li.querySelector('[role="group"] > ul');
                if (subUl) {
                    node.children = parseList(subUl);
                }
                items.push(node);
            }
            return items;
        }

        const topUl = best.querySelector('ul');
        if (!topUl) return null;
        const result = parseList(topUl);
        return result.length > 3 ? result : null;
    }""")


async def extract_links(page, scope_patterns: list[str], paginate_filepath: Path | None = None) -> set[str]:
    current_url = page.url
    current_base = urlparse(current_url)._replace(query="", fragment="").geturl()
    raw_links = await page.eval_on_selector_all(
        "a[href]",
        "elements => elements.map(e => e.href)"
    )
    links = set()
    for href in raw_links:
        url, _ = urldefrag(href)
        if not url or not url.startswith("http"):
            continue
        # クエリパラメータ違いの同一ページ（ページネーション等）を除外
        url_base = urlparse(url)._replace(query="", fragment="").geturl()
        if url_base == current_base:
            continue
        if is_in_scope(url, scope_patterns):
            links.add(url)

    # ページネーション: 「次へ」をクリックして各ページのリンクも収集
    await _collect_pagination_links(page, scope_patterns, links, current_base, filepath=paginate_filepath)

    return links


async def _collect_pagination_links(
    page, scope_patterns: list[str], links: set[str], current_base: str,
    filepath: Path | None = None,
) -> None:
    """ページネーションの「次へ」ボタンを繰り返しクリックし、各ページの<a href>を収集する。
    filepath が指定されている場合、各ページのコンテンツもMarkdownに変換して追記する。"""
    try:
        has_pagination = await page.evaluate("""() => {
            return !!document.querySelector(
                '[class*="pagination"], [class*="pager"], [aria-label*="pagination"], [aria-label*="page"]'
            );
        }""")
        if not has_pagination:
            return

        max_clicks = 20
        seen_states = {page.url}  # 訪問済み状態（URLまたはDOMハッシュ）
        # URL変化なしのJSページネーション用: カード部分のテキストハッシュも記録
        prev_content_hash = await page.evaluate("""() => {
            const items = document.querySelectorAll('article, [class*="card"]');
            return Array.from(items).map(e => e.textContent.trim()).join('|||');
        }""")
        seen_states.add(prev_content_hash)
        for _ in range(max_clicks):
            clicked = await page.evaluate("""() => {
                const container = document.querySelector(
                    '[class*="pagination"], [class*="pager"], [aria-label*="pagination"], [aria-label*="page"]'
                );
                if (!container) return false;
                const candidates = container.querySelectorAll('a, button, [role="button"]');
                for (const el of candidates) {
                    const text = el.textContent.trim().toLowerCase();
                    const label = (el.getAttribute('aria-label') || '').toLowerCase();
                    const testId = (el.getAttribute('data-testid') || '').toLowerCase();
                    if (text === '次へ' || text === 'next' || text === '›' || text === '»'
                        || label.includes('next') || testId.includes('next')) {
                        if (el.getAttribute('disabled') !== null
                            || el.getAttribute('aria-disabled') === 'true'
                            || el.classList.contains('disabled')) {
                            return false;
                        }
                        el.click();
                        return true;
                    }
                }
                return false;
            }""")
            if not clicked:
                break

            # コンテンツ更新を待つ（DOM変化 or タイムアウト）
            try:
                await page.wait_for_timeout(1500)
            except Exception:
                break

            # 同じページを再訪問していたら最終ページ
            # URLが既出 OR コンテンツが既出/空 → 停止
            after_url = page.url
            content_hash = await page.evaluate("""() => {
                const items = document.querySelectorAll('article, [class*="card"]');
                return Array.from(items).map(e => e.textContent.trim()).join('|||');
            }""")
            if after_url in seen_states or content_hash in seen_states or content_hash == "":
                break
            seen_states.add(after_url)
            seen_states.add(content_hash)

            # ページネーションコンテンツ追記（オプション）
            # カード/記事要素だけを抽出（ページ全体ではなくリスト部分のみ）
            if filepath:
                md = await convert_listing_to_markdown(page)
                if md:
                    md = extract_data_url_images(md, filepath.parent, filepath.parent / "images")
                    with open(filepath, "a", encoding="utf-8") as f:
                        f.write(f"\n\n---\n\n{md}\n")

            # 次ページの <a href> リンクを収集（ページネーション自身のURLは除外）
            raw_links = await page.eval_on_selector_all(
                "a[href]", "elements => elements.map(e => e.href)"
            )
            for href in raw_links:
                url, _ = urldefrag(href)
                if not url or not url.startswith("http"):
                    continue
                url_base = urlparse(url)._replace(query="", fragment="").geturl()
                if url_base == current_base:
                    continue
                if is_in_scope(url, scope_patterns):
                    links.add(url)

    except Exception:
        pass


# ─── 1ページの処理 ───

async def process_page(
    url: str,
    context,
    scope_patterns: list[str],
    base_path: str,
    output_dir: Path,
    already_saved: set[str],
    paginate_append: bool = False,
) -> tuple[list[str], bool, str]:
    """
    1ページを処理する。
    Returns: (新規発見URL一覧, 保存したか, ページタイトル)
    """
    new_urls: list[str] = []
    saved = False
    title = ""

    page = await context.new_page()
    try:
        response = await safe_goto(page, url)
        if hasattr(response, 'status') and response.status >= 400:
            return new_urls, False, title

        # タイトル取得（常に実行 — map.json用）
        # SPA だと document.title が更新されない場合があるため、最初の <h1>
        # テキストがあればそちらを優先する
        title = await page.evaluate("""() => {
            const h1 = document.querySelector('main h1, article h1, [role="main"] h1, h1');
            const h1Text = h1 ? (h1.textContent || '').trim() : '';
            const docTitle = (document.title || '').trim();
            return h1Text || docTitle;
        }""") or ""

        filename = url_to_filename(url, base_path)
        filepath = output_dir / filename

        # 1. リンク抽出を先に行う。convert_page_to_markdown 内の
        #    HtmlMdConverter.unwrapHeadingAnchors(document) が live DOM から
        #    heading 内の <a> を剥がす副作用があり、後にすると左 nav の TOC リンクも
        #    巻き添えで消えて新規 URL が 0 件になる (Workshop Studio 等で再現)。
        #    paginate_append は pagination の next クリックでコンテンツを上書きするので
        #    こちらも先に実行して filepath に追記してしまい、MD 保存側で prepend する。
        pag_path = filepath if (paginate_append and filename not in already_saved) else None
        links = await extract_links(page, scope_patterns, paginate_filepath=pag_path)
        new_urls = list(links)

        # 2. Markdown保存
        if filename not in already_saved:
            # Readability + Turndown をページに注入
            await page.evaluate(READABILITY_JS)
            await page.evaluate(HTML_MD_CONVERTER_JS)
            markdown = await convert_page_to_markdown(page)
            if markdown:
                # data:image/... を実体ファイル化 (<output_dir>/images/<ts>.<ext>)
                markdown = extract_data_url_images(markdown, output_dir, output_dir / "images")
                header = f"# {title}\n\n[{url}]({url})\n\n" if title else f"[{url}]({url})\n\n"
                if pag_path is not None and filepath.exists():
                    # paginate_append が先に末尾追記したファイルが存在する → 先頭に prepend
                    existing = filepath.read_text(encoding="utf-8")
                    filepath.write_text(header + markdown.rstrip() + "\n\n" + existing, encoding="utf-8")
                else:
                    filepath.write_text(header + markdown.rstrip() + "\n", encoding="utf-8")
                saved = True

    except Exception as e:
        log(f"  ERROR: {url} -> {e}")
    finally:
        await page.close()

    return new_urls, saved, title


# ─── BFS クローラー本体 ───

async def crawl(
    start_url: str,
    output_dir: Path,
    scope_patterns: list[str],
    limit: int = 0,
    concurrency: int = 10,
    resume: bool = False,
    paginate_append: bool = False,
):
    parsed = urlparse(start_url)
    base_path = parsed.path.rsplit("/", 1)[0] + "/" if "/" in parsed.path else "/"

    # 状態管理（URLは正規化して重複排除）
    visited: set[str] = set()
    pending: list[str] = [start_url]
    visited.add(normalize_url(start_url))
    saved_count = 0
    skipped_count = 0
    processed_count = 0
    failed_count = 0
    start_time = time.time()

    # map.json 用: タイトルを記録
    titles: dict[str, str] = {}

    # レジューム: 既存ファイル
    already_saved: set[str] = set()
    if resume:
        already_saved = {f.name for f in output_dir.glob("*.md")}
        if already_saved:
            log(f"Resume: {len(already_saved)} existing files (scrape skipped, links still extracted)")

    log(f"URL:         {start_url}")
    log(f"Scope:       {scope_patterns}")
    log(f"Limit:       {limit if limit > 0 else 'unlimited'}")
    log(f"Concurrency: {concurrency}")
    log(f"Output:      {output_dir}/")
    log("")

    semaphore = asyncio.Semaphore(concurrency)
    toc_tree: list | None = None  # サイドバーTOC（最初のページから抽出）

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 720},
        )

        # 最初のページからTOC構造を抽出
        try:
            first_page = await context.new_page()
            await safe_goto(first_page, start_url)
            toc_tree = await extract_toc(first_page)
            await first_page.close()
            if toc_tree:
                log(f"TOC:         {len(toc_tree)} top-level entries detected")
            else:
                log("TOC:         not found (using URL path structure)")
            log("")
        except Exception:
            await first_page.close()

        while pending:
            # limit チェック
            if limit > 0 and processed_count >= limit:
                break

            # バッチサイズ = 残りlimitか concurrency の小さい方
            remaining = limit - processed_count if limit > 0 else len(pending)
            batch_size = min(concurrency, remaining, len(pending))
            batch = pending[:batch_size]
            pending = pending[batch_size:]

            # 並列実行
            async def run_one(url: str):
                async with semaphore:
                    return url, await process_page(
                        url, context, scope_patterns,
                        base_path, output_dir, already_saved,
                        paginate_append=paginate_append,
                    )

            results = await asyncio.gather(*[run_one(u) for u in batch])

            # 結果を処理
            for url, (new_links, saved, title) in results:
                processed_count += 1
                if title:
                    titles[normalize_url(url)] = title

                if saved:
                    saved_count += 1
                    filename = url_to_filename(url, base_path)
                    elapsed = time.time() - start_time
                    rate = saved_count / elapsed if elapsed > 0 else 0
                    log(f"  [{saved_count:>4}] {filename:<55} ({rate:.1f}/s, queue: {len(pending)})")
                elif url_to_filename(url, base_path) in already_saved:
                    skipped_count += 1

                # 新規URLをpendingに追加（正規化URLで重複排除）
                for link in new_links:
                    norm = normalize_url(link)
                    if norm not in visited:
                        visited.add(norm)
                        pending.append(link)

        await browser.close()

    elapsed = time.time() - start_time
    rate = saved_count / elapsed if elapsed > 0 else 0
    total_files = len(list(output_dir.glob("*.md")))
    log(f"\nDone! {saved_count} saved, {skipped_count} skipped, {failed_count} failed")
    log(f"Time: {elapsed:.0f}s ({rate:.1f} pages/s)")
    log(f"Discovered: {len(visited)} URLs in scope")
    log(f"Total files: {total_files} in {output_dir}/")

    # ─── map.json 生成 ───
    # URL → ファイル名のマッピング（ファイル名ベースで重複排除）
    url_file: dict[str, str] = {}
    seen_files: set[str] = set()
    for u in visited:
        fname = url_to_filename(u, base_path)
        if fname not in seen_files:
            seen_files.add(fname)
            url_file[u] = fname

    if toc_tree:
        # TOCベース: サイドバーのネスト構造をそのまま使う
        # 正規化済み URL をキーにしたルックアップを作る（TOC 側の href は
        # トレイリングスラッシュの有無が不定なため、正規化して突き合わせる）
        norm_to_file: dict[str, str] = {
            normalize_url(u): f for u, f in url_file.items()
        }

        def build_from_toc(nodes: list) -> list:
            result = []
            for node in nodes:
                entry: dict = {"title": node.get("title", "")}
                toc_url = node.get("url", "")
                if toc_url:
                    norm_toc = normalize_url(toc_url)
                    if norm_toc in norm_to_file:
                        entry["file"] = norm_to_file.pop(norm_toc)
                        # ページタイトル（H1 等）があれば TOC タイトルより優先
                        if norm_toc in titles:
                            entry["title"] = titles[norm_toc]
                kids = node.get("children", [])
                if kids:
                    entry["children"] = build_from_toc(kids)
                # fileもchildrenもないエントリはスキップ（ページ内アンカーのみ）
                if "file" not in entry and "children" not in entry:
                    continue
                result.append(entry)
            return result

        tree_children = build_from_toc(toc_tree)

        # TOCに含まれなかったページを末尾に追加
        others = []
        for norm_u, f in sorted(norm_to_file.items()):
            others.append({"title": titles.get(norm_u, ""), "file": f})
        if others:
            tree_children.append({"title": "(Other)", "children": others})

        tree = {
            "title": titles.get(normalize_url(start_url), ""),
            "file": url_to_filename(start_url, base_path),
            "children": tree_children,
        }
    else:
        # フォールバック: URLパス構造からツリーを構築
        path_root: dict = {"title": "", "children": []}
        for url in sorted(visited):
            p = urlparse(url)
            rel = p.path
            if base_path and base_path in rel:
                rel = rel[rel.index(base_path) + len(base_path):]
            rel = rel.strip("/")
            if not rel:
                rel = "index"
            rel = re.sub(r"\.html?$", "", rel)
            segments = rel.split("/")

            current = path_root
            for i, seg in enumerate(segments):
                if i == len(segments) - 1:
                    current.setdefault("children", []).append({
                        "title": titles.get(normalize_url(url), ""),
                        "file": url_to_filename(url, base_path),
                    })
                else:
                    found = None
                    for child in current.get("children", []):
                        if child.get("_dir") == seg:
                            found = child
                            break
                    if not found:
                        found = {"title": seg, "_dir": seg, "children": []}
                        current.setdefault("children", []).append(found)
                    current = found

        def clean(node: dict):
            node.pop("_dir", None)
            for child in node.get("children", []):
                clean(child)
        clean(path_root)
        tree = path_root["children"][0] if len(path_root.get("children", [])) == 1 else path_root

    map_path = output_dir / "map.json"
    map_path.write_text(json.dumps(tree, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"Map:         {map_path}")


def probe_llms_txt(url: str, timeout: float = 5.0) -> str | None:
    """Walk up the URL path probing for llms.txt. Returns the discovered llms.txt
    URL if found, else None.

    Search order: deepest directory first, walking up to site root.
    """
    import httpx
    parsed = urlparse(url)
    if not parsed.scheme.startswith("http"):
        return None

    # Build the directory path components (strip the trailing filename if any).
    parts = parsed.path.split("/")
    if parts and (parts[-1] == "" or "." in parts[-1]):
        parts = parts[:-1]
    # Normalize: parts looks like ['', 'a', 'b', 'c'] for /a/b/c/
    candidates: list[str] = []
    base = f"{parsed.scheme}://{parsed.netloc}"
    for i in range(len(parts), 0, -1):
        candidates.append(base + "/".join(parts[:i]) + "/llms.txt")
    candidates.append(base + "/llms.txt")
    # Deduplicate while preserving order
    seen: set[str] = set()
    candidates = [c for c in candidates if not (c in seen or seen.add(c))]

    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            for cand in candidates:
                try:
                    r = client.head(cand)
                    if r.status_code == 405:
                        # Some servers don't support HEAD — try GET with empty range
                        r = client.get(cand, headers={"Range": "bytes=0-0"})
                    if r.status_code in (200, 206):
                        ct = (r.headers.get("content-type") or "").lower()
                        if "text/plain" in ct or "text/markdown" in ct:
                            return cand
                except Exception:
                    continue
    except Exception:
        return None
    return None


def main():
    parser = argparse.ArgumentParser(description="JS-aware web crawler → Markdown")
    parser.add_argument("url", help="Start URL to crawl from")
    parser.add_argument("--output", "-o", default="output", help="Output directory")
    parser.add_argument("--limit", "-l", type=int, default=0, help="Max pages (0=unlimited)")
    parser.add_argument("--scope", "-s", nargs="*", help="URL scope patterns (glob)")
    parser.add_argument("--concurrency", "-c", type=int, default=10, help="Concurrent pages (default: 10)")
    parser.add_argument("--resume", "-r", action="store_true", help="Skip already-saved files")
    parser.add_argument("--paginate-append", "-p", action="store_true", help="Append paginated content to the same file")
    parser.add_argument("--no-llms-txt", action="store_true",
                        help="Disable llms.txt auto-detection (force BFS crawl)")
    args = parser.parse_args()

    # ── llms.txt auto-route ──────────────────────────────────────────────
    # 1. URL itself looks like an llms.txt file → delegate immediately.
    # 2. Otherwise probe nearby directories for llms.txt; if found, delegate.
    # 3. --no-llms-txt forces the BFS path.
    if not args.no_llms_txt:
        llms_url = None
        if re.search(r"/llms(-full)?\.txt$", urlparse(args.url).path):
            llms_url = args.url
        else:
            log(f"Probing llms.txt for {args.url} ...")
            llms_url = probe_llms_txt(args.url)
        if llms_url:
            log(f"Detected llms.txt at {llms_url}")
            log(f"Delegating to llms_collect.py (use --no-llms-txt to force BFS instead)")
            import os
            script = Path(__file__).parent / "llms_collect.py"
            argv = [sys.executable, str(script), llms_url,
                    "-o", args.output, "-c", str(args.concurrency)]
            os.execv(sys.executable, argv)
            # os.execv replaces the process; the next line is unreachable.
            return
        log("No llms.txt found, falling back to BFS crawl")

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    scope_patterns = args.scope if args.scope else infer_scope(args.url)

    asyncio.run(crawl(
        start_url=args.url,
        output_dir=output_dir,
        scope_patterns=scope_patterns,
        limit=args.limit,
        concurrency=args.concurrency,
        resume=args.resume,
        paginate_append=args.paginate_append,
    ))


if __name__ == "__main__":
    main()
