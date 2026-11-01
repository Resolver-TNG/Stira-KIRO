"""Stira-KIRO soft routes, served at /api/apps/stira-kiro/<path> by the gateway."""

from __future__ import annotations

import asyncio
from typing import Any

from aiohttp import web

from kiro_crew.apps.route_registry import AppRoute

from . import autosum, chapters, narrative, recall, shelf

NO_STORE = {"Cache-Control": "no-store"}


async def get_shelf(_request: web.Request, _ctx: Any) -> web.Response:
    payload = await asyncio.to_thread(shelf.shelf_payload)
    return web.json_response(payload, headers=NO_STORE)


async def get_health(_request: web.Request, _ctx: Any) -> web.Response:
    return web.json_response({"ok": True})


async def get_chapters_status(_request: web.Request, ctx: Any) -> web.Response:
    return web.json_response(await autosum.get(ctx).status(), headers=NO_STORE)


async def post_chapters_run(request: web.Request, ctx: Any) -> web.Response:
    """手動: 未要約の章を最大 limit 章(1〜5)。すぐ返り、裏で1章ずつ進む。"""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - empty body
        body = {}
    limit = body.get("limit", 3) if isinstance(body, dict) else 3
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 5:
        return web.json_response({"error": "limit must be 1..5"}, status=400)
    started = autosum.get(ctx).start_background(limit, "manual")
    return web.json_response({"started": started, "why": None if started else "busy"}, status=202 if started else 409)


async def post_chapters_settings(request: web.Request, ctx: Any) -> web.Response:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "json body required"}, status=400)
    auto = body.get("auto") if isinstance(body.get("auto"), bool) else None
    cap = body.get("dailyCap") if isinstance(body.get("dailyCap"), int) and not isinstance(body.get("dailyCap"), bool) else None
    return web.json_response(autosum.get(ctx).save_settings(auto=auto, dailyCap=cap))


def _stem(request: web.Request) -> str | None:
    stem = request.match_info.get("stem", "")
    return stem if chapters.STEM_RE.match(stem) else None


async def get_chapter(request: web.Request, _ctx: Any) -> web.Response:
    stem = _stem(request)
    if not stem:
        return web.json_response({"error": "bad chapter id"}, status=400)
    text = await asyncio.to_thread(chapters.read_raw, stem)
    if text is None:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response({"stem": stem, "text": text}, headers=NO_STORE)


async def put_chapter(request: web.Request, _ctx: Any) -> web.Response:
    stem = _stem(request)
    if not stem:
        return web.json_response({"error": "bad chapter id"}, status=400)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "json body required"}, status=400)
    text = body.get("text") if isinstance(body, dict) else None
    if not isinstance(text, str):
        return web.json_response({"error": "text required"}, status=400)
    try:
        ch = await asyncio.to_thread(chapters.save_edit, stem, text)
    except ValueError as err:
        return web.json_response({"error": str(err)}, status=422)
    await autosum.refresh_index()
    return web.json_response({"ok": True, "chapter": ch})


async def delete_chapter(request: web.Request, _ctx: Any) -> web.Response:
    """?mode=redo(次の要約で書き直す、既定) / skip(二度と要約しない)"""
    stem = _stem(request)
    if not stem:
        return web.json_response({"error": "bad chapter id"}, status=400)
    mode = request.query.get("mode", "redo")
    if mode not in {"redo", "skip"}:
        return web.json_response({"error": "mode must be redo or skip"}, status=400)
    existed = await asyncio.to_thread(chapters.remove, stem, keep_out=mode == "skip")
    await autosum.refresh_index()
    return web.json_response({"ok": True, "existed": existed, "mode": mode})


async def get_memory_brief(_request: web.Request, _ctx: Any) -> web.Response:
    text = await asyncio.to_thread(recall.brief)
    return web.json_response({"text": text}, headers=NO_STORE)


async def post_memory_relevant(request: web.Request, _ctx: Any) -> web.Response:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "json body required"}, status=400)
    query = body.get("query") if isinstance(body, dict) else None
    if not isinstance(query, str) or len(query) > 16000:
        return web.json_response({"error": "query (string, up to 16000 chars) required"}, status=400)
    hits = await asyncio.to_thread(recall.relevant, query)
    return web.json_response({"hits": hits, "context": recall.relevant_context(hits)}, headers=NO_STORE)


async def get_narratives(_request: web.Request, _ctx: Any) -> web.Response:
    items = await asyncio.to_thread(narrative.build_all)
    slim = [{k: n[k] for k in ("id", "name", "kind", "chapters", "updatedAt", "text")} for n in items]
    return web.json_response({"books": slim}, headers=NO_STORE)


async def get_promotions(_request: web.Request, _ctx: Any) -> web.Response:
    items = await asyncio.to_thread(narrative.promotions)
    return web.json_response({"candidates": items}, headers=NO_STORE)


def register_routes(_ctx: Any) -> list[AppRoute]:
    return [
        AppRoute(method="GET", path="/health", handler=get_health),
        AppRoute(method="GET", path="/shelf", handler=get_shelf),
        AppRoute(method="GET", path="/chapters/status", handler=get_chapters_status),
        AppRoute(method="POST", path="/chapters/run", handler=post_chapters_run),
        AppRoute(method="POST", path="/chapters/settings", handler=post_chapters_settings),
        AppRoute(method="GET", path="/memory/brief", handler=get_memory_brief),
        AppRoute(method="POST", path="/memory/relevant", handler=post_memory_relevant),
        AppRoute(method="GET", path="/memory/narratives", handler=get_narratives),
        AppRoute(method="GET", path="/memory/promotions", handler=get_promotions),
        AppRoute(method="GET", path="/chapters/{stem}", handler=get_chapter),
        AppRoute(method="PUT", path="/chapters/{stem}", handler=put_chapter),
        AppRoute(method="DELETE", path="/chapters/{stem}", handler=delete_chapter),
    ]
