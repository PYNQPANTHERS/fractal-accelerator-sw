"""WebSocket server entry point.

Accepts one browser connection at a time. Receives set_view / set_mode
JSON messages, drives the scheduler, streams binary tile frames back.

Run:
    python3 -m server.main
    SERVER_HOST=0.0.0.0 SERVER_PORT=8765 python3 -m server.main
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import replace
import json
import logging
import os
import time

import websockets
from websockets.asyncio.server import ServerConnection as WebSocketServerProtocol

from sim.config import RenderConfig
from sim.renderer import render_image, ping as sim_ping
from server.protocol import (
    parse_message,
    pack_tile_frame,  # kept exported for tests/back-compat
    pack_tile_bundle,
    set_view_to_config,
    SetViewMessage,
    SetModeMessage,
    SetMinimapsMessage,
    SetTelemetryMessage,
    UnknownMessage,
    PANEL_MANDELBROT_MAIN,
    PANEL_JULIA_MAIN,
    PANEL_MANDELBROT_MINIMAP,
    PANEL_JULIA_MINIMAP,
)
from server.scheduler import Scheduler

log = logging.getLogger("server")

HOST = os.environ.get("SERVER_HOST", "localhost")
PORT = int(os.environ.get("SERVER_PORT", "8765"))

# Maximum bytes allowed in the WebSocket send buffer before we consider
# the browser too slow and drop the current render.
_MAX_SEND_BUFFER = 256 * 1024   # 256 KB — about 8 tiles worth
_MINIMAP_MAX_ITER = 256
_TELEMETRY_TILE_COLS = 4
_TELEMETRY_TILE_ROWS = 4


def _quality_label(config: RenderConfig) -> str:
    return "preview" if config.preview else "full"


def _config_for_mode(config: RenderConfig, mode: str) -> RenderConfig:
    if mode == "live_evolution" and config.preview:
        return replace(config, preview=False)
    return config


def _mandelbrot_minimap_config() -> RenderConfig:
    return RenderConfig(
        pan_x=-0.5,
        pan_y=0.0,
        zoom=0,
        fractal_type="mandelbrot",
        max_iter=_MINIMAP_MAX_ITER,
    )


def _julia_minimap_config(source: RenderConfig) -> RenderConfig:
    return RenderConfig(
        pan_x=0.0,
        pan_y=0.0,
        zoom=0,
        fractal_type="julia",
        julia_c_real=source.julia_c_real,
        julia_c_imag=source.julia_c_imag,
        max_iter=_MINIMAP_MAX_ITER,
        preview=source.preview,
    )


def _julia_minimap_needs_render(
    existing: RenderConfig,
    source: RenderConfig,
) -> bool:
    return (
        existing.julia_c_real != source.julia_c_real
        or existing.julia_c_imag != source.julia_c_imag
        or (existing.preview and not source.preview)
    )


def _browser_can_receive(ws: WebSocketServerProtocol) -> bool:
    """True if the browser's send buffer is below the backpressure threshold."""
    try:
        return ws.transport.get_write_buffer_size() < _MAX_SEND_BUFFER
    except Exception:
        return True  # if we can't read the buffer size, assume OK


async def _send_telemetry(
    ws: WebSocketServerProtocol,
    enabled: bool,
    payload: dict,
) -> None:
    if not enabled:
        return
    await ws.send(json.dumps({"type": "telemetry", **payload}))


async def _send_scheduler_snapshot(
    ws: WebSocketServerProtocol,
    scheduler: Scheduler,
    enabled: bool,
) -> None:
    await _send_telemetry(
        ws,
        enabled,
        {"event": "scheduler", **scheduler.snapshot()},
    )


