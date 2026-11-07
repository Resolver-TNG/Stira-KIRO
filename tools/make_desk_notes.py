"""作業机の壁に貼る紙のドット絵を作る: ui/stage/kc-assets/desk-notes.png

    uv run --with pillow python tools/make_desk_notes.py

3種類 (付箋 / テープ貼りの紙片 / 画鋲留めのメモ) x 3状態 (red / yellow / green) x 3傾き。
1コマ CELL x CELL。列 = 種類 * 3 + 傾き、行 = 状態。kc_desk.js の NOTE_* と合わせること。

色は部屋の絵 (assets/bg/wall.png, shelf.png, desk.png) から拾ったくすんだ色に寄せている。
明るいのはネオンとモニターだけ、という部屋の約束を崩さないため、紙は暗めに抑える。
傾きは描いてから NEAREST で回すので、縁はドットの階段になる (なめらかに回さない)。
"""

from __future__ import annotations

import random
from pathlib import Path

from PIL import Image

CELL = 24
KINDS = ("note", "tape", "pin")
STATUSES = ("red", "yellow", "green")
TILTS = (-6, 0, 5)  # シアーの段: この行数ごとに1ドットずれる (符号が向き、0 はまっすぐ)

INK = (58, 52, 88)  # #3a3458 (壁の明るい線)
SHADOW = (8, 9, 21)  # #080915

# 状態の色 (くすませた朱 / 日焼けした黄 / 灰がかった若草)。[明, 中, 暗]
TONE = {
    "red": [(176, 96, 88), (146, 74, 72), (104, 52, 60)],
    "yellow": [(186, 160, 98), (154, 130, 78), (110, 92, 60)],
    "green": [(132, 156, 120), (104, 128, 98), (72, 94, 76)],
}
# テープ紙片・画鋲メモの紙 (黄ばんだ白)
PAPER = [(178, 170, 146), (150, 142, 122), (112, 106, 96)]


def bayer(x: int, y: int) -> float:
    m = ((0, 8, 2, 10), (12, 4, 14, 6), (3, 11, 1, 9), (15, 7, 13, 5))
    return m[y % 4][x % 4] / 16.0


def blank() -> Image.Image:
    return Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))


