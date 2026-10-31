"""Stira-KIRO のライフサイクル: 起動時に自動要約のループを始め、終了時に止める。"""

from __future__ import annotations

import asyncio
from typing import Any

from . import autosum, recall


async def on_startup(ctx: Any) -> None:
    if getattr(ctx, "spawn", None) is None:
        ctx.health.mark_degraded("章の自動要約が使えません: spawn の権限がありません")
        return
    autosum.get(ctx).start_loop()
    try:
        await asyncio.to_thread(recall.write_index)  # 普段のチャット用の目次(skills/stira-memory)
    except Exception:  # noqa: BLE001
        ctx.health.mark_degraded("記憶の目次(INDEX.md)を書けませんでした")


async def on_shutdown(ctx: Any) -> None:
    await autosum.get(ctx).stop_loop()
