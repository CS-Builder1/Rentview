# Local implementation validation

## 2026-10-30 PR review follow-up

The bounded local follow-up passed against the final application source and the
revised migrations, including the deletion-tombstone billing recovery fix.
The PR remains a draft with external release gates. No hosted state, credentials,
provider activation, deployment or merge was changed.

| Check | Final local result |
| --- | --- |
| Unit/handler regressions; application/test TypeScript | 146 passed; both type checks passed |
| Runner and cleanup contract guards | 11 database source guards and nine fixture-cleanup guards passed |
| Expo 56 compatibility; guarded web export | Zero mismatches using installed/offline metadata; production export passed with local public settings and empty paid URLs |
| Source/build identity | All 85 app/component/library files match the tested build |
| Fresh migration replay | 34 stages passed, including exact final migration/input hashes, unresolved legacy billing refusal before mutation, verified/rejected synthetic billing decisions, Storage-owner prerequisite, operations, billing, notification and deletion-worker regressions |
| Primary local database | Eleven SQL suites passed; after the final reconciliation-function change, three focused billing checks and three real financial transaction races passed again |
| Fresh extension-owner boundary | Local owner-issued pg_net maintenance and strict browser-denial/worker-allow SQL boundary passed |
| Database advisors | Zero errors; eight unsuppressed warnings: seven permissive-policy warnings and one pg_net installation-namespace warning |
| Real browser core journey | 13 checkpoints passed |
| Review regressions | Seven checkpoints passed: owner/tenant inbox separation, missing-photo isolation, actual polling-link reuse and explicit retry, and one durable ID through failed/repeated/edited/retried work-order, asset and lease saves |
| Finance; keyboard/accessibility | Nine checkpoints per suite passed |
| Local recovery | Nine checkpoints passed, including two real Mailpit PKCE messages; four synthetic identities and both messages cleaned |
| Phone/desktop URL edges | 36 checks passed across two viewports |

All final browser reports record zero runtime errors, external requests and
synthetic cleanup errors. Browser phone emulation does not establish physical
phone behavior. The finance, recovery and accessibility checks retain their
bounded scope; successful full Edge-runtime account deletion, external providers
and full screen-reader/WCAG conformance remain unverified. Fixture teardown uses
real local Auth/Storage/RPC primitives; it does not execute the Deno deletion handler.

The fresh replay applies SQL transactionally; **it does not populate Supabase CLI
migration history**. The older genuine CLI-record evidence below is historical,
and no new CLI record or history repair is claimed. The original trust migration
changed for the legacy billing gate; the final 34-stage report verifies its new
bytes rather than relying on the previous migration checksum.

The initial 32-stage replay failed with `42501` when the migration role attempted
the platform-owned Storage index. That report, intermediate browser launch/setup
and cleanup failures, and the first replay before the billing-tombstone correction
remain preserved. The final reports above supersede their outcomes, without
relabeling failed attempts as passes or treating setup failures as application
assertion failures. Actual-owner Storage index maintenance is separate privileged
SQL; it changes no role/ownership/grants and is required before the operations
migration, which refuses a missing/mismatched index with `55000`.

Private workspace evidence is under
`/workspace/scratch/rentview-review-followup/`: `validation-final/results.json`,
`billing-rpc-results.json`, `primary-apply-results.json`, `advisors-final.log`,
`fresh-net-maintenance.log`, `fresh-net-boundary.log`, `unit-container/check.log`,
`types-container3/check.log`, `test-types-container3/check.log`,
`guards-container/check.log`, `cleanup-guards-container/check.log`,
`sdk-container/check.log`, `build-container4/check.log`,
`final-source-manifest.json`, and the final `results/results.json` in
`browser-core-container3`, `browser-review-container4`, `browser-finance-container`,
`browser-accessibility-container`, `browser-recovery-container2` and
`browser-urls-container`. These scratch paths are private provenance, **not
committed GitHub artifacts**. The checked-in runners and summaries support review.

Current release SQL is the revised trust migration, the identity migration, and
all four `20261030` review migrations. Separate owner/operator prerequisites are
`supabase/privileged/prepare_legacy_billing_reconciliation.sql`,
`supabase/privileged/index_storage_owner_quota.sql` and
`supabase/privileged/lock_down_pg_net.sql`.

