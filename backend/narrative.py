"""物語の現在地(本ごとに章から自動で蒸留した短い要約)と、昇格候補。

3層の記憶制御のうち2層目:
  1. 芯        IPD と steering。ここでは扱わない。物語から芯を書き換えない。
  2. 物語の現在地  本(プロジェクト・会話)ごとの約700字。今どこにいるか、転機の判断、学び。
  3. エピソード   章の本文。必要なときだけ開く(recall.relevant / skills/stira-memory)。

モデルは呼ばない。章(chapters.py が書いたもの)を決まった規則で集めるだけなので、
費用ゼロで、同じ入力なら同じ出力になる。

書き出すもの(workspace/memory/stira/narratives/):
  index.json       hook(kiro-pack/hooks/stira_narrative_hook.py)が読む。本ごとの要約と照合用の語
  <id>.md          人が読む版
  promotions.json  2つ以上の章に出てきた学び(lessons / steering への昇格候補。昇格は人が決める)
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .shelf import books, crew_home, redact

SCHEMA = 1
TEXT_LIMIT = 700
ARC_LEN = 5
SIMILAR = 0.42  # 学びどうしを「同じ」とみなす重なり係数 |A∩B| / min(|A|,|B|)
MIN_GRAMS = 8   # これより短い文は比べない(短い文は偶然重なる)


def narratives_dir(home: Path | None = None) -> Path:
    return (home or crew_home()) / "workspace" / "memory" / "stira" / "narratives"


def _cut(s: str, n: int) -> str:
    s = re.sub(r"\s+", " ", redact(str(s or ""))).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def grams(s: str) -> set[str]:
    """英数字の語と、かな漢字の2-gram。recall._grams と同じ規則(hook 側にも同じ実装がある)。"""
    s = (s or "").lower()
    out = set(re.findall(r"[a-z0-9_][a-z0-9_.\-]{2,}", s))
    cjk = re.sub(r"[^\u3040-\u30ff\u3400-\u9fff]", " ", s)
    for run in cjk.split():
        out.update(run[i : i + 2] for i in range(len(run) - 1))
    return out


def _bullets(text: str) -> list[str]:
    """章の節を1項目ずつに分ける。箇条書きならその行、地の文なら文。"""
    items = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith(("- ", "* ", "・")):
            items.append(line.lstrip("-*・ ").strip())
        else:
            items.extend(p.strip() for p in re.split(r"(?<=[。.!?！?])\s*", line) if p.strip())
    return [i for i in items if len(i) >= 6]


def _similar(a: str, b: str) -> bool:
    ga, gb = grams(a), grams(b)
    if len(ga) < MIN_GRAMS or len(gb) < MIN_GRAMS:
        return a.strip() == b.strip()
    return len(ga & gb) / min(len(ga), len(gb)) >= SIMILAR


def _written(book: dict[str, Any]) -> list[dict[str, Any]]:
    """書かれた章を古い順に。"""
    chs = [c for c in book.get("chapters", []) if c.get("written")]
    return sorted(chs, key=lambda c: c.get("updatedAt", 0))


def lessons_of(chs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """学びを集め、似たものを束ねる。新しい章のものほど前に。"""
    groups: list[dict[str, Any]] = []
    for ch in reversed(chs):
        story = ch.get("story") or {}
        cands = _bullets(story.get("学び", "")) + [lf["text"] for lf in ch.get("leaves", []) if lf.get("text")]
        for text in cands:
            for g in groups:
                if _similar(g["text"], text):
                    if ch.get("stem") not in g["chapters"]:
                        g["chapters"].append(ch.get("stem", ""))
                    break
            else:
                groups.append({"text": _cut(text, 160), "chapters": [ch.get("stem", "")]})
    return groups


def build(book: dict[str, Any]) -> dict[str, Any] | None:
    chs = _written(book)
    if not chs:
        return None
    last = chs[-1].get("story") or {}
    arc = [_cut(c.get("title", ""), 40) for c in chs[-ARC_LEN:]]
    decisions = _bullets(last.get("判断", ""))[:3]
    lessons = lessons_of(chs)
    repeated = [g for g in lessons if len(g["chapters"]) >= 2]
    lines = [f"現在地: {_cut(last.get('結果') or last.get('状況', ''), 220)}"]
    if len(arc) > 1:
        lines.append("これまで: " + " → ".join(arc))
    if decisions:
        lines.append("直近の判断: " + " / ".join(_cut(d, 80) for d in decisions))
    picked = repeated[:2] + [g for g in lessons if g not in repeated][: max(0, 4 - len(repeated[:2]))]
    for g in picked:
        mark = "★" if len(g["chapters"]) >= 2 else "-"
        lines.append(f"{mark} {g['text']}")
    text = "\n".join(lines)
    if len(text) > TEXT_LIMIT:
        text = text[: TEXT_LIMIT - 1] + "…"
    match = " ".join([book.get("name", "")] + [c.get("title", "") for c in chs] + [lf.get("title", "") for c in chs for lf in c.get("leaves", [])])
    return {
        "id": book["id"],
        "name": _cut(book.get("name", ""), 60),
        "kind": book.get("kind", ""),
        "path": book.get("path", ""),
        "chapters": len(chs),
        "updatedAt": max(c.get("updatedAt", 0) for c in chs),
        "text": text,
        "match": _cut(match, 2000),
        "repeated": repeated,
    }


def promotions(home: Path | None = None) -> list[dict[str, Any]]:
    """本をまたいで2つ以上の章に出てきた学び。lessons / steering への昇格候補(決めるのは人)。"""
    every: list[dict[str, Any]] = []
    names: dict[str, str] = {}
    for b in books(home):
        for c in _written(b):
            every.append(c)
            names[c.get("stem", "")] = b.get("name", "")
    every.sort(key=lambda c: c.get("updatedAt", 0))
    out = []
    for g in lessons_of(every):
        if len(g["chapters"]) >= 2:
            out.append({"text": g["text"], "books": sorted({names.get(s, "") for s in g["chapters"]}), "chapters": g["chapters"], "count": len(g["chapters"])})
    out.sort(key=lambda p: p["count"], reverse=True)
    return out[:30]


def build_all(home: Path | None = None) -> list[dict[str, Any]]:
    out = [n for n in (build(b) for b in books(home)) if n]
    out.sort(key=lambda n: n["updatedAt"], reverse=True)
    return out


def _atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _slug(book_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", book_id)[:80] or "book"


def write_all(home: Path | None = None) -> dict[str, Any]:
    d = narratives_dir(home)
    items = build_all(home)
    now = datetime.now(timezone.utc).isoformat()
    keep = set()
    for n in items:
        name = _slug(n["id"]) + ".md"
        keep.add(name)
        n["file"] = name
        _atomic(d / name, f"# 物語の現在地: {n['name']}\n\n章 {n['chapters']} / 自動生成(手で直さない)\n\n{n['text']}\n")
    for old in d.glob("*.md") if d.is_dir() else []:
        if old.name not in keep:
            old.unlink(missing_ok=True)
    index = {
        "schemaVersion": SCHEMA,
        "generatedAt": now,
        "books": [{k: n[k] for k in ("id", "name", "kind", "path", "file", "chapters", "text", "match")} for n in items],
    }
    _atomic(d / "index.json", json.dumps(index, ensure_ascii=False, indent=1))
    promos = promotions(home)
    _atomic(d / "promotions.json", json.dumps({"schemaVersion": SCHEMA, "generatedAt": now, "candidates": promos}, ensure_ascii=False, indent=1))
    return {"books": len(items), "promotions": len(promos), "dir": str(d)}


if __name__ == "__main__":
    print(json.dumps(write_all(), ensure_ascii=False))
