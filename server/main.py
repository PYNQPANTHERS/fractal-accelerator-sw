"""WebSocket server entry point.

Accepts one browser connection at a time. Receives set_view / set_mode
JSON messages, drives the scheduler, streams binary tile frames back.

Run:
    python3 -m server.main
    SERVER_HOST=0.0.0.0 SERVER_PORT=8765 python3 -m server.main
"""

from __future__ import annotations

import asyncio
import logging
import os

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


def _browser_can_receive(ws: WebSocketServerProtocol) -> bool:
    """True if the browser's send buffer is below the backpressure threshold."""
    try:
        return ws.transport.get_write_buffer_size() < _MAX_SEND_BUFFER
    except Exception:
        return True  # if we can't read the buffer size, assume OK


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
) -> None:
    """Pick the next job, render all 16 tiles, stream each to the browser.

    Fix 1 — Event wake-up:
        Awaits scheduler.job_available instead of sleeping, so the render
        loop starts immediately when a new set_view arrives.

    Fix 2 — render_image (single round trip):
        One command to the C++ sim, 16 tile frames streamed back as each
        completes — matches the real PL's interrupt-per-tile behaviour.

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
        return

    panel_id, job = result
    log.info("rendering panel=%d frame_seq=%d", panel_id, job.frame_seq)

    # Collect all tiles for this render, then send them in one binary
    # WS frame. Avoids per-tile send overhead (~0.2 ms × N tiles).
    tiles: list[tuple[int, bytes]] = []
    async for tile_id, tile_bytes in render_image(job.config):
        tiles.append((tile_id, tile_bytes))
    if tiles:
        bundle = pack_tile_bundle(
            panel_id=panel_id,
            frame_seq=job.frame_seq,
            tiles=tiles,
        )
        await ws.send(bundle)


async def _handle(ws: WebSocketServerProtocol) -> None:
    """Handle one browser connection."""
    log.info("browser connected from %s", ws.remote_address)
    scheduler = Scheduler()

    # Fix 3 — Per-panel state: track the last known config for each panel
    # so we can preserve Julia zoom/pan across Mandelbrot panning.
    panel_state: dict[int, RenderConfig] = {}

    # Seed minimaps with default configs so they render on connect.
    _default_mandelbrot = RenderConfig(
        pan_x=0.0, pan_y=0.0, zoom=0, fractal_type="mandelbrot"
    )
    _default_julia = RenderConfig(
        pan_x=0.0, pan_y=0.0, zoom=0, fractal_type="julia",
        julia_c_real=-0.7, julia_c_imag=0.27,
    )
    panel_state[PANEL_MANDELBROT_MAIN]    = _default_mandelbrot
    panel_state[PANEL_JULIA_MAIN]         = _default_julia
    panel_state[PANEL_MANDELBROT_MINIMAP] = _default_mandelbrot
    panel_state[PANEL_JULIA_MINIMAP]      = _default_julia

    scheduler.push(PANEL_MANDELBROT_MINIMAP, _default_mandelbrot, frame_seq=0)
    scheduler.push(PANEL_JULIA_MINIMAP,      _default_julia,       frame_seq=0)

    async def recv_loop() -> None:
        async for raw in ws:
            if not isinstance(raw, str):
                continue
            msg = parse_message(raw)

            if isinstance(msg, SetViewMessage):
                prev = panel_state.get(msg.panel_id)
                cfg = set_view_to_config(msg)
                panel_state[msg.panel_id] = cfg
                scheduler.push(
                    msg.panel_id,
                    cfg,
                    msg.frame_seq,
                    interaction=msg.interaction,
                )

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

            elif isinstance(msg, SetModeMessage):
                scheduler.set_mode(msg.mode)
                log.info("mode → %s", msg.mode)

            elif isinstance(msg, UnknownMessage):
                log.warning("unknown message: %s", msg.raw)

    async def render_loop() -> None:
        while True:
            await _render_and_stream(ws, scheduler)

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
