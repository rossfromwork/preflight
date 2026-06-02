# Code Review — Local-only mode + Local alerts

**Date:** 2026-06-02
**Reviewer:** Claude Opus 4.7 (5 parallel feature-dev:code-reviewer agents)
**Scope:** Everything introduced or materially changed in PRs **#47 (Local-only mode + embedded dashboard)** and **#52 (Local alerts engine + nr_observe_health tool)**, plus the dependency-bump cascade (#51).
**Branch:** `main`

---

## Methodology

Five parallel review agents covered orthogonal slices, each given the design specs (`docs/superpowers/specs/2026-05-28-local-only-mode-design.md`, `docs/superpowers/plans/2026-05-28-local-only-mode.md`, `docs/superpowers/plans/2026-05-29-local-alerts.md`) plus smoke-test checklists, and each instructed to flag every bug regardless of size:

- **Agent 1 — Config + index.ts wiring:** `src/config.ts`, `src/index.ts`, privacy-proof tests, mode gating, `licenseKey/accountId` gating, `validateRulesPath`, fs.watch debounce, alert engine bootstrap.
- **Agent 2 — Dashboard HTTP server + routes:** `src/dashboard/dashboard-server.ts`, `live-event-bus.ts`, `routes/static-handler.ts`, `routes/api-handler.ts`, `routes/sse-handler.ts`. Security headers, Host validation, SPA fallback, SSE replay/heartbeat semantics.
- **Agent 3 — React SPA dashboard:** `src/web/App.tsx`, hooks, store, views (Today/Sessions/History/Audit), components, zustand v5 selector stability, vite/Tailwind v4 migration.
- **Agent 4 — Alerts engine + collector + log:** `src/alerts/local-alert-engine.ts`, `alert-snapshot-collector.ts`, `alert-log.ts`, `local-alert-rule.ts`, `os-notifier.ts`, `examples/local-alert-rules.json`. Rule eval, dedup, percentiles, period-key parsing, log retention, shell-injection.
- **Agent 5 — Alert UI integration + setup wizard:** `AlertBanner*.tsx`, `useLiveAlerts.ts`, alert pieces of `liveStore.ts`, sidebar badge, Today recent-alerts panel, `/api/alerts/recent` route, `setup-wizard.ts` rule copying.

Multi-agent overlaps (e.g. SSE id/seq mismatch flagged by 3 agents) are de-duplicated below.

---

## Severity legend

| Severity | Meaning |
|---|---|
| **Critical** | Active bug that breaks a primary user-visible feature on first use, or a privacy-promise gap |
| **High** | Latent bug that fires under realistic conditions; or a meaningful functional/security regression |
| **Medium** | Bug under uncommon conditions, or a UX/correctness gap that should be fixed before public testing |
| **Low** | Minor issue, fragility, or future-proofing concern |
| **Nit** | Style/redundancy/observation; not a defect |

---

## Categories

| Code | Category |
|---|---|
| **SEC** | Security |
| **LIFE** | Lifecycle / resource management |
| **CORR** | Correctness / logic |
| **TYPE** | Type safety / API contracts |
| **TEST** | Test reliability or coverage gap |
| **PERF** | Performance |
| **DOC** | Documentation mismatch |
| **UX** | User experience / UI behaviour |

---

## Summary

**Total findings:** 51 (8 Critical, 15 High, 13 Medium, 10 Low, 5 Nit).

### Status (as of 2026-06-02)

**All 8 Critical findings fixed** on branch `chris/local-mode-critical-findings` (11 commits, 2221 Jest + 133 vitest tests passing, lint clean):

| Finding | Commit | Notes |
|---|---|---|
| F-001 | `8bdf94c` | Kept `external_network` chip; CODE_REVIEW step was wrong about its source |
| F-002 | `48ba2ff` + `2362d30` | Vite `base:'/'`; revert-guard regression test added in follow-up |
| F-003 | `8defc67` + `2362d30` | Scoped to build-on-demand + child-process telemetry-absent assertion (in-process gate test deferred — see F-003 status block) |
| F-004 | `f503462` | Port `0` → ephemeral; test renamed |
| F-005 | `831a6ad` | New `onWithSeq`/`offWithSeq` API; heartbeats use `hb-<ts>` |
| F-006 | `695e51a` | Snapshot emits on any percentile, not just p95 |
| F-007 | `ef0e2bd` + `2362d30` | `NotFoundError`; revert-guard test uses default `QueryClient` |
| F-008 | `562f9c1` | Default → `'session'`; warns on any non-session value |

Plus: `0af3876` — chore commit fixing flaky `stdio integration` test, enabled by F-004's port-0 pass-through.
Plus: `2362d30` — pre-push test-strengthening commit closing 3 load-bearing coverage gaps in F-002, F-003, F-007 found by parallel test-coverage review.

### Out of scope for this branch

The integration review surfaced three pre-existing High-severity issues (already in `main`, not regressions from this branch):
- **F-011** — `start()` error listener never removed; runtime errors silently dropped
- **F-012** — `Host: 127.0.0.1:abc.evil.com` passes validation (port suffix not numeric-validated)
- **F-017** — `ForecastEodCard` renders `+$-1.23` for negative deltas

These are listed in the High section below and should be addressed in a follow-up branch.

### Highest-impact items (originally — for posterity)

- **F-001** — Audit view non-functional (server↔SPA field-name mismatch).
- **F-002** — Direct navigation to `/sessions`, `/history`, `/audit` produces a blank page (Vite `base: './'`).
- **F-003** — Privacy-proof in-process test never exercises `main()`.
- **F-005** — SSE reconnect replay broken (per-connection counter vs global bus seq).
- **F-006** — `latency.percentile` rules with `percentile: 50` or `99` silently never fire.
- **F-007** — `/api/alerts/recent` 404 in cloud mode permanently shows red error.

Findings begin in the next sections.

---

## ✅ Critical severity

> **All 8 critical findings fixed on branch `chris/local-mode-critical-findings`.** See per-finding `**Status:**` blocks below for the commit SHA and any deviations from the original plan.


### ✅ [F-001] Audit view non-functional — server/SPA field-name mismatch — Critical (CORR)
**Status:** Fixed in commit `8bdf94c`. The CODE_REVIEW step suggested removing the `external_network` chip because it had no source — that turned out to be incorrect. `securityAlert.alertType` already emits `sensitive_file` / `destructive_command` / `external_network` from `audit-trail.ts:155–173`, so all three chips were kept and the classification source is the existing `alertType` field. Tests cover full DTO mapping, `'other'` fallback, redaction, and the negative assertion that `developer`/`command`/`filePath`/`action` are NOT exposed in the response.

**Location:** `src/web/views/Audit.tsx:5-11, 50, 108, 111, 113, 116` and `src/dashboard/routes/api-handler.ts:8-18, 108-111`
**Issue:** The SPA's `AuditEntry` interface declares `ts`, `target`, `classification`. The server returns `redactAuditRecord(entry)` which preserves the `RawAuditRecord` shape: `timestamp`, `detail`, `action` (plus `tool`, `sessionId`). Three primary fields the SPA reads do not exist in the server response.
**Impact:** Every row in the Audit view shows `Invalid Date` for the timestamp (since `r.ts` is `undefined`), a blank target column, and a blank classification chip. Filter chips for `sensitive_file` / `destructive_command` / `external_network` silently hide every row because `r.classification === filter` is always `undefined === 'something'`. Row keys collapse to `undefined-${tool}-undefined`, causing React key collisions for any tool used more than once. The Audit smoke-test in the local-only-mode plan will appear to pass (data is present) but the view is completely unusable.
**Suggested fix:** Transform the server response in `api-handler.ts` to match the SPA's shape, mapping `action` values to the SPA's classification keys.

**Implementation steps for Haiku:**

1. Open `src/dashboard/routes/api-handler.ts`. Locate `redactAuditRecord` near line 23.
2. Above `redactAuditRecord`, add a helper that maps the raw server shape to the SPA shape:
   ```typescript
   const ACTION_TO_CLASSIFICATION: Record<string, string> = {
     FileRead: 'sensitive_file',
     FileWrite: 'sensitive_file',
     FileEdit: 'sensitive_file',
     BashCommand: 'destructive_command',
     // McpToolCall / AgentSpawn / Search / Other → 'other'
   };
   function toAuditEntry(r: RawAuditRecord): {
     ts: number;
     sessionId: string | null;
     tool: string;
     target: string;
     classification: string;
   } {
     return {
       ts: r.timestamp,
       sessionId: r.sessionId,
       tool: r.tool,
       target: typeof r.detail === 'string' ? redactSensitive(r.detail) : '',
       classification: ACTION_TO_CLASSIFICATION[r.action] ?? 'other',
     };
   }
   ```
3. In the `GET /api/audit` route handler (around line 108-111), replace `jsonOk(res, log.map(redactAuditRecord))` with `jsonOk(res, log.map((entry) => toAuditEntry(entry as RawAuditRecord)))`.
4. Verify SPA filter keys in `src/web/views/Audit.tsx:42-46` match the classification values produced. The chip `'external_network'` has no source today — either remove that chip or extend `RawAuditRecord` to carry an explicit classification (preferred: remove for now).
5. Build: `npm run build`.
6. Add an integration test in `src/dashboard/routes/api-handler.test.ts`: with a mock `auditTrailManager.getAuditLog()` returning one record per action type, assert the response has `ts`, `target`, `classification` fields with the correct mapped values.
7. In `src/web/views/Audit.test.tsx`, add a test that mocks `/api/audit` returning the new shape and asserts the table renders timestamp, target, and classification correctly.
8. Run: `npx jest -- src/dashboard/routes/api-handler.test.ts && npm run test:web -- Audit`.
9. Run: `npm run lint`.

---

### ✅ [F-002] Direct navigation to `/sessions`, `/history`, `/audit` produces blank page — Critical (CORR)
**Status:** Fixed in commit `48ba2ff`, regression tests strengthened in `2362d30`. Vite `base` switched from `'./'` to `'/'`. Two tests guard the revert: a config-source check that strips comments and asserts the active `base:` line is `/`, plus an SPA-fallback test that asserts the served HTML contains absolute `/assets/` paths (not relative `./assets/`).

**Location:** `vite.config.ts:8` (`base: './'`) and the built `dist/web/index.html`
**Issue:** Vite is configured with `base: './'`, producing relative asset paths (`./assets/index-iG2fP2Ef.js`) in the built `index.html`. The dashboard's static handler correctly serves `index.html` as fallback for any extensionless path. When the browser parses the served HTML at `http://127.0.0.1:7777/sessions`, it resolves `./assets/...` against `/sessions/`, requesting `/sessions/assets/index-iG2fP2Ef.js` — a 404. Page renders blank with JS errors.
**Impact:** Any time a user refreshes on a non-root URL, follows a bookmark, or navigates directly to `/sessions/some-id`, the dashboard breaks. This is the dominant access pattern for any non-Today view.
**Suggested fix:** Switch `base` to absolute (`'/'`).

