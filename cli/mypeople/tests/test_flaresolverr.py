import contextlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
import urllib.error

import pytest

from mypeople import cli, identity, profile_evidence, socials
from mypeople import flaresolverr as flare


@pytest.fixture
def docker(monkeypatch):
    events = []
    monkeypatch.setattr(flare.shutil, 'which', lambda name: '/tools/docker')

    def run(argv, **kwargs):
        events.append(('docker', argv))
        output = '127.0.0.1:49152' if argv[1] == 'port' else 'container-id'
        return subprocess.CompletedProcess(argv, 0, stdout=output, stderr='')

    started = []
    def proxy(self):
        started.append(True)
        events.append(('proxy', 'start'))
        return {'url': 'http://127.0.0.1:12345', 'username': 'user', 'password': 'secret'}
    def stop_proxy(self):
        if started:
            started.clear()
            events.append(('proxy', 'stop'))

    def api(self, path, payload=None, **kwargs):
        events.append(('api', payload or path))
        return {'status': 'ok'}

    monkeypatch.setattr(flare.subprocess, 'run', run)
    monkeypatch.setattr(flare.FlareSolverr, '_start_proxy', proxy)
    monkeypatch.setattr(flare.FlareSolverr, '_stop_proxy', stop_proxy)
    monkeypatch.setattr(flare.FlareSolverr, '_json', api)
    return events


@pytest.mark.parametrize('failure', [None, RuntimeError, KeyboardInterrupt, SystemExit])
def test_temporary_container_and_session_always_cleaned_up(docker, failure):
    previous = signal.getsignal(signal.SIGTERM)
    browser = flare.FlareSolverr()
    def use():
        with browser:
            if failure:
                raise failure('stop')
    if failure:
        with pytest.raises(failure):
            use()
    else:
        use()
    browser.close()  # Cleanup is idempotent.
    commands = [e[1] for e in docker if e[0] == 'docker']
    run = commands[0]
    assert '--rm' in run and '127.0.0.1::8191' in run and '--mount' not in run and '--volume' not in run
    assert '--add-host' not in run and 'host.docker.internal' not in ' '.join(run)
    assert run[-1] == flare.IMAGE
    assert ['--label', 'dev.mypeople.ephemeral=true'] == run[run.index('--label'):run.index('--label') + 2]
    assert commands[-1] == ['/tools/docker', 'rm', '--force', browser.name]
    assert sum(c[1] == 'rm' for c in commands) == 1
    requests = [e[1] for e in docker if e[0] == 'api' and isinstance(e[1], dict)]
    assert [r['cmd'] for r in requests] == ['sessions.create', 'sessions.destroy']
    assert docker[-1] == ('proxy', 'stop')
    assert signal.getsignal(signal.SIGTERM) == previous


@pytest.mark.parametrize('signum,error', [(signal.SIGTERM, SystemExit), (signal.SIGINT, KeyboardInterrupt)])
def test_signals_remove_container_before_unwinding(docker, signum, error):
    browser = flare.FlareSolverr()
    previous = signal.getsignal(signum)
    with browser:
        with pytest.raises(error):
            signal.getsignal(signum)(signum, None)
        assert ('docker', ['/tools/docker', 'rm', '--force', browser.name]) in docker
        assert browser.closed
    assert signal.getsignal(signum) == previous


@pytest.mark.parametrize('failure', ['run', 'port', 'health', 'proxy', 'session'])
def test_startup_failure_also_cleans_container(docker, monkeypatch, failure):
    run = flare.subprocess.run
    api = flare.FlareSolverr._json
    def broken_run(argv, **kwargs):
        if argv[1] == failure:
            docker.append(('docker', argv))
            return subprocess.CompletedProcess(argv, 1, '', 'startup failed')
        return run(argv, **kwargs)
    def broken_api(self, path, payload=None, **kwargs):
        if (failure == 'health' and path == '/health') or (failure == 'session' and payload and payload['cmd'] == 'sessions.create'):
            raise flare.FlareSolverrError('not ready')
        return api(self, path, payload, **kwargs)
    monkeypatch.setattr(flare.subprocess, 'run', broken_run)
    monkeypatch.setattr(flare.FlareSolverr, '_json', broken_api)
    if failure == 'proxy':
        def broken_proxy(self):
            raise flare.FlareSolverrError('container proxy failed')
        monkeypatch.setattr(flare.FlareSolverr, '_start_proxy', broken_proxy)
    browser = flare.FlareSolverr(startup_timeout=0)
    with pytest.raises(flare.FlareSolverrError):
        with browser:
            pytest.fail('startup must not succeed')
    assert ('docker', ['/tools/docker', 'rm', '--force', browser.name]) in docker
    assert ('proxy', 'start') not in docker or docker[-1] == ('proxy', 'stop')


def test_missing_docker_does_not_create_proxy_or_container(docker, monkeypatch):
    monkeypatch.setattr(flare.shutil, 'which', lambda name: None)
    with pytest.raises(flare.FlareSolverrError, match='Docker is required'):
        with flare.FlareSolverr():
            pass
    assert docker == []