Still open: real legacy paid-account provenance, production public build settings
(Vercel inspection returned scope 403), authorized hosted migration and platform
owner/exposure verification, three upstream dependency advisories, successful
full Edge-runtime deletion and its operator recovery contract, physical devices,
external email/OAuth/push/payment delivery, and commercial/retention/financial
correction decisions. Paid checkout remains disabled. No CI pass or blanket
release clearance is claimed. See [REVIEW_RESPONSE.md](./REVIEW_RESPONSE.md),
[BILLING_RECONCILIATION.md](./BILLING_RECONCILIATION.md) and
[SECURITY_RELEASE_GATES.md](./SECURITY_RELEASE_GATES.md).

## Preserved 2026-10-28 baseline evidence

The remainder records the earlier candidate and its historical attempts. Its
counts and checksums are not substitutes for the final follow-up record above.

This report records disposable-local validation of the implementation prepared
for draft source review. No hosted database, security configuration, credentials,
provider activation or deployment was changed. Publication and automatic-check
status are reported on the pull request. Release SQL comprises
`supabase/migrations/20261028190215_trust_and_operations.sql` and the additive
`supabase/migrations/20261028193614_optimize_identity_policies.sql`. The separate
owner-only `supabase/privileged/lock_down_pg_net.sql` is maintenance SQL, not an
automatic migration. See [SECURITY_RELEASE_GATES.md](./SECURITY_RELEASE_GATES.md)
for the unresolved release decisions and exact advisory inventory.

## Verified locally

| Check | Result |
| --- | --- |
| Unit and handler regression tests | 108 passed; no failures/skips |
| Application and test TypeScript | Passed |
| Expo 56.0.12 dependency compatibility | Zero mismatches using installed SDK metadata; offline-check caveat |
| Web production export | Passed with disposable loopback API/public key and empty paid URLs |
| Real browser → Auth/API/Storage/PostgreSQL journey | 13 checkpoints passed; five synthetic identities cleaned, no cleanup errors |
| Phone 390 × 844 and desktop 1440 × 1000 browser checks | 36 passed again on the combined application changes; no browser errors or external HTTP/WebSocket requests |
| Local password recovery and account interruption | Nine checkpoints passed, including real local-mailbox PKCE, consumed/missing-verifier links, cross-account delays, cross-tab continuation and interrupted deletion recovery |
| Finance, export and date handling | Nine checkpoints passed, including complete 1,007-row CSV export across five pages, separate currencies, Pacific/Atlantic date edits, rejected-save drafts and lost-response replay |
| Finance precision and in-flight saves | Two focused probes passed: 249 large GBP amounts total exactly £2,489,999,999,997.51; pending saves cannot erase a new draft |
| Bounded browser accessibility | Nine checkpoints passed for named keyboard controls, tab state, modal focus/Escape/Back, radio selection and announced validation; full WCAG and screen-reader output not assessed |
| App and Edge embedded query shapes | All 19 resolved against the hardened live Data API |
| Baseline/legacy/security/operations/backend SQL | Passed against local PostgreSQL 17 |
| Special numeric values | 48 NaN/Infinity rejection cases passed |
| Independent expense/completion transactions | Three real lock-controlled races passed |
| Tenant projection | Approved 18 columns/types and base-table permissions unchanged; isolation, redaction, revocation and deletion checks passed |
| Request insert response modes | All three return HTTP 201 with correct stored/returned IDs; forged participants rejected in every mode |
| Identity/RLS optimization | Exactly 68 policy predicates changed; other policies, grants, roles and metadata unchanged; 2,016 equivalence cases and prepared-plan actor switching passed |
| Supabase advisors | Zero errors; eight warnings after the additive replay: seven permissive-policy warnings and one pg_net namespace warning |
| Extension-owner pg_net repair | Passed on both disposable databases; wrong-owner guard, strict browser denial, trusted worker access and backend regressions passed |
| Backend-only Data API boundary | Eleven checks passed again after the owner-only repair; net schema selection and privileged RPCs refused; synthetic cleanup passed |
| Local database runner guards | Seven source-only tests passed; the revised 20-stage initializer was not rerun from scratch |
| Fresh versioned migration replay | Original 15 stages and ten genuine CLI records preserved; the additive continuation passed ten more stages and recorded the eleventh migration without history repair |

The core journey covers property/unit/lease creation, invitation continuation
through signup, claim refresh on the owner's screen, tenant repair photos and
messages, conversion to a single job, vendor assignment, stock consumption,
completion with linked cost/history, rating/closing/reopening, and subsequent
access revocation. It also exercises real disconnected browser saves,
reconnection without duplication, and a genuine rejected operation that survives
reload/retry until explicit discard. API checks include cross-owner references,
forged invitations, direct Pro writes, tenant workflow edits, malformed auth,
concurrent property/stock/invitation limits, expired invitations and signed URLs.

