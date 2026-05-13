"""
llms_collect.py — llms.txt モード収集

llms.txt をパースして階層構造を保持したまま MD ファイル群と map.json を生成する。
crawl.py (BFS + Playwright) とは独立。Markdown を直接 HTTP fetch するだけなので軽量。

使い方:
  python llms_collect.py "https://docs.aws.amazon.com/<svc>/<ver>/<guide>/llms.txt" -o <output>
  python llms_collect.py "./local-llms.txt" --base-url "https://docs.example.com/" -o <output>

設計:
  1. llms.txt をダウンロード（or ローカル file 読込）
  2. ヘッダ深さスタック + リスト項目で階層ツリーを構築
     - `# H1` → root（`> blockquote` は description）
     - `## / ### …` → 階層ノード（heading 深さ = ツリー深さ）
     - ヘッダ自体のリンク `## [Name](url)` も page として保持
     - `- [name](url): desc` → 子ページノード（ネストインデント対応）
  3. 全 URL を httpx async で並列 fetch
     - Content-Type `text/markdown` or `text/plain` → そのまま保存
     - その他（HTML / 404 等）→ Phase 2 にまわす
  4. Phase 2: Playwright + turndown で HTML fallback（lazy import）
  5. map.json を書き出す（crawl.py と同スキーマ: {title, file?, children?}）

出力:
  <output>/<slug>.md  (各ページ、frontmatter 付き)
  <output>/map.json   (階層ツリー)
"""

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, urljoin

import httpx


# ─── parser ────────────────────────────────────────────────────────────

HEADING_RE = re.compile(r'^(#{1,6})\s+(.+?)\s*$')
HEADING_LINK_RE = re.compile(r'^\[(.+?)\]\(([^)\s]+)\)\s*$')
LIST_LINK_RE = re.compile(
    r'^(?P<indent>[ \t]*)[-*+]\s+\[(?P<title>.+?)\]\((?P<url>[^)\s]+)\)'
    r'(?:\s*:\s*(?P<desc>.+))?\s*$'
)
BLOCKQUOTE_RE = re.compile(r'^>\s?(.*)$')


def log(msg: str):
    print(msg, flush=True)


def parse_llms_txt(text: str, base_url: str) -> dict:
    """Parse llms.txt text into an internal tree.

    Internal node shape:
      {"title": str, "url": str|None, "description": str|None, "children": [...]}
    """
    root = {"title": "", "description": "", "url": None, "children": []}
    # Stack of (heading_level, node). Index 0 = root (level=0).
    heading_stack = [(0, root)]
    # Stack of (indent_width, node) tracking nested list items in current section.
    list_stack: list[tuple[int, dict]] = []
    current_section = root

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if not line:
            list_stack = []  # blank line resets list nesting
            continue

        # Heading?
        m = HEADING_RE.match(line)
        if m:
            level = len(m.group(1))
            title_raw = m.group(2).strip()
            # Heading may itself be a link: `## [Section](url)`
            url = None
            title = title_raw
            mm = HEADING_LINK_RE.match(title_raw)
            if mm:
                title = mm.group(1).strip()
                url = urljoin(base_url, mm.group(2).strip())

            if level == 1:
                root["title"] = title
                if url:
                    root["url"] = url
                heading_stack = [(0, root), (1, root)]
                current_section = root
            else:
                while heading_stack and heading_stack[-1][0] >= level:
                    heading_stack.pop()
                parent = heading_stack[-1][1] if heading_stack else root
                node = {"title": title, "url": url, "description": None, "children": []}
                parent["children"].append(node)
                heading_stack.append((level, node))
                current_section = node

            list_stack = []
            continue

        # Blockquote: capture only the first one as root description.
        m = BLOCKQUOTE_RE.match(line)
        if m and current_section is root and not root["description"]:
            root["description"] = m.group(1).strip()
            continue

        # List item with link?
        m = LIST_LINK_RE.match(line)
        if m:
            indent = len(m.group("indent").replace("\t", "    "))
            title = m.group("title").strip()
            url = urljoin(base_url, m.group("url").strip())
            desc = (m.group("desc") or "").strip() or None

            # Pop list_stack until current indent fits as a child
            while list_stack and list_stack[-1][0] >= indent:
                list_stack.pop()
            parent = list_stack[-1][1] if list_stack else current_section
            node = {"title": title, "url": url, "description": desc, "children": []}
            parent.setdefault("children", []).append(node)
            list_stack.append((indent, node))
            continue

        # Other content (intro paragraphs etc) — ignored.

    return root