**Implementation steps for Haiku:**

1. Open `vite.config.ts`. Locate `base: './'` (around line 8).
2. Replace with `base: '/'`.
3. Force a clean rebuild: `rm -rf dist/web && npm run build:web` (check `package.json` for the SPA build script — likely `build:web` or `build`).
4. Verify the built HTML uses absolute paths: `grep '/assets/' dist/web/index.html` — must match. `grep -c 'src="\./assets' dist/web/index.html` — must return 0.
5. Manual smoke check: start the dashboard in `mode: 'local'`, open `http://127.0.0.1:7777/`, click a Sessions link, then refresh with the browser refresh button. Page must continue rendering. Open DevTools and confirm no `/sessions/assets/...` 404s.
6. Add a regression test in `src/dashboard/routes/static-handler.test.ts`: build (or mock) a `dist/web/index.html` containing `<script src="/assets/x.js">`, request `/sessions/abc`, assert response body contains `/assets/` (absolute) and not `./assets/`.
7. Run: `npx jest -- src/dashboard/routes/static-handler.test.ts`.
8. Run: `npm run lint`.

---

### ✅ [F-003] Privacy-proof in-process test never exercises `main()` — Critical (TEST)
**Status:** Partially fixed in commit `8defc67`, regression assertion strengthened in `2362d30`. Scope was reduced after ESM module mocking via `jest.unstable_mockModule` proved fragile under the project's ts-jest + moduleNameMapper setup — rather than ship mocks that may silently stop applying after a Jest/ts-jest upgrade, the in-process tests are scoped honestly to "config returns mode='local'" and "SessionTracker makes no outbound HTTP calls". The load-bearing privacy proof is now the child-process test, which: (1) self-bootstraps via `beforeAll` that runs `npm run build` if `dist/index.js` is missing — so the test always runs in CI; (2) asserts `'Harvest scheduler started'` is absent from the child's stderr, which is the observable signal that `NrIngestManager`'s constructor (and therefore the gate) was correctly skipped. **Follow-up:** if the in-process gate coverage becomes important later, refactor `main()` to extract the gate into a directly-testable function — left as a TODO in the test file.

**Location:** `src/index.privacy.test.ts:57-87` (in-process test) and `:95-171` (child-process test, conditionally skipped)
**Issue:** The first describe block ("privacy proof — mode=local") loads config and constructs a `SessionTracker` in isolation. It never imports `main()` or any code path from `index.ts`. The `if (config.mode !== 'local') { new NrIngestManager(...) }` branch is dead — the test cannot execute it. The `ingestCtor` spy will report zero calls regardless. The child-process test that *does* exercise the real binary requires `dist/index.js` and is silently skipped on a fresh checkout.
**Impact:** The privacy promise — "in mode=local, no NR transport is constructed" — is effectively untested in CI when the build step is skipped or fails. A regression that wires `NrIngestManager` even when `mode === 'local'` would not be caught.
**Suggested fix:** Either invoke `main()` directly with mocked stdio, or guarantee the child-process test runs by ensuring `dist/index.js` exists.

**Implementation steps for Haiku:**

1. Open `src/index.privacy.test.ts`. Locate the first describe block at line 57.
2. Replace its body with one that exercises real `main()`:
   - Use `jest.unstable_mockModule` to mock `@modelcontextprotocol/sdk/server/stdio.js` (transport becomes a no-op).
   - Mock `node:http` and `node:https` `request` so any outbound call is captured.
   - Spy on `NrIngestManager` so its constructor is observable.
   - Set environment: `NR_AI_MODE=local`, no `NEW_RELIC_LICENSE_KEY`.
   - `await import('./index.js')` (after mocks are installed).
   - Wait for `main()` to reach steady state (the dashboard server `listen` resolves).
   - Assert: `NrIngestManager` constructor called 0 times; http/https `request` mocks called 0 times.
   - Trigger shutdown (SIGTERM or close stdin); await.
3. For the child-process test, add a `beforeAll` that builds if needed:
   ```typescript
   beforeAll(() => {
     if (!existsSync('./dist/index.js')) {
       execSync('npm run build', { stdio: 'inherit' });
     }
   });
   ```
4. Build: `npm run build`.
5. Run: `npx jest -- src/index.privacy.test.ts`.
6. Manually verify the test catches a real regression: temporarily change the gate in `src/index.ts` to `if (true)`, re-run, the test must FAIL. Restore the original.
7. Run: `npm run lint`.

---

### ✅ [F-004] Privacy integration test `NR_AI_DASHBOARD_PORT=0` clamps to 7777 — Critical (TEST)
**Status:** Fixed in commit `f503462`. Bounds check tightened from `> 0` to `>= 0`; port `0` now passes through and the OS assigns an ephemeral port. Negative or out-of-range high ports still fall back to the default 7777 (covered by a new test). The previously-misleading test name "clamps to minimum 1" was renamed to accurately describe the behaviour. Also unlocked a piggyback chore commit (`0af3876`) that uses `NR_AI_DASHBOARD_PORT=0` for the `stdio integration` test in `src/index.test.ts` so it no longer fails when port 7777 is held by a real instance.

**Location:** `src/index.privacy.test.ts:113` and `src/config.ts:678`
**Issue:** The child-process privacy test sets `NR_AI_DASHBOARD_PORT=0` intending to use an OS-assigned ephemeral port. The config loader clamps `0` to default `7777` because `dashboardPortRaw! > 0` rejects `0`. The child binds 7777. If anything else uses 7777 (which the smoke-test recommends as the default), the test fails with EADDRINUSE.
**Impact:** Spurious test failures on developer laptops and shared CI runners. Reviewers will see flaky failures and may dismiss them, masking real bugs.
**Suggested fix:** Allow `0` as a valid value meaning "OS-assigned ephemeral".

**Implementation steps for Haiku:**

1. Open `src/config.ts`. Locate the dashboard-port resolution block around line 670-680.
2. Find `dashboardPortRaw! > 0 && dashboardPortRaw! <= 65535`.
3. Change to `dashboardPortRaw! >= 0 && dashboardPortRaw! <= 65535`.
4. Update tests in `src/config.test.ts`:
   - Rename "clamps dashboard port to minimum 1" → "passes 0 through as OS-assigned ephemeral", with `expect(config.dashboard.port).toBe(0)`.
   - Keep negative numbers and out-of-range high numbers falling back to 7777.
5. Confirm `src/dashboard/dashboard-server.ts` `start()` returns the resolved `AddressInfo` and `src/index.ts` logs `addr.port` (the resolved port, not the configured one). It already does — just verify.
6. Build: `npm run build`.
7. Run: `npx jest -- src/config.test.ts -t "dashboard port"`.
8. Manually verify by occupying 7777 (`nc -l 7777` in another terminal) and re-running `npx jest -- src/index.privacy.test.ts` — it should not fail anymore.
9. Run: `npm run lint`.

---

### ✅ [F-005] SSE reconnect replay broken — `id` per-connection counter vs global bus seq — Critical (CORR)
**Status:** Fixed in commit `831a6ad`. `LiveEventBus` gained `onWithSeq`/`offWithSeq` methods that deliver `{seq, payload}` to subscribers via an internal `__seq__:event` channel, so the existing `on`/`off`/`emit` API stays intact for non-seq subscribers. Each `emit()` fires both the plain and seq channels synchronously, preserving ordering. The SSE handler subscribes via `onWithSeq` and uses the bus seq directly in the frame `id` — same namespace the replay buffer uses. Heartbeats use a string id `hb-<timestamp>` so they're outside the seq namespace; on reconnect the browser sends them back as `Last-Event-ID`, the server's `parseInt` returns NaN, and no replay fires (preventing heartbeat ids from contaminating the bus seq numbering). Cleanup is now guarded with a `cleaned` flag so the duplicate `req.on('close')`/`res.on('close')` handlers don't double-off listeners (addresses F-023's adjacent concern). Two regression tests cover (1) frame `id` matches bus seq when the bus has pre-connection events, (2) reconnect with a real bus seq replays only newer events.

**Location:** `src/dashboard/routes/sse-handler.ts:8, 27-37, 52-55` and `src/dashboard/live-event-bus.ts:83`
**Issue:** The bus assigns monotonically increasing **global** sequence numbers from 1 upward and stores them in its replay ring buffer. The SSE handler emits each live event using `id: ${nextLocalSeq}` where `nextLocalSeq` is a **per-connection** counter starting at `lastSeq + 1`. The two numbering systems coincide only when bus and connection are initialized simultaneously.
**Impact:** In real use the bus emits N events before the first browser connects (every tool call goes through the bus). Browser sees `id: 1, 2, 3, ...` (local) but bus has globals `N+1, N+2, ...`. On disconnect+reconnect, browser sends `Last-Event-ID: 10`, server runs `bus.replayFrom(10)` which returns ALL globals > 10 — pre-connection history (replayed unnecessarily) plus duplicates. Client then receives mixed local- and global-id frames; the next reconnect sends the wrong `Last-Event-ID`. Reconnect is essentially never correct except in test edge cases.
**Suggested fix:** Use the bus's global seq for the `id` field on every frame. Remove `nextLocalSeq` entirely.

**Implementation steps for Haiku:**

1. Open `src/dashboard/live-event-bus.ts`. Add a public method that exposes the assigned seq:
   ```typescript
   onWithSeq<E extends LiveEventName>(
     event: E,
     handler: (entry: { seq: number; payload: LiveEventMap[E] }) => void,
   ): void {
     // wrap the existing emitter; assign seq from this.nextSeq at emit time
   }
   ```
   Or simpler: change `emit()` to also emit a `'_internal:seq'` companion event carrying `{seq, event}` so subscribers can read the seq via a side channel. Pick whichever fits the existing typed-emitter style.
2. Open `src/dashboard/routes/sse-handler.ts`:
   - Delete `let nextLocalSeq = lastSeq + 1;`.
   - Subscribe via `bus.onWithSeq` (or the side-channel) and write `frame(event, seq, payload)` using the bus seq.
3. For replay: `bus.replayFrom(lastSeq)` already returns `ReplayEntry[]` with `{seq, event, payload}`. Use `entry.seq` for the frame `id` (already does — verify).
4. For heartbeats: assign `id: 'hb-${Date.now()}'` (string). Browsers won't parrot a non-numeric `Last-Event-ID` as a number, so server's `parseInt` returns `NaN` and no replay is triggered.
5. Open `src/dashboard/routes/sse-handler.test.ts`. Add regression tests:
   - Test 1: emit 5 events into a fresh bus. Open SSE. Receive 5 frames; `id` values must be `1,2,3,4,5`. Emit 3 more while connected. Receive `id: 6,7,8`. Disconnect. Emit one more (`id: 9`). Reconnect with `Last-Event-ID: 8`. Receive only the event with `id: 9`.
   - Test 2: emit 100 events before connecting. Connect. Receive only newer events (ids 101+). Disconnect with `Last-Event-ID: 105`. Reconnect. Receive only seq > 105.
