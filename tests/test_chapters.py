"""backend/chapters.py と autosum.py の試験(モデルは呼ばない)。

実行: <同梱python> -m pytest tests/test_chapters.py -q   (pytest が無ければ python tests/test_chapters.py)
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import autosum, chapters  # noqa: E402


def _home(tmp: Path, rows: int = 30) -> Path:
    s = tmp / "sessions"
    s.mkdir(parents=True)
    lines = [json.dumps({"_type": "metadata", "title": "テスト会話", "project": "x", "memory_mode": "persistent"})]
    for i in range(rows):
        lines.append(json.dumps({"role": "user", "content": f"質問{i} " + "あ" * 40, "ts": f"2026-10-31T0{i % 10}:00"}))
        lines.append(json.dumps({"role": "tool", "content": "gh" + "p_" + "x" * 30}))
        # (偽のトークン。本物に見えないよう実行時に組み立てる)
        fake = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz12"
        lines.append(json.dumps({"role": "assistant", "content": f"答え{i} token: {fake} " + "い" * 40}))
    (s / "dashboard_t1.jsonl").write_text("\n".join(lines), encoding="utf-8")
    return tmp


REPLY = """はい、書きました。
---
session: dashboard_t1
part: 1
title: テストの章
period: 2026-10-31T00:00 .. 2026-10-31T09:00
---
## 状況
試験をしていた。
## 判断
- 試すことにした
## 結果
章が書けた。
## 学び
- 試験は大事
## 葉
- [手順] 試験の回し方: 先に試験を書く。
"""


def test_pending_skips_tools_and_redacts():
    with tempfile.TemporaryDirectory() as d:
        home = _home(Path(d))
        jobs = chapters.pending_jobs(home)
        assert len(jobs) == 1
        text = jobs[0]["text"]
        assert "ghp_" not in text and "[redacted]" in text
        assert "xxxxxxxx" not in text  # ツールの行は入らない


def test_idle_holds_the_last_part():
    with tempfile.TemporaryDirectory() as d:
        home = _home(Path(d))
        assert chapters.pending_jobs(home, idle_secs=3600) == []


def test_accept_writes_with_source_and_rejects_wrong_part():
    with tempfile.TemporaryDirectory() as d:
        home = _home(Path(d))
        job = chapters.pending_jobs(home)[0]
        assert chapters.accept_reply({**job, "part": 2}, REPLY, home) is None
        out = chapters.accept_reply(job, REPLY, home)
        assert out and out.exists()
        assert f"source: {job['source']}" in out.read_text(encoding="utf-8")
        assert chapters.pending_jobs(home) == []  # 同じ材料はもう待たない
        ch = chapters.read_written(home)["dashboard_t1"][0]
        assert ch["title"] == "テストの章" and ch["leaves"][0]["kind"] == "手順"


class _FakeSpawn:
    def __init__(self, home: Path, reply: str):
        self.home, self.reply, self.tasks = home, reply, []

    async def run(self, task, agent="", *, silent=False, model=""):
        self.tasks.append((task, agent))
        sid = f"s{len(self.tasks)}"
        d = self.home / "subagents" / sid
        d.mkdir(parents=True)
        (d / "result.txt").write_text(self.reply, encoding="utf-8")
        return sid

    def is_done(self, _sid):
        return True


def test_summarizer_runs_one_chapter_and_respects_cap(monkeypatch=None):
    with tempfile.TemporaryDirectory() as d:
        home = _home(Path(d))
        orig = autosum.crew_home, chapters.crew_home
        autosum.crew_home = chapters.crew_home = lambda: home
        try:
            ctx = type("C", (), {})()
            ctx.data_dir = home / "data"
            ctx.spawn = _FakeSpawn(home, REPLY)
            s = autosum.Summarizer(ctx)
            s.save_settings(dailyCap=1)
            r = asyncio.run(s.run(5, trigger="manual"))
            assert r["results"] == {"written": 1}
            assert ctx.spawn.tasks[0][1] == "stira-chapter-writer"
            assert "===== 材料 =====" in ctx.spawn.tasks[0][0]
            assert s.used_today() == 1
        finally:
            autosum.crew_home, chapters.crew_home = orig


def test_edit_keeps_ids_marks_edited_and_is_not_rewritten():
    with tempfile.TemporaryDirectory() as d:
        home = _home(Path(d))
        job = chapters.pending_jobs(home)[0]
        chapters.accept_reply(job, REPLY, home)
        raw = chapters.read_raw(job["stem"], home)
        try:
            chapters.save_edit(job["stem"], raw.replace("part: 1", "part: 2"), home)
            raise AssertionError("part change must be refused")
        except ValueError:
            pass
        ch = chapters.save_edit(job["stem"], raw.replace("テストの章", "直した章"), home)
        assert ch["title"] == "直した章"
        text = chapters.read_raw(job["stem"], home)
        assert "edited: true" in text and "source:" not in text
        assert chapters.read_written(home)["dashboard_t1"][0]["edited"] is True
        assert chapters.pending_jobs(home) == []


def test_remove_redo_and_skip():
    with tempfile.TemporaryDirectory() as d:
        home = _home(Path(d))
        job = chapters.pending_jobs(home)[0]
        chapters.accept_reply(job, REPLY, home)
        assert chapters.remove(job["stem"], keep_out=False, home=home) is True
        assert [j["stem"] for j in chapters.pending_jobs(home)] == [job["stem"]]  # 書き直し待ち
        chapters.remove(job["stem"], keep_out=True, home=home)
        assert chapters.pending_jobs(home) == []  # 二度と要約しない
        try:
            chapters.remove("../x__01", keep_out=False, home=home)
            raise AssertionError("bad id must be refused")
        except ValueError:
            pass


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