The canonical migration also replayed through the CLI over deliberately inconsistent
legacy fixtures in a separate PostgreSQL project. Its SQL body exactly matches
the validated source. Legacy authorization, constraint validation, all SQL suites,
48 special-number cases, three concurrent cost races, advisor checks and cleanup
passed on that fresh project. No migration-history repair was used.

The additive identity migration then passed ten continuation stages on that same
isolated replay project. It caches only statement-constant `auth.uid()` values;
row-dependent membership predicates remain unchanged. Catalog comparisons proved
exactly 68 predicate changes on both the replay and primary local databases.
Actual SQL tested 2,016 identity/row-value cases, generic prepared-plan reuse across
owner, tenant, null, deleting and deleted identities, and a measured InitPlan
executing once. The four security suites and three transaction races passed again.

After the Metro update and identity migration, all 107 unit/handler tests, both
type checks, SDK compatibility, a new local-key web export, 13 real core E2E
checkpoints and 36 browser edge checks passed again. The fresh browser runs had
no runtime errors or external HTTP/WebSocket requests; all five synthetic E2E
identities were cleaned. They preceded the separate pg_net ACL repair. The
backend SQL suites, worker-permission checks and eleven API boundary checks ran
again after that repair. Advisors remained at zero errors and eight warnings;
external provider delivery remains untested.

The subsequent recovery, finance and accessibility continuation passed against
the combined current application export. Its manifest matches all 82 reviewed
app, component and library source files. The 108 unit/handler tests, both final
TypeScript checks, 13 core E2E checkpoints and 36 URL/browser edge checks passed;
the separate recovery, finance and accessibility runners each passed nine
checkpoints. Two focused finance probes also passed. Every final browser report
records no runtime errors or external HTTP/WebSocket requests; completed runners
report no synthetic-user cleanup errors.

Recovery used two actual messages in the local test mailbox to complete PKCE.
Consumed links and a missing browser verifier fail visibly without exposing a
password form. A delayed request for the previous account received HTTP 403
`session_not_found`, and the newly signed-in account's password stayed unchanged.
The checks also cover a waiting tab's newly saved safe destination, missing-profile
navigation, and pending-deletion continuation after reload and a transport
interruption. They do not establish successful deletion through the Edge runtime.

Finance checks inspect actual downloaded CSV files for 1,007 current-year rows
at offsets 0, 250, 500, 750 and 1,000, currency totals, formula escaping, quoted
and multiline text, period/property filters and owner isolation. Receipt edits
retain leap-day/end-month dates in Pacific and Atlantic browser timezones.
Actual rejected writes preserve drafts and a stable queued operation identity;
a committed insert with a lost browser response replays after reload as one
expense. A separate precision probe verifies the exact large GBP total above,
and a held-response probe verifies disabled cancellation/editing during save,
Escape preserving the pending form and a later draft surviving completion.

No schema or dependency versions changed during this continuation. The existing
eight database warnings and three upstream advisory packages remain unresolved
as described below; this additional browser coverage does not close those gates.

## Defects found during integration

- Ownership composite foreign keys made existing embedded queries ambiguous.
  Explicit relationship hints now resolve the intended scope across 19 query sites.
- A stable request-access lookup could not see a new request during
  `INSERT RETURNING`. The tenant read policy now checks the inserted row against
  its exact existing lease/unit/property/owner membership; active-lease insert
  restrictions and unrelated permissions remain unchanged.
- The tenant projection used a definer view. A caller-privilege view now uses a
  private, actor-scoped helper exposing only the existing approved columns.
- Fractional stock input could create rounding gains. Unsupported precision is
  rejected before arithmetic. Posted expense reassignment and concurrent
  expense/completion writes are also guarded.
- Four numeric fields accepted NaN. Finite-value constraints and RPC checks now
  reject special values without changing negative-value product policies.
- URL parameters named `toString` or `valueOf` crashed an SDK route comparator.
  Reserved query names are removed before web/native navigation. Real initial
  navigation and back/forward checks pass; remaining callback/fragment bytes and
  incoming history state are preserved. This was an availability defect; no
  prototype pollution or privilege escalation was demonstrated.
- Closing creation dialogs could overlap subsequent dialogs. Those navigation
  dialogs now unmount on close. Owners can explicitly refresh a lease after a
  claim completed on another device.

- Repeated failed expense saves could enqueue fresh creation IDs. The draft now
  retains one account-bound operation identity; explicit discard or a completed
  save separates the next creation intent.
- Summing large financial values through floating-point arithmetic produced cent
  drift. Totals now preserve exact cents; unsupported precision produces a useful
  error while the record list stays visible.
