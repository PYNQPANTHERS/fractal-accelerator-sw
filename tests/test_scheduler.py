from __future__ import annotations

import asyncio

import pytest

import server.scheduler as scheduler_mod
from server.main import _wait_for_scheduler
from server.protocol import PANEL_JULIA_MAIN, PANEL_MANDELBROT_MAIN
from server.scheduler import Scheduler
from sim.config import RenderConfig


@pytest.fixture
def cfg() -> RenderConfig:
    return RenderConfig(pan_x=0.0, pan_y=0.0, zoom=0, fractal_type="mandelbrot")


def test_performance_defer_reports_exact_remaining_delay(monkeypatch, cfg):
    now = 100.0
    monkeypatch.setattr(scheduler_mod.time, "monotonic", lambda: now)

    scheduler = Scheduler()
    scheduler.push(PANEL_MANDELBROT_MAIN, cfg, frame_seq=1)
    assert scheduler.next_job()[0] == PANEL_MANDELBROT_MAIN

    scheduler.push(PANEL_JULIA_MAIN, cfg, frame_seq=1, mark_active=False)
    now = 100.050

    assert scheduler.next_job() is None
    assert scheduler.seconds_until_next_job() == pytest.approx(0.200)

    now = 100.250
    assert scheduler.next_job()[0] == PANEL_JULIA_MAIN


def test_deferred_wait_wakes_when_active_panel_gets_work(monkeypatch, cfg):
    now = 200.0
    monkeypatch.setattr(scheduler_mod.time, "monotonic", lambda: now)

    async def scenario() -> None:
        nonlocal now
        scheduler = Scheduler()
        scheduler.push(PANEL_MANDELBROT_MAIN, cfg, frame_seq=1)
        assert scheduler.next_job()[0] == PANEL_MANDELBROT_MAIN
        scheduler.push(PANEL_JULIA_MAIN, cfg, frame_seq=1, mark_active=False)

        now = 200.010
        assert scheduler.next_job() is None

        waiter = asyncio.create_task(_wait_for_scheduler(scheduler))
        await asyncio.sleep(0)

        now = 200.020
        scheduler.push(PANEL_MANDELBROT_MAIN, cfg, frame_seq=2)
        await asyncio.wait_for(waiter, timeout=0.05)

        assert scheduler.next_job()[0] == PANEL_MANDELBROT_MAIN

    asyncio.run(scenario())
