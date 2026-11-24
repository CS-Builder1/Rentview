# RentView review and verification

November 24, 2026. These checks used synthetic properties and separate accounts against local Supabase Auth, PostgreSQL 17, PostgREST, Storage, Mailpit and the Edge runtime. Chromium exercised the web interface at phone and desktop sizes. The review stack starts with the existing trust and offline fixes in #3, then adds property access in #4, contractor dispatch and messaging in #5, and property history, rent reconciliation and end-to-end tests in this PR.

## Walk through a rental operation

| Step | Action | Observed result |
| --- | --- | --- |
| 1. Prepare the property | Sign in as an owner, create a property, unit and active lease, then invite a renter and a manager. | The renter claimed the intended lease. A separately signed-in manager saw their assigned property. The owner's other property stayed private. |
| 2. Start a general conversation | Send a renewal question through **Message property management** and leave the conversation before the manager replies. | The manager answered from their own inbox. The renter saw the unread alert, opened the reply and received a saved read receipt. The repair queue stayed empty. |
| 3. Report a leak | Open **Report a repair**, select plumbing and high priority, and give access instructions. The manager opens the alert and converts the request to a work order. | The request retained its lease, unit, priority and one linked job. Owner and renter could also exchange repair-specific messages and photos. |
| 4. Dispatch a worker | Assign a plumber. Have the first plumber decline and the manager assign a second plumber. | Each worker received an in-app alert. The first saw the withdrawal and lost job access. The second accepted from their own account. |
| 5. Agree on a visit | The second plumber proposes a window. The renter proposes a different one and the plumber confirms it. | Both parties saw the same confirmed time. The manager could follow the visit on the original job. |
| 6. Complete and follow up | The plumber starts work, records a completion note and uploads a photo. The renter opens the photo, rates the repair and reopens it when the leak returns. | The signed image opened. The worker and manager received the follow-up, the original rating and proof remained in history, and the renter's request returned to active work. |
| 7. Document the unit's condition | Add a dated asset observation, create move-in and move-out room inspections, compare them and export a filtered history. | The unit included the asset observation and both room conditions. The filtered inspection CSV downloaded. A real room photo opened after a reload. |
| 8. Reconcile the books | Post a USD 1,000 charge and USD 400 receipt, then inspect the resident ledger and the manager's report. Record job costs and export the accountant packet. | Both sides showed USD 600 outstanding. Expenses used their incurred date. A separate 1,007-row export retained all rows and kept USD, XCD and EUR separate. An interrupted expense save replayed exactly once. |
| 9. End and relet the lease | Archive the lease, let the next renter claim their own lease, and look up the unit again. | The owner retained the old rent ledger and property history. Neither the former resident nor the incoming resident could read the prior rent ledger after turnover. The new tenancy started with its own records. |
| 10. Operate the portfolio | Create and edit a vendor, change stock, register an asset, enter its QR tag manually, complete recurring service, pause and resume schedules, publish a property announcement and manage a document. | Updates survived a reload. Service appeared in asset history. A selected document was stored, opened through a signed link, and deleted. |
| 11. Recover from interruptions | Disconnect during job creation, lose the response to an expense write, refresh a failed draft, switch accounts, and reset a password through local email. | Reconnection produced one job and one expense. Failed drafts remained recoverable. Each account kept its own data. The email recovery flow restored access to the intended identity. |
| 12. Delete a synthetic account | Confirm deletion from account recovery with an open job and private file present, then reload the app. | The real deletion worker returned success. Independent reads verified removal of the Auth user, property, open order, document and stored file. The browser stayed signed out. |

## Verification by layer