- Closing or editing a form during a pending save could let its delayed callback
  erase a later draft. Pending controls and callback guards now preserve the
  correct form, and failures display actionable messages.
- Cross-tab sign-in could replace the auth navigator during a redirect and crash
  React. The navigator stays mounted, while the login screen validates the current
  identity and safe destination before navigating.
- Owner/tenant tabs, property-type choices and Back controls lacked usable names
  or selection semantics. Keyboard navigation, named controls, radio state and
  modal focus/draft preservation now pass the bounded browser checks.

The legacy fixture's initial `55006` failure was a test-order problem: deferred
cascade events were still pending when it ran `ALTER TABLE … VALIDATE`.
`SET CONSTRAINTS ALL IMMEDIATE` now precedes validation. Deliberately inconsistent
legacy rows, authorization denials, expected pre-cleanup validation failure,
synthetic cleanup and final constraint validation remain tested.

## Dependency and advisor findings

The initial eight compatible transitive updates reduced npm audit from 20 to 12
affected nodes and removed the critical finding. Scoped overrides now align
seven dependency edges beneath three React Native parents with the Expo-selected
Metro 0.84.5 family. All original ranges allowed that patch; Expo and Router remain
on SDK 56. This removes `image-size` from the installed and lockfile graphs,
closing its two high-severity advisories without an image-size major override.
The dependency tree is valid and contains fourteen coherent Metro package nodes.

The current audit reports **11 affected nodes**, including inherited warnings:
five low, three moderate, three high and zero critical. They represent three
remaining advisory packages: `decode-uri-component`, `deepmerge` and `zod`.
Their exact GHSA/CVE identifiers, ranges, source paths and remediation constraints
are recorded in [SECURITY_RELEASE_GATES.md](./SECURITY_RELEASE_GATES.md). None has
been silently accepted. A production decoder attack path was not established:
normal Expo Router incoming links use its URLSearchParams fork. Deepmerge and Zod
are reached through Expo configuration or CLI plugin inputs, rather than a
RentView API/Edge import. Large plugin output remains a resource-bearing Zod input.
A plain query-string 9 override does not satisfy Router 56's namespace imports;
a Zod 4 override is outside its parent's range and remains unvalidated. Compatible
upstream fixes or an explicit release decision are still required.

The identity migration removed all 68 auth/RLS initialization-plan warnings.
The **eight remaining warnings** are seven multiple-permissive-policy warnings
across intentional owner/tenant SELECT lanes and one **pg_net-in-public** warning.
The latter names pg_net, not pgcrypto; pgcrypto is installed in `extensions`.
No authorization bypass was demonstrated by the policy-performance warnings.
They remain open for representative-scale measurement; the policies were not
merged merely to clear the advisor.

The stricter initial pg_net assertion failed because browser roles retained
schema usage and HTTP-function execution granted by `supabase_admin`. Eleven
local API checks separately confirmed that PostgREST rejects selection of `net`
and rejects backend push/dispatch RPCs; that mitigation did not close the SQL
privilege finding. The same eleven API checks passed again after repair, with
no cleanup errors. The owner-guarded maintenance transaction was applied as
the actual extension owner on both approved disposable databases. Wrong-owner
execution failed before changing metadata. Comparisons proved only net schema
and function ACLs changed; strict effective browser denial, retained trusted
worker access, backend SQL regressions and fixture cleanup passed. A real worker
enqueue was rolled back before commit, producing no external HTTP request.

The extension is nonrelocatable and its member objects reside in `net`; its
installation-namespace warning remains visible. No catalog edit, relocation or
reinstall was attempted. Hosted owner-supported ACL application and verification
of API exposure remain release gates. Recheck effective privileges after platform
or extension updates that may restore grants. The original failed assertion and
all earlier failed attempts remain preserved.

## Environment and coverage limits

Tests use synthetic `.test` identities in an explicitly disposable Docker
Supabase project. Published API/database/test-mail ports are bound to 127.0.0.1.
Only ephemeral local keys are used, stored in owner-only scratch files. Browser
HTTP/WebSockets outside loopback are blocked. Database runners refuse hosted
targets and require explicit disposable opt-in.

The full PostgreSQL image exceeded disk during unpacking. The supported,
digest-pinned slim image for the same PostgreSQL release succeeded without
changing Docker's daemon/storage settings. Its BusyBox health probe ignores
loopback proxy exclusions and reports 403 through the outbound proxy. Exact
container-loopback Auth/Storage probes succeed; actual API and journey tests
establish readiness. The failed Docker health metadata is not counted as passed.

