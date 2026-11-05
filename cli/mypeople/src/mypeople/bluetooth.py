"""Temporary, QR-paired macOS Bluetooth sync. No HTTP or raw database transfer."""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
import secrets
import struct
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path

from .transfer import MAX_FILE, TransferError

FRAME_MAGIC = b"SHBT0001"
UPLOAD_MAGIC = b"SHUP0002"
FINISHED = b"SHOK0002"
READY = b"SHRD0003"
MAX_UPLOAD = 8 * 1024 * 1024
HEADER_SIZE = 48


def offer(address: str, service: str, password: str, source: str, token: str, expires: int, *, version: int = 1, publisher: str | None = None, wait_keepalive: bool = False) -> dict:
    return ({"wait_keepalive": True} if wait_keepalive and version >= 2 else {}) | {"publisher": publisher, "type": "sherloq-bluetooth", "version": version, "address": address.replace("-", ":").upper(),
            "service": service, "passphrase": password, "source": source, "token": token,
            "expires": expires, "name": "MyPeople on your Mac"}


def frame_header(data: bytes, *, upload: bool = False) -> bytes:
    if not 52 <= len(data) <= (MAX_UPLOAD if upload else MAX_FILE):
        raise TransferError("Invalid encrypted transfer size.")
    return (UPLOAD_MAGIC if upload else FRAME_MAGIC) + struct.pack(">Q", len(data)) + hashlib.sha256(data).digest()


class SessionProtocol:
    """Bounded incremental decoder; connection state never depends on legacy object IDs.

    v1: authenticate → snapshot → OK.
    v2: authenticate → encrypted edits frame → fresh snapshot → digest ACK → finish.
    No database operation is allowed before the entire upload passes its checksum.
    """
    def __init__(self, token: str, expires: int, *, version: int = 1):
        if version not in (1, 2, 3):
            raise TransferError("Unsupported Bluetooth protocol.")
        self.token, self.expires, self.version = token, expires, version
        self.buffer = bytearray()
        self.authenticated = False
        self.upload: bytes | None = None
        self.expected_digest: str | None = None
        self.imported = threading.Event()
        self.last_activity = time.time()

    def expect_snapshot(self, data: bytes) -> None:
        self.expected_digest = hashlib.sha256(data).hexdigest()

    def feed(self, data: bytes, now: float | None = None) -> str | None:
        self.last_activity = time.time() if now is None else now
        if len(self.buffer) + len(data) > MAX_UPLOAD + HEADER_SIZE + 128:
            raise TransferError("Bluetooth request exceeds the safe size limit.")
        self.buffer.extend(data)
        event = None
        if not self.authenticated:
            end = self.buffer.find(b"\n")
            if end < 0:
                if len(self.buffer) > 128:
                    raise TransferError("Invalid Bluetooth request.")
                return None
            if end > 127:
                raise TransferError("Invalid Bluetooth request.")
            expected = (f"SHERLOQ{self.version} " + self.token).encode()
            line = bytes(self.buffer[:end]).strip()
            if self.last_activity > self.expires or not secrets.compare_digest(line, expected):
                raise TransferError("Invalid or expired Bluetooth request.")
            del self.buffer[:end + 1]
            self.authenticated = True
            event = "authenticated"
        if self.version >= 2 and self.upload is None:
            if len(self.buffer) < HEADER_SIZE:
                return event
            if self.buffer[:8] != UPLOAD_MAGIC:
                raise TransferError("Expected an encrypted edits frame.")
            length = struct.unpack(">Q", self.buffer[8:16])[0]
            if not 52 <= length <= MAX_UPLOAD:
                raise TransferError("Invalid edits upload size.")
            if len(self.buffer) < HEADER_SIZE + length:
                return event
            payload = bytes(self.buffer[HEADER_SIZE:HEADER_SIZE + length])
            if not secrets.compare_digest(bytes(self.buffer[16:48]), hashlib.sha256(payload).digest()):
                raise TransferError("Damaged edits upload.")
            del self.buffer[:HEADER_SIZE + length]
            if self.buffer:
                raise TransferError("Unexpected data after edits upload.")
            self.upload = payload
            return "uploaded"
        if self.buffer:
            if len(self.buffer) > 128:
                raise TransferError("Invalid import acknowledgment.")
            if self.version >= 2 and self.expected_digest is None:
                raise TransferError("Acknowledgment arrived before a snapshot was prepared.")
            while b"\n" in self.buffer:
                end = self.buffer.index(b"\n")
                line = bytes(self.buffer[:end]).strip()
                del self.buffer[:end + 1]
                # Authenticated import liveness is NOT an acknowledgment. Keep the
                # radio alive while Android commits; only the exact digest can finish.
                if self.version >= 2 and line == b"WAIT":
                    event = "waiting"
                    continue
                expected_ack = b"OK" if self.version == 1 else ("OK " + self.expected_digest).encode()
                if not secrets.compare_digest(line, expected_ack) or self.buffer:
                    raise TransferError("Import acknowledgment does not match this snapshot.")
                self.imported.set()
                return "confirmed"
            return event
        return event


