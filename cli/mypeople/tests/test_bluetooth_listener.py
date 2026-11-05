"""macOS listener lifecycle tests without requiring native Bluetooth hardware."""
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from mypeople import bluetooth, transfer


@pytest.fixture
def clock(monkeypatch):
    clock = SimpleNamespace(now=100.0)
    monkeypatch.setattr(bluetooth.time, "time", lambda: clock.now)
    monkeypatch.setattr(bluetooth.time, "monotonic", lambda: clock.now)
    return clock


def listener():
    return SimpleNamespace(done=threading.Event(), active=False, active_protocol=None,
                           started_at=0, receivers=[])


def test_rearms_registration_that_was_returned_before_native_manager_was_ready(clock):
    owner = listener()
    first, second = Mock(), Mock()

    def register():
        if register.calls == 0:
            # macOS returns a notification but silently drops the registration
            # while its asynchronous classic manager is not powered on yet.
            register.calls += 1
            return first
        register.calls += 1
        owner.active = True
        owner.started_at = clock.now
        owner.active_protocol = SimpleNamespace(upload=b"complete", last_activity=clock.now)
        return second

    register.calls = 0
    notifications = bluetooth._IncomingNotifications(register)
    notifications.refresh()

    def pump():
        clock.now += 1
        if owner.active:
            owner.done.set()

    bluetooth._listen(owner, 200, 2, pump, notifications.refresh)
    assert register.calls == 2
    first.unregister.assert_called_once_with()
    second.unregister.assert_not_called()
    notifications.close()
    notifications.close()  # Cleanup is idempotent.
    second.unregister.assert_called_once_with()


@pytest.mark.parametrize("authenticated", [False, True])
def test_does_not_rearm_accepted_socket_even_before_authentication(clock, authenticated):
    owner = listener()
    owner.active = authenticated
    owner.started_at = clock.now
    owner.receivers = [SimpleNamespace(channel=Mock(isOpen=Mock(return_value=True)))]
    refresh = Mock()

    def pump():
        clock.now += 1
        if clock.now >= 104:
            owner.done.set()

    bluetooth._listen(owner, 200, 2, pump, refresh)
    refresh.assert_not_called()


def test_can_rearm_after_unauthenticated_socket_disconnects(clock):
    owner = listener()
    channel = Mock()
    channel.isOpen.return_value = True
    owner.receivers = [SimpleNamespace(channel=channel)]
    refresh = Mock()

    def pump():
        clock.now += 1
        channel.isOpen.return_value = False
        if clock.now >= 102:
            owner.done.set()

    bluetooth._listen(owner, 200, 2, pump, refresh)
    refresh.assert_called_once_with()


def test_failed_refresh_retains_existing_notification_until_cleanup():
    first = Mock()
    notifications = bluetooth._IncomingNotifications(Mock(side_effect=[first, None]))
    notifications.refresh()
    notifications.refresh()
    first.unregister.assert_not_called()
    notifications.close()
    first.unregister.assert_called_once_with()


def test_initial_registration_failure_is_reported():
    notifications = bluetooth._IncomingNotifications(lambda: None)
    with pytest.raises(transfer.TransferError, match="listen for Bluetooth"):
        notifications.refresh()
    notifications.close()


@pytest.mark.parametrize("reason", ["expired", "upload_stalled", "session_timeout"])
def test_listener_retains_pairing_upload_and_session_deadlines(clock, reason):
    owner = listener()
    expires = 200
    if reason == "expired":
        expires = 99
    else:
        owner.active = True
        owner.started_at = -1201 if reason == "session_timeout" else 100
        owner.active_protocol = SimpleNamespace(
            upload=None if reason == "upload_stalled" else b"complete", last_activity=0)
    pump, refresh = Mock(), Mock()
    bluetooth._listen(owner, expires, 2, pump, refresh)
    pump.assert_not_called()
    refresh.assert_not_called()


def test_run_loop_slice_can_deliver_keyboard_interrupt(clock):
    owner = listener()
    with pytest.raises(KeyboardInterrupt):
        bluetooth._listen(owner, 200, 2, Mock(side_effect=KeyboardInterrupt), Mock())
