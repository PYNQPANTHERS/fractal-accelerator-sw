from __future__ import annotations

import asyncio

from server.main import _wait_for_scheduler
from server.protocol import PANEL_JULIA_MAIN, PANEL_MANDELBROT_MAIN
from server.scheduler import Scheduler
from sim.config import RenderConfig


def _cfg(fractal_type: str = "mandelbrot") -> RenderConfig:
    return RenderConfig(pan_x=0.0, pan_y=0.0, zoom=0, fractal_type=fractal_type)


def test_performance_uses_julia_as_background_during_active_drag():
    scheduler = Scheduler()

    scheduler.push(
        PANEL_MANDELBROT_MAIN,
        _cfg("mandelbrot"),
        frame_seq=1,
        interaction="active",
    )
    assert scheduler.next_job()[0] == PANEL_MANDELBROT_MAIN

    scheduler.push(
        PANEL_JULIA_MAIN,
        _cfg("julia"),
        frame_seq=1,
        mark_active=False,
    )
    assert scheduler.next_job()[0] == PANEL_JULIA_MAIN


def test_performance_prioritises_active_panel_over_background():
    scheduler = Scheduler()

    scheduler.push(
        PANEL_MANDELBROT_MAIN,
        _cfg("mandelbrot"),
        frame_seq=1,
        interaction="active",
    )
    assert scheduler.next_job()[0] == PANEL_MANDELBROT_MAIN

    scheduler.push(
        PANEL_JULIA_MAIN,
        _cfg("julia"),
        frame_seq=1,
        mark_active=False,
    )

    scheduler.push(
        PANEL_MANDELBROT_MAIN,
        _cfg("mandelbrot"),
        frame_seq=2,
        interaction="active",
    )
    assert scheduler.next_job()[0] == PANEL_MANDELBROT_MAIN
    assert scheduler.next_job()[0] == PANEL_JULIA_MAIN


def test_wait_wakes_when_active_view_arrives():
    async def scenario() -> None:
        scheduler = Scheduler()
        assert scheduler.next_job() is None

        waiter = asyncio.create_task(_wait_for_scheduler(scheduler))
        await asyncio.sleep(0)

        scheduler.push(
            PANEL_MANDELBROT_MAIN,
            _cfg("mandelbrot"),
            frame_seq=2,
            interaction="active",
        )
        await asyncio.wait_for(waiter, timeout=0.05)

        assert scheduler.next_job()[0] == PANEL_MANDELBROT_MAIN

    asyncio.run(scenario())


def test_live_evolution_can_render_julia_during_active_drag():
    scheduler = Scheduler()
    scheduler.set_mode("live_evolution")

    scheduler.push(
        PANEL_MANDELBROT_MAIN,
        _cfg("mandelbrot"),
        frame_seq=1,
        interaction="active",
    )
    assert scheduler.next_job()[0] == PANEL_MANDELBROT_MAIN

    scheduler.push(
        PANEL_JULIA_MAIN,
        _cfg("julia"),
        frame_seq=1,
        mark_active=False,
    )
    assert scheduler.next_job()[0] == PANEL_JULIA_MAIN