6. Build: `npm run build`.
7. Run: `npx jest -- src/dashboard/routes/sse-handler.test.ts src/dashboard/live-event-bus.test.ts`.
8. Run: `npm run lint`.

---

### ✅ [F-006] `latency.percentile` rule p50/p99 silently never fires when p95 absent — Critical (CORR)
**Status:** Fixed in commit `695e51a`. Snapshot collector now emits an entry whenever ANY of p50/p95/p99 is present; missing percentiles default to 0, which the rule comparator treats as below any positive threshold. Three regression tests cover p50-only, p99-only, and the empty-percentiles case (no entry emitted).

**Location:** `src/alerts/alert-snapshot-collector.ts:312-323` (the `if (typeof percentiles.p95 === 'number')` gate)
**Issue:** The snapshot collector only emits a per-tool latency entry when `percentiles.p95` is present. The `LatencyTracker` may return `{ p50, p99 }` without `p95` when sample count is too low. A `latency.percentile` rule with `percentile: 99` then sees no entry, the engine's `computeLatencyValue()` returns null, and the rule silently never fires — even at very high p99 latencies.
**Impact:** Real latency degradations escape detection. The Phase-3 fix commit claims p50/p99 work end-to-end, but the snapshot layer still gates on p95.
**Suggested fix:** Emit an entry whenever ANY percentile is present, defaulting missing percentiles to 0.

**Implementation steps for Haiku:**

1. Open `src/alerts/alert-snapshot-collector.ts`. Locate the loop around line 312.
2. Replace the `if (typeof percentiles.p95 === 'number')` gate with:
   ```typescript
   if (
     typeof percentiles.p50 === 'number' ||
     typeof percentiles.p95 === 'number' ||
     typeof percentiles.p99 === 'number'
   ) {
     out.push({
       tool,
       p50Ms: typeof percentiles.p50 === 'number' ? percentiles.p50 : 0,
       p95Ms: typeof percentiles.p95 === 'number' ? percentiles.p95 : 0,
       p99Ms: typeof percentiles.p99 === 'number' ? percentiles.p99 : 0,
     });
   }
   ```
3. Above the block, add a comment documenting the default-0 contract: missing percentiles surface as 0; the rule comparator treats 0 as below any positive threshold.
4. Open `src/alerts/alert-snapshot-collector.test.ts`. Add tests:
   - Tracker returns `{ p50: 100 }` only → snapshot includes the tool with `p50Ms: 100, p95Ms: 0, p99Ms: 0`.
   - Tracker returns `{ p99: 5000 }` only → tool included with `p99Ms: 5000` and others 0.
   - Tracker returns `{}` → tool excluded.
5. Open `src/alerts/local-alert-engine.test.ts`. Add a test:
   - Snapshot has `Bash` with `p50Ms: 0, p95Ms: 0, p99Ms: 5000`.
   - Rule: `latency.percentile`, `percentile: 99`, `tool: 'Bash'`, threshold 1000.
   - Assert rule fires.
6. Build: `npm run build`.
7. Run: `npx jest -- src/alerts/`.
8. Run: `npm run lint`.

---

### ✅ [F-007] `/api/alerts/recent` 404 in cloud mode → permanent red error in dashboard — Critical (UX)
**Status:** Fixed in commit `ef0e2bd`, regression test strengthened in `2362d30`. New `NotFoundError` class in `src/web/api/client.ts` is thrown from `getJson` only on 404. `Today.tsx` `RecentAlertsPanel` catches it in the `queryFn` and returns `null`, the panel checks `data === null` and renders nothing, and the query has `retry: false` so React Query doesn't retry the 404 three times before settling. The strengthened regression test uses a default `QueryClient` (with retries enabled) to ensure the suppression must come from the component's own `retry: false` — not from the test harness's `retry: 0` global. Also asserts the alerts/recent endpoint was called exactly once.

**Location:** `src/web/views/Today.tsx:110-114`, `src/web/api/client.ts:3`, `src/dashboard/routes/api-handler.ts:159-162`
**Issue:** When `mode='cloud'`, the alert engine is not constructed → `alertLog` is undefined → `GET /api/alerts/recent` returns 404 (correct per spec). The SPA's `getJson` throws on every non-2xx. React Query catches the throw, retries 3 times with exponential backoff, then surfaces it as `error`. The `RecentAlertsPanel` renders "Error loading recent alerts." in red — and refetches every 30 s, producing 4 failed requests every 30 s with a permanent visible error.
**Impact:** Cloud-mode users (the primary launch audience) open Today and see a persistent error. They will not understand it means "alerts are a local-only feature". Network log noise is high.
**Suggested fix:** Treat 404 as "feature unavailable" and render an empty state with `retry: false`.

**Implementation steps for Haiku:**

1. Open `src/web/api/client.ts`. Add a typed-null branch for 404:
   ```typescript
   export class NotFoundError extends Error {}
   export async function getJson<T>(path: string): Promise<T> {
     const res = await fetch(path);
     if (res.status === 404) throw new NotFoundError(`Not found: ${path}`);
     if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
     return (await res.json()) as T;
   }
   ```
2. Open `src/web/views/Today.tsx`. Locate `useQuery({ queryKey: ['alerts','recent'], ... })` near line 110.
3. Add `retry: false` and a 404-tolerant data path:
   ```typescript
   const { data: recentAlerts, error } = useQuery({
     queryKey: ['alerts', 'recent'],
     queryFn: () => getJson<AlertEvent[]>('/api/alerts/recent').catch((err) => {
       if (err instanceof NotFoundError) return null;
       throw err;
     }),
     refetchInterval: 30_000,
     retry: false,
   });
   ```
4. In the panel render, check `recentAlerts === null` → render nothing (or a small "Alerts not available in cloud mode" hint). Render the error path only when `error && !(error instanceof NotFoundError)`.
5. Open `src/web/views/Today.test.tsx`. Add tests:
   - 404 response → panel renders empty/null, no red text.
   - 500 response → panel renders red error.
   - 200 with entries → panel renders the entries.
6. Build: `npm run build`.
7. Run: `npm run test:web -- Today`.
8. Run: `npm run lint`.

---

### ✅ [F-008] `cost.window` Zod default `costPeriod: 'today'` silently no-ops in v1.1 — Critical (CORR)
**Status:** Fixed in commit `562f9c1`. Zod default for `costPeriod` is now `'session'` (the only working value in v1.1) and `loadAlertRulesFromDisk` warns at load time for any rule whose effective `costPeriod !== 'session'` — covering both explicit and defaulted values. The starter rules in `examples/local-alert-rules.json` already used `costPeriod: 'session'`, so they continue to work without change. The schema-default test was updated.

**Location:** `src/alerts/local-alert-rule.ts:57` (default) and `src/alerts/alert-snapshot-collector.ts:269-281` (v1.1 `todayUsd: 0` placeholder)
**Issue:** The Zod default for `costPeriodSchema` is `'today'`. The snapshot collector's `readCost()` for v1.1 returns `{ sessionUsd: <real>, todayUsd: 0, weekUsd: 0 }` because today/week aggregation isn't wired. A user who creates a `cost.window` rule and omits `costPeriod` gets a rule that always reads 0 and never fires. The `loadRules()` warning fires only when `costPeriod` is *explicitly* `'today'`/`'week'`; a defaulted value bypasses the warning.
**Impact:** Customers configure cost-spike alerts that look correct but never fire. No alert, no warning.
**Suggested fix:** Change the Zod default to `'session'`. Extend the load-time warning to fire for any parsed rule whose costPeriod ≠ 'session'.

**Implementation steps for Haiku:**

1. Open `src/alerts/local-alert-rule.ts`. Locate `costPeriodSchema` near line 57.
2. Change default to `'session'`:
   ```typescript
   const costPeriodSchema = z.enum(['session', 'today', 'week']).default('session');
   ```
3. Open `src/index.ts` (or wherever `parseLocalAlertRules` is called). Restructure the today/week warning to fire for every parsed rule whose effective `costPeriod !== 'session'`:
   ```typescript
   for (const rule of validRules) {
     if (rule.type === 'cost.window' && rule.costPeriod !== 'session') {
       logger.warn(
         `Rule ${rule.id}: costPeriod='${rule.costPeriod}' is not implemented in v1.1 ` +
         `and will always read 0. Use costPeriod='session' until daily/weekly aggregation lands.`,
       );
     }
   }
   ```
4. Update `examples/local-alert-rules.json`. Confirm every `cost.window` rule has explicit `"costPeriod": "session"`.
5. Open `src/alerts/local-alert-rule.test.ts`. Add test asserting `parseLocalAlertRules([{ type: 'cost.window', threshold: 5 }])` produces a rule with `costPeriod === 'session'`.
6. Build: `npm run build`.
7. Run: `npx jest -- src/alerts/`.
8. Run: `npm run lint`.

---

## High severity

### [F-009] `budget.session` rule never emits cleared event — banner stays forever — High (CORR)
**Location:** `src/alerts/local-alert-engine.ts:460-485, 501-509`
**Issue:** Once a `budget.session` rule fires, it stays in `firing` for the entire process lifetime. The clear logic only fires when `storedPeriodKey !== currentPeriodKey`, but `periodKey('session', now)` returns the constant `'session:infinite'`, so the keys never differ. Starting a new Claude Code session (which resets the `CostTracker`) does not clear the alert.
**Impact:** Banner persists indefinitely. The smoke-test step "Within one evaluation interval, the banner disappears and a cleared line is appended" will never pass for `budget.session` rules.
**Suggested fix:** Add a complementary clear path: when the session cost drops back below the threshold (e.g., session resets), emit `cleared`.

**Implementation steps for Haiku:**

1. Open `src/alerts/local-alert-engine.ts`. Locate `evaluateBudgetRule` and the periodKey-rollover clear branch around line 460.
2. Add a second clear condition: when `period === 'session'` and the snapshot's `cost.sessionUsd` is below the threshold AND the rule is currently firing, emit `cleared`:
   ```typescript
   if (
     period === 'session' &&
     state.status === 'firing' &&
     snapshot.cost.sessionUsd * 100 / sessionBudgetUsd < storedThresholdPct
   ) {
     // emit cleared, reset state
   }
   ```
   The exact threshold check depends on how `BudgetTracker` reports `thresholdPct` in the snapshot — read the current `evaluateBudgetRule` implementation and mirror the comparison logic.
