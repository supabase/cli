# 0013. Live E2E Tests Bypass the Replay Server

**Status**: accepted
**Date**: 2026-06-16

## Problem Statement

The CLI has no true end-to-end tests. `apps/cli-e2e` is a replay/record harness:
in **replay** mode it serves recorded HTTP fixtures (fast, deterministic, no
network); in **record** mode it proxies the CLI's Management API and Docker
traffic to staging only to *capture* those fixtures. Tests always assert against
replayed fixtures, never live responses. Behaviour that cannot be mocked — real
Management API calls and the real Docker bundler (e.g. `functions deploy`) — is
therefore untested.

[CLI-1630](https://linear.app/supabase/issue/CLI-1630/set-up-proper-live-e2e-tests-for-the-cli)
adds a structured Vitest **live** suite that runs the real CLI against a real
backend (staging today, the dockerized `supabox` stack later) as a non-blocking
smoke test before a stable deploy.

The open architectural question was *how* live mode should reach the backend.
The first instinct was to add a third runtime mode inside `replay-server.ts`
alongside `replay` and `record` — taking record mode's passthrough path
(CLI → replay server → real API) but skipping fixture I/O. That keeps the
existing Docker and storage proxies "for free."

## Decision

Live mode **does not route through the replay server**. It is a harness-wiring
mode, not a `replay-server.ts` branch.

- Live tests reuse `createHarness`/`exec` from `@supabase/cli-test-helpers`, but
  the harness is wired **directly**: `apiUrl = CLI_E2E_API_URL` (the real
  Management API) and `DOCKER_HOST` points at the **real Docker socket**.
- `replay-server.ts` is untouched — no `live` branch, no live Docker or storage
  proxy.
- Assertions are **outcome-based**, modeled on the manual deploy playbook:
  1. run the real CLI (`run([...])`) and assert `exitCode` / `stdout`;
  2. **invoke the deployed function over HTTP directly** and assert HTTP status +
     the JSON body the function itself returns (e.g. `{case, ok:true}`).
  The invoke is a direct HTTP call to `https://{ref}.{CLI_E2E_PROJECT_HOST}/functions/v1`,
  not a proxied call — the replay server is nowhere in the assertion path.
- Because the assertion target is the function's own deterministic response (plus
  exit codes / stdout substrings), the suite is **ID-agnostic** — no response
  normalization or snapshot machinery by default. The function invoke URL and
  anon key are resolved at setup from the freshly created project (anon key via
  `GET /v1/projects/{ref}/api-keys`).

The CLI target is a CI **matrix axis** (`CLI_HARNESS_TARGET`): each target runs
as its own job with `fail-fast: false`, so each implementation is independently
green/red. The pilot covers `go` (raw Go binary) and `ts-legacy` (the TS rewrite
that shells out to Go for most commands and runs native TS logic for ported
ones); `ts-next` is a later axis.

## Rationale

For the assertions live mode actually makes, intercepting the Management API buys
nothing — nothing inspects a proxied API body. The only thing the replay server
would do in live mode for `functions deploy` is relay Docker traffic
(CLI → relay → real socket) through its streaming/idle-timeout proxy. That
streaming relay is the most complex, most failure-prone code path in the harness,
and it would sit in front of the slowest, flakiest real operation (image pull +
bundle) for zero assertion benefit. Pointing `DOCKER_HOST` at the real socket
removes that failure surface entirely.

Keeping `replay-server.ts` out of the live path also means live and record modes
stay decoupled: record mode's destructive fixture-tree rewrite, scenario logging,
and placeholder normalization never have to grow `isLive` guards, and a future
reader is not left wondering why a "transparent proxy" mode exists that records
nothing.

The storage proxy (the other "free" proxy) is not exercised by the
`functions deploy` pilot, so it is not a reason to keep the server in front. If a
later live command genuinely needs host rewriting (e.g. storage on a different
host than the Management API), a scoped passthrough can be introduced *then* for
that command — YAGNI until a concrete need exists.

The per-target matrix exists because `go` and `ts-legacy` are different code
paths reaching the same backend; running them as separate jobs gives two
independent green signals instead of one averaged result.

## Consequences

### Positive

- The live path has fewer moving parts: no proxy, no streaming relay, no fixture
  guards. The Docker bundler talks to the real daemon as users' machines do.
- `replay-server.ts` and the replay/record contract are unchanged, so the
  PR-blocking `e2e` suite is unaffected.
- Tests are trivial to add: drop a `deploy-e2e-foo` fixture function returning a
  known body, add one `testLive` that runs deploy → invoke → asserts body.
- Retargeting from staging to `supabox` is genuinely an env swap
  (`CLI_E2E_TARGET_ENV` + `CLI_E2E_API_URL` + `CLI_E2E_PROJECT_HOST` + token),
  because assertions key off function output, not hostnames.

### Negative

- Live mode requires a working Docker daemon on the runner (enforced by a
  `docker info` preflight) — unlike the replay suite, which served Docker
  fixtures and needed no daemon.
- Each live run provisions and tears down a real staging project, so the suite is
  inherently slower and subject to provisioning flake. Mitigated by a CI-level
  re-run (up to 3×) rather than in-setup retry.
- A second wiring path now exists for the same harness (replay-via-server vs
  live-direct); contributors must know which mode wires the CLI how.

## Alternatives Considered

1. **Third `live` branch inside `replay-server.ts`** (the initial plan): rejected.
   It adds `isLive` guards throughout record-mode code, keeps the fragile Docker
   stream relay in the hot path for no assertion benefit, and couples live mode to
   machinery it does not use.
2. **Snapshot/normalization-first assertions**: rejected as the default. Outcome
   assertions on function bodies are naturally ID-agnostic; a scoped normalizer is
   added only if a future case makes CLI diagnostic output itself the assertion
   target.
3. **Single CLI target**: rejected. `go` and `ts-legacy` are distinct
   implementations of the same commands; one job would hide a regression in
   whichever target was not chosen.
4. **One shared long-lived staging project**: rejected. State would leak between
   runs and overlapping runs would collide; ephemeral per-job projects with
   scoped teardown keep runs isolated.

## Related Decisions

- [ADR 0012](0012-compiled-bun-runtime-dispatch.md): Compiled Bun Runtime Dispatch
  (the next CLI e2e harness runs against the compiled binary)
- [ADR 0011](0011-cli-release-and-distribution-strategy.md): CLI Release & Distribution Strategy

## See Also

- [cli-e2e harness](../../apps/cli-e2e/AGENTS.md)