def paper_rect(img, x0, y0, w, h, pal, *, curl=True, seed=0):
    """紙: 下と右にディザの陰、右下の角をめくる。"""
    px = img.load()
    hi, mid, lo = pal
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            u, v = (x - x0) / max(1, w - 1), (y - y0) / max(1, h - 1)
            shade = 0.15 + 0.55 * v + 0.2 * u
            c = mid
            if shade < 0.32 and bayer(x, y) > shade:
                c = hi
            elif shade > 0.62 and bayer(x, y) < shade - 0.45:
                c = lo
            px[x, y] = (*c, 255)
    if curl:
        # 右下の角が手前にめくれる: 角を消して、裏(暗)を三角に
        for i in range(4):
            for j in range(4 - i):
                xx, yy = x0 + w - 1 - j, y0 + h - 1 - i
                px[xx, yy] = (0, 0, 0, 0)
        for i in range(3):
            for j in range(3 - i):
                xx, yy = x0 + w - 4 + j + i, y0 + h - 1 - i
                px[xx - i, yy] = (*lo, 255)
    # 走り書き (数本の線、長さはばらばら)
    rnd = random.Random(seed)
    for k in range(3):
        yy = y0 + 4 + k * 3
        if yy >= y0 + h - 3:
            break
        ln = rnd.randint(w // 3, w - 6)
        for xx in range(x0 + 3, x0 + 3 + ln):
            if rnd.random() > 0.18:
                px[xx, yy] = (*INK, 255)


def tinted_paper(tone, k: float = 0.22):
    """黄ばんだ紙に状態の色をうっすら混ぜる (テープや画鋲が小さくても、紙の色で状態が分かる)。"""
    return [tuple(round(p * (1 - k) + t * k) for p, t in zip(pc, tc)) for pc, tc in zip(PAPER, tone)]


ALERT_INK = (206, 84, 74)  # 赤ペン (紙の上)
ALERT_LIGHT = (222, 204, 170)  # 赤い付箋の上は白っぽいペン


def exclaim(px, x: int, y: int, ink, under) -> None:
    """走り書きの「!」: 幅2の縦線 (上が1ドット右に傾く) と点。下の1ドットに紙の暗い色で影。"""
    for i in range(6):
        dx = 1 if i < 2 else 0  # 書き始めが少し右に流れる
        for w in range(2):
            if i == 5 and w == 1:
                continue  # 書き終わりは細くなる
            px[x + dx + w, y + i] = (*ink, 255)
    for w in range(2):
        px[x + w, y + 7] = (*ink, 255)
        px[x + w, y + 8] = (*ink, 255)
    px[x + 2, y + 8] = (*under, 255)


def draw(kind: str, status: str, seed: int) -> Image.Image:
    img = blank()
    tone = TONE[status]
    px = img.load()
    alert = status == "red"
    if kind == "note":
        paper_rect(img, 4, 4, 16, 16, tone, seed=seed)
        # 上の糊の帯 (少し濃い)
        for x in range(4, 20):
            px[x, 4] = (*tone[2], 255)
    elif kind == "tape":
        paper_rect(img, 4, 6, 15, 14, tinted_paper(tone), curl=False, seed=seed)
        # 状態の色のテープを上辺の真ん中に横1本 (10x3、両端はギザギザに切れている)
        for i in range(10):
            for t in range(3):
                if (i == 0 or i == 9) and t == 1:
                    continue
                x, y = 7 + i, 4 + t
                c = tone[0] if t == 0 else tone[1] if (x * 3 + y) % 4 else tone[2]
                px[x, y] = (*c, 240)
    else:  # pin
        paper_rect(img, 5, 7, 14, 13, tinted_paper(tone), seed=seed)
        # 画鋲: 5x5 の丸い頭と光、下に影
        cx, cy = 12, 6
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                if abs(dx) + abs(dy) > 3:
                    continue
                c = tone[1] if dy < 1 else tone[2]
                if abs(dx) + abs(dy) == 3:
                    c = tone[2]
                px[cx + dx, cy + dy] = (*c, 255)
        px[cx - 1, cy - 1] = (*tone[0], 255)
        px[cx - 1, cy - 2] = (*tuple(min(255, v + 60) for v in tone[0]), 255)
        px[cx + 1, cy + 3] = (*SHADOW, 200)
    if alert:
        # 赤いもの (手が要るもの) にだけ赤ペンで「!」を書き足す。紙の右寄り、走り書きの上に重ねる
        if kind == "note":
            exclaim(px, 15, 7, ALERT_LIGHT, tone[2])
        elif kind == "tape":
            exclaim(px, 14, 9, ALERT_INK, PAPER[2])
        else:
            exclaim(px, 14, 10, ALERT_INK, PAPER[2])
    return img


def shear(img: Image.Image, step: int) -> Image.Image:
    """傾き: 行ごとに横へずらす (step 行ごとに1ドット)。回転と違って穴が空かず、縁はきれいな階段になる。
    step の符号が向き、0 はまっすぐ。"""
    if step == 0:
        return img
    out = blank()
    src, dst = img.load(), out.load()
    c = CELL // 2
    for y in range(CELL):
        dx = round((y - c) / step)
        for x in range(CELL):
            if src[x, y][3] and 0 <= x + dx < CELL:
                dst[x + dx, y] = src[x, y]
    return out


def with_shadow(img: Image.Image) -> Image.Image:
    """1px 右下に影 (壁 #080915)。ぼかさない。"""
    out = blank()
    sh = blank()
    src = img.load()
    d = sh.load()
    for y in range(CELL):
        for x in range(CELL):
            if src[x, y][3] > 0 and x + 1 < CELL and y + 1 < CELL:
                d[x + 1, y + 1] = (*SHADOW, 150)
    out.alpha_composite(sh)
    out.alpha_composite(img)
    return out


def main() -> None:
    atlas = Image.new("RGBA", (CELL * len(KINDS) * len(TILTS), CELL * len(STATUSES)), (0, 0, 0, 0))
    for r, status in enumerate(STATUSES):
        for k, kind in enumerate(KINDS):
            for t, angle in enumerate(TILTS):
                base = draw(kind, status, seed=r * 31 + k * 7 + t)
                atlas.alpha_composite(with_shadow(shear(base, angle)), ((k * len(TILTS) + t) * CELL, r * CELL))
    out = Path(__file__).resolve().parents[1] / "ui" / "stage" / "kc-assets" / "desk-notes.png"
    atlas.save(out, optimize=True)
    print(out, atlas.size)


if __name__ == "__main__":
    main()