Phone viewport testing is browser emulation. Physical iOS/Android callbacks,
device permissions, push delivery, Google OAuth, external email delivery and
payment-provider delivery have not run. Local email recovery, interrupted account
flows, multi-currency exports, date edits and selected keyboard/accessibility
paths now have the bounded browser coverage described above. Successful
Edge-runtime account deletion, native sharing/device timezones, external
accountant applications, screen-reader speech output and a full WCAG or financial
policy audit remain unverified. The core runner's own exclusions still apply to
that runner; the separate suites provide the additional evidence.

ESLint is not configured, so the lint script was not run. Offline hard reload is
unsupported by the current web export without a service worker. No external
provider was activated for tests.

Paid checkout remains gated until trusted initial provider binding/reconciliation
is implemented; ordinary account creation remains available. Pricing/grace,
retention/anonymization and posted-financial-correction decisions remain for
review. Portfolio import, expanded desktop navigation/tables and product analytics
are later adoption work, not claims of this milestone.

These results are evidence for the tested boundaries, not proof that every
possible exploit or device/provider scenario has been excluded.

## Evidence in this workspace

Machine-readable current state: `IMPLEMENTATION_STATUS.json`.

Absolute `/workspace/scratch/` paths identify private evidence retained in the
original validation workspace; those logs, credentials and screenshots are not
part of this repository. The summaries and committed test runners are available
for review and reproduction against an explicitly disposable local backend.

Latest application-journey continuation evidence:

- `/workspace/scratch/rentview-journey-coverage/candidate2-source-hashes.json`
- `/workspace/scratch/rentview-journey-coverage/recovery-final-retry1/results.json`
- `/workspace/scratch/rentview-journey-coverage/mail-leftover-inspection.json`
- `/workspace/scratch/rentview-journey-coverage/finance-final/results.json`
- `/workspace/scratch/rentview-journey-coverage/finance-precision-final.json`
- `/workspace/scratch/rentview-journey-coverage/finance-inflight-final.json`
- `/workspace/scratch/rentview-journey-coverage/accessibility-final/results.json`
- `/workspace/scratch/rentview-journey-coverage/core-final-retry1/results.json`
- `/workspace/scratch/rentview-journey-coverage/edges-final/results.json`
- `/workspace/scratch/rentview-journey-coverage/unit-candidate1.log`
- `/workspace/scratch/rentview-journey-coverage/typecheck-final.log`
- `/workspace/scratch/rentview-journey-coverage/typecheck-tests-final.log`

Prior security/dependency continuation evidence:

- `/workspace/scratch/rentview-warning-triage/rls-results-retry1.json`
- `/workspace/scratch/rentview-warning-triage/rls-metadata-comparison.json`
- `/workspace/scratch/rentview-warning-triage/primary-rls-comparison.json`
- `/workspace/scratch/rentview-warning-triage/advisors-post-repair.stdout`
- `/workspace/scratch/rentview-warning-triage/pg-net-repair-results.json`
- `/workspace/scratch/rentview-warning-triage/extension-boundary-failure.json`
- `/workspace/scratch/rentview-warning-triage/backend-boundary-final.json`
- `/workspace/scratch/rentview-warning-triage/core-e2e/results.json`
- `/workspace/scratch/rentview-warning-triage/browser-edges/results.json`
- `/workspace/scratch/rentview-warning-triage/npm-audit.json`
- `/workspace/scratch/rentview-warning-triage/unit-tests.log`
- `/workspace/scratch/rentview-warning-triage/web-export.log`

Preserved earlier milestone evidence:

- `/workspace/scratch/rentview-migration-replay/validation/results.json`
- `/workspace/scratch/rentview-local-e2e-final/results.json`
- `/workspace/scratch/rentview-browser-url-fixed-retry1/results.json`
- `/workspace/scratch/rentview-local-db-retry1/results.json`
- `/workspace/scratch/rentview-finite-numerics/results.json`
- `/workspace/scratch/rentview-tenant-projection/results.json`
- `/workspace/scratch/rentview-request-returning/results.json`
- `/workspace/scratch/rentview-request-insert-probe-fixed.json`
- `/workspace/scratch/rentview-dependency-audit-final.json`
- `/workspace/scratch/rentview-url-fix-tests.log`

The earlier failed attempts are retained separately, including the initial
180-second export timeout and a runner stdout `BrokenPipe` failure. Those attempts
are not counted as application passes; successful reruns have their own reports.
Logs/screenshots contain
synthetic fixtures only and are kept private in scratch; local key files are not
part of the repository or report.