@pytest.mark.parametrize('access', ['ok', 'not_found', 'private', 'error'])
def test_browser_not_used_for_successes_or_missing_private_accounts(monkeypatch, access):
    normal = {'access': access, 'url': 'https://github.com/cwren'}
    monkeypatch.setattr(profile_evidence, 'fetch', lambda *a, **kw: normal)
    browser = flare.FlareSolverr()
    monkeypatch.setattr(browser, '_json', lambda *a, **kw: pytest.fail('must not browse'))
    assert browser(normal['url']) is normal


def blocked_fetch(monkeypatch, access='blocked'):
    original = profile_evidence.fetch
    def fetch(url, timeout=8, **kwargs):
        if 'get' in kwargs:
            return original(url, timeout=timeout, **kwargs)
        return {'url': url, 'access': access, 'title': '', 'description': ''}
    monkeypatch.setattr(profile_evidence, 'fetch', fetch)
    monkeypatch.setattr(profile_evidence, 'public_address', lambda host: '8.8.8.8')


def test_blocked_page_fallback_extracts_metadata_but_discards_cookies(monkeypatch):
    blocked_fetch(monkeypatch)
    calls = []
    browser = flare.FlareSolverr(timeout=43)
    def api(path, payload, timeout):
        calls.append(payload)
        assert timeout == 48 and payload['maxTimeout'] == 43000
        return {'status': 'ok', 'solution': {
            'url': payload['url'], 'status': 200,
            'response': '<title>Chris Wren</title><meta name="description" content="Recruiter in Richmond">',
            'cookies': [{'name': 'clearance', 'value': 'SECRET_COOKIE'}], 'turnstile_token': 'SECRET_TOKEN'}}
    monkeypatch.setattr(browser, '_json', api)
    result = browser('https://medium.com/@cwren')
    assert result['access'] == 'ok' and result['title'] == 'Chris Wren'
    assert result['transport'] == 'flaresolverr'
    assert 'SECRET' not in json.dumps(result)
    assert calls[0]['session'] == browser.session


def test_duolingo_browser_fallback_parses_html_not_api_json(monkeypatch):
    blocked_fetch(monkeypatch)
    browser = flare.FlareSolverr()
    monkeypatch.setattr(browser, "_json", lambda *a, **kw: {"solution": {
        "url": "https://duolingo.com/profile/chriswren", "status": 200,
        "response": "<title>Chris Wren | Duolingo</title>"}})
    result = browser("https://duolingo.com/profile/chriswren")
    assert result["access"] == "ok" and result["title"] == "Chris Wren | Duolingo"
    assert result["transport"] == "flaresolverr"


def test_browser_status_200_does_not_hide_a_soft_404(monkeypatch):
    blocked_fetch(monkeypatch)
    browser = flare.FlareSolverr()
    monkeypatch.setattr(browser, '_json', lambda *a, **kw: {'solution': {
        'url': 'https://medium.com/@missing', 'status': 200,
        'response': '<title>Medium</title><h1>404</h1>'}})
    assert browser('https://medium.com/@missing')['access'] == 'not_found'


def test_solver_failure_keeps_page_inaccessible(monkeypatch):
    blocked_fetch(monkeypatch)
    browser = flare.FlareSolverr()
    def fail(*a, **kw):
        raise flare.FlareSolverrError('CAPTCHA could not be solved')
    monkeypatch.setattr(browser, '_json', fail)
    result = browser('https://medium.com/@cwren')
    assert result['access'] == 'blocked' and 'CAPTCHA' in result['browser_error']


@pytest.mark.parametrize('url', ['https://untrusted.medium.com', 'http://github.com/cwren'])
def test_browser_cannot_be_sent_to_arbitrary_subdomains_or_plain_http(monkeypatch, url):
    blocked_fetch(monkeypatch)
    browser = flare.FlareSolverr()
    monkeypatch.setattr(browser, '_json', lambda *a, **kw: pytest.fail('must not browse arbitrary hosts'))
    assert browser(url)['access'] == 'blocked'


def test_browser_final_navigation_must_stay_in_scope(monkeypatch):
    blocked_fetch(monkeypatch)
    browser = flare.FlareSolverr()
    monkeypatch.setattr(browser, '_json', lambda *a, **kw: {'solution': {'url': 'http://127.0.0.1/admin'}})
    assert browser('https://github.com/cwren')['access'] == 'blocked'


def test_opt_in_retries_cached_blocks_without_discarding_good_cache(conn):
    def blocked(url, timeout):
        return {'url': url, 'access': 'blocked'}
    urls = ['https://medium.com/@cwren']
    profile_evidence.collect_many(conn, urls, fetcher=blocked)
    seen = []
    def solved(url, timeout):
        seen.append(url)
        return {'url': url, 'access': 'ok'}
    profile_evidence.collect_many(conn, urls, fetcher=solved)
    assert not seen
    profile_evidence.collect_many(conn, urls, fetcher=solved, retry_inaccessible=True)
    assert seen == urls
    profile_evidence.collect_many(conn, urls, fetcher=solved, retry_inaccessible=True)
    assert seen == urls