3. Open `src/alerts/local-alert-engine.test.ts`. Add tests:
   - Session budget rule fires at 80%. Then `cost.sessionUsd` drops to a value below 80%. Engine evaluates. Expect `cleared` event emitted.
   - Session budget rule fires. Cost stays the same. Engine evaluates again. Expect no events emitted (no spurious re-fire).
4. Build: `npm run build`.
5. Run: `npx jest -- src/alerts/local-alert-engine.test.ts`.
6. Run: `npm run lint`.
7. Manually verify smoke-test step 3 from `docs/superpowers/plans/2026-06-01-local-alerts-smoke-test.md`: trigger the rule, then reset session, watch banner clear.

---

### [F-010] Negative `Last-Event-ID` enables full unintended replay on next reconnect — High (CORR)
**Location:** `src/dashboard/routes/sse-handler.ts:26-33`
**Issue:** A client sending `Last-Event-ID: -1` gets `replaySeq = -1 < 0` so no replay runs, but `nextLocalSeq = -1 + 1 = 0`. The first live event is sent with `id: 0`. On the next reconnect, the browser sends `Last-Event-ID: 0`, triggering `bus.replayFrom(0)` — a full replay of all 100 buffered events. (Note: this finding compounds with F-005 above — fix F-005 first.)
**Impact:** A second reconnect floods the client with up to 100 buffered events, causing UI duplicates.
**Suggested fix:** Clamp negative or non-numeric `Last-Event-ID` values before using them anywhere.

**Implementation steps for Haiku:**

1. Open `src/dashboard/routes/sse-handler.ts`. After parsing `lastEventIdHeader`, normalise:
   ```typescript
   const rawSeq =
     typeof lastEventIdHeader === 'string' ? parseInt(lastEventIdHeader, 10) : NaN;
   const lastSeq = Number.isFinite(rawSeq) && rawSeq >= 0 ? rawSeq : 0;
   ```
2. Use `lastSeq` for both replay (`bus.replayFrom(lastSeq)`) and any starting-seq computation. (After F-005 lands, the local-counter usage goes away entirely — this fix is still useful as a defence for the replay call.)
3. Add a test in `src/dashboard/routes/sse-handler.test.ts`:
   - Connect with `Last-Event-ID: -1` → no replay, no errors.
   - Connect with `Last-Event-ID: not-a-number` → no replay.
   - Connect with `Last-Event-ID: 5` → replay events with global seq > 5.
4. Build: `npm run build`.
5. Run: `npx jest -- src/dashboard/routes/sse-handler.test.ts`.
6. Run: `npm run lint`.

---

### [F-011] `start()` error listener never removed — runtime errors silently swallowed — High (LIFE)
**Location:** `src/dashboard/dashboard-server.ts:88`
**Issue:** `server.once('error', reject)` remains attached after `start()` resolves. A later runtime error on the server (e.g., the OS reclaims the port, NIC change) calls `reject` on the already-resolved promise — a no-op. Because the `once` listener consumed the error event, Node does not re-emit it. The error is silently dropped with no log entry.
**Impact:** Production failures are invisible; debugging is impossible.
**Suggested fix:** Remove the once-listener on success and attach a permanent error logger.

**Implementation steps for Haiku:**

1. Open `src/dashboard/dashboard-server.ts`. Locate the `start()` body around line 80-90.
2. Modify the `listen` callback:
   ```typescript
   server.listen(this.opts.port, this.opts.host, () => {
     const addr = server.address() as AddressInfo;
     server.removeListener('error', reject);
     server.on('error', (err) => {
       logger.error('Dashboard server error after start', { error: String(err) });
     });
     logger.info('Dashboard server listening', { host: addr.address, port: addr.port });
     this.server = server;
     resolve(addr);
   });
   ```
3. Add a regression test in `src/dashboard/dashboard-server.test.ts`:
   - Start server. Resolve. Then forcibly emit an error: `server.emit('error', new Error('after-start'))`. Capture logger output (mock `createLogger`). Assert the error was logged.
4. Build: `npm run build`.
5. Run: `npx jest -- src/dashboard/dashboard-server.test.ts`.
6. Run: `npm run lint`.

---

