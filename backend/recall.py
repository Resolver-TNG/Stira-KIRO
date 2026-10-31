"""Kiro が記憶を使うための読み出し(モデルは呼ばない、決定的)。

brief()     セッションの最初に渡す目次: 棚の本と、最近の章、知識の葉のタイトル(約1500字まで)
relevant()  送る文に関係する章と葉を、文字の重なりで最大 k 件(約1200字まで)
どちらも本文は短く切り、秘密っぽい文字列は伏せる(shelf.redact)。
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any

from . import chapters
from .shelf import books, redact

BRIEF_LIMIT = 1500
HIT_LIMIT = 1200


def _cut(s: str, n: int) -> str:
    s = re.sub(r"\s+", " ", redact(str(s or ""))).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def _items(home: Path | None = None) -> list[dict[str, Any]]:
    """要約済みの章と、その葉を1件ずつ並べたもの(新しい順)。"""
    out: list[dict[str, Any]] = []
    for session, parts in chapters.read_written(home).items():
        for ch in parts:
            lesson = ch.get("学び", "")
            out.append({"type": "章", "id": ch.get("stem", session), "title": ch["title"], "text": f"{ch.get('結果', '')} {lesson}", "at": ch.get("updatedAt", "")})
            for lf in ch.get("leaves", []):
                out.append({"type": f"葉/{lf['kind']}", "id": ch.get("stem", session), "title": lf["title"], "text": lf["text"], "at": ch.get("updatedAt", "")})
    out.sort(key=lambda x: x["at"], reverse=True)
    return out


def brief(home: Path | None = None) -> str:
    lines = ["[Stira 記憶の目次] Stira Stage の棚にある記憶。関係しそうなら参考にする(全部は読まなくてよい)。"]
    for b in books(home)[:14]:
        last = b["chapters"][0]["title"] if b.get("chapters") else ""
        lines.append(f"- 本「{_cut(b['name'], 30)}」章{b['chapterCount']}: 最新「{_cut(last, 40)}」")
    leaves = [x for x in _items(home) if x["type"].startswith("葉")][:14]
    if leaves:
        lines.append("知識の葉: " + " / ".join(_cut(x["title"], 28) for x in leaves))
    text = "\n".join(lines)
    return text[:BRIEF_LIMIT]


def _grams(s: str) -> set[str]:
    s = s.lower()
    words = set(re.findall(r"[a-z0-9_][a-z0-9_.\-]{2,}", s))
    cjk = re.sub(r"[^\u3040-\u30ff\u3400-\u9fff]", " ", s)
    for run in cjk.split():
        words.update(run[i : i + 2] for i in range(len(run) - 1))
    return words


def relevant(query: str, k: int = 3, home: Path | None = None) -> list[dict[str, Any]]:
    q = _grams(query or "")
    if len(q) < 2:
        return []
    scored = []
    for it in _items(home):
        g = _grams(f"{it['title']} {it['title']} {it['text']}")
        hit = len(q & g)
        if hit >= 2:
            scored.append((hit / (len(q) ** 0.5), it))
    scored.sort(key=lambda x: x[0], reverse=True)
    top = scored[0][0] if scored else 0
    out, seen = [], set()
    for score, it in scored:
        if score < top * 0.75:  # 一番近いものより明らかに遠いものは渡さない
            break
        key = (it["type"], it["title"])
        if key in seen:
            continue
        seen.add(key)
        out.append({"type": it["type"], "title": _cut(it["title"], 60), "text": _cut(it["text"], 220), "chapter": it["id"], "score": round(score, 2)})
        if len(out) >= k:
            break
    return out


def index_path(home: Path | None = None) -> Path:
    return chapters.chapters_dir(home).parent / "INDEX.md"


def write_index(home: Path | None = None) -> Path:
    """普段のチャットの Kiro が読む目次(skills/stira-memory が案内する)。章のファイルの場所付き。

    中身は棚と同じ(タイトル・日付・結果の要約・学び・葉)で、会話の本文は入れない。
    """
    d = chapters.chapters_dir(home)
    lines = [
        "# Stira 記憶の目次",
        "",
        "Stira Stage が自動で作る。手で直さない(章の手直しは Stira Stage の森から)。",
        f"章のファイル: `{d}`(1章 = 1ファイル、`<セッション>__<部>.md`)",
        "",
    ]
    by: dict[str, list[dict[str, Any]]] = {}
    for session, parts in chapters.read_written(home).items():
        by[session] = parts
    for b in books(home):
        lines.append(f"## {b['name']}(章 {b['chapterCount']})")
        for c in b.get("chapters", [])[:40]:
            ts = c.get("updatedAt", "")
            day = datetime.fromtimestamp(ts).strftime("%Y-%m-%d") if isinstance(ts, (int, float)) else str(ts)[:10]
            if c.get("written") and c.get("stem"):
                lines.append(f"- {day} **{_cut(c['title'], 60)}** — `{c['stem']}.md`")
                story = c.get("story") or {}
                if story.get("結果"):
                    lines.append(f"  - 結果: {_cut(story['結果'], 160)}")
                if story.get("学び"):
                    lines.append(f"  - 学び: {_cut(story['学び'], 160)}")
                for lf in c.get("leaves", [])[:3]:
                    lines.append(f"  - 葉[{lf['kind']}] {_cut(lf['title'], 40)}: {_cut(lf['text'], 120)}")
            else:
                more = f" — {_cut(c.get('excerpt', ''), 100)}" if c.get("excerpt") else ""
                where = f" (`{c['file']}`)" if c.get("file") else ""
                lines.append(f"- {day} {_cut(c['title'], 60)}{where}{more}")
        lines.append("")
    out = index_path(home)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".md.tmp")
    tmp.write_text(redact("\n".join(lines)), encoding="utf-8")
    tmp.replace(out)
    return out


def relevant_context(hits: list[dict[str, Any]]) -> str:
    if not hits:
        return ""
    lines = ["[Stira 記憶] この依頼に関係しそうな、過去の自分の章と葉(古い可能性あり。今の事実を優先する):"]
    for h in hits:
        lines.append(f"- [{h['type']}] {h['title']}: {h['text']}")
    return "\n".join(lines)[:HIT_LIMIT]