async def _wait_for_scheduler(scheduler: Scheduler) -> None:
    """Wait until a pending job may be renderable, or new input arrives."""
    timeout = scheduler.seconds_until_next_job()
    if timeout is None:
        await scheduler.job_available.wait()
        return
    if timeout <= 0:
        return
    try:
        await asyncio.wait_for(scheduler.job_available.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        pass


async def _render_and_stream(
    ws: WebSocketServerProtocol,
    scheduler: Scheduler,
    telemetry_enabled: Callable[[], bool],
) -> None:
    """Pick the next job, render all 16 tiles, stream the result to the browser.

    Fix 1 — Event wake-up:
        Awaits scheduler.job_available instead of sleeping, so the render
        loop starts immediately when a new set_view arrives.

    Fix 2 — render_image (single round trip):
        One command to the C++ sim, 16 tile frames streamed back as each
        completes for telemetry. The binary payload is bundled into one
        WebSocket send to reduce browser/socket overhead.

    Fix 4 — Backpressure:
        If the browser's send buffer is too full, skip this render and wait
        for the next job rather than queuing tiles the browser can't consume.
    """
    result = scheduler.next_job()
    if result is None:
        # Pending work may be deferred by Performance mode, but a fresh
        # active-panel push should wake us immediately instead of paying
        # a blind polling sleep on every Mandelbrot frame.
        await _wait_for_scheduler(scheduler)
        return

    # Fix 4: drop render if browser buffer is backed up.
    if not _browser_can_receive(ws):
        log.debug("backpressure: dropping render for panel=%d", result[0])
        await _send_telemetry(
            ws,
            telemetry_enabled(),
            {
                "event": "render_dropped",
                "reason": "browser_backpressure",
                "panel_id": result[0],
                "frame_seq": result[1].frame_seq,
            },
        )
        return

    panel_id, job = result
    config = _config_for_mode(job.config, scheduler.mode)
    log.info("rendering panel=%d frame_seq=%d", panel_id, job.frame_seq)
    started = time.perf_counter()
    await _send_telemetry(
        ws,
        telemetry_enabled(),
        {
            "event": "render_started",
            "panel_id": panel_id,
            "frame_seq": job.frame_seq,
            "quality": _quality_label(config),
            "max_iter": config.max_iter,
            "backend": "sim",
            "tile_cols": _TELEMETRY_TILE_COLS,
            "tile_rows": _TELEMETRY_TILE_ROWS,
        },
    )

    # Collect all tiles for this render, then send them in one binary
    # WS frame. Avoids per-tile send overhead (~0.2 ms × N tiles).
    tiles: list[tuple[int, bytes]] = []
    async for tile_id, tile_bytes, tile_elapsed_ms in render_image(config):
        tiles.append((tile_id, tile_bytes))
        await _send_telemetry(
            ws,
            telemetry_enabled(),
            {
                "event": "tile_done",
                "panel_id": panel_id,
                "frame_seq": job.frame_seq,
                "tile_id": tile_id,
                "elapsed_ms": round(tile_elapsed_ms, 3),
                "quality": _quality_label(config),
                "backend": "sim",
                "stage": "available",
                "tile_cols": _TELEMETRY_TILE_COLS,
                "tile_rows": _TELEMETRY_TILE_ROWS,
            },
        )
    if tiles:
        bundle = pack_tile_bundle(
            panel_id=panel_id,
            frame_seq=job.frame_seq,
            tiles=tiles,
        )
        await ws.send(bundle)
        await _send_telemetry(
            ws,
            telemetry_enabled(),
            {
                "event": "render_finished",
                "panel_id": panel_id,
                "frame_seq": job.frame_seq,
                "elapsed_ms": round((time.perf_counter() - started) * 1000.0, 3),
                "tile_count": len(tiles),
                "quality": _quality_label(config),
                "backend": "sim",
            },
        )


async def _handle(ws: WebSocketServerProtocol) -> None:
    """Handle one browser connection."""
    log.info("browser connected from %s", ws.remote_address)
    scheduler = Scheduler()
    minimaps_enabled = True
    telemetry_enabled = False

    # Fix 3 — Per-panel state: track the last known config for each panel
    # so we can preserve Julia zoom/pan across Mandelbrot panning.
    panel_state: dict[int, RenderConfig] = {}

    def queue_minimap(
        panel_id: int,
        config: RenderConfig,
        frame_seq: int,
    ) -> None:
        panel_state[panel_id] = config
        if minimaps_enabled:
            scheduler.push(panel_id, config, frame_seq, mark_active=False)

    # Seed minimaps with default configs so they render on connect.
    _default_mandelbrot = RenderConfig(
        pan_x=-0.5, pan_y=0.0, zoom=0, fractal_type="mandelbrot"
    )
    _default_julia = RenderConfig(
        pan_x=0.0, pan_y=0.0, zoom=0, fractal_type="julia",
        julia_c_real=-0.7, julia_c_imag=0.27,
    )
    _default_mandelbrot_minimap = _mandelbrot_minimap_config()
    _default_julia_minimap = _julia_minimap_config(_default_julia)
    panel_state[PANEL_MANDELBROT_MAIN]    = _default_mandelbrot
    panel_state[PANEL_JULIA_MAIN]         = _default_julia
    queue_minimap(PANEL_MANDELBROT_MINIMAP, _default_mandelbrot_minimap, frame_seq=0)
    queue_minimap(PANEL_JULIA_MINIMAP,      _default_julia_minimap,      frame_seq=0)

    async def recv_loop() -> None:
        nonlocal minimaps_enabled, telemetry_enabled

        async for raw in ws:
            if not isinstance(raw, str):
                continue
            msg = parse_message(raw)

            if isinstance(msg, SetViewMessage):
                prev = panel_state.get(msg.panel_id)
                cfg = _config_for_mode(set_view_to_config(msg), scheduler.mode)
                panel_state[msg.panel_id] = cfg
                scheduler.push(
                    msg.panel_id,
                    cfg,
                    msg.frame_seq,
                    interaction=msg.interaction,
                )
                await _send_scheduler_snapshot(ws, scheduler, telemetry_enabled)

                # Mandelbrot pan changes Julia's c. Pure zoom doesn't:
                # the crosshair stays on the same complex point, so no
                # Julia re-render is needed. Skip the coupling push then
                # — saves a 16-tile render the user can't see anyway.
                if msg.panel_id == PANEL_MANDELBROT_MAIN:
                    pan_changed = (prev is None
                                   or prev.pan_x != cfg.pan_x
                                   or prev.pan_y != cfg.pan_y)
                    existing_julia = panel_state.get(PANEL_JULIA_MAIN, _default_julia)
                    julia_needs_quality_upgrade = (
                        existing_julia.preview and not cfg.preview
                    )
                    if pan_changed or julia_needs_quality_upgrade:
                        julia_cfg = RenderConfig(
                            pan_x        = existing_julia.pan_x,
                            pan_y        = existing_julia.pan_y,
                            zoom         = existing_julia.zoom,
                            fractal_type = "julia",
                            julia_c_real = msg.pan_x,   # c = Mandelbrot centre
                            julia_c_imag = msg.pan_y,
                            max_iter     = existing_julia.max_iter,
                            # If the Mandelbrot drag is in preview mode,
                            # render Julia in preview too — keeps the
                            # live coupling fast during interaction.
                            preview      = cfg.preview,
                        )
                        panel_state[PANEL_JULIA_MAIN] = julia_cfg
                        scheduler.push(PANEL_JULIA_MAIN, julia_cfg, msg.frame_seq,
                                       mark_active=False)
                        await _send_scheduler_snapshot(
                            ws,
                            scheduler,
                            telemetry_enabled,
                        )
                    existing_julia_minimap = panel_state.get(
                        PANEL_JULIA_MINIMAP,
                        _default_julia_minimap,
                    )
                    julia_minimap_source = panel_state.get(
                        PANEL_JULIA_MAIN,
                        existing_julia,
                    )
                    if _julia_minimap_needs_render(
                        existing_julia_minimap,
                        julia_minimap_source,
                    ):
                        julia_minimap_cfg = _julia_minimap_config(
                            julia_minimap_source
                        )
                        queue_minimap(
                            PANEL_JULIA_MINIMAP,
                            julia_minimap_cfg,
                            msg.frame_seq,
                        )
                        await _send_scheduler_snapshot(
                            ws,
                            scheduler,
                            telemetry_enabled,
                        )
                elif msg.panel_id == PANEL_JULIA_MAIN:
                    existing_julia_minimap = panel_state.get(
                        PANEL_JULIA_MINIMAP,
                        _default_julia_minimap,
                    )
                    if _julia_minimap_needs_render(
                        existing_julia_minimap,
                        cfg,
                    ):
                        julia_minimap_cfg = _julia_minimap_config(cfg)
                        queue_minimap(
                            PANEL_JULIA_MINIMAP,
                            julia_minimap_cfg,
                            msg.frame_seq,
                        )
                        await _send_scheduler_snapshot(
                            ws,
                            scheduler,
                            telemetry_enabled,
                        )

            elif isinstance(msg, SetModeMessage):
                scheduler.set_mode(msg.mode)
                if msg.mode == "live_evolution":
                    for panel_id, config in list(panel_state.items()):
                        panel_state[panel_id] = _config_for_mode(config, msg.mode)
                await _send_scheduler_snapshot(ws, scheduler, telemetry_enabled)
                log.info("mode → %s", msg.mode)

            elif isinstance(msg, SetMinimapsMessage):
                minimaps_enabled = msg.enabled
                if minimaps_enabled:
                    queue_minimap(
                        PANEL_MANDELBROT_MINIMAP,
                        _mandelbrot_minimap_config(),
                        msg.frame_seq,
                    )
                    queue_minimap(
                        PANEL_JULIA_MINIMAP,
                        _julia_minimap_config(
                            panel_state.get(PANEL_JULIA_MAIN, _default_julia)
                        ),
                        msg.frame_seq,
                    )
                else:
                    scheduler.cancel(
                        PANEL_MANDELBROT_MINIMAP,
                        PANEL_JULIA_MINIMAP,
                    )
                await _send_scheduler_snapshot(ws, scheduler, telemetry_enabled)
                log.info("minimaps → %s", "on" if minimaps_enabled else "off")

            elif isinstance(msg, SetTelemetryMessage):
                telemetry_enabled = msg.enabled
                await _send_scheduler_snapshot(ws, scheduler, telemetry_enabled)
                log.info("telemetry → %s", "on" if telemetry_enabled else "off")

            elif isinstance(msg, UnknownMessage):
                log.warning("unknown message: %s", msg.raw)

    async def render_loop() -> None:
        while True:
            await _render_and_stream(
                ws,
                scheduler,
                lambda: telemetry_enabled,
            )

    try:
        await asyncio.gather(recv_loop(), render_loop())
    except websockets.exceptions.ConnectionClosed:
        log.info("browser disconnected")


async def main() -> None:
    try:
        sim_ping()
    except Exception as e:
        log.error("sim not available: %s", e)
        raise SystemExit(1)

    log.info("fractal server on ws://%s:%d", HOST, PORT)
    # compression=None disables permessage-deflate. Our payload is
    # entropy-dense palette indices — gzipping them buys nothing and
    # costs ~3-5 ms per render of CPU time on both endpoints.
    async with websockets.serve(_handle, HOST, PORT, compression=None):
        await asyncio.Future()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    asyncio.run(main())