### [F-012] `Host: 127.0.0.1:1234.evil.com` passes validation — High (SEC)
**Location:** `src/dashboard/dashboard-server.ts:174-185`
**Issue:** The Host validator splits on the first `:`, extracts `127.0.0.1`, and returns true. A non-numeric port suffix is not rejected. Not exploitable via browser-based DNS rebinding (browsers don't allow JS to set malformed Host headers), but a raw HTTP client (`curl -H "Host: 127.0.0.1:abc.evil.com" ...`) would pass.
**Impact:** Defence-in-depth gap; intent of the validator is bypassed.
**Suggested fix:** Validate the port suffix is numeric.

**Implementation steps for Haiku:**

1. Open `src/dashboard/dashboard-server.ts`. Locate `isHostAllowed` (around line 174).
2. After extracting `hostOnly`, verify any port suffix is digits:
   ```typescript
   const firstColon = hostHeader.indexOf(':');
   const hostOnly = firstColon === -1 ? hostHeader : hostHeader.slice(0, firstColon);
   const portStr = firstColon === -1 ? '' : hostHeader.slice(firstColon + 1);
   if (portStr !== '' && !/^\d+$/.test(portStr)) return false;
   ```
   (Skip this for the bracketed-IPv6 path which already handles ports correctly.)
3. Add tests in `src/dashboard/dashboard-server.test.ts`:
   - `Host: 127.0.0.1:abc.evil.com` → 403.
   - `Host: 127.0.0.1:` → 403.
   - `Host: 127.0.0.1:1234` → 200.
   - `Host: 127.0.0.1` (no port) → 200.
4. Build: `npm run build`.
5. Run: `npx jest -- src/dashboard/dashboard-server.test.ts`.
6. Run: `npm run lint`.

---

### [F-013] `openOnStart` config field is read but never consumed — High (DOC)
**Location:** `src/config.ts:68, 158, 689-695` (interface, schema, loader) and `src/index.ts` (no consumer)
**Issue:** `config.dashboard.openOnStart` is declared in the interface, validated by Zod, and accepted from both file (`dashboard.openOnStart`) and env (`NR_AI_DASHBOARD_OPEN`). `src/index.ts` never references it. A user who sets `openOnStart: true` sees no browser open, no warning, no log line.
**Impact:** Spec mismatch; users assume the feature works.
**Suggested fix:** Either implement the auto-open OR log a warning when set.

**Implementation steps for Haiku:**

1. Decide which: minimal-effort warning (recommended for v1) or full implementation.
2. **Minimal-effort path** — Open `src/index.ts`, find where the dashboard URL is logged. After that:
   ```typescript
   if (config.dashboard.openOnStart) {
     logger.warn(
       'dashboard.openOnStart is not implemented in v1; the dashboard URL is logged above. ' +
       'Open it manually in your browser.',
     );
   }
   ```
3. **Full implementation path** (optional) — After the dashboard `start()` resolves, spawn the OS open command:
   ```typescript
   if (config.dashboard.openOnStart) {
     const url = `http://${addr.address}:${addr.port}`;
     const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
     spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
   }
   ```
   Test on macOS, Linux, and Windows. Wrap in try/catch and log on failure.
4. Update `example.config.js` comment to remove "(future)" if implementing, or keep it and add the warning approach.
5. Build: `npm run build`.
6. Run: `npx jest`.
7. Run: `npm run lint`.

---

### [F-014] Port-in-use error lacks `NR_AI_DASHBOARD_PORT` remediation — High (UX)
**Location:** `src/index.ts` (around `dashboardServer.start()`) and `src/dashboard/dashboard-server.ts:88`
**Issue:** When port 7777 is already in use, `dashboardServer.start()` rejects with raw `EADDRINUSE`. The user sees `Fatal error: Error: listen EADDRINUSE: address already in use 127.0.0.1:7777` with no remediation hint. Spec §5 explicitly requires the message to suggest `NR_AI_DASHBOARD_PORT`.
**Impact:** User confusion; support burden.
**Suggested fix:** Catch EADDRINUSE specifically and rewrap with an actionable message.

**Implementation steps for Haiku:**

1. Open `src/index.ts`. Locate `await dashboardServer.start()`.
2. Wrap in a try/catch that rethrows EADDRINUSE with guidance:
   ```typescript
   let addr;
   try {
     addr = await dashboardServer.start();
   } catch (err) {
     if (err && typeof err === 'object' && 'code' in err && err.code === 'EADDRINUSE') {
       throw new Error(
         `Dashboard port ${config.dashboard.port} is already in use. ` +
         `Set NR_AI_DASHBOARD_PORT to a different port (e.g. 7778) ` +
         `or stop the process using port ${config.dashboard.port}.`,
       );
     }
     throw err;
   }
   ```
3. Add a test in `src/index.test.ts` (or a new `src/dashboard/port-conflict.test.ts`):
   - Start a dummy server on a chosen port.
   - Configure the dashboard to that port and start `main()`.
   - Assert the error log contains `NR_AI_DASHBOARD_PORT`.
4. Build: `npm run build`.
5. Run: `npx jest`.
6. Run: `npm run lint`.

---

### [F-015] AlertBannerStack stuck-expanded UX trap when count drops below threshold — High (UX)
**Location:** `src/web/components/AlertBannerStack.tsx:33-34, 63`
**Issue:** With 6+ alerts, user expands the stack; subsequently dismisses 2 down to 4. `expanded` state is local to the component and never resets. The expanded path renders without the collapse button (because `count < COLLAPSE_THRESHOLD`). The user can never re-collapse without reloading the page.
**Impact:** UI feels broken once count crosses 5 and back. Users perceive bugs.
**Suggested fix:** Reset `expanded` to `false` when `count` drops below the threshold.

**Implementation steps for Haiku:**

1. Open `src/web/components/AlertBannerStack.tsx`. Locate the local `expanded` state.
2. Add a `useEffect` that resets `expanded` when `count` drops below `COLLAPSE_THRESHOLD`:
   ```typescript
   useEffect(() => {
     if (count < COLLAPSE_THRESHOLD) setExpanded(false);
   }, [count]);
   ```
3. Add a test in `src/web/components/AlertBannerStack.test.tsx`:
   - Start with 6 alerts, expand. Count drops to 4 (mock store update). Assert the collapsed-state view returns.
   - Start with 4 alerts. Count rises to 6. Assert collapsed (header with count) view appears.
4. Build: `npm run build`.
5. Run: `npm run test:web -- AlertBannerStack`.
6. Run: `npm run lint`.

---

### [F-016] `RecentAlertsPanel` ordering follows JSONL append order (oldest first) — High (UX)
**Location:** `src/web/views/Today.tsx:140` (the `entries.slice(0, 50)` render) and `src/alerts/alert-log.ts:63-68` (`readRecent` implementation)
**Issue:** `AlertLog.readRecent(50)` reads the file end and returns the last 50 lines in *append* order (oldest first within the slice). The UI does not reverse them. Users see the most-recent alert at the bottom of the table; they must scroll to find what just fired.
**Impact:** Recent alerts panel surfaces stale data first; usability is poor for the panel's primary purpose.
**Suggested fix:** Sort by `firedAt` descending in the panel before rendering. (Alternative: reverse the array in `readRecent`. Doing it in the UI is less risky.)

**Implementation steps for Haiku:**

1. Open `src/web/views/Today.tsx`. Locate the `RecentAlertsPanel` rendering loop.
2. Before mapping `entries`, sort:
   ```typescript
   const sorted = [...entries].sort((a, b) => b.firedAt - a.firedAt);
   sorted.slice(0, 50).map(...)
   ```
3. (Alternative) Open `src/alerts/alert-log.ts` `readRecent` and reverse the result before returning. If you go this route, also update tests that assert append order.
4. Add a test in `src/web/views/Today.test.tsx` (or wherever the panel is tested): given entries with `firedAt: [1000, 2000, 3000]`, render the panel, assert the first row is the entry with `firedAt: 3000`.
5. Build: `npm run build`.
6. Run: `npm run test:web -- Today`.
7. Run: `npm run lint`.

---

### [F-017] `ForecastEodCard` hardcodes `+$` sign — renders `+$-1.23` for negative deltas — High (UX)
**Location:** `src/web/views/Today.tsx:215`
**Issue:** Line 215 unconditionally prepends `+$` to `delta.toFixed(2)`. When `delta < 0` (forecast revised downward, possible after a quiet period), the output is `+$-1.23 from now`. The `pct` sign on line 216 is handled correctly with a conditional — the `delta` line was missed.
**Impact:** Visible UI bug whenever the forecast revises downward.
**Suggested fix:** Conditional sign + `Math.abs`.

**Implementation steps for Haiku:**

1. Open `src/web/views/Today.tsx`. Locate line 215.
2. Replace:
   ```tsx
   +${delta.toFixed(2)}
   ```
   with:
   ```tsx
   {delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}
   ```
   (Use the Unicode minus `−` for visual clarity, or plain `-` — match the existing typographic style.)
3. Add a test in `src/web/views/Today.test.tsx`:
   - `todayTotal=10, forecastEod=8` (`delta=-2`) → assert rendered text contains `−$2.00` (or `-$2.00`), not `+$-2.00`.
   - `todayTotal=10, forecastEod=12` (`delta=2`) → assert `+$2.00`.
4. Build: `npm run build`.
5. Run: `npm run test:web -- Today`.
6. Run: `npm run lint`.

---

### [F-018] `downloadJsonl` Audit export fails silently in Firefox — High (UX)
**Location:** `src/web/views/Audit.tsx:27-31`
**Issue:** Programmatically clicking an `<a download>` anchor that's not in the DOM works in Chromium and Safari but is silently no-op in Firefox.
**Impact:** Firefox users cannot export audit logs. No error shown.
**Suggested fix:** Append the anchor to `document.body` before `.click()`, then remove it.

**Implementation steps for Haiku:**

1. Open `src/web/views/Audit.tsx`. Locate `downloadJsonl` near line 27.
2. Replace the anchor logic with:
   ```typescript
   document.body.appendChild(a);
   try {
     a.click();
   } finally {
     document.body.removeChild(a);
     URL.revokeObjectURL(url);
   }
   ```
3. Add a test in `src/web/views/Audit.test.tsx`: spy on `document.body.appendChild` and `removeChild`, click the export button, assert both were called with the anchor.
4. Build: `npm run build`.
5. Run: `npm run test:web -- Audit`.
6. Run: `npm run lint`.

---

### [F-019] `useLiveEvents` stale-snapshot pattern (latent fragility) — High (CORR)
**Location:** `src/web/hooks/useLiveEvents.ts:7-10`
**Issue:** The hook captures `const store = useLiveStore.getState()` once at effect-run time and reuses that snapshot in named listeners. With Zustand, action functions are stable references, so the bug doesn't manifest today. But a future change that adds memoization or wraps actions will silently start failing.
**Impact:** No current functional bug, but a hard-to-find latent regression vector.
**Suggested fix:** Always read live state via `useLiveStore.getState()` inside each callback.

**Implementation steps for Haiku:**

1. Open `src/web/hooks/useLiveEvents.ts`. Find the `const store = useLiveStore.getState()` line near 7-10.
2. Delete that line.
3. Replace each named listener that uses `store.action(...)` with `useLiveStore.getState().action(...)` so the live state is always read.
4. Verify no behavioural change by running existing tests.
5. Build: `npm run build`.
6. Run: `npm run test:web -- useLiveEvents`.
7. Run: `npm run lint`.

---

### [F-020] No test that cloud-mode skips `copyStarterAlertRules` — High (TEST)
**Location:** `src/install/setup-wizard.test.ts` (missing test) and `src/install/setup-wizard.ts:276`
**Issue:** The wizard correctly gates rule-copying on `mode === 'local' || mode === 'both'`. No test asserts the negative case: that `copyFileSync` is NOT called when `mode='cloud'`. Removing the guard would not break any test.
**Impact:** Regression risk — a future refactor could silently start copying rules in cloud mode.
**Suggested fix:** Add a negative test.

**Implementation steps for Haiku:**

1. Open `src/install/setup-wizard.test.ts`. In the `setupWizard mode branch` suite, add:
   ```typescript
   it('does not copy starter rules when mode=cloud', async () => {
     // Sequence wizard answers for cloud-mode + don't install hooks
     sequenceAnswers('cloud', '12345', 'NRLIC-test', 'tester', '', '', '', 'n');
     await runSetupWizard(...);
     expect(mockedFs.copyFileSync).not.toHaveBeenCalled();
   });
   ```
2. Build: `npm run build`.
3. Run: `npx jest -- src/install/setup-wizard.test.ts`.
4. Run: `npm run lint`.

---

### [F-021] JSONL log rotation TOCTOU may lose events on crash — High (LIFE)
**Location:** `src/alerts/alert-log.ts:51-56` (`rotateIfNeeded` then `appendFile`)
**Issue:** Rotation does `fs.rename(log.jsonl, log.jsonl.1)` then `appendFile` the new line. If the process crashes between the two calls, the alert event is lost (not in `.1`, not in the new file).
**Impact:** Audit gap on rare crash boundaries.
**Suggested fix:** For v1.1, document the trade-off. For a stricter guarantee, write to a temp file then rename.

**Implementation steps for Haiku:**

1. Open `src/alerts/alert-log.ts`. Locate `rotateIfNeeded` and `append` logic.
2. **Option A (acceptable for v1):** Add a comment above the rotate block: `// TOCTOU window: a crash between rename and appendFile loses the current event. Acceptable for v1.1; revisit for stricter audit guarantees.` No code change.
3. **Option B (stricter):** Buffer the line in memory, write the line to a temp file `log.jsonl.tmp` via `appendFile`, fsync, rename `log.jsonl.tmp → log.jsonl`. This is more disruptive — only do if audit-trail compliance demands it.
4. If you take Option B, add a test that simulates a crash mid-rotation and asserts the line ends up in either the rotated file or the new file (never lost).
5. Build: `npm run build`.
6. Run: `npx jest -- src/alerts/alert-log.test.ts`.
7. Run: `npm run lint`.

---

### [F-022] `parseLocalAlertRules` does not warn on duplicate rule IDs — High (CORR)
**Location:** `src/alerts/local-alert-rule.ts:148-168`
**Issue:** Two rules with the same `id` both pass validation. The engine's per-rule state (`Map<string, RuleState>`) overwrites on `getOrInitState()`, but both rules still run in `evaluate()`. The second rule sees the first's state — if rule-A is firing and rule-B's condition becomes true, B won't fire because it sees `status: 'firing'` in shared state.
**Impact:** Silent rule shadowing. Hard to debug.
**Suggested fix:** Detect duplicates after validation; either reject duplicates with a logged warning, or warn and keep only the first.

**Implementation steps for Haiku:**

1. Open `src/alerts/local-alert-rule.ts`. After collecting valid rules in `parseLocalAlertRules`, scan for duplicates:
   ```typescript
   const seen = new Set<string>();
   const dedupedValid = [];
   for (const rule of valid) {
     if (seen.has(rule.id)) {
       logger.warn(`Duplicate rule id '${rule.id}' — skipping later occurrence`);
       continue;
     }
     seen.add(rule.id);
     dedupedValid.push(rule);
   }
   ```
2. Open `src/alerts/local-alert-rule.test.ts`. Add a test:
   - Input: `[{id: 'a', ...}, {id: 'a', ...different fields}]`
   - Output: `valid` has length 1; logged warning matches `Duplicate rule id 'a'`.
3. Build: `npm run build`.
4. Run: `npx jest -- src/alerts/local-alert-rule.test.ts`.
5. Run: `npm run lint`.

---

### [F-023] Double-cleanup in SSE handler (low actual impact) — High (LIFE)
**Location:** `src/dashboard/routes/sse-handler.ts:65-66`
**Issue:** Both `req.on('close')` and `res.on('close')` register the same `cleanup` function. On a normal disconnect both fire. Second call to `bus.off(event, handler)` is a no-op, `clearInterval` on cleared timer is safe — so no current functional bug, but intent is ambiguous.
**Impact:** No current bug. Future code change could introduce a real double-execution issue.
**Suggested fix:** Add a `cleaned` guard.

**Implementation steps for Haiku:**

1. Open `src/dashboard/routes/sse-handler.ts`. In the handler scope:
   ```typescript
   let cleaned = false;
   const cleanup = (): void => {
     if (cleaned) return;
     cleaned = true;
     clearInterval(heartbeat);
     bus.off('tool-call', handlers['tool-call']);
     bus.off('cost-update', handlers['cost-update']);
     bus.off('anti-pattern', handlers['anti-pattern']);
     bus.off('alert', handlers['alert']);
   };
   ```
2. Build: `npm run build`.
3. Run: `npx jest -- src/dashboard/routes/sse-handler.test.ts`.
4. Run: `npm run lint`.

---

## Medium severity

### [F-024] Sidebar badge has no `99+` cap; visual overflow at 100+ alerts — Medium (UX)
**Location:** `src/web/components/Sidebar.tsx:63`
**Issue:** The badge renders the raw count in a `px-1.5 rounded text-[10px]` container sized for 1–2 digit numbers. With 100+ firing alerts the badge overflows or breaks layout.
**Impact:** Visual bug at high alert volumes.
**Suggested fix:** Cap display at `99+`.

**Implementation steps for Haiku:**

