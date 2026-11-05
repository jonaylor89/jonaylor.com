import hashlib
import struct
import uuid
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from mypeople import bluetooth, transfer


def test_bluetooth_frame_has_bounded_length_and_integrity_hash():
    encrypted = transfer.encrypt(b"synthetic payload", "synthetic-transfer-passphrase")
    header = bluetooth.frame_header(encrypted)
    assert header[:8] == b"SHBT0001"
    assert struct.unpack(">Q", header[8:16])[0] == len(encrypted)
    assert header[16:] == hashlib.sha256(encrypted).digest()
    with pytest.raises(transfer.TransferError):
        bluetooth.frame_header(b"short")


def test_import_ack_is_bound_to_connection_and_survives_fragmentation():
    session = bluetooth.SessionProtocol("synthetic-token", 200)
    assert session.feed(b"SHERLOQ1 synthetic-", now=100) is None
    assert session.feed(b"token\n", now=100) == "authenticated"
    assert not session.imported.is_set()
    assert session.feed(b"O", now=300) is None  # TTL applies to pairing, not finishing.
    assert session.feed(b"K\n", now=300) == "confirmed"
    assert session.imported.is_set()
    other = bluetooth.SessionProtocol("synthetic-token", 200)
    with pytest.raises(transfer.TransferError):
        other.feed(b"OK\n", now=100)
    assert not other.imported.is_set()


def test_duplex_upload_is_fragmented_bounded_and_checksum_verified():
    encrypted = transfer.encrypt(b"synthetic edits archive", "synthetic-transfer-passphrase")
    packet = bluetooth.frame_header(encrypted, upload=True) + encrypted
    session = bluetooth.SessionProtocol("synthetic-token", 200, version=2)
    assert session.feed(b"SHERLOQ2 synthetic-token\n", now=100) == "authenticated"
    events = [session.feed(packet[i:i + 7], now=100) for i in range(0, len(packet), 7)]
    assert events[-1] == "uploaded" and session.upload == encrypted
    snapshot = b"synthetic encrypted snapshot"
    session.expect_snapshot(snapshot)
    digest = hashlib.sha256(snapshot).hexdigest().encode()
    assert session.feed(b"OK " + digest[:10], now=300) is None
    assert session.feed(digest[10:] + b"\n", now=300) == "confirmed"
    assert session.imported.is_set()


def test_coalesced_auth_and_upload_and_incomplete_or_corrupt_upload():
    encrypted = transfer.encrypt(b"synthetic edits", "synthetic-transfer-passphrase")
    packet = bluetooth.frame_header(encrypted, upload=True) + encrypted
    def ready():
        s = bluetooth.SessionProtocol("synthetic-token", 200, version=2)
        s.feed(b"SHERLOQ2 synthetic-token\n", now=100)
        return s
    s = bluetooth.SessionProtocol("synthetic-token", 200, version=2)
    assert s.feed(b"SHERLOQ2 synthetic-token\n" + packet, now=100) == "uploaded"
    incomplete = ready()
    assert incomplete.feed(packet[:-1], now=100) is None and incomplete.upload is None
    corrupt = ready()
    with pytest.raises(transfer.TransferError, match="Damaged"):
        corrupt.feed(packet[:-1] + bytes([packet[-1] ^ 1]), now=100)
    assert corrupt.upload is None
    oversized = bluetooth.UPLOAD_MAGIC + struct.pack(">Q", bluetooth.MAX_UPLOAD + 1) + bytes(32)
    with pytest.raises(transfer.TransferError, match="size"):
        ready().feed(oversized, now=100)


def test_duplex_rejects_wrong_snapshot_ack_and_early_ack():
    payload = transfer.encrypt(b"synthetic edits", "synthetic-transfer-passphrase")
    s = bluetooth.SessionProtocol("synthetic-token", 200, version=2)
    s.feed(b"SHERLOQ2 synthetic-token\n" + bluetooth.frame_header(payload, upload=True) + payload, now=100)
    with pytest.raises(transfer.TransferError, match="before"):
        s.feed(b"OK\n", now=100)
    s.buffer.clear()
    s.expect_snapshot(b"current snapshot")
    with pytest.raises(transfer.TransferError, match="does not match"):
        s.feed(b"OK " + b"0" * 64 + b"\n", now=100)
    assert not s.imported.is_set()


def test_service_prefers_high_channel_and_advertises_that_exact_channel():
    service = str(uuid.uuid4())
    record = Mock()
    record.getRFCOMMChannelID_.return_value = (0, 30)
    publish = Mock(return_value=record)
    bt = SimpleNamespace(IOBluetoothSDPServiceRecord=SimpleNamespace(
        publishedServiceRecordWithDictionary_=publish))

    assert bluetooth._publish_service(bt, service) == (record, 30)
    attributes = publish.call_args.args[0]
    assert attributes["0001 - ServiceClassIDList"] == [uuid.UUID(service).bytes]
    assert attributes["0004 - ProtocolDescriptorList"][1][1] == {
        "DataElementType": 1, "DataElementSize": 1, "DataElementValue": 30,
    }
    assert attributes["LocalAttributes"] == {"Persistent": False}
    record.removeServiceRecord.assert_not_called()


def test_service_cleans_up_remapped_channels_and_tries_lower_channel():
    remapped, failed, accepted = Mock(), Mock(), Mock()
    remapped.getRFCOMMChannelID_.return_value = (0, 12)
    failed.getRFCOMMChannelID_.return_value = (1, 28)
    accepted.getRFCOMMChannelID_.return_value = (0, 27)
    publish = Mock(side_effect=[remapped, None, failed, accepted])
    bt = SimpleNamespace(IOBluetoothSDPServiceRecord=SimpleNamespace(
        publishedServiceRecordWithDictionary_=publish))

    assert bluetooth._publish_service(bt, str(uuid.uuid4())) == (accepted, 27)
    requested = [call.args[0]["0004 - ProtocolDescriptorList"][1][1]["DataElementValue"]
                 for call in publish.call_args_list]
    assert requested == [30, 29, 28, 27]
    remapped.removeServiceRecord.assert_called_once_with()
    failed.removeServiceRecord.assert_called_once_with()
    accepted.removeServiceRecord.assert_not_called()


def test_service_fails_if_no_matching_channel_is_available():
    record = Mock()
    record.getRFCOMMChannelID_.return_value = (0, 0)
    publish = Mock(return_value=record)
    bt = SimpleNamespace(IOBluetoothSDPServiceRecord=SimpleNamespace(
        publishedServiceRecordWithDictionary_=publish))

    with pytest.raises(transfer.TransferError, match="allocate a Bluetooth channel"):
        bluetooth._publish_service(bt, str(uuid.uuid4()))
    assert publish.call_count == record.removeServiceRecord.call_count == 30


def test_qr_is_a_bluetooth_capability_not_a_network_url():
    service, source = str(uuid.uuid4()), str(uuid.uuid4())
    offer = bluetooth.offer("AA-BB-CC-DD-EE-FF", service, "synthetic-transfer-passphrase", source, "synthetic-token-for-tests", 12345)
    assert offer["address"] == "AA:BB:CC:DD:EE:FF"
    assert offer["service"] == service and offer["source"] == source
    assert offer["type"] == "sherloq-bluetooth" and offer["expires"] == 12345
    assert not any(k in offer for k in ("url", "server", "http"))
