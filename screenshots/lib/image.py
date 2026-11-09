"""撮影した PNG の後処理（Pillow）。

  python3 -I image.py stitch <spec.json> <out.png>
      デスクトップアプリのビュー（サイドバー・note ごと）の画像を、ウィンドウの中の位置に並べて 1 枚にする。
      spec.json: [{"file": <png>, "x": .., "y": .., "w": .., "h": ..}]（x・y・w・h はウィンドウの座標。画像は 2 倍などの大きさ）
  python3 -I image.py fit <in.png> <out.png> <width> [<colors>]
      横幅 width に縮める。colors を付けると減色する（ホームページの一覧の画像を軽くする）
"""
import json
import sys

from PIL import Image


def stitch(spec_file, out):
    spec = json.load(open(spec_file))
    imgs = [(Image.open(p['file']), p) for p in spec]
    scale = max(im.width / p['w'] for im, p in imgs if p['w'])
    width = int(max(p['x'] + p['w'] for _, p in imgs) * scale)
    height = int(max(p['y'] + p['h'] for _, p in imgs) * scale)
    canvas = Image.new('RGB', (width, height), 'white')
    for im, p in imgs:
        canvas.paste(im, (int(p['x'] * scale), int(p['y'] * scale)))
    canvas.save(out)


def fit(src, out, width, colors=None):
    im = Image.open(src).convert('RGB')
    if im.width != width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    if colors:
        im = im.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    im.save(out, optimize=True)
    print(out, im.size)


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'stitch':
        stitch(sys.argv[2], sys.argv[3])
    elif cmd == 'fit':
        fit(sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]) if len(sys.argv) > 5 else None)
    else:
        sys.exit('unknown command: ' + cmd)
