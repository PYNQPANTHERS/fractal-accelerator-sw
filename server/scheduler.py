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


DEFER_MS = 50   # ms of inactivity on the active panel before the other renders


@dataclass
class PendingJob:
    config:    RenderConfig
    frame_seq: int


class Scheduler:
    """Single-slot coalescing scheduler for up to 4 panels."""

    def __init__(self) -> None:
        # One pending slot per panel. Newest write wins.
        self._pending: dict[int, PendingJob] = {}

        self._active_panel: int = PANEL_MANDELBROT_MAIN
        self._last_input_time: float = 0.0

        self.mode: str = "performance"

        # Tracks which main panel was last rendered (for live_evolution
        # round-robin between the two main panels).
        self._last_rendered_main: int = PANEL_JULIA_MAIN  # so Mandelbrot goes first

    # ── Input ─────────────────────────────────────────────────────────────────

    def push(self, panel_id: int, config: RenderConfig, frame_seq: int) -> None:
        """Record the latest config for a panel. Overwrites any previous pending."""
        self._pending[panel_id] = PendingJob(config=config, frame_seq=frame_seq)

        if panel_id in (PANEL_MANDELBROT_MAIN, PANEL_JULIA_MAIN):
            self._active_panel = panel_id
            self._last_input_time = time.monotonic()

    def set_mode(self, mode: str) -> None:
        if mode in ("performance", "live_evolution"):
            self.mode = mode

    # ── Output ────────────────────────────────────────────────────────────────

    def next_job(self) -> Optional[tuple[int, PendingJob]]:
        """Return (panel_id, PendingJob) for the next render, or None if idle.

        Consumes the slot — the same job won't be returned again unless
        push() is called again for that panel.
        """
        panel_id = self._pick_panel()
        if panel_id is None:
            return None

        job = self._pending.pop(panel_id)

        if panel_id in (PANEL_MANDELBROT_MAIN, PANEL_JULIA_MAIN):
            self._last_rendered_main = panel_id

        return panel_id, job

    # ── Priority logic ────────────────────────────────────────────────────────

    def _pick_panel(self) -> Optional[int]:
        if not self._pending:
            return None

        if self.mode == "performance":
            return self._pick_performance()
        else:
            return self._pick_live_evolution()

    def _pick_performance(self) -> Optional[int]:
        """Active main panel wins. The other main panel only renders if
        the active panel has had no input for DEFER_MS."""

        other_main = (
            PANEL_JULIA_MAIN
            if self._active_panel == PANEL_MANDELBROT_MAIN
            else PANEL_MANDELBROT_MAIN
        )
        idle_ms = (time.monotonic() - self._last_input_time) * 1000

        # Active main panel has first priority.
        if self._active_panel in self._pending:
            return self._active_panel

        # Other main panel only if active has been idle long enough.
        if idle_ms >= DEFER_MS and other_main in self._pending:
            return other_main

        # Minimaps are background work — only when both mains are quiet.
        for minimap in (PANEL_MANDELBROT_MINIMAP, PANEL_JULIA_MINIMAP):
            if minimap in self._pending:
                return minimap

        return None

    def _pick_live_evolution(self) -> Optional[int]:
        """Round-robin between the two main panels so both evolve visibly.
        Minimaps fill any remaining idle gaps."""

        mains = [PANEL_MANDELBROT_MAIN, PANEL_JULIA_MAIN]
        pending_mains = [p for p in mains if p in self._pending]

        if pending_mains:
            # Alternate: pick whichever main panel was NOT last rendered.
            for panel_id in mains:
                if panel_id in pending_mains and panel_id != self._last_rendered_main:
                    return panel_id
            # Both pending and same as last — just pick the first one.
            return pending_mains[0]

        for minimap in (PANEL_MANDELBROT_MINIMAP, PANEL_JULIA_MINIMAP):
            if minimap in self._pending:
                return minimap

        return None