def _known_channel(receivers, channel):
    """Re-armed native observers may deliver the SAME accepted channel more than once.

    Never replace its delegate or close it after authentication. Native wrappers can
    differ while referring to the same public IOBluetooth object ID.
    """
    for receiver in receivers:
        old = receiver.channel
        if old is channel or old == channel:
            return True
        if old.isOpen() and old.getObjectID() and old.getObjectID() == channel.getObjectID():
            return True
    return False


def _publish_service(bt, service_id: str):
    # Low channels are commonly occupied by macOS services. Its compatibility
    # layer can retain the requested number in SDP even when the listener was
    # allocated elsewhere, so start at the high end rather than always using 1.
    for requested in range(30, 0, -1):
        record = bt.IOBluetoothSDPServiceRecord.publishedServiceRecordWithDictionary_({
            "0001 - ServiceClassIDList": [uuid.UUID(service_id).bytes],
            "0004 - ProtocolDescriptorList": [
                [bytes.fromhex("0100")],
                [bytes.fromhex("0003"), {"DataElementType": 1, "DataElementSize": 1, "DataElementValue": requested}],
            ],
            "0100 - ServiceName": "MyPeople encrypted sync",
            "LocalAttributes": {"Persistent": False},
        })
        if record is None:
            continue
        status, assigned = record.getRFCOMMChannelID_(None)
        if status == 0 and assigned == requested:
            return record, assigned
        record.removeServiceRecord()
    raise TransferError("Couldn’t allocate a Bluetooth channel. Check Bluetooth permissions.")


class _IncomingNotifications:
    """Re-arm the public API while macOS's asynchronous classic manager starts.

    A non-nil notification alone does not mean the underlying manager accepted
    the registration. Re-registering also picks up a pending incoming connection
    that the compatibility layer did not deliver to the original observer.
    """
    def __init__(self, register):
        self.register = register
        self.current = None

    def refresh(self):
        replacement = self.register()
        if replacement is None:
            if self.current is None:
                raise TransferError("Couldn’t listen for Bluetooth connections.")
            return
        previous, self.current = self.current, replacement
        if previous is not None:
            previous.unregister()

    def close(self):
        previous, self.current = self.current, None
        if previous is not None:
            previous.unregister()


def _listen(listener, expires: int, version: int, pump, refresh):
    next_refresh = time.monotonic() + 1
    while not listener.done.is_set():
        now = time.time()
        if not listener.active and now > expires:
            print("QR expired. Run mypeople transfer qr again.", flush=True)
            break
        protocol = listener.active_protocol
        if protocol is not None and version >= 2 and protocol.upload is None and now - protocol.last_activity > 60:
            print("Edits upload stalled. Incomplete edits were not applied.", flush=True)
            break
        if listener.active and now - listener.started_at > 1200:
            break
        if not listener.active and time.monotonic() >= next_refresh:
            # Never re-arm an accepted socket, even before authentication arrives.
            if not any(receiver.channel.isOpen() for receiver in listener.receivers):
                refresh()
            next_refresh = time.monotonic() + 1
        # Short run-loop slices deliver native callbacks AND Python signals.
        # A blocking CFRunLoopRun can otherwise delay Ctrl-C until another event.
        pump()


