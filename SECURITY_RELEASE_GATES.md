# Security findings and release gates

Local review dated 2026-10-28, prepared for draft source review. Publishing the
draft does not close release gates or authorize merge, hosted changes, deployment
or provider activation. Findings remain open unless a passing result below
explicitly closes them; no risk acceptance is implied. See `VALIDATION.md` for the complete test scope and its limitations.

| Finding or gate | Current evidence and disposition | Required next step |
| --- | --- | --- |
| 68 identity/RLS initialization-plan warnings | **Fixed locally.** Additive migration `20261028193614_optimize_identity_policies.sql` changes only the 68 reviewed identity predicates to statement-scoped subqueries. Exact catalog comparison, 2,016 predicate row-value cases, prepared-plan actor changes, four security SQL suites, three transaction races and the fresh core browser journey passed; 11 CLI migration records are genuine. Advisors now report zero errors and eight warnings. No populated latency benchmark was run. | Review migrations and actual legacy-data reconciliation before any separately authorized rollout. |
| Seven multiple-permissive-policy warnings | **Open performance debt.** These represent three SELECT combinations: announcements (five roles), maintenance requests and rent payments. Separate owner/tenant lanes are intentional; isolation/revocation tests pass. No authorization bypass was demonstrated. | Benchmark representative portfolios, then review any role-preserving policy merge. Preserve the exact tenant membership condition that fixes `INSERT RETURNING`. Do not merge policies merely to silence the advisor. |
| `pg_net` effective SQL privileges | **Fixed locally; hosted owner/exposure gate remains open.** The preserved initial strict assertion failed: `anon unexpectedly has net schema usage`; prior migration-role REVOKEs had not removed extension-owner grants. Explicit maintenance script `supabase/privileged/lock_down_pg_net.sql`, independently reviewed, now passes on both disposable databases: wrong-owner refusal before mutation, metadata changes limited to `net` ACLs, denied anon/authenticated privileges, preserved trusted workers, and actual queue insertion rolled back with no committed HTTP request. Trust/backend SQL suites passed on both targets. | For a separately authorized hosted target, inspect its actual extension owner/layout and exposure; use the supported owner/grantor path and rerun strict ACL/worker tests. This script is separate privileged maintenance, not an automatic migration or a way to acquire privileges. Recheck grants after extension/bootstrap updates. |
| `pg_net` public-namespace advisor warning | **Open installation-layout finding.** `pg_net` 0.20.4 is owned by `supabase_admin`, metadata schema `public`, actual objects in `net`, and is not relocatable. Its one namespace warning remains after the verified local ACL repair; `pgcrypto` is correctly in `extensions`. | Keep the warning visible. Do not force relocation or drop/recreate the extension to clear the display; review supported platform options separately. |
| Local Docker Auth/Storage health metadata | **Measured local-environment issue, outside the eight advisor warnings.** The slim image's BusyBox probe sends container-loopback health traffic through the outbound proxy and receives 403. Exact loopback probes and real Auth/API/Storage journeys succeed; failed Docker health metadata is not counted as passed. | Retain direct readiness evidence and diagnose the supported image/probe configuration separately. This finding does not justify weakening external proxy controls or waiving database/dependency findings. |
| Data API access to backend-only helpers | **Verified locally after ACL repair.** Eleven actual Auth/Data API checks passed: `net` read/write schema selection returns `PGRST106`; backend push/dispatch RPCs reject anon/authenticated with `42501`; normal authenticated profile access succeeds. Synthetic user cleanup passed. | Keep `net` outside exposed API schemas. Repeat against any separately authorized release environment alongside the independent SQL privilege checks. |
| Dependency advisories | **Three upstream package gates remain open.** Scoped Metro 0.84.5 overrides removed `image-size` from installed and lock graphs, closing its two GHSA records. Fourteen Metro-family nodes are coherent; `npm ls --all` passes. Audit remains 11 affected nodes: five low, three moderate, three high, zero critical, representing decode-uri-component, deepmerge and Zod. Latest source verification passed 108 regressions, both types, fresh web export, 13 core E2E checkpoints and 36 browser edge checks. The unchanged dependency graph previously passed zero SDK mismatches using installed/offline metadata. | Resolve the three advisories through compatible upstream fixes/backports or an explicit release risk decision. None is accepted here. Avoid forced SDK upgrades/downgrades or API-incompatible overrides. |
| Paid checkout and reconciliation | **Intentionally gated.** Both paid checkout controls under owner More → Plan & billing are disabled. Ordinary signup remains available. Unknown provider subscriptions stay unmatched and retryable; metadata/email does not bind ownership. | Implement and test authenticated initial provider binding, subscription expiry/deletion/reconciliation and customer-visible pending state before enabling checkout. Resolve legacy paid-account reconciliation policy. |
| Password recovery and interrupted account actions | **Bounded local coverage completed: nine checks.** Real Mailpit email/PKCE recovery, validation and retry, consumed/wrong-verifier failures, cross-tab destinations, missing-profile recovery and interrupted pending-deletion continuation across reload passed. A delayed old-account password request returned `403 session_not_found`; the newly signed-in account's password remained unchanged. Recovery navigation now retains a stable Auth layout. | Complete successful Edge-runtime deletion and external-email/native callback cases. Local pending-deletion continuation does not establish full account deletion completion. |
| Financial exports, calendar dates and save recovery | **Bounded local coverage completed: nine journey checks plus two focused probes.** Actual CSV pagination exported all 1,007 current-year rows; formula/quoted/newline text, property/owner filters, separated currencies and Pacific/Atlantic calendar dates passed. Rejected and lost-response saves retain one durable expense identity. Exact-cent totals passed a 249-row large-value probe. With an actual committed response held, editing/cancel and a second draft stayed blocked until completion; Escape retained the active form and the subsequent draft survived. All synthetic cleanup passed. | Complete native sharing/device-timezone and external accountant checks; decide posted financial correction/reversal policy. These tests do not establish a full finance policy audit. |
| Keyboard, names, modal focus and draft retention | **Bounded browser accessibility coverage completed: nine checks.** Named fields/actions, keyboard owner/tenant tabs and selected state, radio semantics/arrows, validation announcements, modal focus/trap/Escape restoration and browser Back draft retention passed without runtime errors or external traffic. | Complete screen-reader speech, physical-device accessibility and full WCAG audit before claiming comprehensive accessibility conformance. |
| Provider and native delivery | **Not run.** Browser phone emulation does not establish physical iOS/Android callbacks, camera/photo permissions or push delivery. Google OAuth, external email and payment-provider delivery remain unverified. | Run authorized device/provider sandbox cases, including cancellation, expiry, duplication, retry and account switching. Keep paid providers inactive until their separate gate passes. |
| Product and wider journey decisions | **Open.** Existing Free-three-property limit and past-due behavior are retained. Pricing/grace, retention/anonymization, owner/property cascades and posted financial corrections require decisions. Email changes remain read-only pending confirmation-flow verification. | Decide these policies and complete the remaining Edge/native/provider/accessibility gates. Portfolio import, broader desktop layouts and analytics remain later adoption work. |