# ─── filename allocation ───────────────────────────────────────────────

def url_to_filename(url: str, seen: set[str], strip_path: str = "") -> str:
    """Generate a unique .md filename for a URL.

    strip_path: optional path prefix to strip from URL path before slugifying
        (typically the directory holding llms.txt, so filenames stay short).
    """
    parsed = urlparse(url)
    path = parsed.path
    if strip_path and path.startswith(strip_path):
        path = path[len(strip_path):]
    path = path.strip("/")
    if not path:
        path = "index"
    # Strip trailing .md or .html for normalization, then re-add .md.
    base = re.sub(r"\.(md|html?)$", "", path)
    base = base.replace("/", "_")
    base = re.sub(r"[^\w\-.]", "_", base)
    name = f"{base}.md"

    if name not in seen:
        seen.add(name)
        return name

    # Collision: prefix host (good for cross-host llms.txt), then counter.
    host = re.sub(r"[^\w]", "_", parsed.netloc)
    candidate = f"{host}__{name}"
    if candidate not in seen:
        seen.add(candidate)
        return candidate

    i = 2
    while True:
        candidate = f"{base}_{i}.md"
        if candidate not in seen:
            seen.add(candidate)
            return candidate
        i += 1


# ─── tree helpers ──────────────────────────────────────────────────────

def collect_url_nodes(node: dict) -> list[dict]:
    """Walk the internal tree and collect every node that has a URL (DFS)."""
    out: list[dict] = []
    if node.get("url"):
        out.append(node)
    for child in node.get("children", []):
        out.extend(collect_url_nodes(child))
    return out


def assign_filenames(root: dict, strip_path: str = "") -> None:
    """Walk tree, assign `_filename` to each node that has a URL."""
    seen: set[str] = set()
    for node in collect_url_nodes(root):
        node["_filename"] = url_to_filename(node["url"], seen, strip_path)


def build_map_tree(node: dict) -> dict:
    """Convert internal tree to map.json schema {title, file?, children?}."""
    out: dict = {"title": node.get("title") or ""}
    fname = node.get("_filename")
    if fname:
        out["file"] = fname
    children = []
    for c in node.get("children", []):
        cm = build_map_tree(c)
        # Drop empty leaves (no title and no file and no children).
        if cm.get("title") or cm.get("file") or cm.get("children"):
            children.append(cm)
    if children:
        out["children"] = children
    return out


# ─── frontmatter writer ────────────────────────────────────────────────

def yaml_escape(s: str) -> str:
    return (s or "").replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ").strip()


def write_md_file(path: Path, title: str, source: str, body: str) -> None:
    fm = f'---\ntitle: "{yaml_escape(title)}"\nsource: "{yaml_escape(source)}"\n---\n\n'
    path.write_text(fm + body.rstrip() + "\n", encoding="utf-8")


# ─── Phase 1: parallel markdown download ───────────────────────────────

