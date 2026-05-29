"""Render job scheduler.

Holds one pending RenderConfig per panel (last-write-wins coalescing).
Picks the next job to render based on the current scheduling mode.

Two modes:
    performance    — active panel gets full renderer throughput;
                     the other main panel defers until active has
                     been idle for DEFER_MS milliseconds.
    live_evolution — both main panels interleave; each gets roughly
                     half the renderer throughput but both update
                     continuously.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

from sim.config import RenderConfig
from server.protocol import (
    PANEL_MANDELBROT_MAIN,
    PANEL_JULIA_MAIN,
    PANEL_MANDELBROT_MINIMAP,
    PANEL_JULIA_MINIMAP,
)


DEFER_MS = 250  # ms of inactivity on active panel before the other renders
                # in Performance mode. Larger = active panel feels snappier
                # because Julia coupling stops competing for the renderer
                # while the user is still moving Mandelbrot.


@dataclass
class PendingJob:
    config:    RenderConfig
    frame_seq: int


class Scheduler:
    """Single-slot coalescing scheduler for up to 4 panels."""

    def __init__(self) -> None:
        self._pending: dict[int, PendingJob] = {}
        self._active_panel: int = PANEL_MANDELBROT_MAIN
        self._last_input_time: float = 0.0
        self.mode: str = "performance"
        self._last_rendered_main: int = PANEL_JULIA_MAIN

        # Event that fires whenever a new job is pushed. The render loop
        # awaits this instead of sleeping — zero idle latency on new input.
        self.job_available: asyncio.Event = asyncio.Event()

    # ── Input ─────────────────────────────────────────────────────────────────

    def push(self,
             panel_id: int,
             config: RenderConfig,
             frame_seq: int,
             mark_active: bool = True) -> None:
        """Record the latest config for a panel. Overwrites any previous pending.

        mark_active=False is used for system-derived pushes (e.g. the
        server-side Julia coupling triggered by a Mandelbrot pan). Those
        must not steal "active panel" status from the panel the user is
        actually interacting with — otherwise Performance mode keeps
        re-deferring the user's own panel because every stream-commit's
        coupling push resets the idle timer.
        """
        self._pending[panel_id] = PendingJob(config=config, frame_seq=frame_seq)
        if mark_active and panel_id in (PANEL_MANDELBROT_MAIN, PANEL_JULIA_MAIN):
            self._active_panel = panel_id
            self._last_input_time = time.monotonic()
        self.job_available.set()

    def set_mode(self, mode: str) -> None:
        if mode in ("performance", "live_evolution"):
            self.mode = mode
            # A mode switch can make already-pending work eligible
            # immediately, so wake the render loop even without a new view.
            self.job_available.set()

    def has_pending(self) -> bool:
        """True if any job is queued, even if currently deferred."""
        return bool(self._pending)

    def seconds_until_next_job(self) -> Optional[float]:
        """Seconds until the current pending set can produce work.

        Returns:
            None  — no work is pending; wait indefinitely for a push.
            0.0   — a job is ready now.
            >0.0  — Performance mode has only the non-active main pending,
                    and it is still inside the defer window.
        """
        if not self._pending:
            return None
        if self._pick_panel() is not None:
            return 0.0
        if self.mode != "performance":
            return 0.0

        idle_ms = (time.monotonic() - self._last_input_time) * 1000
        return max(0.0, (DEFER_MS - idle_ms) / 1000)

    # ── Output ────────────────────────────────────────────────────────────────

    def next_job(self) -> Optional[tuple[int, PendingJob]]:
        """Return (panel_id, PendingJob) for the next render, or None if idle."""
        panel_id = self._pick_panel()
        if panel_id is None:
            self.job_available.clear()
            return None
        job = self._pending.pop(panel_id)
        if panel_id in (PANEL_MANDELBROT_MAIN, PANEL_JULIA_MAIN):
            self._last_rendered_main = panel_id
        return panel_id, job

    # ── Priority logic ────────────────────────────────────────────────────────

    def _pick_panel(self) -> Optional[int]:
        if not self._pending:
            return None
        return self._pick_performance() if self.mode == "performance" \
            else self._pick_live_evolution()

    def _pick_performance(self) -> Optional[int]:
        other_main = (PANEL_JULIA_MAIN
                      if self._active_panel == PANEL_MANDELBROT_MAIN
                      else PANEL_MANDELBROT_MAIN)
        idle_ms = (time.monotonic() - self._last_input_time) * 1000

        if self._active_panel in self._pending:
            return self._active_panel
        if idle_ms >= DEFER_MS and other_main in self._pending:
            return other_main
        for minimap in (PANEL_MANDELBROT_MINIMAP, PANEL_JULIA_MINIMAP):
            if minimap in self._pending:
                return minimap
        return None

    def _pick_live_evolution(self) -> Optional[int]:
        mains = [PANEL_MANDELBROT_MAIN, PANEL_JULIA_MAIN]
        pending_mains = [p for p in mains if p in self._pending]
        if pending_mains:
            for panel_id in mains:
                if panel_id in pending_mains and panel_id != self._last_rendered_main:
                    return panel_id
            return pending_mains[0]
        for minimap in (PANEL_MANDELBROT_MINIMAP, PANEL_JULIA_MINIMAP):
            if minimap in self._pending:
                return minimap
        return None