## Exact dependency advisory inventory

The audit labels tooling packages as production dependencies because Expo is a
runtime dependency. The source paths below describe where the affected APIs are
used; absence of a demonstrated public exploit path does not remove an advisory.
GHSA ranges and CVEs were checked against official GitHub advisory pages.

| Installed package and dependency chain | Advisory and affected/fixed versions | Affected path and release disposition |
| --- | --- | --- |
| `expo-router@56.2.11 → query-string@7.1.3 → decode-uri-component@0.2.2` | [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr), **CVE-2026-45822**. Affected `<=0.4.2`; fixed `0.5.0`. | `query-string/index.js:3` loads the vulnerable decoder; Router's fallback `build/react-navigation/core/getStateFromPath.js:499` calls its parser. Normal ExpoRoot navigation explicitly selects `build/getLinkingConfig.js:90` → `build/fork/getStateFromPath-forks.js:370`, which uses URL search parameters. No RentView custom fallback parser/container was found. **Open:** public decoding attack path unestablished. Prefer a compatible Router 56/backported decoder fix; decoder 0.5 is ESM while query-string 7 expects callable CommonJS, and plain query-string 9 does not provide Router 56's expected namespace exports. |
| `expo@56.0.12 → @expo/config@56.0.15 → deepmerge@4.3.1` | [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), **CVE-2026-93753**. Affected `>=4.2.0 <=4.3.1`; **no patched version listed**. | `deepmerge/dist/cjs.js:79` writes keys into its result; `@expo/config/build/Config.js:415,453` merges repository config/plugin properties. A bounded benign probe confirmed returned-object prototype poisoning; ordinary objects and `Object.prototype` remained unaffected. No tenant-controlled config path was found. **Open:** require an upstream compatible fix/backport and reviewed build inputs; do not treat an older version outside the listed range as automatically safe. |
| `react-native@0.85.3 → @react-native/community-cli-plugin@0.85.3 → metro@0.84.4 → image-size@1.2.1` (pre-remediation tree) | [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq), **CVE-2025-71329**. Affected `>=1.2.0 <=2.0.2`; fixed upstream `2.0.3`. | JXL/HEIF parser infinite loops. Alternate Metro `src/Assets.js:17,72` called image-size on imported source assets. Content sniffing meant extension filtering alone did not close this path. **Fixed locally by removal:** coherent Metro 0.84.5 removes the dependency from installed/lock graphs and audit; no image-size major override was used. Post-install regression/types, SDK compatibility, fresh export and browser journey/edge checks pass. |
| Same pre-remediation `image-size@1.2.1` chain | [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr), **CVE-2025-71330**. Affected `>=0.6.3 <=2.0.2`; fixed upstream `2.0.3`. | ICNS parser infinite loop; **fixed locally by the same dependency removal**. Expo's already-selected Metro 0.84.5 uses `src/Assets.js:11` → `src/lib/imageSize.js:17`, with its own supported-format parsers. No runtime repair-upload → Metro path was found. |
| `expo@56.0.12 → @expo/cli@56.1.27 → zod@3.25.76` | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), **CVE-2023-54404**. Affected `<4.6.6`; fixed `4.6.6`. | `zod/v3/types.cjs:1829` parses every array element; Expo CLI `build/src/start/server/DevToolsPlugin.schema.js:77` validates plugin output, called by `DevToolsPluginCliExtensionResults.js:61`. Official description includes huge arrays **without** a length constraint; missing `.max()` is not a defense. The wrapper's V8 maximum-string-length cap is not a small resource bound. **Open:** local plugin-output tooling path; no public RentView API/Edge import found. Prefer an Expo CLI 56/Zod 3 backport or narrow upstream resource-limit fix. Zod 4 is outside the parent's range and its schema/error/MCP compatibility is unvalidated. |

