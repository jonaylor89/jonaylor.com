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
