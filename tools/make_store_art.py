"""ストア用の画像を、frames.mjs で撮った Stage から作る(ドット絵は最近傍で拡大)。

    node tools/frames.mjs --state calm   --from 90  --to 90  --size 1200x675 --out <S>/hero
    node tools/frames.mjs --state memory --from 120 --to 120 --size 1280x720 --out <S>/shot
    uv run --with pillow tools/make_store_art.py <S>

出力: assets/icon.png(512x512 不透明)、assets/hero.png(1200x675)、assets/hero-detail.png(1200x288)、
      assets/screenshots/stage.png
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[1]
BG = (5, 5, 12)


def load(folder: Path) -> tuple[Image.Image, dict]:
    rep = json.loads((folder / "frames.json").read_text(encoding="utf-8"))
    f = [x for x in rep["frames"] if x.get("file")][-1]
    return Image.open(folder / f["file"]).convert("RGB"), f


def fit(img: Image.Image, w: int, h: int) -> Image.Image:
    out = Image.new("RGB", (w, h), BG)
    s = min(w / img.width, h / img.height)
    im = img.resize((round(img.width * s), round(img.height * s)), Image.NEAREST)
    out.paste(im, ((w - im.width) // 2, (h - im.height) // 2))
    return out


def main(src: Path) -> None:
    assets = REPO / "assets"
    (assets / "screenshots").mkdir(parents=True, exist_ok=True)
    hero, f = load(src / "hero")
    scale = int(f["layout"]["scale"])
    vw = f["layout"]["view"][0]
    art = hero.resize((hero.width // scale, hero.height // scale), Image.NEAREST)
    # 文字窓は HTML なので、撮った解像度のまま使う(ドット単位に縮めると文字が潰れる)
    fit(hero, 1200, 675).save(assets / "hero.png")
    # 横長の帯: 棚から窓まで、キャラの目の高さ
    band_h = round(hero.width * 288 / 1200)
    top = 40 * scale
    fit(hero.crop((0, top, hero.width, top + band_h)), 1200, 288).save(assets / "hero-detail.png")
    # アイコン: キャラの顔(絵のドット座標。キャラは部屋の x=181 から、表示の左端は 320 - vw/2)
    cx = 181 - round(320 - vw / 2) + 139
    face = art.crop((cx - 62, 18, cx + 62, 142))
    face.resize((496, 496), Image.NEAREST)
    icon = Image.new("RGB", (512, 512), BG)
    icon.paste(face.resize((496, 496), Image.NEAREST), (8, 8))
    icon.save(assets / "icon.png")
    shot, _ = load(src / "shot")
    fit(shot, 1280, 720).save(assets / "screenshots" / "stage.png")
    for p in ["icon.png", "hero.png", "hero-detail.png", "screenshots/stage.png"]:
        im = Image.open(assets / p)
        print(p, im.size, im.mode)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