Paths in this table are relative to `node_modules/` at the reviewed versions.
After Metro replacement, the removed image paths describe the preserved
pre-remediation evidence, not a claim that they remain installed.

The Metro change pins seven dependency edges beneath three React Native parents
to 0.84.5; every original edge allowed `^0.84.3`. Expo already uses that exact
Metro family. It changes 15 installed nodes and removes 19, without an Expo SDK
major change. This is a scoped parent override, not an assertion that an
unconstrained `npm update` selected the patched family automatically.

## Evidence and next sequence

1. Resolve the three remaining upstream package gates through compatible fixes
   or a documented release risk decision; no acceptance is recorded here.
2. Prepare a reviewed hosted rollout and extension-owner repair plan, including
   actual legacy data and API exposure. Execution requires separate target
   authorization; local repair results do not establish hosted privileges.
3. Complete remaining policy/device/provider decisions, successful Edge account
   deletion, native sharing/timezone and full accessibility coverage before
   claiming those release paths verified. The bounded local recovery, finance
   and keyboard journeys listed above have completed their final reruns.

Preserved baseline results include 15 canonical migration replay stages and the
verified identity/Metro changes. The ACL repair has separate two-database
ACL/worker, trust/backend SQL and 11 Data API results. The latest source changes
then passed 108 unit/handler tests, both type checks, fresh web export, 13 real
local core E2E checkpoints, 36 phone/desktop edge checks, nine recovery checks,
nine finance checks, two focused finance probes and nine keyboard/accessibility
checks. This includes fixes for stable failed-expense IDs, exact-cent totals,
in-flight draft guards, actionable errors, Auth layout lifetime and accessible
controls. No new schema or dependency change occurred in that source pass:
advisors remain zero errors/eight warnings, and the audit remains 11 affected
nodes across three unresolved advisory packages. The prior zero-mismatch Expo
56 check retains its installed/offline metadata caveat.

Workspace evidence:

- `/workspace/scratch/rentview-warning-triage/rls-results-retry1.json`
- `/workspace/scratch/rentview-warning-triage/rls-metadata-comparison.json`
- `/workspace/scratch/rentview-warning-triage/rls-advisors.stdout`
- `/workspace/scratch/rentview-warning-triage/extension-boundary-failure.json`
- `/workspace/scratch/rentview-warning-triage/extension-catalog.json`
- `/workspace/scratch/rentview-warning-triage/backend-boundary-retry1.json`
- `/workspace/scratch/rentview-warning-triage/pg-net-repair-results.json`
- `/workspace/scratch/rentview-warning-triage/backend-boundary-final.json`
- `/workspace/scratch/rentview-warning-triage/advisors-post-repair.stdout`
- `/workspace/scratch/rentview-warning-triage/npm-audit.json`
- `/workspace/scratch/rentview-warning-triage/metro-install.json`
- `/workspace/scratch/rentview-warning-triage/unit-tests.log`
- `/workspace/scratch/rentview-warning-triage/typecheck.log`
- `/workspace/scratch/rentview-warning-triage/typecheck-tests.log`
- `/workspace/scratch/rentview-warning-triage/web-export.log`
- `/workspace/scratch/rentview-warning-triage/core-e2e/results.json`
- `/workspace/scratch/rentview-warning-triage/browser-edges/results.json`
- `/workspace/scratch/rentview-journey-coverage/recovery-final-retry1/results.json`
- `/workspace/scratch/rentview-journey-coverage/finance-final/results.json`
- `/workspace/scratch/rentview-journey-coverage/finance-precision-final.json`
- `/workspace/scratch/rentview-journey-coverage/finance-inflight-final.json`
- `/workspace/scratch/rentview-journey-coverage/accessibility-final/results.json`
- `/workspace/scratch/rentview-journey-coverage/core-final-retry1/results.json`
- `/workspace/scratch/rentview-journey-coverage/edges-final/results.json`
- `/workspace/scratch/rentview-advisory-triage/source-findings.json`
- `/workspace/scratch/rentview-warning-triage/GHSA-*.html`
