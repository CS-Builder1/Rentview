"""Synthetic frontend smoke only: no real login, tenant, email or provider calls.
Run against a loopback-served production export after SDK alignment. All page
HTTP/WebSocket traffic outside loopback is intercepted and blocked.
"""
import argparse
import json
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('base_url')
parser.add_argument('--output', default='/workspace/scratch/rentview-browser-smoke')
parser.add_argument('--browser', default='/usr/bin/chromium')
args = parser.parse_args()
parsed = urlparse(args.base_url)
LOOPBACK = {'localhost', '127.0.0.1', '::1'}
if parsed.scheme not in {'http', 'https'} or parsed.hostname not in LOOPBACK:
    parser.error('Only a local loopback test server is accepted.')
base = args.base_url.rstrip('/')
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
results = []
# Exercise the real Router/browser parsing path with bounded URLs. These are
# navigation/render regressions, not claims that a dependency exploit is reachable.
# The reserved .invalid destination must never become a browser request.
query_vectors = [
    ('malformed percent escapes', 'next=%&note=%2&escape=%GG'),
    ('malformed UTF-8 escapes', 'next=%E0%A4%A&note=%ED%A0%80'),
    ('Unicode query values', urlencode({'next': '/', 'note': '\U0001f600\u00e9\u96ea\ufffd'})),
    ('duplicate query keys', 'next=%2Fclaim%3Fcode%3DA1B2C3D4E5F6A7B8&next=https%3A%2F%2Foutside.invalid%2Fcapture&note=one&note=two'),
    ('prototype-like query keys', urlencode({'__proto__': '{"polluted":true}', 'constructor': 'prototype', 'constructor[prototype][polluted]': 'true', 'toString': 'harmless', 'next': '/'})),
    ('valueOf query key', 'valueOf=harmless&next=%2F'),
    ('encoded conversion member keys', '%74oString=harmless&%76alueOf=harmless&next=%2F'),
    ('absolute external return', urlencode({'next': 'https://outside.invalid/capture'})),
    ('protocol-relative external return', urlencode({'next': '//outside.invalid/capture'})),
    ('double-encoded external return', urlencode({'next': '%2F%2Foutside.invalid%2Fcapture'})),
    ('bounded long query', urlencode({'next': '/', 'note': 'x' * 3800, 'duplicate': ['one', 'two']}, doseq=True)),
]
assert all(len(query.encode('ascii')) <= 4096 for _, query in query_vectors)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.browser, headless=True, args=['--no-sandbox', '--disable-background-networking'])
    try:
        for name, viewport in [('phone', {'width': 390, 'height': 844}), ('desktop', {'width': 1440, 'height': 1000})]:
            blocked = []
            errors = []
            context = browser.new_context(viewport=viewport, service_workers='block')
            def guard(route):
                url = urlparse(route.request.url)
                if url.scheme in {'data', 'blob'} or url.hostname in LOOPBACK:
                    route.continue_()
                else:
                    blocked.append({'kind': 'http', 'method': route.request.method, 'host': url.hostname, 'path': url.path})
                    route.abort('blockedbyclient')
            context.route('**/*', guard)
            if not hasattr(context, 'route_web_socket'):
                raise RuntimeError('Playwright lacks WebSocket interception; upgrade the approved toolchain before running this smoke.')
            def guard_ws(route):
                url = urlparse(route.url)
                if url.hostname in LOOPBACK:
                    route.connect_to_server()
                else:
                    blocked.append({'kind': 'websocket', 'host': url.hostname, 'path': url.path})
                    route.close()
            context.route_web_socket('**/*', guard_ws)
            page = context.new_page()
            page.set_default_timeout(15_000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            checks = []
            history_snapshots = []
            history_replacements = []
            try:
                response = page.goto(base + '/login', wait_until='domcontentloaded', timeout=30_000)
                assert response and response.status == 200
                expect(page.get_by_text('Operations-first property management.', exact=True)).to_be_visible()
                page.get_by_role('button', name='Sign in', exact=True).click()
                expect(page.get_by_text('Enter a valid email address.', exact=True)).to_be_visible()
                checks.append('empty sign-in validates without network')
                page.get_by_role('button', name='Forgot password?', exact=True).click()
                page.get_by_role('button', name='Send reset link', exact=True).click()
                expect(page.get_by_text('Enter a valid email address.', exact=True)).to_be_visible()
                checks.append('recovery validates without sending email')
                page.get_by_role('button', name='Back to sign in', exact=True).click()
                page.get_by_role('button', name='No account yet? Create one', exact=True).click()
                expect(page.get_by_placeholder('Your name')).to_be_visible()
                page.get_by_placeholder('you@example.com').fill('fixture@invalid.example')
                page.get_by_label('Password (at least 12 characters)', exact=True).fill('short')
                page.get_by_role('button', name='Create account', exact=True).click()
                expect(page.get_by_text('Use a password with at least 12 characters.', exact=True)).to_be_visible()
                checks.append('weak signup password rejected locally')
                page.get_by_role('link', name='I have an invite code', exact=True).click()
                page.get_by_label('Invite code', exact=True).fill('A1B2C3D4E5F6A7B8')
                page.get_by_role('button', name='Continue to sign in or create account', exact=True).click()
                expect(page.get_by_text('Sign in or create an account to join your landlord. Your invitation will be kept for the next step.', exact=True)).to_be_visible()
                assert parse_qs(urlparse(page.url).query).get('next') == ['/claim?code=A1B2C3D4E5F6A7B8']
                checks.append('invitation continues into authentication')
                page.screenshot(path=str(output / f'{name}-invitation.png'), full_page=True)
                page.goto(base + '/callback?error_description=Fixture%20expired', wait_until='domcontentloaded', timeout=30_000)
                expect(page.get_by_text('Link unavailable', exact=True)).to_be_visible()
                expect(page.get_by_text('Fixture expired', exact=True)).to_be_visible()
                checks.append('expired callback has an actionable state')
                for label, query in query_vectors:
                    response = page.goto(base + '/login?' + query, wait_until='domcontentloaded', timeout=30_000)
                    assert response and response.status == 200, label
                    signin = page.get_by_role('button', name='Sign in', exact=True)
                    expect(signin).to_be_visible()
                    expect(signin).to_be_enabled()
                    current = urlparse(page.url)
                    assert (current.scheme, current.hostname, current.port) == (parsed.scheme, parsed.hostname, parsed.port), (label, page.url)
                    assert current.path.rstrip('/') == '/login', (label, current.path)
                    assert not errors, (label, errors)
                    assert not blocked, (label, blocked)
                    checks.append(f'login handles {label} and stays local')
                # pushState does not notify Router. Real browser back/forward
                # events must clean these inbound entries in the capture phase,
                # before Router's normal popstate listener reads the URL.
                page.goto(base + '/login?note=history-start', wait_until='domcontentloaded', timeout=30_000)
                expect(page.get_by_role('button', name='Sign in', exact=True)).to_be_enabled()
                page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
                page.evaluate('''() => {
                    window.__rentviewHistorySnapshots = [];
                    window.__rentviewHistoryReplacements = [];
                    const replaceState = window.history.replaceState;
                    window.history.replaceState = function(state, title, url) {
                        const result = replaceState.apply(this, arguments);
                        window.__rentviewHistoryReplacements.push({
                            href: window.location.href,
                            input_state: structuredClone(state),
                            after_state: structuredClone(window.history.state),
                            stack: new Error('history replacement boundary').stack,
                        });
                        return result;
                    };
                    window.addEventListener('popstate', event => {
                        window.__rentviewHistorySnapshots.push({
                            href: window.location.href,
                            state: structuredClone(window.history.state),
                            event_state: structuredClone(event.state),
                        });
                    }, true);
                    const state = window.history.state;
                    window.history.pushState({ ...state, rentviewSmoke: 'back-fixture' }, '',
                        '/login?toString=harmless&valueOf=harmless&note=history-back');
                    window.history.pushState({ ...state, rentviewSmoke: 'forward-fixture' }, '',
                        '/login?%74oString=harmless&%76alueOf=harmless&note=history-forward');
                }''')
                for direction, marker, note in [('back', 'back-fixture', 'history-back'), ('forward', 'forward-fixture', 'history-forward')]:
                    if direction == 'back':
                        page.go_back(wait_until='domcontentloaded', timeout=30_000)
                    else:
                        page.go_forward(wait_until='domcontentloaded', timeout=30_000)
                    count = 1 if direction == 'back' else 2
                    page.wait_for_function('(count) => window.__rentviewHistorySnapshots.length >= count', arg=count)
                    history_snapshots = page.evaluate('window.__rentviewHistorySnapshots')
                    snapshot = history_snapshots[count - 1]
                    captured = urlparse(snapshot['href'])
                    assert (captured.scheme, captured.hostname, captured.port) == (parsed.scheme, parsed.hostname, parsed.port), snapshot
                    assert captured.path.rstrip('/') == '/login', snapshot
                    assert parse_qs(captured.query) == {'note': [note]}, snapshot
                    # Router owns history and can replace its state during the
                    # microtask checkpoint between listeners. Measure exact
                    # preservation at the sanitizer's synchronous replacement
                    # boundary, before control returns to Router.
                    history_replacements = page.evaluate('window.__rentviewHistoryReplacements')
                    preserved = [entry for entry in history_replacements if isinstance(entry['input_state'], dict) and entry['input_state'].get('rentviewSmoke') == marker]
                    assert preserved, {'snapshot': snapshot, 'replacements': history_replacements}
                    boundary = preserved[-1]
                    assert boundary['input_state'] == snapshot['event_state'], boundary
                    assert boundary['after_state'] == snapshot['event_state'], boundary
                    assert boundary['href'] == snapshot['href'], boundary
                    assert snapshot['event_state']['rentviewSmoke'] == marker, snapshot
                    expect(page.get_by_role('button', name='Sign in', exact=True)).to_be_visible()
                    expect(page.get_by_role('button', name='Sign in', exact=True)).to_be_enabled()
                    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
                    assert not errors, (direction, errors)
                    assert not blocked, (direction, blocked)
                    checks.append(f'browser {direction} sanitizes before Router and preserves inbound history state')
                assert not errors, errors
                assert not blocked, f'Unexpected external page requests: {blocked}'
                results.append({'viewport': name, 'checks': checks, 'history_snapshots': history_snapshots, 'history_replacements': history_replacements, 'page_errors': errors, 'blocked_requests': blocked})
            except Exception:
                page.screenshot(path=str(output / f'{name}-failure.png'), full_page=True)
                print(json.dumps({'viewport': name, 'completed': checks, 'page_errors': errors, 'blocked_requests': blocked}, indent=2))
                raise
            finally:
                context.close()
    finally:
        browser.close()
(output / 'results.json').write_text(json.dumps({'scope': 'synthetic frontend only; no authenticated backend flow', 'results': results}, indent=2))
print(json.dumps({'scope': 'synthetic frontend only; no authenticated backend flow', 'results': results}, indent=2))