async def fetch_markdown(client: httpx.AsyncClient, url: str) -> tuple[bool, str, str]:
    """Returns (ok, body_or_empty, hint).

    ok=True: body is markdown ready to save.
    ok=False: hint is one of 'html', 'http_<status>', 'unknown_<ct>', 'error_<exc>'.
    """
    try:
        r = await client.get(url, timeout=30.0, follow_redirects=True)
    except Exception as e:
        return False, "", f"error_{type(e).__name__}"
    if r.status_code != 200:
        return False, "", f"http_{r.status_code}"
    ct = (r.headers.get("content-type") or "").lower()
    if "text/markdown" in ct:
        return True, r.text, "markdown"
    if "text/plain" in ct:
        # Some servers serve markdown as text/plain (e.g. llms.txt itself, occasionally body).
        return True, r.text, "plain"
    if "text/html" in ct or "application/xhtml" in ct:
        return False, "", "html"
    return False, "", f"unknown_{ct.split(';')[0]}"


# ─── Phase 2: HTML fallback (lazy Playwright import) ───────────────────

async def html_fallback(
    failed: list[dict],
    output_dir: Path,
    concurrency: int,
) -> set[str]:
    """Re-fetch failed URLs via Playwright + turndown.

    Returns the set of URLs that were successfully recovered.
    """
    # Lazy import — Playwright is heavy.
    sys.path.insert(0, str(Path(__file__).parent))
    import crawl as c  # type: ignore
    from playwright.async_api import async_playwright

    recovered: set[str] = set()
    sem = asyncio.Semaphore(min(concurrency, 5))

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context()
        try:
            async def one(node: dict):
                async with sem:
                    page = await ctx.new_page()
                    try:
                        await c.safe_goto(page, node["url"])
                        title = (await page.title()) or node.get("title", "")
                        await page.evaluate(c.READABILITY_JS)
                        await page.evaluate(c.HTML_MD_CONVERTER_JS)
                        md = await c.convert_page_to_markdown(page)
                        if md:
                            md = c.extract_data_url_images(md, output_dir, output_dir / "images")
                            write_md_file(
                                output_dir / node["_filename"],
                                title,
                                node["url"],
                                md,
                            )
                            recovered.add(node["url"])
                    except Exception as e:
                        log(f"  fallback failed: {node['url']} -> {type(e).__name__}: {e}")
                    finally:
                        await page.close()

            await asyncio.gather(*[one(n) for n in failed])
        finally:
            await browser.close()

    return recovered


# ─── main flow ─────────────────────────────────────────────────────────