| Layer | Result |
| --- | --- |
| Application and handlers | 157 unit and handler tests passed. Both application and test TypeScript checks passed. |
| Database and migrations | All 16 SQL suites passed after a full dump and restore. The run covers portfolio handover, permissions, dispatch, private evidence, inboxes, inspections, rent allocation, billing reconciliation and deletion. The restore exposed two foreign-key ordering defects that were fixed before rerunning the suite. |
| Core browser workflows | 13 authenticated checkpoints passed, including offline sync, photo storage, conversion, stock consumption, cost posting and tenant turnover controls. Seven additional review regressions passed. |
| Field and records | Four independently signed-in browsers exercised the repair, with a fifth account owning the property. A separate four-account walkthrough exercised delegation, rent, condition and turnover. |
| Portfolio, finance and accessibility | Six owner workflows, nine finance/export checks and nine keyboard/focus checks passed. Focus and currency/date tests also ran at different screen sizes or timezones as appropriate. |
| Sign-in and recovery | 36 signed-out checks passed, 18 per viewport. Both password-email and interrupted-account groups passed using local Auth and Mailpit. Successful deletion was also verified through the local Edge gateway. |
| Builds | Web, iOS and Android production exports succeeded. Both native exports contained Hermes bytecode and all assets referenced by their manifests. |

The standard local PostgreSQL image interrupted three existing SQL fixtures. A separate restored PostgreSQL 17.6 instance with JIT off and fewer preloaded extensions ran every fixture unchanged. The full application browser journeys used the local Supabase services. The Edge runtime used a local copy of the official Supabase JS distribution for its import because the JSR registry was unreachable. The release handler source stayed identical.

## Repeat the checks

Use Node 24 or newer, Python with Playwright, Chromium, psql and a disposable local Supabase project. Apply the reviewed migrations in order and prepare the database-owner prerequisites described in the setup guide. Serve the combined web app with SPA route fallback, including the app route `/assets`, and set the local Auth callback to that same origin. Keep a mode-0600 credentials JSON file outside the checkout with `api_url`, `anon_key` and `service_role_key`. The web bundle takes only its public configuration. [Setup and release prerequisites](SETUP.md)

```bash
npm ci
npm test
npm run typecheck
npm run typecheck:tests

# Set RENTVIEW_TEST_DATABASE_URL to the migrated disposable database first.
RENTVIEW_DISPOSABLE_DATABASE=1 npm run test:db

# Set EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY and
# EXPO_PUBLIC_APP_URL to match the local test environment.
npm run build:web
npx expo export --platform ios --platform android --output-dir /tmp/rentview-native
```

For example, run the following in Bash after setting `RV_LOCAL_CREDENTIALS` to the private local credentials file. Adjust the browser and Mailpit origins to match the local instance. Each browser run writes its own report.

```bash
set -e
rv_web=http://127.0.0.1:4173
rv_mail=http://127.0.0.1:54324
rv_results=$(mktemp -d)
rv_args=(--base-url "$rv_web" --credentials-file "$RV_LOCAL_CREDENTIALS" --allow-disposable-local)
python3 scripts/test-browser.py "$rv_web" --output "$rv_results/signed-out"
for suite in local_e2e local_field_suite local_property_records local_portfolio_operations local_finance local_review_regressions local_accessibility finance_precision_probe finance_inflight_probe; do
  python3 "tests/e2e/$suite.py" "${rv_args[@]}" --output "$rv_results/$suite"
done
python3 tests/e2e/local_recovery.py "${rv_args[@]}" --mail-url "$rv_mail" --output "$rv_results/recovery"
```

## Checks that still require release access

- Install signed builds on physical iOS and Android devices. Exercise camera QR scanning, permissions, native sharing, callbacks, screen readers and background notifications. The local acceptance test used manual QR entry and signed image previews.
- Verify Google OAuth, production email and Expo/APNs/FCM delivery with the intended provider accounts. The local suite exercised durable in-app alerts, signed-out recovery through Mailpit, and notification handler fixtures.
- Paid subscription checkout remains disabled. Real provider-to-account binding, independently verified legacy billing decisions, and sandbox transactions for the configured payment providers are release work. [Billing reconciliation](BILLING_RECONCILIATION.md)
- Verify the actual hosted schema, extension versions and ownership before running any release migration or privileged operation. The installed local Supabase image shipped pg_net 0.20.0. The checked-in privileged script requires 0.20.4. Historical dependency advisories and the broader accessibility and data-retention decisions are tracked separately. [Release gates](SECURITY_RELEASE_GATES.md)