def serve(path: Path, password: str, source: str, *, minutes: int = 10, show: bool = True,
          directory: Path | None = None, exchange: Callable[[bytes], bytes] | None = None, publisher: str | None = None) -> None:
    """Run on the main thread. exchange applies edits and builds a fresh encrypted snapshot.

    The callback runs on the transfer worker, so it must open its own SQLite connection.
    Omitting it retains the original download-only protocol for old clients/tests.
    """
    try:
        import objc
        import IOBluetooth as BT
        from Foundation import NSObject
        from CoreFoundation import CFRunLoopRunInMode, kCFRunLoopDefaultMode
        import qrcode
    except ImportError:
        raise TransferError("Install Bluetooth support: uv sync --extra bluetooth") from None
    if not 1 <= minutes <= 60:
        raise TransferError("Choose a QR lifetime between 1 and 60 minutes.")
    version = 3 if exchange is not None else 1
    legacy_data = None
    if version == 1:
        if path.stat().st_size > MAX_FILE:
            raise TransferError("Snapshot is too large for this transfer.")
        legacy_data = path.read_bytes()
        frame_header(legacy_data)
    controller = BT.IOBluetoothHostController.defaultController()
    address = str(controller.addressAsString()) if controller else ""
    if not address or address == "00:00:00:00:00:00" or controller.powerState() != 1:
        raise TransferError("Enable Bluetooth and allow Bluetooth access for your terminal in macOS Settings.")
    service_id = str(uuid.uuid4())
    token = secrets.token_urlsafe(24)
    expires = int(time.time()) + minutes * 60
    payload = offer(address, service_id, password, source, token, expires, version=version, publisher=publisher, wait_keepalive=version >= 2)
    record, channel_id = _publish_service(BT, service_id)

    class ChannelReceiver(NSObject):
        @objc.python_method
        def prepare(self, owner, channel):
            self.owner = owner
            self.channel = channel
            self.protocol = SessionProtocol(token, expires, version=version)
            self.rejected = False

        @objc.python_method
        def send_ready(self):
            # Android's connect() may return BEFORE macOS installs our delegate.
            # v3 waits for this marker before sending authentication or any upload.
            with objc.autorelease_pool():
                if self.channel.writeSync_length_(READY, len(READY)):
                    self.rejected = True
                    self.channel.closeChannel()

        @objc.typedSelector(b"v@:@^vQ")
        def rfcommChannelData_data_length_(self, channel, pointer, length):
            if self.rejected:
                return
            # Native callbacks can coalesce multiple RFCOMM packets; they are not
            # bounded by the sender's write chunk. Keep the SESSION bound unchanged.
            if length > MAX_UPLOAD + HEADER_SIZE + 128:
                self.rejected = True
                channel.closeChannel()
                return
            chunk = bytes(pointer[:length]) if isinstance(pointer, (bytes, bytearray, memoryview)) else ctypes.string_at(int(pointer), length)
            was_authenticated = self.protocol.authenticated
            try:
                decision = self.protocol.feed(chunk)
            except TransferError as exc:
                self.rejected = True
                print(f"Bluetooth request rejected ({exc}); no incomplete edits will be applied.", flush=True)
                channel.closeChannel()
                if was_authenticated:
                    self.owner.done.set()
                return
            if not was_authenticated and self.protocol.authenticated:
                with self.owner.lock:
                    if self.owner.active:
                        channel.closeChannel()
                        return
                    self.owner.active = True
                    self.owner.active_protocol = self.protocol
                    self.owner.started_at = time.time()
                print("Phone authenticated.", flush=True)
            if (version == 1 and decision == "authenticated") or decision == "uploaded":
                threading.Thread(target=self.owner.transmit, args=(channel, self.protocol), daemon=True).start()
            elif decision == "confirmed":
                print("Phone import acknowledgment received.", flush=True)

    class Listener(NSObject):
        @objc.python_method
        def prepare(self):
            self.receivers = []
            self.lock = threading.Lock()
            self.active = False
            self.active_protocol = None
            self.done = threading.Event()
            self.started_at = 0.0

        @objc.typedSelector(b"v@:@@")
        def channelOpened_channel_(self, notification, channel):
            if not channel.isIncoming() or channel.getChannelID() != channel_id:
                return
            if _known_channel(self.receivers, channel):
                return
            if time.time() > expires or self.active:
                channel.closeChannel()
                return
            receiver = ChannelReceiver.alloc().init()
            receiver.prepare(self, channel)
            self.receivers.append(receiver)
            if channel.setDelegate_(receiver):
                channel.closeChannel()
            elif version >= 3:
                threading.Thread(target=receiver.send_ready, daemon=True).start()

        @objc.python_method
        def transmit(self, channel, protocol):
            with objc.autorelease_pool():
                stage = "preparing updated memory"
                try:
                    if version >= 2:
                        print("Edits received and checksum verified. Applying on the Mac and preparing fresh memory…", flush=True)
                        response = exchange(protocol.upload)
                    else:
                        response = legacy_data
                    header = frame_header(response)
                    protocol.expect_snapshot(response)
                    mtu = max(1, min(int(channel.getMTU()), 65535))
                    sent, last_percent = 0, -10
                    stage = "sending updated memory"
                    print("Sending updated encrypted memory over Bluetooth…", flush=True)
                    for part in (header, response):
                        for start in range(0, len(part), mtu):
                            if time.time() - self.started_at > 1200 or self.done.is_set():
                                raise TransferError("Bluetooth transfer stopped or timed out.")
                            block = part[start:start + mtu]
                            if channel.writeSync_length_(block, len(block)):
                                raise TransferError("Bluetooth interrupted. Edits already applied are safe to retry by UUID.")
                            sent += len(block)
                            percent = min(100, sent * 100 // (len(header) + len(response)))
                            if percent >= last_percent + 10:
                                last_percent = percent
                                print(f"Bluetooth: {percent}%", flush=True)
                    stage = "waiting for the phone to commit its import"
                    if not protocol.imported.wait(120):
                        raise TransferError("Sent memory but the phone did not confirm import. It is safe to sync again.")
                    if version >= 2 and channel.writeSync_length_(FINISHED, len(FINISHED)):
                        print("Phone imported memory; final radio confirmation was interrupted.", flush=True)
                    print("Sync complete: phone confirmed updated memory and edit receipts were saved.", flush=True)
                except Exception as exc:
                    print(str(exc) if isinstance(exc, TransferError) else f"Couldn’t finish sync while {stage} ({type(exc).__name__}). Phone edits remain queued; retrying is safe.", flush=True)
                finally:
                    channel.closeChannel()
                    self.done.set()

    listener = Listener.alloc().init()
    listener.prepare()
    notifications = _IncomingNotifications(lambda:
        BT.IOBluetoothRFCOMMChannel.registerForChannelOpenNotifications_selector_withChannelID_direction_(
            listener, b"channelOpened:channel:", channel_id,
            BT.kIOBluetoothUserNotificationChannelDirectionIncoming,
        ))
    try:
        notifications.refresh()
    except Exception:
        record.removeServiceRecord()
        raise
    directory = directory or Path.home() / ".mypeople" / "bluetooth"
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    qr_path = directory / f"Pair-with-MyPeople-{service_id[:8]}.png"
    session_path = directory / "session.json"
    from .transfer import write_file
    write_file(session_path, json.dumps(payload).encode())
    qrcode.make(json.dumps(payload, separators=(",", ":"))).save(qr_path)
    qr_path.chmod(0o600)
    print(f"Bluetooth listener registered on RFCOMM channel {channel_id} (protocol v{version}).", flush=True)
    print(f"QR ready at {qr_path}. In MyPeople Settings, tap Scan Mac QR. Expires in {minutes} minutes.", flush=True)
    print("Approve OS pairing prompts. Keep this command running until both devices confirm sync.", flush=True)
    awake = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if show:
        subprocess.run(["open", str(qr_path)], check=False)
    try:
        _listen(listener, expires, version,
                lambda: CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, False),
                notifications.refresh)
    except KeyboardInterrupt:
        print("Bluetooth sync stopped.", flush=True)
    finally:
        listener.done.set()
        notifications.close()
        for receiver in listener.receivers:
            receiver.channel.setDelegate_(None)
            receiver.channel.closeChannel()
        record.removeServiceRecord()
        awake.terminate()
        session_path.unlink(missing_ok=True)
        qr_path.unlink(missing_ok=True)
