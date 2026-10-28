"""Bounded real-browser recovery checks against approved disposable local services.

Uses the product's real PKCE recovery email flow and local Mailpit inbox. No
session injection, external email/provider, Edge success mock, or hosted target.
Partial deletion uses the real backend tombstone and an explicitly interrupted
browser request; final Edge-runtime deletion is outside this runner.
"""
from __future__ import annotations

import argparse
import base64
import html
import json
import os
from pathlib import Path
import re
import secrets
import signal
import time
import traceback
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright
from local_e2e import LOOPBACK, LocalAPI, LocalRedirects, local_url, private_credentials


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--mail-url', required=True)
    parser.add_argument('--credentials-file', type=Path, required=True)
    parser.add_argument('--allow-disposable-local', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--check-target', action='store_true')
    parser.add_argument('--scenario-group', choices=('all','accounts','email'), default='all')
    parser.add_argument('--navigation-diagnostics', action='store_true')
    args = parser.parse_args(argv)
    if not args.allow_disposable_local:
        parser.error('Explicit disposable-local opt-in required; no services contacted.')
    try:
        base = local_url(args.base_url, root=True)
        mail_base = local_url(args.mail_url, root=True)
        target = private_credentials(args.credentials_file)
    except (ValueError, OSError, json.JSONDecodeError) as failure:
        parser.error(str(failure))
    if args.check_target:
        print(json.dumps({'target':'loopback only','credentials':'owner-only file','contacted':False}))
        return 0
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    result_file = args.output/'results.json'
    if result_file.exists():
        parser.error('Prior evidence exists; choose a fresh output directory.')
    secret_values = [target['anon'], target['service']]
    api = LocalAPI(target, secret_values)
    mail_http = build_opener(ProxyHandler({}), LocalRedirects())
    users, contexts, mail_ids = [], [], set()
    result = {'status':'running','scope':'synthetic browser + local Auth/Data API/Mailpit only',
              'scenario_group':args.scenario_group,'checks':[],'page_errors':[],'blocked_requests':[],
              'not_run':['external email delivery','physical-device callbacks','successful Edge-runtime account deletion']}
    current_step = 'initialization'
    browser = None
    playwright = None
    run_id = uuid4().hex[:12]
    result['fixture_run_id']=run_id

    def save():
        result_file.write_text(json.dumps(result, indent=2)+'\n')
        result_file.chmod(0o600)

    def checkpoint(label):
        result['checks'].append({'name':label})
        save()
        print(json.dumps({'passed':label}), flush=True)

    def mail_request(method, path, body=None):
        if not path.startswith('/') or path.startswith('//'):
            raise ValueError('Invalid local test-mail path.')
        raw = json.dumps(body).encode() if body is not None else None
        req = Request(local_url(mail_base+path), data=raw, method=method,
                      headers={'Content-Type':'application/json'} if raw else {})
        try:
            response = mail_http.open(req, timeout=8)
        except HTTPError as failure:
            response = failure
        value = response.read(1024*1024+1)
        assert len(value)<=1024*1024, 'Unexpectedly large local test email.'
        if method=='DELETE' or response.status>=400:
            return response.status, None
        return response.status, json.loads(value) if value else None

    def recovery_link(email, page):
        # Read only the exact task-created recipient, never a shared mailbox.
        assert email.startswith('rentview-recovery-'+run_id+'-') and email.endswith('@example.test')
        deadline = time.monotonic()+30
        while time.monotonic()<deadline:
            status, payload = mail_request('GET','/api/v1/search?'+urlencode({'query':'to:'+email,'limit':10}))
            assert status==200 and isinstance(payload,dict)
            matches = [m for m in payload.get('messages',[]) if any(t.get('Address','').lower()==email for t in m.get('To',[]))]
            if matches:
                identifier = matches[0]['ID']
                assert re.fullmatch(r'[A-Za-z0-9-]{1,100}',identifier)
                status, message = mail_request('GET','/api/v1/message/'+quote(identifier))
                assert status==200
                assert any(t.get('Address','').lower()==email for t in message.get('To',[]))
                mail_ids.add(identifier)
                content = html.unescape(message.get('HTML','')+'\n'+message.get('Text',''))
                links = re.findall(r'https?://[^\s<>"\']+',content)
                candidates = [v for v in links if urlparse(v).path=='/auth/v1/verify']
                assert len(set(candidates))==1, 'Expected one real Auth verification link.'
                link = candidates[0]
                parsed = urlparse(local_url(link))
                query = parse_qs(parsed.query)
                assert query.get('type')==['recovery'] and parsed.netloc==urlparse(target['url']).netloc
                assert query.get('redirect_to') and local_url(query['redirect_to'][0]).startswith(base+'/callback?')
                secret_values.append(link)
                return link
            page.wait_for_timeout(200)
        raise AssertionError('Local recovery email did not arrive for the synthetic recipient.')

    def principal(label):
        email = f'rentview-recovery-{run_id}-{label}@example.test'
        password = 'Rv!'+secrets.token_urlsafe(24)
        secret_values.append(password)
        uid = api.admin_user(email,password,'Fixture recovery '+label)
        users.append(uid)
        _, token = api.login(email,password)
        return {'id':uid,'email':email,'password':password,'token':token}

    def wire_context():
        context = browser.new_context(viewport={'width':1280,'height':900},service_workers='block')
        contexts.append(context)
        if args.navigation_diagnostics:
            # Observe committed component ancestry and real history calls only.
            # No app state/session/route data is injected or changed.
            context.add_init_script(r"""(() => {
                const trace = { commits: [], history: [], observed: 0 };
                Object.defineProperty(window, '__rentviewRecoveryNavigation', { value: trace });
                const path = value => { try { return new URL(value || location.href, location.href).pathname; } catch { return '[invalid path]'; } };
                for (const method of ['pushState', 'replaceState']) {
                    const original = history[method];
                    history[method] = function(...args) {
                        trace.history.push({ method, path: path(args[2]) });
                        if (trace.history.length > 80) trace.history.shift();
                        return original.apply(this, args);
                    };
                }
                if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;
                const renderers = new Map();
                const name = fiber => {
                    let type = fiber?.elementType || fiber?.type;
                    if (typeof type === 'string') return type;
                    if (typeof type?.render === 'function') type = type.render;
                    if (typeof type?.type === 'function') type = type.type;
                    return type?.displayName || type?.name || '';
                };
                window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
                    supportsFiber: true, renderers,
                    inject(renderer) { const id = renderers.size + 1; renderers.set(id, renderer); return id; },
                    onCommitFiberUnmount() {},
                    onCommitFiberRoot(_id, root) {
                        try {
                            trace.observed += 1;
                            const redirects = []; const layouts = []; const nodes = [root.current]; let visited = 0;
                            while (nodes.length && visited++ < 3000) {
                                const fiber = nodes.pop(); if (!fiber) continue;
                                const label = name(fiber);
                                if (['AuthLayout','AppLayout','Login','ResetPassword','Account','Index'].includes(label)) layouts.push({ component: label, renderedChild: name(fiber.child) });
                                if (label === 'Redirect') {
                                    const ancestry = []; let cursor = fiber.return; let depth = 0;
                                    while (cursor && depth++ < 100) { const label = name(cursor); if (label) ancestry.push(label); cursor = cursor.return; }
                                    const href = fiber.memoizedProps?.href;
                                    redirects.push({ target: path(typeof href === 'string' ? href : href?.pathname), ancestry });
                                }
                                if (fiber.sibling) nodes.push(fiber.sibling);
                                if (fiber.child) nodes.push(fiber.child);
                            }
                            const sample = { path: location.pathname, layouts, redirects };
                            const last = trace.commits[trace.commits.length - 1];
                            if (last && JSON.stringify(last.sample) === JSON.stringify(sample)) last.repeats += 1;
                            else trace.commits.push({ sample, repeats: 1 });
                            if (trace.commits.length > 80) trace.commits.shift();
                        } catch { /* Diagnostics must not affect navigation. */ }
                    },
                };
            })();""")
        def guard(route):
            parsed=urlparse(route.request.url)
            if parsed.scheme in {'data','blob'} or parsed.hostname in LOOPBACK:
                route.continue_()
            else:
                result['blocked_requests'].append({'host':parsed.hostname,'path':parsed.path})
                route.abort('blockedbyclient')
        context.route('**/*',guard)
        if not hasattr(context,'route_web_socket'):
            raise RuntimeError('WebSocket guard unavailable; no browser flow run.')
        def guard_ws(route):
            parsed=urlparse(route.url)
            if parsed.hostname in LOOPBACK:route.connect_to_server()
            else:
                result['blocked_requests'].append({'host':parsed.hostname,'path':parsed.path,'kind':'websocket'})
                route.close()
        context.route_web_socket('**/*',guard_ws)
        return context

    def new_page(context):
        page=context.new_page()
        page.set_default_timeout(20_000)
        # Record sanitized messages, never stacks containing callback URLs.
        def page_error(error):
            message=str(error)
            for value in secret_values:
                if value:message=message.replace(value,'[fixture-secret]')
            message=re.sub(r'https?://[^\s\"\'<>]+', '[local URL]', message)
            message=re.sub(r'eyJ[A-Za-z0-9_.-]{30,}', '[token]', message)
            stack=getattr(error,'stack','') or ''
            def safe_stack_url(match):
                parsed=urlparse(match.group(0))
                return '[local build]'+parsed.path if parsed.hostname in LOOPBACK and parsed.path.startswith('/_expo/') else '[local URL]'
            stack=re.sub(r'https?://[^\s\"\'<>)]+' ,safe_stack_url,stack)
            for value in secret_values:
                if value:stack=stack.replace(value,'[fixture-secret]')
            stack=re.sub(r'eyJ[A-Za-z0-9_.-]{30,}','[token]',stack)
            result['page_errors'].append({'step':current_step,'message':message[:500],'stack':stack[:4000]})
            if args.navigation_diagnostics:
                try:
                    result.setdefault('navigation_diagnostics',[]).append({'step':current_step,'trace':page.evaluate('() => window.__rentviewRecoveryNavigation')})
                except Exception:pass
        page.on('pageerror',page_error)
        return page

    def login(page, who):
        page.goto(base+'/login',wait_until='domcontentloaded')
        page.get_by_label('Email',exact=True).fill(who['email'])
        page.get_by_label('Password',exact=True).fill(who['password'])
        page.get_by_role('button',name='Sign in',exact=True).click()
        page.wait_for_url(lambda value:urlparse(value).path.rstrip('/')!='/login')
        expect(page.get_by_role('button',name='Open Work',exact=True)).to_be_visible()

    def request_recovery(page,who):
        page.goto(base+'/login?'+urlencode({'next':'/account'}),wait_until='domcontentloaded')
        page.get_by_role('button',name='Forgot password?',exact=True).click()
        page.get_by_label('Email',exact=True).fill(who['email'])
        with page.expect_response(lambda response:urlparse(response.url).path=='/auth/v1/recover') as recovered:
            page.get_by_role('button',name='Send reset link',exact=True).click()
        assert recovered.value.status==200
        request=json.loads(recovered.value.request.post_data)
        assert request.get('code_challenge') and request.get('code_challenge_method')=='s256'
        expect(page.get_by_text('If an account exists for this address, a password reset link is on its way. Open it on this device/browser.',exact=True)).to_be_visible()
        return recovery_link(who['email'],page)

    def password_fields(page,password,confirmation=None):
        page.get_by_label('New password (at least 12 characters)',exact=True).fill(password)
        page.get_by_label('Repeat new password',exact=True).fill(password if confirmation is None else confirmation)

    def password_status(who,password):
        status,payload=api.request('POST','/auth/v1/token?grant_type=password',body={'email':who['email'],'password':password})
        if isinstance(payload,dict):
            secret_values.extend([payload.get('access_token',''),payload.get('refresh_token','')])
        return status,payload.get('error_code') or payload.get('code') if isinstance(payload,dict) else None

    try:
        owner, other, pending, missing = [principal(label) for label in ('owner','other','pending','missing')]
        playwright=sync_playwright().start()
        pw=playwright
        browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-background-networking'])
        context=wire_context();page=new_page(context)
        if args.scenario_group!='accounts':
            current_step='same-browser real PKCE recovery and local email'
            link=request_recovery(page,owner)
            page.goto(link,wait_until='domcontentloaded')
            expect(page.get_by_text('Choose a new password',exact=True)).to_be_visible()
            assert urlparse(page.url).path=='/reset-password'
            assert parse_qs(urlparse(page.url).query).get('next')==['/account']
            checkpoint('real local email recovery completes PKCE in its initiating browser and retains the safe account destination')

            current_step='password validation and interrupted save retry'
            updates=[]
            def count_updates(request):
                if request.method=='PUT' and urlparse(request.url).path=='/auth/v1/user':updates.append(True)
            page.on('request',count_updates)
            password_fields(page,'short')
            page.get_by_role('button',name='Save password',exact=True).click()
            expect(page.get_by_role('alert')).to_have_text('Use at least 12 characters.')
            changed='Rv!'+secrets.token_urlsafe(24);secret_values.append(changed)
            password_fields(page,changed,changed+'different')
            page.get_by_role('button',name='Save password',exact=True).click()
            expect(page.get_by_role('alert')).to_have_text('The passwords do not match.')
            assert len(updates)==0
            password_fields(page,changed)
            aborted=[]
            def abort_update(route):
                if route.request.method=='PUT':aborted.append(True);route.abort('internetdisconnected')
                else:route.continue_()
            page.route('**/auth/v1/user',abort_update)
            page.get_by_role('button',name='Save password',exact=True).click()
            expect(page.get_by_role('alert')).not_to_be_empty()
            assert len(aborted)==1
            expect(page.get_by_label('New password (at least 12 characters)',exact=True)).to_have_value(changed)
            expect(page.get_by_label('Repeat new password',exact=True)).to_have_value(changed)
            page.unroute('**/auth/v1/user',abort_update)
            current_step='cross-account releasing the initiating account request'
            with page.expect_response(lambda response:response.request.method=='PUT' and urlparse(response.url).path=='/auth/v1/user') as saved:
                page.get_by_role('button',name='Save password',exact=True).click()
            assert saved.value.status==200
            expect(page.get_by_text('Account & security',exact=True)).to_be_visible()
            assert password_status(owner,owner['password'])==(400,'invalid_credentials')
            assert password_status(owner,changed)[0]==200
            owner['password']=changed
            checkpoint('password validation sends no writes; interrupted save retains both fields and retries against the correct real identity')

            current_step='consumed link replay'
            replay_page=new_page(wire_context())
            replay_page.goto(link,wait_until='domcontentloaded')
            expect(replay_page.get_by_text('Link unavailable',exact=True)).to_be_visible()
            expect(replay_page.get_by_label('New password (at least 12 characters)',exact=True)).to_have_count(0)
            checkpoint('consumed recovery link fails visibly and exposes no password form in a fresh browser')

            current_step='wrong-browser PKCE verifier failure'
            initiating_page=new_page(wire_context())
            wrong_link=request_recovery(initiating_page,other)
            wrong_page=new_page(wire_context())
            wrong_page.goto(wrong_link,wait_until='domcontentloaded')
            expect(wrong_page.get_by_text('Link unavailable',exact=True)).to_be_visible()
            expect(wrong_page.get_by_label('New password (at least 12 characters)',exact=True)).to_have_count(0)
            assert password_status(other,other['password'])[0]==200
            checkpoint('recovery opened without its PKCE verifier fails without changing the account password')

        else:
            result['not_run'].append('PKCE email cases excluded from accounts-only run; earlier evidence is separate')
            login(page,owner)
        if args.scenario_group!='email':
            current_step='cross-account delayed password update'
            page.goto(base+'/account',wait_until='domcontentloaded')
            page.get_by_role('button',name='Change password',exact=True).click()
            delayed_password='Rv!'+secrets.token_urlsafe(24);secret_values.append(delayed_password)
            password_fields(page,delayed_password)
            held=[]
            def hold_update(route):
                if route.request.method=='PUT':
                    auth=route.request.headers.get('authorization','').split(' ',1)[-1]
                    payload=json.loads(base64.urlsafe_b64decode(auth.split('.')[1]+'==='))
                    assert payload['sub']==owner['id']
                    held.append(route)
                else:route.continue_()
            page.route('**/auth/v1/user',hold_update)
            page.get_by_role('button',name='Save password',exact=True).click()
            deadline=time.monotonic()+10
            while not held and time.monotonic()<deadline:page.wait_for_timeout(50)
            assert len(held)==1
            current_step='cross-account second tab before sign out'
            second=new_page(context)
            second.goto(base+'/account',wait_until='domcontentloaded')
            second.get_by_role('button',name='Sign out this device',exact=True).click()
            expect(second.get_by_role('button',name='Sign in',exact=True)).to_be_visible()
            current_step='cross-account second tab signing into the next account'
            login(second,other)
            second.goto(base+'/account',wait_until='domcontentloaded')
            expect(second.get_by_text('Signed in as '+other['email'],exact=True)).to_be_visible()
            current_step='cross-account releasing the initiating account request'
            with page.expect_response(lambda response:response.request.method=='PUT' and urlparse(response.url).path=='/auth/v1/user') as stale:
                held.pop().continue_()
            try:
                stale_body=stale.value.json()
                stale_code=stale_body.get('error_code') or stale_body.get('code') if isinstance(stale_body,dict) else None
            except Exception:stale_code=None
            result['delayed_old_identity_response']={'http_status':stale.value.status,'code':stale_code}
            save()
            # The barrier releases only AFTER local sign-out revoked A's Auth
            # session. GoTrue must reject that exact stale session, not retarget
            # it to B or accept an unrelated server/network error as success.
            assert stale.value.status==403 and stale_code=='session_not_found', 'Stale signed-out Auth session was not rejected exactly.'
            assert password_status(owner,owner['password'])[0]==200
            assert password_status(owner,delayed_password)==(400,'invalid_credentials')
            assert password_status(other,other['password'])[0]==200
            assert password_status(other,delayed_password)==(400,'invalid_credentials')
            page.unroute('**/auth/v1/user',hold_update)
            page.goto(base+'/account',wait_until='domcontentloaded')
            expect(page.get_by_text('Signed in as '+other['email'],exact=True)).to_be_visible()
            expect(page.get_by_label('Type DELETE to confirm',exact=True)).to_have_value('')
            expect(page.get_by_label('New password (at least 12 characters)',exact=True)).to_have_count(0)
            result['delayed_old_identity_http_status']=stale.value.status
            checkpoint('a delayed password request remains bound to its initiating account and cannot change the newly signed-in account')

            current_step='cross-tab saved authentication destination'
            destination_context=wire_context()
            waiting_page=new_page(destination_context)
            waiting_page.goto(base+'/login',wait_until='domcontentloaded')
            expect(waiting_page.get_by_role('button',name='Sign in',exact=True)).to_be_enabled()
            choosing_page=new_page(destination_context)
            choosing_page.goto(base+'/login?'+urlencode({'next':'/account'}),wait_until='domcontentloaded')
            expect(choosing_page.get_by_role('button',name='Sign in',exact=True)).to_be_enabled()
            choosing_page.get_by_label('Email',exact=True).fill(other['email'])
            choosing_page.get_by_label('Password',exact=True).fill(other['password'])
            choosing_page.get_by_role('button',name='Sign in',exact=True).click()
            # Both tabs must consume the destination saved by the product's
            # real login flow. Never inject serialized destination or session.
            for destination_page in [choosing_page,waiting_page]:
                expect(destination_page.get_by_text('Account & security',exact=True)).to_be_visible()
                expect(destination_page.get_by_text('Signed in as '+other['email'],exact=True)).to_be_visible()
                assert urlparse(destination_page.url).path=='/account'
            checkpoint('a waiting login tab honors the safe destination another tab saved before shared sign-in')

            current_step='missing profile recovery navigation'
            missing_page=new_page(wire_context());login(missing_page,missing)
            deleted=api.ok('DELETE','/rest/v1/profiles?'+urlencode({'id':'eq.'+missing['id']}),admin=True,headers={'Prefer':'return=representation'})
            assert isinstance(deleted,list) and len(deleted)==1 and deleted[0]['id']==missing['id']
            missing_page.reload(wait_until='domcontentloaded')
            expect(missing_page.get_by_text('Account needs attention',exact=True)).to_be_visible()
            missing_page.get_by_role('button',name='Account recovery / continue deletion',exact=True).click()
            expect(missing_page.get_by_text('Account & security',exact=True)).to_be_visible()
            expect(missing_page.get_by_text('Account access needs attention',exact=True)).to_be_visible()
            expect(missing_page.get_by_role('button',name='Save profile',exact=True)).to_have_count(0)
            missing_page.get_by_role('button',name='Retry account access',exact=True).click()
            expect(missing_page.get_by_role('alert')).not_to_be_empty()
            missing_page.reload(wait_until='domcontentloaded')
            expect(missing_page.get_by_text('Account & security',exact=True)).to_be_visible()
            expect(missing_page.get_by_role('button',name='Sign out this device',exact=True)).to_be_enabled()
            checkpoint('a missing profile exposes usable recovery navigation and an actionable retry error across reload')

            current_step='partial deletion tombstone and interrupted continuation'
            pending_context=wire_context();pending_page=new_page(pending_context);login(pending_page,pending)
            api.ok('POST','/rest/v1/rpc/prepare_identity_deletion',admin=True,body={'p_owner_id':pending['id']})
            pending_page.reload(wait_until='domcontentloaded')
            expect(pending_page.get_by_text('Account needs attention',exact=True)).to_be_visible()
            pending_page.get_by_role('button',name='Account recovery / continue deletion',exact=True).click()
            expect(pending_page.get_by_text('Account & security',exact=True)).to_be_visible()
            expect(pending_page.get_by_label('Full name',exact=True)).to_have_count(0)
            pending_page.get_by_label('Type DELETE to confirm',exact=True).fill('DELETE')
            interrupted=[]
            def abort_deletion(route):
                interrupted.append(True);route.abort('internetdisconnected')
            pending_page.route('**/functions/v1/delete-account',abort_deletion)
            pending_page.get_by_role('button',name='Permanently delete account',exact=True).click()
            expect(pending_page.get_by_role('alert')).not_to_be_empty()
            assert len(interrupted)==1
            expect(pending_page.get_by_label('Type DELETE to confirm',exact=True)).to_have_value('DELETE')
            pending_page.unroute('**/functions/v1/delete-account',abort_deletion)
            pending_page.reload(wait_until='domcontentloaded')
            expect(pending_page.get_by_text('Account & security',exact=True)).to_be_visible()
            expect(pending_page.get_by_label('Type DELETE to confirm',exact=True)).to_have_value('')
            expect(pending_page.get_by_role('button',name='Permanently delete account',exact=True)).to_be_disabled()
            assert api.rpc('current_account_is_active',{},pending['token']) is False
            pending_page.get_by_role('button',name='Sign out this device',exact=True).click()
            expect(pending_page.get_by_role('button',name='Sign in',exact=True)).to_be_visible()
            login(pending_page,other)
            pending_page.goto(base+'/account',wait_until='domcontentloaded')
            expect(pending_page.get_by_text('Signed in as '+other['email'],exact=True)).to_be_visible()
            expect(pending_page.get_by_label('Type DELETE to confirm',exact=True)).to_have_value('')
            expect(pending_page.get_by_role('button',name='Permanently delete account',exact=True)).to_be_disabled()
            checkpoint('real partial deletion remains recoverable after transport interruption and reload; a new account inherits no confirmation')

        else:
            result['not_run'].append('Cross-account and deletion cases excluded from email-only run')
        assert not result['page_errors'] and not result['blocked_requests']
        checkpoint('recovery scenarios produce no runtime errors or external browser traffic')
        result['status']='passed'
    except Exception as failure:
        result['status']='failed'
        frames=[f for f in traceback.extract_tb(failure.__traceback__) if f.filename==__file__]
        message=str(failure)
        for value in secret_values:
            if value:message=message.replace(value,'[fixture-secret]')
        message=re.sub(r'https?://[^\s\"\'<>]+', '[local URL]', message)
        message=re.sub(r'eyJ[A-Za-z0-9_.-]{30,}', '[token]', message)
        result['failure']={'step':current_step,'type':type(failure).__name__,
                           'runner_line':frames[-1].lineno if frames else None,'message':message[:1000]}
        # Keep bounded product text for debugging; never URLs, tokens, form
        # values, raw auth/server errors or stack traces containing the link.
        if browser:
            for index,context in enumerate(contexts):
                for number,page in enumerate(context.pages):
                    if not page.is_closed():
                        try:
                            text=page.locator('body').inner_text(timeout=1000)[:6000]
                            for value in secret_values:
                                if value:text=text.replace(value,'[fixture-secret]')
                            (args.output/f'failure-{index}-{number}.txt').write_text(text)
                        except Exception:pass
    finally:
        if browser:
            try:browser.close()
            except Exception:pass
        if playwright:
            try:playwright.stop()
            except Exception:pass
        cleanup_errors=0
        cleanup_notes=[]
        for uid in reversed(users):
            try:
                status,_=api.request('DELETE','/auth/v1/admin/users/'+uid,admin=True)
                assert status==200
            except Exception:
                cleanup_errors+=1;cleanup_notes.append('synthetic user cleanup failed')
        if mail_ids:
            try:
                status,_=mail_request('DELETE','/api/v1/messages',{'IDs':sorted(mail_ids)})
                assert status==200, 'Unexpected test-mail cleanup HTTP status: '+str(status)
            except Exception as failure:
                cleanup_errors+=1;cleanup_notes.append(str(failure)[:100])
        result['cleanup']={'synthetic_users':len(users),'synthetic_messages':len(mail_ids),'errors':cleanup_errors,'notes':cleanup_notes}
        if cleanup_errors:result['status']='failed'
        save()
        print(json.dumps({'status':result['status'],'checks':len(result['checks']),'failure':result.get('failure'),'result_file':str(result_file)}))
    return 0 if result['status']=='passed' else 1


if __name__=='__main__':
    def timeout(_signal,_frame):raise TimeoutError('Bounded local recovery wall-clock limit reached.')
    signal.signal(signal.SIGALRM,timeout)
    signal.alarm(360)
    raise SystemExit(main())
