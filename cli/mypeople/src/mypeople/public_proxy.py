"""Container-local authenticated CONNECT proxy for the Docker browser's public egress.

Every tunnel resolves and pins a public IP. No HTTP forwarding, non-443 ports,
private LAN/host addresses, or unauthenticated open-proxy access is allowed.
"""

import base64
import hmac
import json
import select
import secrets
import socket
import threading
import time
import urllib.parse
from contextlib import contextmanager
from importlib import resources
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .public_network import public_address


class PublicProxy(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        self.password = secrets.token_urlsafe(32)
        self.authorization = 'Basic ' + base64.b64encode(f'mypeople:{self.password}'.encode()).decode()
        self.tunnels: set[socket.socket] = set()
        self.lock = threading.Lock()
        super().__init__(('127.0.0.1', 0), Tunnel)

    def close_tunnels(self):
        with self.lock:
            for sock in self.tunnels:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                sock.close()
            self.tunnels.clear()


class Tunnel(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log proxy credentials or browser request URLs.

    def do_CONNECT(self):
        auth = self.headers.get('Proxy-Authorization', '')
        if not hmac.compare_digest(auth.encode(), self.server.authorization.encode()):
            self.send_response(407)
            self.send_header('Proxy-Authenticate', 'Basic realm="MyPeople"')
            self.end_headers()
            return
        upstream = None
        try:
            target = urllib.parse.urlsplit('//' + self.path)
            if not target.hostname or target.port != 443 or target.username or target.password or target.path:
                raise ValueError('Only public HTTPS tunnels are allowed')
            address = public_address(target.hostname)
            upstream = socket.create_connection((address, 443), timeout=10)
        except (OSError, ValueError):
            if upstream:
                upstream.close()
            self.send_error(403)
            return
        self.send_response(200, 'Connection established')
        self.end_headers()
        self.wfile.flush()
        self.connection.settimeout(10)
        upstream.settimeout(10)
        sockets = (self.connection, upstream)
        with self.server.lock:
            self.server.tunnels.update(sockets)
        deadline = time.monotonic() + 180
        try:
            while time.monotonic() < deadline:
                readable, _, _ = select.select(sockets, [], [], 1)
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    (upstream if source is self.connection else self.connection).sendall(data)
        except (OSError, ValueError):
            pass
        finally:
            with self.server.lock:
                self.server.tunnels.difference_update(sockets)
            upstream.close()
            self.close_connection = True

    def do_GET(self):
        self.send_error(405, 'Only authenticated HTTPS CONNECT is supported')


@contextmanager
def public_proxy():
    server = PublicProxy()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield {'url': f'http://127.0.0.1:{server.server_port}',
               'username': 'mypeople', 'password': server.password}
    finally:
        server.shutdown()
        server.close_tunnels()
        server.server_close()
        thread.join(timeout=2)


def serve():
    """Run via docker exec, sending credentials only over its private stdout pipe."""
    server = PublicProxy()
    try:
        print(json.dumps({'url': f'http://127.0.0.1:{server.server_port}',
                          'username': 'mypeople', 'password': server.password}), flush=True)
        server.serve_forever()
    finally:
        server.close_tunnels()
        server.server_close()


def container_source() -> str:
    """Load these stdlib-only modules into the container without host mounts/files."""
    network = resources.files('mypeople').joinpath('public_network.py').read_text(encoding='utf-8')
    proxy = resources.files('mypeople').joinpath('public_proxy.py').read_text(encoding='utf-8')
    return (
        "import sys, types\n"
        "pkg = types.ModuleType('mypeople'); pkg.__path__ = []; sys.modules['mypeople'] = pkg\n"
        "network = types.ModuleType('mypeople.public_network'); sys.modules[network.__name__] = network\n"
        f"exec({network!r}, network.__dict__)\n"
        "proxy = types.ModuleType('mypeople.public_proxy'); sys.modules[proxy.__name__] = proxy\n"
        f"exec({proxy!r}, proxy.__dict__)\n"
        "proxy.serve()\n"
    )
