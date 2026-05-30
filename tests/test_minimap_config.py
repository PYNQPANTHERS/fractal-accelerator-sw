from __future__ import annotations

from server.main import (
    _julia_minimap_config,
    _julia_minimap_needs_render,
)
from server.protocol import SetMinimapsMessage, SetTelemetryMessage, parse_message
from sim.config import RenderConfig


def _julia_cfg(
    c_real: float = -0.5,
    c_imag: float = 0.0,
    preview: bool = False,
) -> RenderConfig:
    return RenderConfig(
        pan_x=1.25,
        pan_y=-0.75,
        zoom=7,
        fractal_type="julia",
        julia_c_real=c_real,
        julia_c_imag=c_imag,
        max_iter=1024,
        preview=preview,
    )


def test_julia_minimap_config_is_an_overview_of_the_current_c():
    cfg = _julia_minimap_config(_julia_cfg(0.1, -0.2, preview=True))

    assert cfg.pan_x == 0.0
    assert cfg.pan_y == 0.0
    assert cfg.zoom == 0
    assert cfg.fractal_type == "julia"
    assert cfg.julia_c_real == 0.1
    assert cfg.julia_c_imag == -0.2
    assert cfg.max_iter == 256
    assert cfg.preview is True


def test_julia_minimap_rerenders_on_c_change_or_preview_upgrade():
    existing = _julia_minimap_config(_julia_cfg(preview=True))

    assert not _julia_minimap_needs_render(
        existing,
        _julia_cfg(preview=True),
    )
    assert _julia_minimap_needs_render(
        existing,
        _julia_cfg(preview=False),
    )
    assert _julia_minimap_needs_render(
        existing,
        _julia_cfg(c_real=-0.45, preview=True),
    )


def test_parse_set_minimaps_message():
    msg = parse_message('{"type":"set_minimaps","enabled":false,"frame_seq":99}')

    assert isinstance(msg, SetMinimapsMessage)
    assert msg.enabled is False
    assert msg.frame_seq == 99


def test_parse_set_telemetry_message():
    msg = parse_message('{"type":"set_telemetry","enabled":true}')

    assert isinstance(msg, SetTelemetryMessage)
    assert msg.enabled is True
