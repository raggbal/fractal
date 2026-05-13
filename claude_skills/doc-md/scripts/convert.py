#!/usr/bin/env python3
"""各種ドキュメント → Markdown 変換ツール (Docling版)"""

# Workaround: pyenv Python が xz なしでビルドされた場合の _lzma 欠落対策
import sys
import types

try:
    import _lzma  # noqa: F401
except ModuleNotFoundError:
    _mod = types.ModuleType("_lzma")
    for _attr in [
        "FORMAT_AUTO", "FORMAT_XZ", "FORMAT_ALONE", "FORMAT_RAW",
        "CHECK_NONE", "CHECK_CRC32", "CHECK_CRC64", "CHECK_SHA256",
        "CHECK_ID_MAX", "CHECK_UNKNOWN",
        "MF_HC3", "MF_HC4", "MF_BT2", "MF_BT3", "MF_BT4",
        "MODE_FAST", "MODE_NORMAL", "PRESET_DEFAULT", "PRESET_EXTREME",
    ]:
        setattr(_mod, _attr, 0)
    _mod.LZMACompressor = None
    _mod.LZMADecompressor = None
    _mod.LZMAError = Exception
    _mod.is_check_supported = lambda check_id: True
    _mod._encode_filter_properties = lambda *a, **kw: b""
    _mod._decode_filter_properties = lambda *a, **kw: {}
    sys.modules["_lzma"] = _mod

import argparse
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import urlparse, unquote

from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling_core.types.doc.base import ImageRefMode


SUPPORTED_EXTENSIONS = {
    # MS Office
    ".pdf", ".docx", ".pptx", ".xlsx",
    # マークアップ
    ".html", ".xhtml", ".md", ".adoc", ".tex",
    # データ
    ".csv",
    # 画像
    ".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".webp",
    # 音声
    ".wav", ".mp3",
    # その他
    ".xml", ".json", ".vtt",
}


def is_url(source: str) -> bool:
    parsed = urlparse(source)
    return parsed.scheme in ("http", "https")


def download_file(url: str, dest_dir: Path) -> Path:
    """URLからファイルをダウンロードして一時ディレクトリに保存する。"""
    parsed = urlparse(url)
    filename = unquote(Path(parsed.path).name)
    if not filename:
        filename = "downloaded_file"
    dest_path = dest_dir / filename
    print(f"Downloading: {url}")
    urllib.request.urlretrieve(url, dest_path)
    return dest_path


def convert_to_markdown(source: str, output_dir: str | None = None) -> Path:
    """ファイルまたはURLをMarkdownに変換する。"""
    if is_url(source):
        tmp_dir = tempfile.mkdtemp()
        file_path = download_file(source, Path(tmp_dir))
    else:
        file_path = Path(source).resolve()
        if not file_path.exists():
            print(f"Error: ファイルが見つかりません: {file_path}", file=sys.stderr)
            sys.exit(1)

    ext = file_path.suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        print(f"Error: 非対応の形式です: {ext}", file=sys.stderr)
        print(f"対応形式: {', '.join(sorted(SUPPORTED_EXTENSIONS))}", file=sys.stderr)
        sys.exit(1)

    print(f"Converting: {file_path.name}")
    pdf_options = PdfPipelineOptions(generate_picture_images=True)
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options),
        }
    )
    result = converter.convert(str(file_path))

    if output_dir:
        out_dir = Path(output_dir).resolve()
    elif is_url(source):
        out_dir = Path.cwd()
    else:
        out_dir = file_path.parent

    out_dir.mkdir(parents=True, exist_ok=True)
    output_path = out_dir / f"{file_path.stem}.md"
    result.document.save_as_markdown(output_path, image_mode=ImageRefMode.REFERENCED)
    print(f"Output: {output_path}")
    return output_path


def main():
    parser = argparse.ArgumentParser(
        description="各種ドキュメント → Markdown 変換 (Docling版)"
    )
    parser.add_argument("source", help="変換するファイルのパスまたはURL")
    parser.add_argument("-o", "--output-dir", help="出力先ディレクトリ (省略時は入力ファイルと同じ場所)")
    args = parser.parse_args()
    convert_to_markdown(args.source, args.output_dir)


if __name__ == "__main__":
    main()
