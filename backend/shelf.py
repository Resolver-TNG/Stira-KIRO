"""The memory shelf: books of what the crew has done and knows, read from disk.

Books, in shelf order:
  environment  workspace/notes/environment/*.md  - PC and tool setup notes
  journal      workspace/memory/history/*.md     - KiroCrew's own work log, one chapter per entry
  notes        workspace/notes/*.md              - research and design notes
  project      workspace/<dir>/ with a README.md - README and docs/*.md
  talk         sessions/*.jsonl header lines     - one book per project folder, chapter = session

Read-only, deterministic, no model call. Session transcripts: only the header line and the row
count are read, never message text. Incognito / temporary sessions are skipped. Every excerpt
goes through redact() before it leaves this module.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PRIVATE_MODES = {"incognito", "temporary", "ephemeral"}
MAX_FILES = 2000
MAX_COUNT_BYTES = 64 * 1024 * 1024
MAX_MD_BYTES = 512 * 1024
EXCERPT = 180
OTHER = "(no project)"
SKIP_DIRS = {"memory", "notes", "knowledge", "exports", "_src", ".kiro", "node_modules"}

# credential-shaped text never reaches the board
_SECRET = re.compile(
    r"(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|"
    r"sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"
    r"(?i:(?:password|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}))"
)


def redact(text: str) -> str:
    return _SECRET.sub("[redacted]", text)


def crew_home() -> Path:
    try:
        from kiro_crew.config.loader import config_dir

        return Path(config_dir())
    except Exception:  # noqa: BLE001 - outside the gateway (tests)
        return Path.home() / ".kiro" / "crew"


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _ts(value: Any, fallback: float) -> float:
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return fallback


def _cut(text: str, n: int = EXCERPT) -> str:
    s = re.sub(r"\s+", " ", redact(text)).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def _book_id(kind: str, key: str) -> str:
    return kind + "-" + hashlib.sha256(key.casefold().encode("utf-8")).hexdigest()[:10]


def _read_md(path: Path) -> str | None:
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_MD_BYTES:
            return None
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def md_summary(text: str) -> tuple[str, str]:
    """First '# ' heading and the first plain paragraph after it."""
    title = ""
    para: list[str] = []
    in_code = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        if not title and line.startswith("# "):
            title = line[2:].strip()
            continue
        if line.startswith("#") or line.startswith("<!--") or line in {"---", "***"}:
            if para:
                break
            continue
        if not line:
            if para:
                break
            continue
        para.append(line.lstrip(">-* ").strip())
    return title, " ".join(para)


def _chapter(title: str, ts: float, excerpt: str = "", **extra: Any) -> dict[str, Any]:
    return {"title": _cut(title, 120), "updatedAt": ts, "excerpt": _cut(excerpt) if excerpt else "", **extra}


def _book(kind: str, key: str, name: str, chapters: list[dict[str, Any]], **extra: Any) -> dict[str, Any] | None:
    if not chapters:
        return None
    chapters.sort(key=lambda c: c["updatedAt"], reverse=True)
    return {
        "id": _book_id(kind, key),
        "kind": kind,
        "name": name,
        "chapters": chapters,
        "chapterCount": len(chapters),
        "startedAt": min(c["updatedAt"] for c in chapters),
        "updatedAt": max(c["updatedAt"] for c in chapters),
        **extra,
    }


# --- md folders ---------------------------------------------------------------------------
def md_book(kind: str, folder: Path, name: str) -> dict[str, Any] | None:
    if not folder.is_dir() or folder.is_symlink():
        return None
    chapters = []
    for path in sorted(folder.glob("*.md"))[:200]:
        text = _read_md(path)
        if text is None:
            continue
        title, excerpt = md_summary(text)
        chapters.append(_chapter(title or path.stem, path.stat().st_mtime, excerpt, file=path.name))
    return _book(kind, str(folder), name, chapters)


# --- KiroCrew work log: "[YYYY-MM-DD HH:MM...] text" entries ---------------------------------
_ENTRY = re.compile(r"^\[(\d{4}-\d{2}-\d{2})[ T]?(\d{2}:\d{2})?[^\]]*\]\s*(.+)$")


def journal_book(folder: Path) -> dict[str, Any] | None:
    if not folder.is_dir() or folder.is_symlink():
        return None
    chapters = []
    for path in sorted(folder.glob("*.md"))[-120:]:
        text = _read_md(path)
        if text is None:
            continue
        for line in text.splitlines():
            m = _ENTRY.match(line.strip())
            if not m:
                continue
            day, hm, body = m.group(1), m.group(2) or "00:00", m.group(3)
            ts = _ts(f"{day}T{hm}:00+09:00", path.stat().st_mtime)
            first = re.split(r"(?<=[。.])", body, maxsplit=1)[0]
            chapters.append(_chapter(first, ts, body))
    return _book("journal", str(folder), "作業日誌", chapters)


# --- workspace projects -------------------------------------------------------------------
def project_books(workspace: Path) -> list[dict[str, Any]]:
    out = []
    if not workspace.is_dir():
        return out
    for d in sorted(p for p in workspace.iterdir() if p.is_dir() and not p.is_symlink()):
        if d.name in SKIP_DIRS or d.name.startswith("."):
            continue
        readme = next((d / n for n in ("README.md", "README_ja.md", "_pack/README.md") if (d / n).is_file()), None)
        if readme is None:
            continue
        chapters = []
        for path in [readme, *sorted((d / "docs").glob("*.md"))[:40]] if (d / "docs").is_dir() else [readme]:
            text = _read_md(path)
            if text is None:
                continue
            title, excerpt = md_summary(text)
            chapters.append(_chapter(title or path.stem, path.stat().st_mtime, excerpt, file=str(path.relative_to(d))))
        book = _book("project", str(d), d.name, chapters, path=str(d))
        if book:
            out.append(book)
    return out


# --- conversations (session headers) ------------------------------------------------------
def _rows(path: Path) -> int:
    n = read = 0
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            n += chunk.count(b"\n")
            read += len(chunk)
            if read >= MAX_COUNT_BYTES:
                break
    return max(0, n - 1)


def read_chapters(home: Path) -> list[dict[str, Any]]:
    sessions = home / "sessions"
    if not sessions.is_dir() or sessions.is_symlink():
        return []
    out = []
    for path in sorted(sessions.glob("*.jsonl"))[:MAX_FILES]:
        if path.is_symlink() or not path.is_file():
            continue
        try:
            with path.open(encoding="utf-8") as f:
                header = json.loads(f.readline() or "{}")
            stat = path.stat()
        except (OSError, ValueError):
            continue
        if not isinstance(header, dict):
            continue
        mode = header.get("memory_mode")
        if isinstance(mode, str) and mode.strip().casefold() in PRIVATE_MODES:
            continue
        project = header.get("project") if isinstance(header.get("project"), str) else ""
        title = header.get("title") if isinstance(header.get("title"), str) else ""
        agent = header.get("agent") if isinstance(header.get("agent"), str) else ""
        try:
            rows = _rows(path)
        except OSError:
            rows = 0
        out.append(
            {
                "id": path.stem,
                "title": _cut(title or path.stem, 120),
                "agent": agent.strip()[:60],
                "project": project.strip() or OTHER,
                "startedAt": _ts(header.get("created_at"), stat.st_ctime),
                "updatedAt": stat.st_mtime,
                "rows": rows,
                "excerpt": "",
            }
        )
    return out


def _with_written(chs: list[dict[str, Any]], home: Path) -> list[dict[str, Any]]:
    """要約済みの章(chapters.py)があるセッションは、その章に置き換える。"""
    from .chapters import read_written

    written = read_written(home)
    out = []
    for ch in chs:
        parts = written.get(ch["id"])
        if not parts:
            out.append(ch)
            continue
        for p in parts:
            out.append(
                {
                    **ch,
                    "id": f"{ch['id']}__{p['part']:02d}",
                    "stem": p.get("stem", f"{ch['id']}__{p['part']:02d}"),
                    "edited": p.get("edited", False),
                    "title": p["title"] or ch["title"],
                    "excerpt": _cut(p.get("結果") or p.get("状況") or ""),
                    "story": {k: p.get(k, "") for k in ("状況", "判断", "結果", "学び")},
                    "leaves": p["leaves"],
                    "session": ch["title"],
                    "part": p["part"],
                    "written": True,
                    # 同じセッションの章は部の順に並ぶよう、時刻を少しずらす
                    "updatedAt": ch["updatedAt"] - (len(parts) - p["part"]),
                }
            )
    return out


def talk_books(home: Path) -> list[dict[str, Any]]:
    # 作業フォルダが workspace 直下(=どのプロジェクトでもない)の会話は、セッションごとに1冊にする。
    # そうしないと Tarkov も 3D も Stira も「会話: workspace」1冊に混ざる。
    ws = str((home / "workspace").resolve()).casefold()
    by: dict[str, list[dict[str, Any]]] = {}
    names: dict[str, str] = {}
    for ch in _with_written(read_chapters(home), home):
        if not ch.get("written") and ch.get("rows", 0) < 10:
            continue  # プローブなどのごく短い会話
        project = ch["project"]
        try:
            loose = project == OTHER or str(Path(project).resolve()).casefold() == ws
        except OSError:
            loose = False
        if loose:
            key = "session:" + (ch.get("session") or ch["title"])
            names[key] = "会話: " + (ch.get("session") or ch["title"])
        else:
            key = project
            names[key] = "会話: " + Path(project).name
        by.setdefault(key, []).append(ch)
    out = []
    for project, chs in by.items():
        name = names[project]
        for c in chs:
            c.pop("project", None)
        book = _book("talk", project, name, chs, path="" if project.startswith("session:") or project == OTHER else project)
        if book:
            book["rows"] = sum(c["rows"] for c in chs)
            out.append(book)
    out.sort(key=lambda b: b["updatedAt"], reverse=True)
    return out


ORDER = {"environment": 0, "journal": 1, "notes": 2, "project": 3, "talk": 4}


def books(home: Path | None = None) -> list[dict[str, Any]]:
    home = home or crew_home()
    ws = home / "workspace"
    found = [
        md_book("environment", ws / "notes" / "environment", "環境メモ"),
        journal_book(ws / "memory" / "history"),
        md_book("notes", ws / "notes", "ノート"),
        *project_books(ws),
        *talk_books(home),
    ]
    result = [b for b in found if b]
    result.sort(key=lambda b: (ORDER.get(b["kind"], 9), -b["updatedAt"]))
    return result


def shelf_payload(home: Path | None = None) -> dict[str, Any]:
    data = books(home)
    for b in data:
        for k in ("startedAt", "updatedAt"):
            b[k] = _iso(b[k])
        for c in b["chapters"]:
            for k in ("startedAt", "updatedAt"):
                if isinstance(c.get(k), (int, float)):
                    c[k] = _iso(c[k])
    return {"version": 2, "books": data, "generatedAt": _iso(datetime.now(tz=timezone.utc).timestamp())}


if __name__ == "__main__":
    print(json.dumps(shelf_payload(), ensure_ascii=False, indent=1)[:6000])