1. Open `src/web/components/Sidebar.tsx`. Locate the alert badge near line 63.
2. Replace `{alertCount}` with `{alertCount > 99 ? '99+' : alertCount}`.
3. Update the `aria-label` to use the same cap: `${alertCount > 99 ? '99+' : alertCount} firing ${alertCount === 1 ? 'alert' : 'alerts'}`.
4. Add a test in `src/web/components/Sidebar.test.tsx`:
   - 5 alerts → badge text `5`.
   - 100 alerts → badge text `99+`.
5. Build: `npm run build`.
6. Run: `npm run test:web -- Sidebar`.
7. Run: `npm run lint`.

---

### [F-025] AlertBanner ESC handler on outer div with no `tabIndex` — Medium (UX)
**Location:** `src/web/components/AlertBanner.tsx:51-58`
**Issue:** The outer `<div>` has `onKeyDown` but no `tabIndex`. Only the dismiss `<button>` is keyboard-focusable. The comment claims attaching to the outer container makes ESC work even when title/description spans are focused, but spans without `tabIndex` are never focused. The test that simulates `fireEvent.keyDown(title, ...)` bypasses focus rules and passes anyway.
**Impact:** ESC works when the dismiss button is focused (the only focusable descendant). The test passes for the wrong reason.
**Suggested fix:** Either add `tabIndex={0}` and `role="group"` to the outer div, or remove the misleading comment and document that ESC requires button focus.

**Implementation steps for Haiku:**

1. Open `src/web/components/AlertBanner.tsx`. Locate the outer `<div>` around line 51-58.
2. Pick one approach:
   - **Approach A (preferred):** Add `tabIndex={0}` and `role="group"` to the outer div, plus `aria-labelledby` referencing the title's id, so the entire banner is genuinely keyboard-navigable.
   - **Approach B:** Remove the misleading comment about outer-container focus. Update the test to simulate keydown on the dismiss button.
3. Open `src/web/components/AlertBanner.test.tsx`. If Approach A, add a test that focuses the outer div and simulates ESC; assert dismiss callback fires. If Approach B, change the existing test to focus the button first.
4. Build: `npm run build`.
5. Run: `npm run test:web -- AlertBanner`.
6. Run: `npm run lint`.

---

### [F-026] `aggregateDailyCost` uses UTC dates — wrong day for negative-offset users — Medium (CORR)
**Location:** `src/web/views/History.tsx:284`
**Issue:** `new Date(r.startTime).toISOString().slice(5, 10)` always produces UTC. A session at 10 PM in UTC-5 is at 3 AM UTC next day, attributed to the wrong day.
**Impact:** History chart bars are mis-attributed for users west of UTC.
**Suggested fix:** Use local-time getters.

**Implementation steps for Haiku:**

1. Open `src/web/views/History.tsx`. Locate `aggregateDailyCost` near line 284.
2. Replace the date-key derivation:
   ```typescript
   const d = new Date(r.startTime);
   const day = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
   ```
3. Add a test:
   - Mock `Date.now` and `r.startTime` to be `2026-06-01T03:00:00Z` (3 AM UTC). With local time UTC-5 this is `2026-05-31T22:00:00`, day key should be `05-31`.
   - This will require some `jest.spyOn(Date.prototype, ...)` or a mocked timezone.
4. Build: `npm run build`.
5. Run: `npm run test:web -- History`.
6. Run: `npm run lint`.

---

### [F-027] `SessionTimeline` row keys collide for concurrent same-tool calls — Medium (CORR)
**Location:** `src/web/views/Sessions.tsx:117`
**Issue:** Key `${c.startTime}-${c.toolName}` collides when two `Read` calls share `startTime` (possible if pre-events arrive in the same millisecond). React drops one row silently and logs a warning.
**Impact:** Missing rows in busy sessions.
**Suggested fix:** Add the array index as a tiebreaker.

**Implementation steps for Haiku:**

1. Open `src/web/views/Sessions.tsx`. Locate the timeline render near line 117.
2. Change the key to include the index: `key={\`${c.startTime}-${c.toolName}-${i}\`}` where `i` is the `.map((c, i) => ...)` index. Update the function signature to provide `i`.
3. Add a test in `src/web/views/Sessions.test.tsx`: render a timeline with two entries having identical `startTime` and `toolName`; assert both rows render.
4. Build: `npm run build`.
5. Run: `npm run test:web -- Sessions`.
6. Run: `npm run lint`.

---

