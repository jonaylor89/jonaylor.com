import hashlib

import pytest

from mypeople import bluetooth, transfer


def authenticated(version=2):
    p = bluetooth.SessionProtocol("synthetic-token", 9999999999, version=version)
    data = b"x" * 52
    assert p.feed(f"SHERLOQ{version} synthetic-token\n".encode() + bluetooth.frame_header(data, upload=True) + data) == "uploaded"
    return p, data


@pytest.mark.parametrize("version", [2, 3])
def test_import_keepalives_never_acknowledge_and_support_split_and_coalesced_lines(version):
    p, data = authenticated(version)
    p.expect_snapshot(data)
    assert p.feed(b"WA") is None
    assert p.feed(b"IT\nWAIT\n") == "waiting"
    assert not p.imported.is_set()
    ack = ("WAIT\nOK " + hashlib.sha256(data).hexdigest() + "\n").encode()
    assert p.feed(ack) == "confirmed"
    assert p.imported.is_set()


def test_keepalive_requires_an_authenticated_upload_and_prepared_snapshot():
    p, _ = authenticated()
    with pytest.raises(transfer.TransferError, match="before a snapshot"):
        p.feed(b"WAIT\n")
    legacy = bluetooth.SessionProtocol("synthetic-token", 9999999999)
    legacy.feed(b"SHERLOQ1 synthetic-token\n")
    with pytest.raises(transfer.TransferError):
        legacy.feed(b"WAIT\n")


def test_keepalive_does_not_authorize_an_incorrect_digest():
    p, data = authenticated()
    p.expect_snapshot(data)
    p.feed(b"WAIT\n")
    with pytest.raises(transfer.TransferError):
        p.feed(b"OK " + b"a" * 64 + b"\n")
    assert not p.imported.is_set()


class ClockEvent:
    def __init__(self, clock, tick):
        self.clock, self.tick, self.value = clock, tick, False

    def is_set(self):
        return self.value

    def set(self):
        self.value = True

    def wait(self, seconds):
        self.clock[0] += seconds
        self.tick(self.clock[0])
        return self.value


@pytest.mark.parametrize("version", [2, 3])
def test_valid_keepalives_allow_a_192_second_durable_import_without_faking_a_receipt(monkeypatch, version):
    clock = [100.0]
    monkeypatch.setattr(bluetooth.time, "monotonic", lambda: clock[0])
    p, data = authenticated(version)
    p.expect_snapshot(data)
    digest = hashlib.sha256(data).hexdigest()

    def tick(now):
        if int(now - 100) % 10 == 0:
            assert p.feed(b"WAIT\n") == "waiting"
            assert not p.imported.is_set()
        if now - 100 >= 192:
            p.feed(f"OK {digest}\n".encode())

    p.imported = ClockEvent(clock, tick)
    progress = []
    import threading
    assert bluetooth._wait_for_import(p, threading.Event(), 100 + 1200, progress=lambda: progress.append(clock[0]))
    assert clock[0] == 292
    assert p.imported.is_set()
    assert progress


@pytest.mark.parametrize("keepalive,limit,expected", [(False, 1200, 120), (True, 200, 200)])
def test_import_wait_still_bounds_dead_peers_and_total_session(monkeypatch, keepalive, limit, expected):
    clock = [0.0]
    monkeypatch.setattr(bluetooth.time, "monotonic", lambda: clock[0])
    p, data = authenticated(3)
    p.expect_snapshot(data)
    p.imported = ClockEvent(clock, lambda now: p.feed(b"WAIT\n") if keepalive and int(now) % 10 == 0 else None)
    import threading
    assert not bluetooth._wait_for_import(p, threading.Event(), limit)
    assert clock[0] == expected
    assert not p.imported.is_set()


def test_partial_or_unvalidated_bytes_do_not_extend_the_import_idle_timeout(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(bluetooth.time, "monotonic", lambda: clock[0])
    p, data = authenticated(3)
    p.expect_snapshot(data)
    p.feed(b"WA")
    p.imported = ClockEvent(clock, lambda now: None)
    import threading
    assert not bluetooth._wait_for_import(p, threading.Event(), 1200)
    assert clock[0] == 120
    assert not p.imported.is_set()


def test_duplicate_native_open_does_not_replace_or_close_an_accepted_channel():
    from types import SimpleNamespace
    def channel(ident, opened=True):
        return SimpleNamespace(getObjectID=lambda: ident, isOpen=lambda: opened)
    old = channel(42)
    receivers = [SimpleNamespace(channel=old)]
    assert bluetooth._known_channel(receivers, old)
    assert bluetooth._known_channel(receivers, channel(42))  # Different ObjC wrapper, same native channel
    assert not bluetooth._known_channel(receivers, channel(43))
    assert not bluetooth._known_channel([SimpleNamespace(channel=channel(42, False))], channel(42))
    assert not bluetooth._known_channel([SimpleNamespace(channel=channel(0))], channel(0))


def test_offer_advertises_keepalive_only_when_supported():
    args = ("AA:BB:CC:DD:EE:FF", "service", "password", "source", "token", 9999999999)
    assert "wait_keepalive" not in bluetooth.offer(*args)
    assert bluetooth.offer(*args, version=2, wait_keepalive=True)["wait_keepalive"] is True
