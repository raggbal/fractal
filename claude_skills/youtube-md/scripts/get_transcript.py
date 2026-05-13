"""YouTube動画のトランスクリプト（字幕）を取得するサンプルスクリプト"""

import sys
import re
from youtube_transcript_api import YouTubeTranscriptApi


def extract_video_id(url_or_id: str) -> str:
    """URLまたは動画IDから動画IDを抽出する"""
    patterns = [
        r"(?:v=|youtu\.be/)([a-zA-Z0-9_-]{11})",
        r"^([a-zA-Z0-9_-]{11})$",
    ]
    for pattern in patterns:
        match = re.search(pattern, url_or_id)
        if match:
            return match.group(1)
    raise ValueError(f"動画IDを抽出できません: {url_or_id}")


def get_transcript(video_id: str, languages: list[str] = None):
    """トランスクリプトを取得して返す"""
    if languages is None:
        languages = ["ja", "en"]

    api = YouTubeTranscriptApi()
    transcript = api.fetch(video_id, languages=languages)
    return transcript


def format_transcript(transcript, with_timestamp: bool = True) -> str:
    """トランスクリプトをテキストに整形する"""
    lines = []
    for entry in transcript:
        if with_timestamp:
            minutes = int(entry.start // 60)
            seconds = int(entry.start % 60)
            lines.append(f"[{minutes:02d}:{seconds:02d}] {entry.text}")
        else:
            lines.append(entry.text)
    return "\n".join(lines)


def format_readable(transcript) -> str:
    """字幕断片を繋げて読みやすい文章に整形する"""
    # 長い間（8秒以上）かつ直前が句点で終わる箇所で段落分け
    paragraphs = []
    current = []
    for i, entry in enumerate(transcript):
        current.append(entry.text)
        gap = transcript[i + 1].start - entry.start if i + 1 < len(transcript) else 0
        combined = re.sub(r"\s+", "", " ".join(current))
        if gap >= 8 and re.search(r"[。！？]$", combined):
            paragraphs.append(combined)
            current = []
    if current:
        paragraphs.append(re.sub(r"\s+", "", " ".join(current)))
    # 各段落内で句点の後に改行を挿入
    result = []
    for p in paragraphs:
        p = re.sub(r"([。！？])(?!$)", r"\1\n", p)
        result.append(p.strip())
    return "\n\n".join(result)


def main():
    import argparse
    from pathlib import Path

    parser = argparse.ArgumentParser(description="YouTube動画のトランスクリプト（字幕）を取得")
    parser.add_argument("url", help="YouTube URL or Video ID")
    parser.add_argument("-o", "--output-dir", help="出力先ディレクトリ (省略時はカレントディレクトリ)")
    parser.add_argument("--no-timestamp", action="store_true", help="タイムスタンプなし")
    parser.add_argument("--readable", action="store_true", help="読みやすい文章形式")
    args = parser.parse_args()

    video_id = extract_video_id(args.url)
    print(f"動画ID: {video_id}")
    print(f"トランスクリプト取得中...\n")

    transcript = get_transcript(video_id)
    if args.readable:
        text = format_readable(transcript)
    else:
        text = format_transcript(transcript, with_timestamp=not args.no_timestamp)
    print(text)

    # ファイルにも保存
    if args.output_dir:
        out_dir = Path(args.output_dir).resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
    else:
        out_dir = Path.cwd()
    output_file = out_dir / f"transcript_{video_id}.md"
    output_file.write_text(text, encoding="utf-8")
    print(f"\n--- 保存先: {output_file} ---")


if __name__ == "__main__":
    main()
