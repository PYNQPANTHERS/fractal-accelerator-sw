from __future__ import annotations

from server.protocol import SetMinimapsMessage, SetTelemetryMessage, parse_message


def test_parse_set_minimaps_message():
    msg = parse_message('{"type":"set_minimaps","enabled":false,"frame_seq":99}')

    assert isinstance(msg, SetMinimapsMessage)
    assert msg.enabled is False
    assert msg.frame_seq == 99


def test_parse_set_telemetry_message():
    msg = parse_message('{"type":"set_telemetry","enabled":true}')

    assert isinstance(msg, SetTelemetryMessage)
    assert msg.enabled is True
