from __future__ import annotations

from server.main import _mandelbrot_minimap_config
from server.protocol import SetMinimapsMessage, SetTelemetryMessage, parse_message


def test_mandelbrot_minimap_config_is_static_overview():
    cfg = _mandelbrot_minimap_config()

    assert cfg.pan_x == -0.5
    assert cfg.pan_y == 0.0
    assert cfg.zoom == 0
    assert cfg.fractal_type == "mandelbrot"
    assert cfg.max_iter == 256
    assert cfg.preview is False


def test_parse_set_minimaps_message():
    msg = parse_message('{"type":"set_minimaps","enabled":false,"frame_seq":99}')

    assert isinstance(msg, SetMinimapsMessage)
    assert msg.enabled is False
    assert msg.frame_seq == 99


def test_parse_set_telemetry_message():
    msg = parse_message('{"type":"set_telemetry","enabled":true}')

    assert isinstance(msg, SetTelemetryMessage)
    assert msg.enabled is True