@pytest.mark.parametrize('failure', [False, True])
def test_cli_scopes_solver_to_invocation_and_closes_on_model_errors(conn, monkeypatch, failure):
    identity.create_person(conn, 'Chris Wren')
    state = []
    @contextlib.contextmanager
    def solver(**kwargs):
        state.append('start')
        try:
            yield 'fetcher'
        finally:
            state.append('stop')
    def find(*a, **kw):
        assert kw['fetcher'] == 'fetcher' and kw['retry_inaccessible']
        if failure:
            raise socials.llm.LLMError('model failed')
        return 0, 0.0
    monkeypatch.setattr(flare, 'FlareSolverr', solver)
    monkeypatch.setattr(socials, 'find', find)
    args = cli.build_parser().parse_args(['socials', 'find', 'Chris Wren', '--flaresolverr'])
    if failure:
        with pytest.raises(SystemExit):
            cli.cmd_socials(conn, args)
    else:
        cli.cmd_socials(conn, args)
    assert state == ['start', 'stop']


@pytest.mark.skipif(os.environ.get('MYPEOPLE_TEST_DOCKER') != '1', reason='opt-in live Docker lifecycle test')
def test_live_docker_health_session_proxy_navigation_and_removal(monkeypatch):
    from mypeople import public_proxy

    monkeypatch.setattr(public_proxy, 'PublicProxy', lambda: pytest.fail('must not open a proxy on the host'))
    with flare.FlareSolverr() as browser:
        assert browser._json('/health')['status'] == 'ok'
        name = browser.name
        value = browser._json('/v1', {'cmd': 'request.get', 'session': browser.session,
                                     'url': 'https://github.com/jonaylor89', 'maxTimeout': 45000,
                                     'disableMedia': True}, timeout=50)
        parser = profile_evidence.Metadata(value['solution']['url'])
        parser.feed(value['solution']['response'][:profile_evidence.MAX_BYTES])
        assert 'jonaylor89' in parser.title.lower()
        config = json.loads(browser._docker('inspect', name))[0]
        assert set(config['HostConfig']['PortBindings']) == {'8191/tcp'}
        proxy_port = int(urllib.parse.urlsplit(browser.proxy_url).port)
        # The private proxy is bound to 127.0.0.1 in the CONTAINER network namespace.
        listeners = browser._docker('exec', name, 'python3', '-c',
            "import pathlib; print(pathlib.Path('/proc/net/tcp').read_text())")
        assert f'0100007F:{proxy_port:04X}' in listeners
    result = subprocess.run(['docker', 'inspect', name], capture_output=True, timeout=10)
    assert result.returncode != 0


@pytest.mark.skipif(os.environ.get('MYPEOPLE_TEST_DOCKER') != '1', reason='opt-in live Docker failure-cleanup test')
def test_live_docker_removal_on_exception():
    browser = flare.FlareSolverr()
    with pytest.raises(RuntimeError, match='intentional live failure'):
        with browser:
            raise RuntimeError('intentional live failure')
    assert subprocess.run(['docker', 'inspect', browser.name], capture_output=True, timeout=10).returncode != 0


@pytest.mark.skipif(os.environ.get('MYPEOPLE_TEST_DOCKER') != '1', reason='opt-in live Docker signal-cleanup test')
@pytest.mark.parametrize('signum', [signal.SIGINT, signal.SIGTERM])
def test_live_docker_removal_on_real_process_signal(tmp_path, signum):
    marker = tmp_path / 'name'
    ready = tmp_path / 'ready'
    child = '''
import sys, time
from pathlib import Path
from mypeople.flaresolverr import FlareSolverr
browser = FlareSolverr()
Path(sys.argv[1]).write_text(browser.name)
with browser:
    Path(sys.argv[2]).write_text('ready')
    time.sleep(120)
'''
    proc = subprocess.Popen([sys.executable, '-c', child, str(marker), str(ready)],
                            cwd=Path(__file__).resolve().parents[1], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 420
        while not ready.exists():
            if proc.poll() is not None:
                _, error = proc.communicate()
                pytest.fail(f'Browser child exited before readiness: {error.decode()[-1000:]}')
            if time.monotonic() >= deadline:
                pytest.fail('Browser child did not become ready')
            time.sleep(0.1)
        name = marker.read_text()
        proc.send_signal(signum)
        proc.communicate(timeout=30)
        assert proc.returncode != 0
        assert subprocess.run(['docker', 'inspect', name], capture_output=True, timeout=10).returncode != 0
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate(timeout=5)
        # Last-resort cleanup on assertion/time-budget failures, scoped only to
        # the unique container name generated by this test's own child process.
        if marker.exists() and marker.read_text().startswith('mypeople-flaresolverr-'):
            subprocess.run(['docker', 'rm', '-f', marker.read_text()], capture_output=True, timeout=20)