async def run(args: argparse.Namespace) -> None:
    # 1. Load llms.txt
    if re.match(r"^https?://", args.llms_url):
        log(f"Loading: {args.llms_url}")
        async with httpx.AsyncClient() as client:
            r = await client.get(args.llms_url, timeout=30.0, follow_redirects=True)
            r.raise_for_status()
            llms_text = r.text
        base_url = args.base_url or args.llms_url
    else:
        p = Path(args.llms_url)
        if not p.exists():
            log(f"ERROR: file not found: {p}")
            sys.exit(1)
        llms_text = p.read_text(encoding="utf-8")
        base_url = args.base_url or ""
        if not base_url:
            log("WARNING: local llms.txt without --base-url; relative URLs will be skipped")

    # 2. Parse
    tree = parse_llms_txt(llms_text, base_url)
    if not tree["title"] and not tree["children"]:
        log("ERROR: llms.txt parsed empty. Is the format correct?")
        sys.exit(1)
    url_nodes = collect_url_nodes(tree)
    log(f"Parsed: title='{tree['title']}', {len(url_nodes)} URLs across the tree")
    if tree.get("description"):
        log(f"        > {tree['description']}")

    # 3. Filenames — strip the directory containing llms.txt to keep names short.
    #    e.g. base_url=".../userguide/llms.txt" -> strip "/userguide/" prefix.
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    parsed_base = urlparse(base_url)
    strip_path = parsed_base.path
    if strip_path.endswith("llms.txt"):
        strip_path = strip_path[: -len("llms.txt")]
    elif strip_path.endswith("llms-full.txt"):
        strip_path = strip_path[: -len("llms-full.txt")]
    elif not strip_path.endswith("/"):
        strip_path = strip_path.rsplit("/", 1)[0] + "/"
    assign_filenames(tree, strip_path=strip_path)

    # 4. Phase 1: parallel MD fetch
    log(f"Phase 1: downloading {len(url_nodes)} URLs as markdown (concurrency={args.concurrency})...")
    sem = asyncio.Semaphore(args.concurrency)
    saved_count = 0
    failed: list[dict] = []
    cross_host: list[dict] = []
    llms_host = urlparse(base_url).netloc

    async with httpx.AsyncClient(headers={"User-Agent": "web-crawler-md/llms-collect"}) as client:
        async def task(idx: int, node: dict):
            nonlocal saved_count
            async with sem:
                host = urlparse(node["url"]).netloc
                if llms_host and host and host != llms_host:
                    cross_host.append(node)
                ok, body, hint = await fetch_markdown(client, node["url"])
                if ok:
                    write_md_file(
                        output_dir / node["_filename"],
                        node["title"],
                        node["url"],
                        body,
                    )
                    saved_count += 1
                else:
                    node["_failure"] = hint
                    failed.append(node)
                if (idx + 1) % 25 == 0 or (idx + 1) == len(url_nodes):
                    log(f"  [{idx + 1}/{len(url_nodes)}] saved={saved_count} failed={len(failed)}")

        await asyncio.gather(*[task(i, n) for i, n in enumerate(url_nodes)])

    log(f"Phase 1 done: {saved_count} saved, {len(failed)} failed")
    if cross_host:
        log(f"  cross-host links: {len(cross_host)} (kept; first: {cross_host[0]['url']})")

    # 5. Phase 2: HTML fallback (only failures worth retrying)
    recovered: set[str] = set()
    if failed and not args.no_html_fallback:
        retry = [
            f for f in failed
            if f["_failure"] == "html" or f["_failure"].startswith("http_")
        ]
        if retry:
            log(f"Phase 2: HTML fallback for {len(retry)} URLs (loading Playwright)...")
            recovered = await html_fallback(retry, output_dir, args.concurrency)
            saved_count += len(recovered)
            log(f"Phase 2 done: {len(recovered)} recovered, {len(retry) - len(recovered)} still failing")
        else:
            log("Phase 2: skipped (no retryable failures)")
    elif failed:
        log("Phase 2: skipped (--no-html-fallback)")

    # 6. map.json
    map_tree = build_map_tree(tree)
    map_path = output_dir / "map.json"
    map_path.write_text(json.dumps(map_tree, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"Map:    {map_path}")

    # 7. Summary log
    unresolved = [f for f in failed if f["url"] not in recovered]
    log(f"Done!  {saved_count} saved, {len(unresolved)} unresolved -> {output_dir}/")
    if unresolved:
        log("Unresolved URLs:")
        for f in unresolved[:10]:
            log(f"  - [{f['_failure']}] {f['url']}")
        if len(unresolved) > 10:
            log(f"  ... and {len(unresolved) - 10} more")


def main():
    parser = argparse.ArgumentParser(
        description="llms.txt mode collector — hierarchical fetch via llms.txt index"
    )
    parser.add_argument("llms_url", help="URL to an llms.txt file (or local path)")
    parser.add_argument("--output", "-o", default="output", help="Output directory")
    parser.add_argument("--concurrency", "-c", type=int, default=10,
                        help="Concurrent downloads (default: 10)")
    parser.add_argument("--no-html-fallback", action="store_true",
                        help="Disable Playwright HTML→MD fallback for failed fetches")
    parser.add_argument("--base-url", default="",
                        help="Base URL for resolving relative links (required when llms_url is local)")
    args = parser.parse_args()

    start = time.time()
    asyncio.run(run(args))
    log(f"Time: {time.time() - start:.1f}s")


if __name__ == "__main__":
    main()
