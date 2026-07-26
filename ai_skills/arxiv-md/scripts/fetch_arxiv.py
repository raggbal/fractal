#!/usr/bin/env python3
"""arXiv URL → PDF download → doc-md で Markdown 化."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse


ARXIV_ID_RE = re.compile(
    r"""
    (?P<id>
        \d{4}\.\d{4,5}(?:v\d+)?      # new style: 2401.08822 / 2401.08822v1
        |
        [a-z\-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?  # old style: hep-th/9901001
    )
    """,
    re.VERBOSE,
)

ATOM_NS = {"atom": "http://www.w3.org/2005/Atom"}


def extract_arxiv_id(source: str) -> str:
    """arXiv の URL / ID 文字列から arXiv ID を取り出す."""
    parsed = urlparse(source)
    target = parsed.path if parsed.scheme in ("http", "https") else source
    m = ARXIV_ID_RE.search(target)
    if not m:
        raise ValueError(f"arXiv ID を抽出できませんでした: {source}")
    return m.group("id")


def pdf_url_for(arxiv_id: str) -> str:
    return f"https://arxiv.org/pdf/{arxiv_id}.pdf"


def abs_url_for(arxiv_id: str) -> str:
    return f"https://arxiv.org/abs/{arxiv_id}"


def fetch_metadata(arxiv_id: str) -> dict | None:
    """arXiv API からメタデータを取得する (失敗時は None).

    取得項目: title, summary(abstract), authors, categories, published, updated
    """
    api_url = f"http://export.arxiv.org/api/query?id_list={arxiv_id}"
    try:
        req = urllib.request.Request(
            api_url,
            headers={"User-Agent": "arxiv-md-skill/1.0 (+https://arxiv.org)"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"[warn] arXiv API 取得失敗: {e}", file=sys.stderr)
        return None

    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        print(f"[warn] arXiv API レスポンス解析失敗: {e}", file=sys.stderr)
        return None

    entry = root.find("atom:entry", ATOM_NS)
    if entry is None:
        return None

    def text(tag: str) -> str:
        el = entry.find(f"atom:{tag}", ATOM_NS)
        return " ".join(el.text.split()) if el is not None and el.text else ""

    authors = [
        (a.findtext("atom:name", default="", namespaces=ATOM_NS) or "").strip()
        for a in entry.findall("atom:author", ATOM_NS)
    ]
    authors = [a for a in authors if a]

    categories = [
        c.attrib.get("term", "")
        for c in entry.findall("atom:category", ATOM_NS)
    ]
    categories = [c for c in categories if c]

    title = text("title")
    if not title:
        return None

    return {
        "title": title,
        "summary": text("summary"),
        "authors": authors,
        "categories": categories,
        "published": text("published"),
        "updated": text("updated"),
    }


def slugify(title: str, max_len: int = 80) -> str:
    s = re.sub(r"[^\w\s\-]", "", title, flags=re.UNICODE)
    s = re.sub(r"\s+", "-", s.strip())
    return s[:max_len] or "arxiv"


def download_pdf(arxiv_id: str, dest: Path) -> Path:
    url = pdf_url_for(arxiv_id)
    print(f"Downloading: {url}")
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "arxiv-md-skill/1.0 (+https://arxiv.org)"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    dest.write_bytes(data)
    return dest


def resolve_doc_md_convert() -> Path:
    """doc-md の convert.py を解決する.

    1) 環境変数 DOC_MD_CONVERT が最優先
    2) このスクリプト基準の兄弟 skill: ../../doc-md/scripts/convert.py
    3) ~/.claude/skills/doc-md/scripts/convert.py
    """
    env = os.environ.get("DOC_MD_CONVERT")
    if env:
        p = Path(env).expanduser().resolve()
        if p.exists():
            return p

    here = Path(__file__).resolve()
    sibling = here.parent.parent.parent / "doc-md" / "scripts" / "convert.py"
    if sibling.exists():
        return sibling

    fallback = Path("~/.claude/skills/doc-md/scripts/convert.py").expanduser()
    if fallback.exists():
        return fallback

    raise FileNotFoundError(
        "doc-md の convert.py が見つかりません。DOC_MD_CONVERT で絶対パスを指定してください。"
    )


def run_doc_md(pdf_path: Path, output_dir: Path) -> Path:
    convert_script = resolve_doc_md_convert()
    output_dir.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(convert_script), str(pdf_path), "-o", str(output_dir)]
    print(f"Running: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    md_path = output_dir / f"{pdf_path.stem}.md"
    if not md_path.exists():
        raise FileNotFoundError(f"MD 出力が見つかりません: {md_path}")
    return md_path


def maybe_rename_with_title(md_path: Path, pdf_path: Path, title: str | None) -> tuple[Path, Path]:
    """タイトルがあればファイル名を `<arxiv_id>-<slug>.md` / `.pdf` にリネーム."""
    if not title:
        return md_path, pdf_path
    slug = slugify(title)
    new_stem = f"{pdf_path.stem}-{slug}"
    new_md = md_path.with_name(f"{new_stem}.md")
    new_pdf = pdf_path.with_name(f"{new_stem}.pdf")
    if new_md != md_path and not new_md.exists():
        md_path.rename(new_md)
        md_path = new_md
    if new_pdf != pdf_path and not new_pdf.exists() and pdf_path.exists():
        pdf_path.rename(new_pdf)
        pdf_path = new_pdf
    return md_path, pdf_path


def build_front_matter(arxiv_id: str, meta: dict | None) -> str:
    """YAML front matter を生成する."""
    lines = ["---"]
    lines.append(f'arxiv_id: "{arxiv_id}"')
    lines.append(f'abs_url: "{abs_url_for(arxiv_id)}"')
    lines.append(f'pdf_url: "{pdf_url_for(arxiv_id)}"')
    if meta:
        if meta.get("title"):
            safe_title = meta["title"].replace('"', '\\"')
            lines.append(f'title: "{safe_title}"')
        if meta.get("authors"):
            lines.append("authors:")
            for a in meta["authors"]:
                safe_a = a.replace('"', '\\"')
                lines.append(f'  - "{safe_a}"')
        if meta.get("categories"):
            cats = ", ".join(f'"{c}"' for c in meta["categories"])
            lines.append(f"categories: [{cats}]")
        if meta.get("published"):
            lines.append(f'published: "{meta["published"]}"')
        if meta.get("updated"):
            lines.append(f'updated: "{meta["updated"]}"')
    lines.append("---")
    lines.append("")
    return "\n".join(lines)


def prepend_metadata(
    md_path: Path,
    arxiv_id: str,
    meta: dict | None,
    with_abstract: bool,
    with_front_matter: bool,
) -> None:
    """生成した MD の冒頭に front matter / 可読ヘッダ / abstract を追記."""
    header_parts: list[str] = []

    if with_front_matter:
        header_parts.append(build_front_matter(arxiv_id, meta))

    title = meta.get("title") if meta else None
    header_lines = [f"# {title}" if title else f"# arXiv {arxiv_id}", ""]
    header_lines.append(f"- arXiv ID: `{arxiv_id}`")
    if meta and meta.get("authors"):
        header_lines.append("- Authors: " + ", ".join(meta["authors"]))
    header_lines.append(f"- Abstract: {abs_url_for(arxiv_id)}")
    header_lines.append(f"- PDF: {pdf_url_for(arxiv_id)}")
    header_lines.append("")

    if with_abstract and meta and meta.get("summary"):
        header_lines.append("## Abstract")
        header_lines.append("")
        header_lines.append(meta["summary"])
        header_lines.append("")

    header_lines.append("---")
    header_lines.append("")
    header_parts.append("\n".join(header_lines))

    header = "".join(header_parts)
    body = md_path.read_text(encoding="utf-8")
    md_path.write_text(header + body, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="arXiv URL から PDF を取得し doc-md で Markdown 化する."
    )
    parser.add_argument("source", help="arXiv URL / abs URL / pdf URL / arXiv ID")
    parser.add_argument(
        "-o",
        "--output-dir",
        default=None,
        help="出力先ディレクトリ (既定: カレントディレクトリ)",
    )
    parser.add_argument(
        "--keep-pdf",
        action="store_true",
        help="ダウンロードした PDF を出力先に残す",
    )
    parser.add_argument(
        "--no-title",
        action="store_true",
        help="arXiv API からメタデータを取得せず arXiv ID のみのファイル名にする",
    )
    parser.add_argument(
        "--no-abstract",
        action="store_true",
        help="冒頭に Abstract 本文を埋め込まない (既定は埋め込む)",
    )
    parser.add_argument(
        "--no-front-matter",
        action="store_true",
        help="YAML front matter を付与しない (既定は付与する)",
    )
    args = parser.parse_args()

    try:
        arxiv_id = extract_arxiv_id(args.source)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 2

    out_dir = Path(args.output_dir).resolve() if args.output_dir else Path.cwd()
    out_dir.mkdir(parents=True, exist_ok=True)

    meta = None if args.no_title else fetch_metadata(arxiv_id)
    title = meta.get("title") if meta else None

    with tempfile.TemporaryDirectory() as tmp:
        pdf_tmp = Path(tmp) / f"{arxiv_id.replace('/', '_')}.pdf"
        download_pdf(arxiv_id, pdf_tmp)

        if args.keep_pdf:
            final_pdf = out_dir / pdf_tmp.name
            pdf_tmp.replace(final_pdf)
            pdf_for_convert = final_pdf
        else:
            pdf_for_convert = pdf_tmp

        md_path = run_doc_md(pdf_for_convert, out_dir)

    if args.keep_pdf:
        md_path, _ = maybe_rename_with_title(md_path, pdf_for_convert, title)
    else:
        dummy_pdf = out_dir / pdf_for_convert.name
        md_path, _ = maybe_rename_with_title(md_path, dummy_pdf, title)

    prepend_metadata(
        md_path,
        arxiv_id,
        meta,
        with_abstract=not args.no_abstract,
        with_front_matter=not args.no_front_matter,
    )

    print(f"Done: {md_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
