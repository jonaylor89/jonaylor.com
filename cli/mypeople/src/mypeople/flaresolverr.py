"""Opt-in, invocation-scoped Docker browser fallback for public profile metadata."""

from __future__ import annotations

import atexit
import json
import logging
import os
import shutil
import selectors
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import ExitStack

from . import profile_evidence
from .profile_urls import DOMAINS, host_for, profile_url
from .public_proxy import container_source

IMAGE = 'ghcr.io/flaresolverr/flaresolverr:v3.5.2'
logger = logging.getLogger(__name__)


class FlareSolverrError(RuntimeError):
    pass


class FlareSolverr:
    """One temporary container and anonymous browser session; never reuse a user's container.

    The Docker image cache is intentionally retained. No host volumes are mounted.
    finally/atexit handle cleanup; SIGTERM becomes a normal unwinding exit. SIGKILL
    or a dead Docker daemon still require manual removal of the named container.
    """

    def __init__(self, timeout: float = 60, startup_timeout: float = 90):
        self.timeout = timeout
        self.startup_timeout = startup_timeout
        self.name = 'mypeople-flaresolverr-' + uuid.uuid4().hex[:12]
        self.session = 'mypeople-' + uuid.uuid4().hex
        self.endpoint = None
        self.docker = None
        self.remove_needed = False
        self.session_attempted = False
        self.proxy_process = None
        self.proxy_url = None
        self.closed = False
        self.stack = ExitStack()
        self.lock = threading.Lock()  # One browser at a time, even with parallel metadata collection.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _docker(self, *args, timeout=20):
        result = subprocess.run([self.docker, *args], capture_output=True, text=True, timeout=timeout, check=False)
        if result.returncode:
            raise FlareSolverrError((result.stderr or result.stdout or 'Docker command failed').strip()[:500])
        return result.stdout.strip()

    def _start_proxy(self):
        # The listener exists ONLY on container loopback. Docker's exec pipe is
        # the control channel; no host listener, published proxy port, or mount.
        self.proxy_process = subprocess.Popen(
            [self.docker, 'exec', '-i', self.name, 'python3', '-u', '-'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.proxy_process.stdin.write(container_source().encode())
        self.proxy_process.stdin.close()
        raw = bytearray()
        deadline = time.monotonic() + 10
        with selectors.DefaultSelector() as selector:
            selector.register(self.proxy_process.stdout, selectors.EVENT_READ)
            while b'\n' not in raw and len(raw) < 4096:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise FlareSolverrError('Container-local egress proxy did not start')
                chunk = os.read(self.proxy_process.stdout.fileno(), 4096 - len(raw))
                if not chunk:
                    raise FlareSolverrError('Container-local egress proxy exited during startup')
                raw.extend(chunk)
        try:
            value = json.loads(raw.split(b'\n', 1)[0])
            url = urllib.parse.urlsplit(value['url'])
            if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.username or url.password:
                raise ValueError('Proxy must stay on container loopback')
            if value['username'] != 'mypeople' or not isinstance(value['password'], str) or len(value['password']) < 32:
                raise ValueError('Invalid proxy authentication')
        except (ValueError, KeyError, TypeError):
            raise FlareSolverrError('Invalid container-local egress proxy response') from None
        return value

    def _stop_proxy(self):
        if self.proxy_process is None:
            return
        try:
            # Removing the container normally terminates docker exec as well.
            self.proxy_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proxy_process.kill()
            self.proxy_process.wait(timeout=5)
        finally:
            for pipe in (self.proxy_process.stdin, self.proxy_process.stdout):
                if pipe:
                    pipe.close()
            self.proxy_process = None

    def _json(self, path: str, payload=None, timeout=5):
        request = urllib.request.Request(self.endpoint + path,
                                         data=json.dumps(payload).encode() if payload is not None else None,
                                         headers={'content-type': 'application/json'})
        with self.opener.open(request, timeout=timeout) as response:
            raw = response.read(8_000_001)
        if len(raw) > 8_000_000:
            raise FlareSolverrError('FlareSolverr response exceeded size limit')
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise FlareSolverrError('Invalid FlareSolverr response')
        if value.get('status') != 'ok':
            raise FlareSolverrError(str(value.get('message', 'FlareSolverr request failed'))[:300])
        return value

    def __enter__(self):
        self.docker = shutil.which('docker')
        if self.docker is None:
            raise FlareSolverrError('Docker is required for --flaresolverr. Install/start Docker first.')
        try:
            if threading.current_thread() is threading.main_thread():
                def interrupt(signum, frame):
                    # Kill the browser before a ThreadPoolExecutor waits for its
                    # in-flight metadata requests to finish during unwinding.
                    try:
                        self.close()
                    finally:
                        if signum == signal.SIGINT:
                            raise KeyboardInterrupt
                        raise SystemExit(128 + signum)
                for signum in (signal.SIGINT, signal.SIGTERM):
                    old = signal.getsignal(signum)
                    signal.signal(signum, interrupt)
                    self.stack.callback(signal.signal, signum, old)
            atexit.register(self.close)
            self.remove_needed = True  # Even a timed-out/failed docker run may have created it.
            self._docker('run', '--detach', '--rm', '--name', self.name,
                         '--label', 'dev.mypeople.ephemeral=true',
                         '--publish', '127.0.0.1::8191',
                         '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                         '--memory', '1g', '--cpus', '2', '--pids-limit', '512',
                         '--tmpfs', '/tmp:size=512m,mode=1777',
                         '--env', 'LOG_LEVEL=error', '--env', 'LOG_HTML=false',
                         '--env', 'TEST_URL=about:blank',
                         os.environ.get('MYPEOPLE_FLARESOLVERR_IMAGE', IMAGE), timeout=300)
            binding = self._docker('port', self.name, '8191/tcp')
            prefix, port = binding.rsplit(':', 1)
            if prefix != '127.0.0.1' or not port.isdigit():
                raise FlareSolverrError('Unexpected Docker port binding; only localhost is allowed')
            self.endpoint = f'http://127.0.0.1:{port}'
            deadline = time.monotonic() + self.startup_timeout
            while True:
                try:
                    self._json('/health')
                    break
                except (OSError, ValueError, FlareSolverrError):
                    if time.monotonic() >= deadline:
                        raise FlareSolverrError('FlareSolverr did not become healthy in time') from None
                    time.sleep(0.5)
            proxy = self._start_proxy()
            self.proxy_url = proxy['url']
            self.session_attempted = True
            self._json('/v1', {'cmd': 'sessions.create', 'session': self.session, 'proxy': proxy}, timeout=self.timeout + 5)
            return self
        except BaseException as exc:
            self.close()
            if isinstance(exc, (OSError, subprocess.SubprocessError)):
                raise FlareSolverrError(f'Could not start FlareSolverr: {exc}') from None
            raise

    def __exit__(self, *exc):
        self.close()

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            if self.endpoint and self.session_attempted:
                try:
                    self._json('/v1', {'cmd': 'sessions.destroy', 'session': self.session}, timeout=5)
                except Exception:
                    pass  # Forced container removal also destroys browsers/cookies.
        finally:
            try:
                if self.remove_needed:
                    result = subprocess.run([self.docker, 'rm', '--force', self.name],
                                            capture_output=True, text=True, timeout=20, check=False)
                    if result.returncode and 'No such container' not in result.stderr:
                        logger.warning('Could not remove %s. Run: docker rm -f %s', self.name, self.name)
            except (OSError, subprocess.SubprocessError):
                logger.warning('Could not remove %s. Run: docker rm -f %s', self.name, self.name)
            finally:
                try:
                    self._stop_proxy()
                finally:
                    atexit.unregister(self.close)
                    self.stack.close()

    def __call__(self, url: str, timeout: float = 8) -> dict:
        """Try normal metadata first; browser fallback only for blocked/empty pages."""
        normal = profile_evidence.fetch(url, timeout=timeout)
        if normal['access'] not in ('blocked', 'empty'):
            return normal
        try:
            # Browser navigation is confined to trusted platform roots, not arbitrary
            # user subdomains. Its proxy also blocks private destinations/subresources.
            if profile_url(url) is None or urllib.parse.urlsplit(url).scheme != 'https' or host_for(url) not in DOMAINS:
                raise profile_evidence.UnsafeURL('Browser fallback requires a known platform host')
            profile_evidence.public_address(urllib.parse.urlsplit(url).hostname)
            with self.lock:
                value = self._json('/v1', {'cmd': 'request.get', 'session': self.session,
                                           'url': url, 'maxTimeout': int(self.timeout * 1000),
                                           'disableMedia': True}, timeout=self.timeout + 5)
            solution = value['solution']
            final = solution['url']
            if profile_url(final) is None or urllib.parse.urlsplit(final).scheme != 'https' or host_for(final) not in DOMAINS:
                raise profile_evidence.UnsafeURL('Browser navigation left supported profile routes')
            body = solution.get('response', '').encode()[:profile_evidence.MAX_BYTES]
            snapshot = profile_evidence.fetch(final, prefer_api=False, get=lambda *a: (
                int(solution['status']), {'content-type': 'text/html'}, body))
            snapshot.update(url=url, transport='flaresolverr')
            return snapshot  # Deliberately discard all returned cookies/screenshots/tokens.
        except (OSError, ValueError, KeyError, TypeError, FlareSolverrError) as exc:
            normal['browser_error'] = str(exc)[:160]
            return normal
