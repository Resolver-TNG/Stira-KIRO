"""tools/frames.mjs で撮ったフレームを解析する。

    uv run --with pillow tools/analyze_frames.py <フレームのフォルダ>

出力(同じフォルダ):
  sheet.png   キャラ周りを切り出して並べたコンタクトシート(フレーム番号・モーション付き)
  diff.png    前のフレームとの差(変わった画素を赤、1画素だけ孤立して変わった所を黄色)
  report.md   フレームごとの変化量、孤立画素(ちらつき)の数、大きく跳んだフレーム
ドット絵なので、画面の画素を拡大率で割って「絵の1ドット」単位で比べる。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

CHAR_POS = (181, 20)  # scene.js: キャラの絵の左上(部屋の画像座標)
CHAR_SIZE = 278
VIEW_TOP_ROW = 10


def view_left(vw: int) -> int:
    return round(320 - vw / 2)


def art(img: Image.Image, scale: int) -> Image.Image:
    """画面の画素 -> 絵の1ドット(拡大率で間引く)。"""
    if scale <= 1:
        return img
    return img.resize((img.width // scale, img.height // scale), Image.NEAREST)


def char_box(vw: int, vh: int) -> tuple[int, int, int, int]:
    x = CHAR_POS[0] - view_left(vw)
    y = CHAR_POS[1] - VIEW_TOP_ROW
    return max(0, x - 30), max(0, y), min(vw, x + CHAR_SIZE + 30), min(vh, y + CHAR_SIZE)


def diff(a: Image.Image, b: Image.Image) -> tuple[Image.Image, int, int]:
    """変わったドット数と、そのうち周りが変わっていない孤立ドット数。"""
    w, h = a.size
    pa, pb = a.load(), b.load()
    changed = [[sum(abs(x - y) for x, y in zip(pa[i, j][:3], pb[i, j][:3])) > 24 for j in range(h)] for i in range(w)]
    out = b.convert("L").convert("RGB").point(lambda v: v // 3)
    po = out.load()
    n = iso = 0
    for i in range(w):
        for j in range(h):
            if not changed[i][j]:
                continue
            n += 1
            near = any(changed[x][y] for x in range(max(0, i - 1), min(w, i + 2)) for y in range(max(0, j - 1), min(h, j + 2)) if (x, y) != (i, j))
            if not near:
                iso += 1
                po[i, j] = (255, 220, 40)
            else:
                po[i, j] = (255, 50, 50)
    return out, n, iso


def main(folder: Path) -> None:
    rep = json.loads((folder / "frames.json").read_text(encoding="utf-8"))
    frames = [f for f in rep["frames"] if f.get("file")]
    if not frames:
        sys.exit("フレームがありません")
    scale = int(frames[0]["layout"]["scale"])
    vw, vh = frames[0]["layout"]["view"]
    box = char_box(vw, vh)
    crops = [art(Image.open(folder / f["file"]).convert("RGB"), scale).crop(box) for f in frames]

    z = 2  # シートでの拡大(1ドット = 2px)
    cw, ch = crops[0].width * z, crops[0].height * z
    cols = min(6, len(crops))
    rows = (len(crops) + cols - 1) // cols
    label = 16
    sheet = Image.new("RGB", (cols * cw, rows * (ch + label)), (12, 10, 24))
    dsheet = Image.new("RGB", sheet.size, (12, 10, 24))
    d1, d2 = ImageDraw.Draw(sheet), ImageDraw.Draw(dsheet)
    lines = [f"# フレーム解析: {rep['state']}", "", f"- 画面 {rep['size'][0]}x{rep['size'][1]}、拡大率 {scale}、表示 {vw}x{vh} ドット、{len(frames)} 枚(1/60秒 × {rep['step']} 刻み)", f"- キャラ周りの切り出し(ドット): {box}", "", "| フレーム | 秒 | 変化ドット | 孤立ドット | モーション(シート|頭|目|眉…) |", "|---|---|---|---|---|"]
    stats = []
    for k, (f, c) in enumerate(zip(frames, crops)):
        x, y = (k % cols) * cw, (k // cols) * (ch + label)
        sheet.paste(c.resize((cw, ch), Image.NEAREST), (x, y + label))
        d1.text((x + 4, y + 2), f"#{f['n']} {f['frame'].split('|')[0]}", fill=(130, 230, 255))
        if k:
            dimg, n, iso = diff(crops[k - 1], c)
            dsheet.paste(dimg.resize((cw, ch), Image.NEAREST), (x, y + label))
            d2.text((x + 4, y + 2), f"#{f['n']} chg {n} iso {iso}", fill=(255, 200, 120))
        else:
            n = iso = 0
        stats.append((f, n, iso))
        lines.append(f"| {f['n']} | {f['t']} | {n} | {iso} | `{f['frame']}` |")
    sheet.save(folder / "sheet.png")
    dsheet.save(folder / "diff.png")
    moving = [s for s in stats[1:]]
    if moving:
        avg = sum(n for _, n, _ in moving) / len(moving)
        jumps = [f"#{f['n']}({n})" for f, n, _ in moving if n > max(40, avg * 2.5)]
        flick = [f"#{f['n']}({iso})" for f, _, iso in moving if iso >= 12]
        lines += ["", "## 見どころ", f"- 平均の変化: {avg:.0f} ドット / 刻み", f"- 大きく跳んだフレーム(平均の2.5倍超): {', '.join(jumps) or 'なし'}", f"- 孤立ドットが多い(ちらつき候補、12以上): {', '.join(flick) or 'なし'}"]
    if rep.get("console"):
        lines += ["", "## ブラウザのログ", *[f"- {c}" for c in rep["console"][:20]]]
    (folder / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[-6:]))
    print(f"-> {folder / 'sheet.png'} / diff.png / report.md")


def zoom(folder: Path, box: tuple[int, int, int, int], only: list[int] | None, z: int = 3) -> Path:
    """絵のドット座標 box(x, y, w, h)を、選んだフレームで拡大して並べる(zoom.png)。"""
    rep = json.loads((folder / "frames.json").read_text(encoding="utf-8"))
    frames = [f for f in rep["frames"] if f.get("file") and (not only or f["n"] in only)]
    x, y, w, h = box
    tiles = []
    for f in frames:
        s = int(f["layout"]["scale"])
        im = art(Image.open(folder / f["file"]).convert("RGB"), s).crop((x, y, x + w, y + h))
        tiles.append((f, im.resize((w * z, h * z), Image.NEAREST)))
    tw, th = w * z, h * z
    cols = 2 if len(tiles) > 1 else 1
    sheet = Image.new("RGB", (tw * cols, (th + 14) * ((len(tiles) + cols - 1) // cols)), (0, 0, 0))
    d = ImageDraw.Draw(sheet)
    for k, (f, t) in enumerate(tiles):
        px, py = (k % cols) * tw, (k // cols) * (th + 14)
        sheet.paste(t, (px, py + 14))
        d.text((px + 4, py + 1), f"#{f['n']} {f['frame'][:60]}", fill=(130, 230, 255))
    out = folder / "zoom.png"
    sheet.save(out)
    return out


if __name__ == "__main__":
    folder = Path(sys.argv[1])
    opts = dict(a.split("=", 1) for a in sys.argv[2:] if "=" in a)
    if "zoom" in opts:  # zoom=x,y,w,h [only=7,13,19]
        bx = tuple(int(v) for v in opts["zoom"].split(","))
        only = [int(v) for v in opts["only"].split(",")] if "only" in opts else None
        print(zoom(folder, bx, only))  # type: ignore[arg-type]
    else:
        main(folder)