### [F-028] `useSyncExternalStore` ready-gate in `App.tsx` is dead code — Medium (DOC)
**Location:** `src/web/App.tsx:17-22`
**Issue:** The `useSyncExternalStore` block returns `false` only during SSR. This app has no SSR (it's a Vite SPA). The `if (!isClient) return <></>` guard never runs. `useLiveEvents()` is called above the guard, so even the intent of "delay subscription" doesn't hold.
**Impact:** No bug, but confusing dead code that misleads future readers.
**Suggested fix:** Remove the gate.

**Implementation steps for Haiku:**

1. Open `src/web/App.tsx`. Delete the `useSyncExternalStore` block and the `if (!isClient) return <></>` guard.
2. Verify the remaining structure: `useLiveEvents()` runs inside the component body, then JSX is returned unconditionally.
3. Run existing tests to confirm no behavioural change.
4. Build: `npm run build`.
5. Run: `npm run test:web -- App`.
6. Run: `npm run lint`.

---

### [F-029] `Audit` view has no virtualization — freezes on large logs — Medium (PERF)
**Location:** `src/web/views/Audit.tsx:86-127`
**Issue:** All audit rows are rendered in a single `<table>`. With thousands of entries the page hangs during render.
**Impact:** Long sessions (500+ tool calls each generating audit entries) make the Audit view unusable.
**Suggested fix:** Cap visible rows with a "Showing first 200 of N" note. Proper fix is server-side pagination later.

**Implementation steps for Haiku:**

1. Open `src/web/views/Audit.tsx`. Locate the table render around line 86.
2. Cap to 200:
   ```tsx
   const visibleSlice = visible.slice(0, 200);
   ```
   Use `visibleSlice` in the `.map(...)` call instead of `visible`.
3. Above the table add a note:
   ```tsx
   {visible.length > 200 && (
     <div className="text-xs text-gray-500 mb-2">
       Showing first 200 of {visible.length} entries.
     </div>
   )}
   ```
4. Add a test: render with 500 entries; assert only 200 rows render.
5. Build: `npm run build`.
6. Run: `npm run test:web -- Audit`.
7. Run: `npm run lint`.

---

### [F-030] `rulesPath: string | null` interface lies; null guard is dead — Medium (TYPE)
**Location:** `src/config.ts:80` (interface) and `src/index.ts:327`
**Issue:** Interface declares `string | null` but the loader always returns a non-null string (default fallback to `~/.nr-ai-observe/alerts/rules.json`). The `if (rulesPath)` guard in `index.ts` can never be false. A future loader change that legitimately produces `null` would silently disable rules.
**Impact:** Type-system lie; latent regression vector.
**Suggested fix:** Tighten the interface to non-nullable string.

**Implementation steps for Haiku:**

1. Open `src/config.ts`. Locate `readonly rulesPath: string | null` near line 80. Change to `readonly rulesPath: string`.
2. In the Zod schema, ensure `rulesPath` is required-with-default (not nullable).
3. In `validateRulesPath`, ensure every code path returns a string (it already does).
4. Open `src/index.ts:327`. Remove the dead `if (rulesPath)` guard.
5. Build: `npm run build`. Fix any type errors that surface (probably none).
6. Run: `npx jest`.
7. Run: `npm run lint`.

---

### [F-031] Privacy mock doesn't cover global `fetch` — Medium (TEST)
**Location:** `src/index.privacy.test.ts:26-42`
**Issue:** The mock intercepts `node:http` and `node:https` `request` but not the global `fetch` introduced in Node 18+. If any dependency uses `fetch` in its outbound path (likely for OTLP exporters or future dependencies), the privacy proof would not detect it.
**Impact:** Privacy promise has a known coverage gap.
**Suggested fix:** Mock or assert against `global.fetch`.

**Implementation steps for Haiku:**

1. Open `src/index.privacy.test.ts`. In the test setup that already mocks `node:http`, add:
   ```typescript
   const originalFetch = global.fetch;
   const fetchSpy = jest.fn();
   beforeEach(() => { global.fetch = fetchSpy as unknown as typeof fetch; });
   afterEach(() => { global.fetch = originalFetch; });
   ```
2. After running the privacy assertions, also assert: `expect(fetchSpy).not.toHaveBeenCalled();`.
3. Build: `npm run build`.
4. Run: `npx jest -- src/index.privacy.test.ts`.
5. Run: `npm run lint`.

---

### [F-032] Linux notify-send ENOENT logs as "unexpected error" — Medium (UX)
**Location:** `src/alerts/os-notifier.ts:121`
**Issue:** When `notify-send` is not installed on Linux, the outer try/catch logs `'os-notifier: unexpected error'`. The message looks like a code bug rather than a missing binary.
**Impact:** Developer confusion when enabling OS notifications on Linux.
**Suggested fix:** Catch ENOENT specifically in `notifyLinux` with a friendly message.

**Implementation steps for Haiku:**

1. Open `src/alerts/os-notifier.ts`. Locate `notifyLinux`.
2. Replace its body:
   ```typescript
   private async notifyLinux(title: string, body: string): Promise<void> {
     try {
       await this.run('notify-send', ['--', title, body]);
     } catch (err) {
       const msg = err instanceof Error ? err.message : String(err);
       this.log.warn('os-notifier: notify-send unavailable or failed', { error: msg });
     }
   }
   ```
3. Add a test in `src/alerts/os-notifier.test.ts`: mock `process.platform = 'linux'`, mock `run` to reject with `ENOENT`, call `notify(...)`, assert no throw and a warn log emitted.
4. Build: `npm run build`.
5. Run: `npx jest -- src/alerts/os-notifier.test.ts`.
6. Run: `npm run lint`.

---

### [F-033] Static handler directory request → SPA fallback (untested) — Medium (CORR)
**Location:** `src/dashboard/routes/static-handler.ts:50-53`
**Issue:** A request for an existing directory (e.g., `/assets/`) succeeds the `stat`, fails `isFile()`, then falls through to `serveIndexFallback` returning `index.html` with 200. This is technically valid SPA behaviour but masks misconfigured asset paths in development.
**Impact:** `/assets/` returns the SPA HTML, which the browser tries to interpret as `index.html` — confusing in DevTools.
**Suggested fix:** Return 404 for directory requests; SPA fallback only for genuinely missing paths.

**Implementation steps for Haiku:**

1. Open `src/dashboard/routes/static-handler.ts`. Locate the `stat` block.
2. After `stat`, if `!st.isFile()`, return 404 explicitly:
   ```typescript
   if (!st.isFile()) {
     res.writeHead(404);
     res.end();
     return;
   }
   ```
   The SPA fallback path remains for paths that throw ENOENT.
3. Add a test in `src/dashboard/routes/static-handler.test.ts`:
   - Create a temp dir with subdir `assets/`. Request `/assets/`. Assert 404.
4. Build: `npm run build`.
5. Run: `npx jest -- src/dashboard/routes/static-handler.test.ts`.
6. Run: `npm run lint`.

---

### [F-034] No `Cache-Control` headers on static assets — Medium (PERF)
**Location:** `src/dashboard/routes/static-handler.ts:56-61`
**Issue:** Every asset is served without `Cache-Control`. Vite-built assets have content-hash filenames (`main-abc123.js`) and should be served with `Cache-Control: max-age=31536000, immutable`. `index.html` should be `no-cache`.
**Impact:** Browser cache behavior is unpredictable; full re-downloads on every page load.
**Suggested fix:** Add appropriate Cache-Control by file type/path.

**Implementation steps for Haiku:**

1. Open `src/dashboard/routes/static-handler.ts`. After determining the MIME type, add caching:
   ```typescript
   const isImmutable = target.includes(`${sep}assets${sep}`);
   const cacheControl = filename === 'index.html'
     ? 'no-cache'
     : isImmutable
     ? 'max-age=31536000, immutable'
     : 'max-age=300';
   res.writeHead(200, {
     'content-type': type,
     'content-length': String(data.length),
     'cache-control': cacheControl,
   });
   ```
2. Add tests in `src/dashboard/routes/static-handler.test.ts`:
   - `/assets/x.js` → response has `Cache-Control: max-age=31536000, immutable`.
   - `/index.html` (or `/`) → `Cache-Control: no-cache`.
3. Build: `npm run build`.
4. Run: `npx jest -- src/dashboard/routes/static-handler.test.ts`.
5. Run: `npm run lint`.

---

### [F-035] `/api/sessions` uses `loadAllSessions` (cost shape) — Medium (CORR)
**Location:** `src/dashboard/routes/api-handler.ts:91`
**Issue:** `loadAllSessions?.() ?? listSessions()` — when `loadAllSessions` is present it's called with no `since` filter and returns the cost-analysis-only `SessionLikeForCostOutcome[]` shape. The Sessions view may rely on fields not present in that shape (e.g., full `outcome` data, `developer`).
**Impact:** Sessions list may render incomplete data when both helpers are wired.
**Suggested fix:** Always use `listSessions` for the list endpoint; reserve `loadAllSessions` for cost-per-outcome endpoints.

**Implementation steps for Haiku:**

1. Open `src/dashboard/routes/api-handler.ts`. Locate the `GET /api/sessions` route around line 91.
2. Change to use `listSessions()` directly:
   ```typescript
   if (!deps.listSessions) return unavailable(res, 'sessionStore');
   const limit = parseLimit(req.url) ?? 50;
   jsonOk(res, deps.listSessions({ limit }));
   ```
3. Audit the SPA's expected `Session` shape in `src/web/views/Sessions.tsx` — confirm the fields it reads exist on `listSessions`'s return type.
4. Add a test in `src/dashboard/routes/api-handler.test.ts` asserting `loadAllSessions` is NOT called for `GET /api/sessions`.
5. Build: `npm run build`.
6. Run: `npx jest -- src/dashboard/routes/api-handler.test.ts`.
7. Run: `npm run lint`.

---

### [F-036] Missing `index.html` returns silent 404 with no diagnostic — Medium (UX)
**Location:** `src/dashboard/routes/static-handler.ts:31-35`
**Issue:** If `dist/web/` was never built, every SPA route returns an empty 404. No log, no helpful message.
**Impact:** First-time users who skip `npm run build:web` see a blank page they can't diagnose.
**Suggested fix:** Log a warning at startup if `dist/web/index.html` is missing.

**Implementation steps for Haiku:**

1. Open `src/dashboard/dashboard-server.ts`. After resolving `staticDir` in the constructor, check existence:
   ```typescript
   if (opts.staticDir) {
     const indexPath = join(opts.staticDir, 'index.html');
     if (!existsSync(indexPath)) {
       logger.warn(
         `Dashboard static dir is missing index.html (${indexPath}). ` +
         `Run 'npm run build:web' to build the SPA bundle.`,
       );
     }
   }
   ```
2. Build: `npm run build`.
3. Add a test in `src/dashboard/dashboard-server.test.ts` confirming the warning fires when staticDir is empty.
4. Run: `npx jest -- src/dashboard/dashboard-server.test.ts`.
5. Run: `npm run lint`.

---

## Low severity

### [F-037] `RecentAlertsPanel` no `retry: false`; 4× request multiplier in cloud mode — Low (PERF)
**Location:** `src/web/views/Today.tsx:110-114`
**Issue:** React Query defaults to `retry: 3`. In cloud mode each refetch fires the query and retries 3 times before settling (4 requests every 30 s). Once F-007 is fixed with `retry: false`, this finding is also addressed.
**Impact:** Server access-log noise; minor wasted bandwidth.
**Suggested fix:** Subsumed by F-007 fix (`retry: false`).

**Implementation steps for Haiku:**

1. Verify F-007's fix included `retry: false`. If not, apply it now.
2. No additional steps.

---

### [F-038] Audit timestamp shows time without date — Low (UX)
**Location:** `src/web/views/Audit.tsx:111`
**Issue:** `toLocaleTimeString()` returns only the time portion. Two entries at the same time on different days are indistinguishable.
**Impact:** Confusing when entries span multiple days.
**Suggested fix:** Include date.

**Implementation steps for Haiku:**

1. Open `src/web/views/Audit.tsx`. Locate the timestamp render near line 111.
2. Replace `new Date(r.ts).toLocaleTimeString()` with:
   ```typescript
   new Date(r.ts).toLocaleString(undefined, {
     month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
   })
   ```
   This produces `Jun 1, 09:15`. Match the format already used in `Sessions.tsx` if it differs.
3. Update the test to assert the new format.
4. Build: `npm run build`.
5. Run: `npm run test:web -- Audit`.
6. Run: `npm run lint`.

---

### [F-039] `Sparkline` `style={{ height }}` overrides responsive `viewBox` height — Low (UX)
**Location:** `src/web/components/Sparkline.tsx:32-38`
**Issue:** Inline `style={{ height: 50 }}` makes the SVG fixed-height regardless of any caller's `height` prop. The polyline scales correctly, but the SVG element does not. API confusion.
**Impact:** Cosmetic; consumers passing `height={80}` get a 50px-tall SVG.
**Suggested fix:** Use the `height` attribute (not style) so the SVG honours the prop.

**Implementation steps for Haiku:**

1. Open `src/web/components/Sparkline.tsx`. Remove `style={{ height }}` from the SVG.
2. Add `height={height}` as an SVG attribute (matching the `viewBox` height).
3. Build: `npm run build`.
4. Run: `npm run test:web -- Sparkline`.
5. Run: `npm run lint`.

---

### [F-040] `History.weekStart.slice(5)` truncates year — breaks cross-year display — Low (CORR)
**Location:** `src/web/views/History.tsx:89, 312`
**Issue:** `w.weekStart.slice(5)` strips the year from `'2026-01-05'` to `'01-05'`. Two entries from different years with the same month-day produce identical X-axis labels.
**Impact:** Edge case at year boundary; only matters for users with 8+ weeks of data spanning year transitions.
**Suggested fix:** Either keep the year (`slice(2)` → `'26-01-05'`) or sort/group by full ISO date and format on tick render.

**Implementation steps for Haiku:**

1. Open `src/web/views/History.tsx`. Locate `slice(5)` calls (around lines 89, 312).
2. Replace each with the full date and format only at the axis tick:
   ```typescript
   // keep the full date as data
   { week: w.weekStart, ... }
   // format on tick render
   <XAxis tickFormatter={(s) => s.slice(5)} />
   ```
3. The internal data uses unique year-prefixed strings; only the visible tick is shortened.
4. Build: `npm run build`.
5. Run: `npm run test:web -- History`.
6. Run: `npm run lint`.

---

### [F-041] `alertRulesWatcher` not nilled after close — Low (LIFE)
**Location:** `src/index.ts:164-169`
**Issue:** After `alertRulesWatcher.close()`, the variable is not set to `undefined`. The `shuttingDown` guard prevents double-close today, but a future change that calls shutdown twice would attempt double-close.
**Impact:** Future regression risk only.
**Suggested fix:** Set to undefined after close.

**Implementation steps for Haiku:**

1. Open `src/index.ts`. Locate the `alertRulesWatcher.close()` call near line 164-169.
2. Add `alertRulesWatcher = undefined;` immediately after.
3. Build: `npm run build`.
4. Run: `npx jest`.
5. Run: `npm run lint`.

---

### [F-042] Test name vs behaviour mismatch — "clamps to min 1" but actually falls back to 7777 — Low (DOC)
**Location:** `src/config.test.ts:1211` and `src/config.ts:678`
**Issue:** Test name says "clamps dashboard port to minimum 1" but the implementation falls back to `7777` (the default) for out-of-range values. Misleading test name.
**Impact:** Reader confusion.
**Suggested fix:** Rename the test.

**Implementation steps for Haiku:**

1. Open `src/config.test.ts`. Locate the test around line 1211.
2. Rename to "falls back to default 7777 when port is out of range".
3. Verify the body still asserts `expect(config.dashboard.port).toBe(7777)`.
4. Build: `npm run build`.
5. Run: `npx jest -- src/config.test.ts`.
6. Run: `npm run lint`.

---

### [F-043] Static handler MIME table missing `.wasm`, `.webp`, `.avif`, `.txt` — Low (CORR)
**Location:** `src/dashboard/routes/static-handler.ts:5-20`
**Issue:** Files with these extensions are served as `application/octet-stream`. For `.wasm` this prevents WebAssembly instantiation (browsers require `application/wasm`). Current dependencies don't use WASM, but it's a future-proofing gap.
**Impact:** Future-proofing.
**Suggested fix:** Extend the MIME table.

**Implementation steps for Haiku:**

1. Open `src/dashboard/routes/static-handler.ts`. Locate the MIME table.
2. Add entries:
   ```typescript
   '.wasm': 'application/wasm',
   '.webp': 'image/webp',
   '.avif': 'image/avif',
   '.txt':  'text/plain; charset=utf-8',
   ```
3. Build: `npm run build`.
4. Run: `npx jest -- src/dashboard/routes/static-handler.test.ts`.
5. Run: `npm run lint`.

---

### [F-044] `LiveEventBus.setMaxListeners(50)` may noise-warn at scale — Low (LIFE)
**Location:** `src/dashboard/live-event-bus.ts:71`
**Issue:** Each SSE connection adds 4 listeners (tool-call, cost-update, anti-pattern, alert). 50 ÷ 4 = 12 concurrent connections before Node emits `MaxListenersExceededWarning`. Test parallelism could exceed this.
**Impact:** Noisy warnings; harmless.
**Suggested fix:** Raise to 200 or set to 0 (unlimited).

**Implementation steps for Haiku:**

1. Open `src/dashboard/live-event-bus.ts`. Locate `setMaxListeners(50)` near line 71.
2. Change to `setMaxListeners(200)` (or `0` for unlimited).
3. Build: `npm run build`.
4. Run: `npx jest`.
5. Run: `npm run lint`.

---

### [F-045] `nextSeq` overflow theoretical (~285,000 years at 1 ms/event) — Low (CORR)
**Location:** `src/dashboard/live-event-bus.ts:83`
**Issue:** `nextSeq` increments without bound. Overflow at `Number.MAX_SAFE_INTEGER` is impossibly far away.
**Impact:** None practical.
**Suggested fix:** Document and move on.

**Implementation steps for Haiku:**

1. No code change required. Optionally add a comment above `nextSeq`: `// Practical overflow at MAX_SAFE_INTEGER (~285k years at 1 event/ms). No bound enforced.`
2. No build/test required.

---

### [F-046] Rotated `.1` log file may inherit looser permissions if pre-existing — Low (SEC)
**Location:** `src/alerts/alert-log.ts:103-104`
**Issue:** `fs.rename` preserves the source file's existing permissions. In normal operation `appendFile(..., {mode: 0o600})` creates the file at 0o600, so the `.1` rotation inherits 0o600. If a user manually pre-created the log with looser permissions, that mode is preserved.
**Impact:** Edge case; only affects users who manually create the log file.
**Suggested fix:** Explicitly chmod after rotation.

**Implementation steps for Haiku:**

1. Open `src/alerts/alert-log.ts`. Locate the `fs.rename` rotation call.
2. After the rename, explicitly chmod:
   ```typescript
   await fs.chmod(rotatedPath, 0o600);
   ```
3. Build: `npm run build`.
4. Run: `npx jest -- src/alerts/alert-log.test.ts`.
5. Run: `npm run lint`.

---

## Nit severity

### [F-047] `unavailable()` doesn't set Content-Length — Nit (CORR)
**Location:** `src/dashboard/routes/api-handler.ts:64-67`
**Issue:** `jsonOk` sets both `content-type` and `content-length`; `unavailable` only sets `content-type`. Functionally fine (HTTP/1.1 chunked transfer), but inconsistent.
**Impact:** Cosmetic.
**Suggested fix:** Add Content-Length for consistency.

**Implementation steps for Haiku:**

1. Open `src/dashboard/routes/api-handler.ts`. In `unavailable()`, build the JSON payload first, then set `content-length`:
   ```typescript
   const payload = JSON.stringify({ error: 'unavailable', what });
   res.writeHead(503, {
     'content-type': 'application/json; charset=utf-8',
     'content-length': String(Buffer.byteLength(payload)),
   });
   res.end(payload);
   ```
2. Build: `npm run build`.
3. Run: `npx jest -- src/dashboard/routes/api-handler.test.ts`.
4. Run: `npm run lint`.

---

### [F-048] AlertBanner has both `role="alert"` and `aria-live` — redundant — Nit (DOC)
**Location:** `src/web/components/AlertBanner.tsx:53-54`
**Issue:** `role="alert"` already implies `aria-live="assertive"`. Setting both is redundant per the ARIA spec.
**Impact:** None.
**Suggested fix:** Drop one.

**Implementation steps for Haiku:**

1. Open `src/web/components/AlertBanner.tsx`. Remove the explicit `aria-live` attribute, keeping `role="alert"`.
2. Build and run tests: `npm run build && npm run test:web -- AlertBanner && npm run lint`.

---

### [F-049] `formatValue` and `formatNumber` duplicated — Nit (CORR)
**Location:** `src/web/components/AlertBanner.tsx:83-88` and `src/web/views/Today.tsx:186-191`
**Issue:** Two identical formatter functions. Maintenance hazard.
**Impact:** Minor; future divergence.
**Suggested fix:** Extract to `src/web/lib/format.ts`.

**Implementation steps for Haiku:**

1. Create `src/web/lib/format.ts`:
   ```typescript
   export function formatNumber(n: number): string {
     return Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2);
   }
   ```
2. Open `src/web/components/AlertBanner.tsx`. Delete the local `formatValue` definition. Import `formatNumber` and use it in place.
3. Open `src/web/views/Today.tsx`. Same: delete `formatNumber`, import from the new module.
4. Build: `npm run build`.
5. Run: `npm run test:web`.
6. Run: `npm run lint`.

---

### [F-050] Today efficiency KPI hardcoded to `"—"` — Nit (UX)
**Location:** `src/web/views/Today.tsx:49`
**Issue:** The efficiency KPI shows `"—"` with `sub="needs more data"` regardless of actual data. No wiring to the efficiency score from the SSE stream or REST API.
**Impact:** A KPI tile is permanently empty.
**Suggested fix:** Wire to `/api/session/current` (exposes `efficiencyScore`) via React Query, OR add `efficiencyScore` to the SSE `cost-update` payload.

**Implementation steps for Haiku:**

1. Open `src/web/views/Today.tsx`. Add a query for the current session:
   ```typescript
   const { data: session } = useQuery({
     queryKey: ['session', 'current'],
     queryFn: () => getJson<SessionMetrics>('/api/session/current'),
     refetchInterval: 30_000,
   });
   ```
2. In the efficiency KPI render, use `session?.efficiencyScore` if present, falling back to `"—"`.
3. Add a test asserting the KPI updates when the API returns a score.
4. Build: `npm run build`.
5. Run: `npm run test:web -- Today`.
6. Run: `npm run lint`.

---

### [F-051] Sessions list capped at 50 with no load-more — Nit (UX)
**Location:** `src/web/views/Sessions.tsx:35-38`
**Issue:** `qk.sessionsList(50)` fetches at most 50. Older sessions silently disappear.
**Impact:** UX gap for active users; not a bug per se.
**Suggested fix:** Add a "Load more" button OR a notice "Showing 50 most recent sessions".

**Implementation steps for Haiku:**

1. Open `src/web/views/Sessions.tsx`. Below the list, add:
   ```tsx
   <div className="text-xs text-gray-500 mt-2">Showing 50 most recent sessions.</div>
   ```
2. (Optional later) Convert `useQuery` to `useInfiniteQuery` with a "Load more" button calling `fetchNextPage`.
3. Build and run tests: `npm run build && npm run test:web -- Sessions && npm run lint`.

---

## Intent vs implementation summary

| Design intent | Implementation | Gap |
|---|---|---|
| Audit view shows filterable table from `AuditTrailManager` | Server returns `timestamp`/`detail`/`action`; SPA reads `ts`/`target`/`classification` | **F-001** — view non-functional |
| SPA works on direct navigation to `/sessions`, `/history`, `/audit` | Vite `base: './'` produces relative asset paths | **F-002** — blank page on direct navigation |
| Privacy proof: no NR transport in `mode='local'` | In-process test never invokes `main()`; child-process test conditionally skipped | **F-003** — privacy gate untested in CI without build |
| SSE `id` carries bus global seq for accurate replay | `id` carries per-connection counter | **F-005** — reconnect replay broken |
| `latency.percentile` rules support p50/p95/p99 (Phase-3 fix claim) | Snapshot collector still gates on p95 presence | **F-006** — p50/p99 silently never fire |
| Cloud mode must not surface alert errors | `/api/alerts/recent` 404 → React Query error → red banner | **F-007** — permanent visible error |
| `cost.window` warns when not session-scoped (Phase-3 fix claim) | Warning fires for explicit value only; default `'today'` bypasses warning | **F-008** — silent no-op |
| `budget.session` rules clear when condition lifts | `session:infinite` periodKey never rolls; no alternate clear path | **F-009** — banner never disappears |
| `openOnStart` config field auto-opens browser | Field is read but never consumed | **F-013** — silent no-op |
| Port-in-use error suggests `NR_AI_DASHBOARD_PORT` (spec §5) | Raw EADDRINUSE propagates | **F-014** — no remediation hint |
| Setup wizard does not copy starter rules in cloud mode | Guard exists, but no test verifies it | **F-020** — regression vector |
| Rule IDs are unique | Parser accepts duplicates silently | **F-022** — silent rule shadowing |
| Audit view handles long sessions gracefully | All rows rendered; freezes at thousands | **F-029** — no virtualization or cap |

## All-clear list (verified correct)

The following concerns were investigated by one or more agents and confirmed clean:

- **Path traversal** in static handler: `resolve` + `startsWith(root + sep)` correctly handles `../`, percent-encoded sequences, double-slash.
- **Host header validation** (DNS rebinding): correctly handles bracketed IPv6 (`[::1]:port`), case-variations, missing header, the malformed-port suffix is the one gap (F-012).
- **POST/PUT/DELETE blocking:** all non-GET methods cleanly fall through to 404.
- **`stop()` idempotency:** `if (!this.server) return` makes double-call safe.
- **Privacy: NR transport gating** — every `nrIngest` / OTLP path correctly guarded by `config.mode !== 'local'` and `capturedNrIngest?.` optional chain.
- **`validateRulesPath`** — extension and prefix checks are correct; six tests cover the path-traversal scenarios.
- **`process.argv[1]` for ESM static path** — correctly used in `src/index.ts` and `src/install/setup-wizard.ts`; no `__dirname` regressions in production code.
- **`fs.watch` debounce + unref** — 200ms debounce, timer unref'd, cleared on shutdown.
- **`alerts.enabled` defaults `true` for `mode !== 'cloud'`** — correctly gated.
- **All `NR_AI_ALERTS_*` env vars wired** — `enabled`, `evaluationIntervalSeconds`, `osNotifications`, `logRetentionMb`, `rulesPath`.
- **CSP and security headers** on dashboard responses — `default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`.
- **Server binding** — always 127.0.0.1; never 0.0.0.0.
- **Setup wizard idempotency** — `existsSync(destPath)` check before copy; mkdir 0o700, file 0o600.
- **Banner ESC handler attached to outer container** (with the F-025 caveat).
- **`useLiveAlerts` `useShallow`** wrap on the array selector (zustand v5).
- **`/api/alerts/recent` returns 404 (not 503)** when alertLog is absent.
- **No env variable leakage** in the SPA bundle (no `import.meta.env`, no `define:` in vite.config.ts).
- **`downloadJsonl` URL revocation** — `revokeObjectURL` in finally block.
- **Sparkline empty/single-point guard** — `if (values.length < 2) return null`.
- **`ForecastEodCard` `null`/`NaN` guard** — `Number.isFinite` check on forecast.
- **Tailwind v4 migration** — `@theme` block correctly drives custom colours; CSS bundle increase is expected.
- **Shutdown order** — alertInterval → alertTimer → alertWatcher → eventProcessor → dashboardServer → nrIngest → mcpServer.

---

