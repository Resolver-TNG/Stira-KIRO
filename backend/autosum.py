"""章の要約を、アプリの中で回す。

- 1回に1章ずつ、ツールを持たない章書き(agents/stira-chapter-writer.json)を ctx.spawn で起こす。
  材料はタスク本文に入れ、章は返答として受け取る(章書きはファイルを一切触らない)。
- 返答は、終わったサブエージェントの result.txt から読み、chapters.accept_reply で形式と
  中身を確かめてから書く。合わない返答は捨てて記録する。
- 1日の上限(既定 10 章 ≒ 10 クレジット)を超えたら止まる。自動は「静かになったセッション」だけ。
- 状態と記録は data_dir/autosum.json / autosum.log.jsonl。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from . import chapters
from .shelf import crew_home

log = logging.getLogger("stira-kiro.autosum")

AGENT = "stira-chapter-writer"
MODEL = "auto"
DAILY_CAP = 10
AUTO_EVERY_SECS = 30 * 60
AUTO_IDLE_SECS = 2 * 60 * 60  # 最後の部は、2時間静かになってから
AUTO_PER_TICK = 2
SPAWN_TIMEOUT = 300.0
PROBE_EVERY = 2.0


async def refresh_index() -> None:
    """章が変わったら、普段のチャット用の目次(INDEX.md)を書き直す。失敗しても止めない。"""
    from . import recall

    from . import narrative

    try:
        await asyncio.to_thread(recall.write_index)
    except Exception:  # noqa: BLE001
        log.warning("INDEX.md refresh failed", exc_info=True)
    try:  # 物語の現在地と昇格候補も同じ時に作り直す(モデルは呼ばない)
        await asyncio.to_thread(narrative.write_all)
    except Exception:  # noqa: BLE001
        log.warning("narrative refresh failed", exc_info=True)


class Summarizer:
    def __init__(self, ctx: Any) -> None:
        self.ctx = ctx
        self.data = Path(getattr(ctx, "data_dir", None) or (crew_home() / "apps" / "stira-kiro" / "data"))
        self.data.mkdir(parents=True, exist_ok=True)
        self.lock = asyncio.Lock()
        self.current: dict[str, Any] | None = None
        self.task: asyncio.Task | None = None

    # --- 設定と記録 ----------------------------------------------------------------------
    def _settings_path(self) -> Path:
        return self.data / "autosum.json"

    def settings(self) -> dict[str, Any]:
        try:
            s = json.loads(self._settings_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            s = {}
        return {"auto": bool(s.get("auto", True)), "dailyCap": int(s.get("dailyCap", DAILY_CAP))}

    def save_settings(self, **kw: Any) -> dict[str, Any]:
        s = self.settings() | {k: v for k, v in kw.items() if v is not None}
        s["dailyCap"] = max(0, min(100, int(s["dailyCap"])))
        tmp = self._settings_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(s), encoding="utf-8")
        tmp.replace(self._settings_path())
        return s

    def _log(self, **row: Any) -> None:
        row = {"at": datetime.now().isoformat(timespec="seconds"), **row}
        with (self.data / "autosum.log.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def recent(self, n: int = 20) -> list[dict[str, Any]]:
        try:
            lines = (self.data / "autosum.log.jsonl").read_text(encoding="utf-8").splitlines()[-n:]
        except OSError:
            return []
        out = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
        return out

    def used_today(self) -> int:
        today = datetime.now().date().isoformat()
        return sum(1 for r in self.recent(500) if r.get("at", "").startswith(today) and r.get("event") in {"written", "rejected", "failed"})

    # --- 状態 ---------------------------------------------------------------------------
    async def status(self) -> dict[str, Any]:
        jobs = await asyncio.to_thread(chapters.pending_jobs)
        waiting = await asyncio.to_thread(chapters.pending_jobs, idle_secs=AUTO_IDLE_SECS)
        s = self.settings()
        return {
            "pending": len(jobs),
            "pendingIdle": len(waiting),
            "pendingList": [{"stem": j["stem"], "title": j["title"], "part": j["part"], "parts": j["parts"]} for j in jobs[:20]],
            "usedToday": self.used_today(),
            "dailyCap": s["dailyCap"],
            "auto": s["auto"],
            "running": self.current,
            "recent": self.recent(8),
            "spawnAvailable": getattr(self.ctx, "spawn", None) is not None,
        }

    # --- 1章ぶん ------------------------------------------------------------------------
    async def _one(self, job: dict[str, Any], trigger: str) -> str:
        spawn = getattr(self.ctx, "spawn", None)
        if spawn is None:
            self._log(event="failed", stem=job["stem"], why="no spawn permission")
            return "failed"
        self.current = {"stem": job["stem"], "title": job["title"], "startedAt": time.time(), "trigger": trigger}
        try:
            sid = await spawn.run(chapters.task_for(job), agent=AGENT, silent=True, model=MODEL)
        except Exception as err:  # noqa: BLE001 - SpawnError, refusal
            self.current = None
            self._log(event="failed", stem=job["stem"], why=f"spawn: {err}"[:200])
            return "failed"
        deadline = time.monotonic() + SPAWN_TIMEOUT
        while time.monotonic() < deadline and not spawn.is_done(sid):
            await asyncio.sleep(PROBE_EVERY)
        self.current = None
        result = crew_home() / "subagents" / sid / "result.txt"
        try:
            reply = await asyncio.to_thread(result.read_text, encoding="utf-8")
        except OSError:
            self._log(event="failed", stem=job["stem"], spawn=sid, why="no result (timeout or reaped)")
            return "failed"
        out = await asyncio.to_thread(chapters.accept_reply, job, reply)
        if out is None:
            self._log(event="rejected", stem=job["stem"], spawn=sid, why="reply did not match the chapter format", head=reply[:160])
            return "rejected"
        self._log(event="written", stem=job["stem"], spawn=sid, trigger=trigger)
        await refresh_index()
        return "written"

    async def run(self, limit: int, *, trigger: str, idle_secs: float = 0.0) -> dict[str, Any]:
        """未要約の部分を最大 limit 章、1章ずつ。日の上限で止まる。"""
        if self.lock.locked():
            return {"started": False, "why": "busy"}
        async with self.lock:
            jobs = await asyncio.to_thread(chapters.pending_jobs, idle_secs=idle_secs)
            done: dict[str, int] = {}
            for job in jobs:
                if sum(done.values()) >= limit:
                    break
                if self.used_today() >= self.settings()["dailyCap"]:
                    self._log(event="capped", cap=self.settings()["dailyCap"])
                    break
                r = await self._one(job, trigger)
                done[r] = done.get(r, 0) + 1
            return {"started": True, "results": done, "left": max(0, len(jobs) - sum(done.values()))}

    def start_background(self, limit: int, trigger: str) -> bool:
        if self.lock.locked():
            return False
        asyncio.get_running_loop().create_task(self.run(limit, trigger=trigger))
        return True

    # --- 自動 ---------------------------------------------------------------------------
    async def _loop(self) -> None:
        await asyncio.sleep(120)  # 起動直後は待つ
        while True:
            try:
                if self.settings()["auto"]:
                    await self.run(AUTO_PER_TICK, trigger="auto", idle_secs=AUTO_IDLE_SECS)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.warning("autosum tick failed", exc_info=True)
            await asyncio.sleep(AUTO_EVERY_SECS)

    def start_loop(self) -> None:
        if self.task is None or self.task.done():
            self.task = asyncio.get_running_loop().create_task(self._loop())

    async def stop_loop(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self.task = None


_ONE: Summarizer | None = None


def get(ctx: Any) -> Summarizer:
    global _ONE
    if _ONE is None or _ONE.ctx is not ctx:
        _ONE = Summarizer(ctx)
    return _ONE
