"""Bounded keyboard, accessible-name, modal and draft checks on local fixtures.

Uses real browser navigation and the disposable Auth/Data API, never injected
sessions or queue bytes. This is browser accessibility coverage, not a physical
device or screen-reader certification.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import traceback
from urllib.parse import urlencode, urlparse
from uuid import uuid4

from local_e2e import LOOPBACK, LocalAPI, local_url, private_credentials, protect_file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--credentials-file', type=Path, required=True)
    parser.add_argument('--allow-disposable-local', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--browser', default='/usr/bin/chromium')
    args = parser.parse_args()
    if not args.allow_disposable_local:
        parser.error('Explicit disposable-local opt-in is required; no service contacted.')
    base = local_url(args.base_url, root=True)
    target = private_credentials(args.credentials_file)
    os.umask(0o077)
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    secret_values = [target['anon'], target['service']]
    api = LocalAPI(target, secret_values)
    users, contexts = [], []
    result = {'status': 'running', 'scope': 'local browser keyboard/names/focus/draft checks only',
              'checks': [], 'page_errors': [], 'blocked_requests': [],
              'not_run': ['physical devices', 'screen-reader speech output', 'external providers', 'full WCAG audit']}
    browser = playwright = None
    run_id = uuid4().hex[:12]

    def checkpoint(name, work):
        try:
            detail = work()
            result['checks'].append({'name': name, 'status': 'passed', 'detail': detail})
            print(json.dumps({'passed': name}), flush=True)
        except TimeoutError:
            # The process-wide deadline must abort the pass and reach cleanup,
            # rather than becoming one failed checkpoint followed by more work.
            raise
        except Exception as failure:
            # Exception text can contain a credential-bearing input locator.
            detail = {'name': name, 'status': 'failed', 'exception': type(failure).__name__}
            detail['test_source_lines'] = [frame.lineno for frame in traceback.extract_tb(failure.__traceback__)
                                           if Path(frame.filename).resolve() == Path(__file__).resolve()]
            # Keep only fixed focus attributes and path; never credential input
            # values, arbitrary response bodies or the full query string.
            detail['browser_state'] = []
            for context in contexts:
                for page in context.pages:
                    if not page.is_closed():
                        try:
                            detail['browser_state'].append({'path': urlparse(page.url).path,
                                'focus': active_focus(page), 'dialogs': page.get_by_role('dialog').count()})
                        except Exception: pass
            result['checks'].append(detail)
            print(json.dumps({'failed': name, 'exception': type(failure).__name__}), flush=True)

    def principal(label):
        email = f'rentview-a11y-{run_id}-{label}@example.test'
        password = 'Rv!' + secrets.token_urlsafe(24)
        secret_values.append(password)
        uid = api.admin_user(email, password, 'Fixture accessibility ' + label)
        users.append(uid)
        _, token = api.login(email, password)
        return {'id': uid, 'email': email, 'password': password, 'token': token}

    def page_for(viewport):
        context = browser.new_context(viewport=viewport, service_workers='block')
        contexts.append(context)
        def guard(route):
            parsed = urlparse(route.request.url)
            if parsed.scheme in {'data', 'blob'} or parsed.hostname in LOOPBACK:
                route.continue_()
            else:
                result['blocked_requests'].append({'kind': 'http', 'host': parsed.hostname, 'path': parsed.path})
                route.abort('blockedbyclient')
        context.route('**/*', guard)
        if not hasattr(context, 'route_web_socket'):
            raise RuntimeError('WebSocket interception is required.')
        def ws_guard(route):
            parsed = urlparse(route.url)
            if parsed.hostname in LOOPBACK:
                route.connect_to_server()
            else:
                result['blocked_requests'].append({'kind': 'websocket', 'host': parsed.hostname, 'path': parsed.path})
                route.close()
        context.route_web_socket('**/*', ws_guard)
        page = context.new_page()
        page.set_default_timeout(10000)
        page.on('pageerror', lambda error: result['page_errors'].append(type(error).__name__))
        page.on('dialog', lambda dialog: dialog.accept())
        return page

    def tab_to(page, locator):
        expect(locator).to_be_visible()
        for _ in range(100):
            if locator.evaluate('(element) => element === document.activeElement'):
                return
            page.keyboard.press('Tab')
        raise AssertionError('Named control is not reachable within the bounded Tab cycle.')

    def activate(page, locator):
        tab_to(page, locator)
        page.keyboard.press('Enter')

    def login(page, person, tenant=False):
        page.goto(base + '/login', wait_until='domcontentloaded')
        email = page.get_by_label('Email', exact=True)
        password = page.get_by_label('Password', exact=True)
        tab_to(page, email)
        page.keyboard.type(person['email'])
        tab_to(page, password)
        page.keyboard.type(person['password'])
        page.keyboard.press('Enter')
        page.wait_for_url(lambda value: urlparse(value).path.rstrip('/') != '/login', timeout=30000)
        expect(page.get_by_text('My leases', exact=True) if tenant else page.get_by_role('button', name='Open Work', exact=True)).to_be_visible(timeout=30000)

    def active_focus(page):
        return page.evaluate('''() => ({tag: document.activeElement?.tagName,
          role: document.activeElement?.getAttribute('role'),
          name: document.activeElement?.getAttribute('aria-label'),
          insideDialog: !!document.activeElement?.closest('[role="dialog"]')})''')

    try:
        from playwright.sync_api import sync_playwright, expect
        api.ok('GET', '/auth/v1/health')
        owner, tenant = principal('owner'), principal('tenant')
        property_row = api.insert('properties', {'owner_id': owner['id'], 'name': 'Fixture Keyboard Building ' + run_id}, owner['token'])
        unit = api.insert('units', {'owner_id': owner['id'], 'property_id': property_row['id'], 'label': 'Fixture keyboard unit'}, owner['token'])
        lease = api.insert('leases', {'owner_id': owner['id'], 'unit_id': unit['id'], 'tenant_name': 'Fixture keyboard tenant', 'tenant_email': tenant['email'], 'status': 'active'}, owner['token'])
        invitation = api.rpc('create_tenant_invite', {'p_lease_id': lease['id'], 'p_email': tenant['email']}, owner['token'])
        api.rpc('claim_tenant_invite', {'invite_code': invitation['code']}, tenant['token'])
        playwright = sync_playwright().start()
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True, args=['--no-sandbox', '--disable-background-networking'])
        owner_page = page_for({'width': 1440, 'height': 1000})

        def login_validation():
            owner_page.goto(base + '/login', wait_until='domcontentloaded')
            expect(owner_page.get_by_label('Email', exact=True)).to_have_count(1)
            expect(owner_page.get_by_label('Password', exact=True)).to_have_count(1)
            activate(owner_page, owner_page.get_by_role('button', name='Sign in', exact=True))
            expect(owner_page.get_by_role('alert')).to_have_text('Enter a valid email address.')
            expect(owner_page.get_by_role('button', name='Sign in', exact=True)).to_be_focused()
        checkpoint('named login controls are keyboard reachable; invalid submit announces and retains focus', login_validation)
        login(owner_page, owner)

        def owner_navigation():
            activate(owner_page, owner_page.get_by_role('tab', name='Properties', exact=True))
            owner_page.wait_for_url(lambda value: urlparse(value).path == '/properties')
            expect(owner_page.get_by_role('tab', name='Properties', exact=True)).to_have_attribute('aria-selected', 'true')
            expect(owner_page.get_by_label('Search properties', exact=True)).to_be_visible()
        checkpoint('owner tabs navigate by keyboard and expose selected state', owner_navigation)

        def modal_focus():
            owner_page.goto(base + '/properties', wait_until='domcontentloaded')
            activate(owner_page, owner_page.get_by_role('button', name='Add property', exact=True))
            expect(owner_page.get_by_role('dialog')).to_have_count(1)
            expect(owner_page.get_by_label('Name', exact=True)).to_be_focused()
            for _ in range(18):
                owner_page.keyboard.press('Tab')
                assert active_focus(owner_page)['insideDialog'], 'Tab focus escaped the active modal.'
            owner_page.get_by_label('Name', exact=True).fill('Fixture interrupted draft ' + run_id)
            owner_page.keyboard.press('Escape')
            expect(owner_page.get_by_role('dialog')).to_have_count(0)
            expect(owner_page.get_by_role('button', name='Add property', exact=True)).to_be_focused()
        checkpoint('property modal takes and traps focus; Escape restores the opener', modal_focus)

        def modal_draft():
            owner_page.goto(base + '/properties', wait_until='domcontentloaded')
            activate(owner_page, owner_page.get_by_role('button', name='Add property', exact=True))
            # RN-web assigns the active dialog role after its opening animation.
            # Waiting for that state prevents an Escape sent before activation
            # from being mistaken for a successful close because count is zero.
            expect(owner_page.get_by_role('dialog')).to_have_count(1)
            expect(owner_page.get_by_label('Name', exact=True)).to_be_focused()
            owner_page.get_by_label('Name', exact=True).fill('Fixture interrupted draft ' + run_id)
            owner_page.keyboard.press('Escape')
            expect(owner_page.get_by_role('dialog')).to_have_count(0)
            expect(owner_page.get_by_role('button', name='Add property', exact=True)).to_be_focused()
            activate(owner_page, owner_page.get_by_role('button', name='Add property', exact=True))
            expect(owner_page.get_by_role('dialog')).to_have_count(1)
            expect(owner_page.get_by_label('Name', exact=True)).to_have_value('Fixture interrupted draft ' + run_id)
            # Selection must have a keyboard-operable role and nonvisual state.
            commercial = owner_page.get_by_role('radio', name='Commercial', exact=True).or_(
                owner_page.get_by_role('button', name='Commercial', exact=True))
            expect(commercial).to_have_count(1)
            if commercial.get_attribute('role') == 'radio':
                group = owner_page.get_by_role('radiogroup', name='Property type', exact=True)
                expect(group).to_have_count(1)
                radios = group.get_by_role('radio')
                selected = group.locator('[role="radio"][aria-checked="true"]')
                expect(selected).to_have_count(1)
                expect(group.locator('[role="radio"][tabindex="0"]')).to_have_count(1)
                initial_state = radios.evaluate_all('''elements => elements.map(element => ({
                    label: element.getAttribute('aria-label'), checked: element.getAttribute('aria-checked'),
                    tabIndex: element.tabIndex
                }))''')
                assert all(item['checked'] in ('true', 'false') for item in initial_state)
                assert all((item['checked'] == 'true') == (item['tabIndex'] == 0) for item in initial_state)
                residential = owner_page.get_by_role('radio', name='Residential', exact=True)
                # Only the checked radio belongs in the Tab order. Arrow/Home
                # keys move within the group; unchecked radios need not Tab-focus.
                tab_to(owner_page, selected)
                owner_page.keyboard.press('Home')
                expect(residential).to_be_focused()
                expect(residential).to_have_attribute('aria-checked', 'true')
                owner_page.keyboard.press('ArrowRight')
                expect(commercial).to_be_focused()
                owner_page.keyboard.press('Space')
                expect(commercial).to_have_attribute('aria-checked', 'true')
                owner_page.keyboard.press('Home')
                expect(residential).to_be_focused()
                expect(residential).to_have_attribute('aria-checked', 'true')
                owner_page.keyboard.press('End')
                expect(owner_page.get_by_role('radio', name='Mixed', exact=True)).to_be_focused()
                owner_page.keyboard.press('ArrowRight')
                expect(residential).to_be_focused()
                owner_page.keyboard.press('ArrowRight')
            else:
                activate(owner_page, commercial)
            state_attribute = 'aria-checked' if commercial.get_attribute('role') == 'radio' else 'aria-pressed'
            expect(commercial).to_have_attribute(state_attribute, 'true')
            residential = owner_page.get_by_role('radio', name='Residential', exact=True).or_(
                owner_page.get_by_role('button', name='Residential', exact=True))
            expect(residential).to_have_attribute(state_attribute, 'false')
            if commercial.get_attribute('role') == 'radio':
                expect(group.locator('[role="radio"][aria-checked="true"]')).to_have_count(1)
                return {'initial_radio_state': initial_state, 'checked_after_keyboard': 'Commercial'}
        checkpoint('Escape preserves the draft and property-type selection exposes role and state', modal_draft)

        def interrupted_navigation():
            owner_page.goto(base + '/', wait_until='domcontentloaded')
            expect(owner_page.get_by_role('button', name='Open Work', exact=True)).to_be_visible()
            activate(owner_page, owner_page.get_by_role('tab', name='Properties', exact=True))
            activate(owner_page, owner_page.get_by_role('button', name='Add property', exact=True))
            expect(owner_page.get_by_role('dialog')).to_have_count(1)
            expect(owner_page.get_by_label('Name', exact=True)).to_be_focused()
            owner_page.get_by_label('Name', exact=True).fill('Fixture interrupted draft ' + run_id)
            owner_page.go_back(wait_until='domcontentloaded')
            expect(owner_page.get_by_role('button', name='Open Work', exact=True)).to_be_visible()
            expect(owner_page.get_by_role('dialog')).to_have_count(0)
            expect(owner_page.get_by_label('Name', exact=True)).not_to_be_attached()
            activate(owner_page, owner_page.get_by_role('tab', name='Properties', exact=True))
            activate(owner_page, owner_page.get_by_role('button', name='Add property', exact=True))
            expect(owner_page.get_by_label('Name', exact=True)).to_have_value('Fixture interrupted draft ' + run_id)
            activate(owner_page, owner_page.get_by_role('button', name='Cancel', exact=True))
            expect(owner_page.get_by_role('dialog')).to_have_count(0)
            assert len(api.select('properties', owner['token'])) == 1, 'Interrupted form wrote a property.'
        checkpoint('browser Back closes the inactive modal and preserves its unsaved draft without a write', interrupted_navigation)

        def keyboard_card():
            if owner_page.get_by_role('dialog').count(): owner_page.keyboard.press('Escape')
            owner_page.goto(base + '/properties', wait_until='domcontentloaded')
            card = owner_page.get_by_role('button', name=property_row['name'] + ' residential 1 unit', exact=False)
            # Child text is the accessible name of the actual pressable card.
            if not card.count(): card = owner_page.get_by_role('button').filter(has_text=property_row['name'])
            activate(owner_page, card)
            owner_page.wait_for_url(lambda value: urlparse(value).path == '/property/' + property_row['id'])
            back = owner_page.get_by_role('button', name='Back', exact=True)
            activate(owner_page, back)
            owner_page.wait_for_url(lambda value: urlparse(value).path == '/properties')
        checkpoint('named property card and detail Back control work by keyboard', keyboard_card)

        tenant_page = page_for({'width': 390, 'height': 844})
        login(tenant_page, tenant, tenant=True)
        def tenant_navigation():
            for label, path in [('Requests', '/tenant/requests'), ('Rent', '/tenant/rent'), ('Home', '/tenant')]:
                tab = tenant_page.get_by_role('tab', name=label, exact=True)
                activate(tenant_page, tab)
                tenant_page.wait_for_url(lambda value: urlparse(value).path.rstrip('/') == path)
                expect(tab).to_have_attribute('aria-selected', 'true')
        checkpoint('tenant phone viewport tabs are keyboard reachable with current-page state', tenant_navigation)

        def tenant_draft():
            activate(tenant_page, tenant_page.get_by_role('button', name='Report a repair', exact=True))
            for name in ["What's wrong", 'Details', 'When can someone visit? (optional)', 'Access instructions / permission (optional)', 'Preferred contact (optional)']:
                field = tenant_page.get_by_label(name, exact=True)
                expect(field).to_have_count(1)
                tab_to(tenant_page, field)
            tenant_page.get_by_label("What's wrong", exact=True).fill('x')
            tenant_page.get_by_label('Details', exact=True).fill('Fixture detail remains after validation')
            activate(tenant_page, tenant_page.get_by_role('button', name='Submit request', exact=True))
            expect(tenant_page.get_by_role('alert')).to_contain_text('at least 3 characters')
            expect(tenant_page.get_by_label("What's wrong", exact=True)).to_have_value('x')
            expect(tenant_page.get_by_label('Details', exact=True)).to_have_value('Fixture detail remains after validation')
            expect(tenant_page.get_by_role('button', name='Submit request', exact=True)).to_be_focused()
            assert api.select('maintenance_requests', tenant['token']) == [], 'Invalid tenant request wrote data.'
        checkpoint('tenant repair fields have names; keyboard validation announces without losing draft or focus', tenant_draft)
        checkpoint('no browser errors or external HTTP/WebSocket requests', lambda: (assert_empty(result['page_errors']), assert_empty(result['blocked_requests'])))
        result['status'] = 'passed' if all(c['status'] == 'passed' for c in result['checks']) else 'failed'
    except Exception as failure:
        result['status'] = 'failed'
        result['failure'] = {'exception': type(failure).__name__}
    finally:
        for context in contexts:
            try: context.close()
            except Exception: pass
        if browser:
            try: browser.close()
            except Exception: pass
        if playwright:
            try: playwright.stop()
            except Exception: pass
        cleanup_errors = 0
        for uid in reversed(users):
            try: api.ok('DELETE', '/auth/v1/admin/users/' + uid, admin=True)
            except Exception: cleanup_errors += 1
        result['cleanup'] = {'synthetic_users': len(users), 'errors': cleanup_errors}
        if cleanup_errors: result['status'] = 'failed'
        report = args.output / 'results.json'
        report.write_text(json.dumps(result, indent=2) + '\n')
        protect_file(report)
        print(json.dumps({'status': result['status'], 'checks': len(result['checks']), 'report': str(report)}))
    return 0 if result['status'] == 'passed' else 1


def assert_empty(values):
    assert values == [], 'Unexpected browser runtime error or outbound request.'


if __name__ == '__main__':
    def timeout(_signal, _frame):
        raise TimeoutError('Bounded accessibility runner exceeded its wall-clock limit.')
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(300)
    raise SystemExit(main())
