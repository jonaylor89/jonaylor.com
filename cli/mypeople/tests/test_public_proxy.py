import http.client
import socket
import threading

import pytest

from mypeople import public_proxy as proxy
from mypeople.profile_evidence import UnsafeURL


@pytest.fixture
def server():
    value = proxy.PublicProxy()
    thread = threading.Thread(target=value.serve_forever, daemon=True)
    thread.start()
    try:
        yield value
    finally:
        value.shutdown()
        value.close_tunnels()
        value.server_close()
        thread.join(timeout=2)


def test_listener_is_loopback_only(server):
    assert server.server_address[0] == '127.0.0.1'


def test_connect_requires_authentication_before_dns(server, monkeypatch):
    monkeypatch.setattr(proxy, 'public_address', lambda *a: pytest.fail('unauthenticated proxy must not resolve hosts'))
    conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
    try:
        conn.request('CONNECT', 'github.com:443')
        assert conn.getresponse().status == 407
    finally:
        conn.close()


@pytest.mark.parametrize('target', ['localhost:443', '127.0.0.1:443', '169.254.169.254:443', 'github.com:80'])
def test_proxy_denies_private_addresses_and_non_https_ports(server, monkeypatch, target):
    def deny(host):
        raise UnsafeURL('not public')
    monkeypatch.setattr(proxy, 'public_address', deny)
    conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
    try:
        conn.request('CONNECT', target, headers={'Proxy-Authorization': server.authorization})
        assert conn.getresponse().status == 403
    finally:
        conn.close()


def test_proxy_does_not_forward_plain_http(server):
    conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
    try:
        conn.request('GET', 'http://example.com/')
        assert conn.getresponse().status == 405
    finally:
        conn.close()


def test_cleanup_shuts_active_tunnels(server):
    left, right = socket.socketpair()
    server.tunnels.add(left)
    server.close_tunnels()
    try:
        assert not server.tunnels and right.recv(1) == b''
    finally:
        right.close()
