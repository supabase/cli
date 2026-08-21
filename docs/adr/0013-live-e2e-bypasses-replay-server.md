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
adds a structured Vitest **live** suite under `apps/cli` that runs the real CLI
against a real backend (managed staging or an attached Supabox/local stack) as
a non-blocking smoke test before a stable deploy.

The open architectural question was *how* live mode should reach the backend.
The first instinct was to add a third runtime mode inside `replay-server.ts`
alongside `replay` and `record` — taking record mode's passthrough path
(CLI → replay server → real API) but skipping fixture I/O. That keeps the
existing Docker and storage proxies "for free."

## Decision

Live mode **does not route through the replay server**. It is a harness-wiring
mode, not a `replay-server.ts` branch.

- Live tests are collocated with their command under `apps/cli/src/**` as
  `*.live.test.ts` files and use `runSupabaseLive`, which wires the CLI directly
  to the selected `SUPABASE_PROFILE` and real Docker socket.
- Global setup provisions one shared environment per Vitest run. Attached mode
  (the default) probes the existing Supabox/local platform and never mutates or
  deletes its project. Explicit managed mode (`SUPABASE_LIVE_MODE=managed`)
  provisions one uniquely named staging project, shares it across tests, and
  deletes exactly that project during teardown unless explicitly kept.
- `replay-server.ts` is untouched — no `live` branch, no live Docker or storage
  proxy.
- Assertions are **outcome-based**, modeled on the manual deploy playbook:
  1. run the real CLI (`run([...])`) and assert `exitCode` / `stdout`;
  2. **invoke the deployed function over HTTP directly** and assert HTTP status +
     the JSON body the function itself returns (e.g. `{case, ok:true}`).
  The invoke is a direct HTTP call to `https://{ref}.{SUPABASE_LIVE_PROJECT_HOST}/functions/v1`,
  not a proxied call — the replay server is nowhere in the assertion path.
- Because the assertion target is the function's own deterministic response (plus
  exit codes / stdout substrings), the suite is **ID-agnostic** — no response
  normalization or snapshot machinery by default. The function invoke URL and
  anon key are resolved at setup from the freshly created project (anon key via
  `GET /v1/projects/{ref}/api-keys`).

The live CI currently targets the shipped `ts-legacy` shell. A live file asserts
one command's golden path; setup and teardown may invoke other commands without
asserting them. This keeps cross-command scenarios for a later phase while the
suite grows toward one representative live test per command.

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

The attached/managed environment contract keeps local Supabox and staging
runs interchangeable: switch `SUPABASE_PROFILE` and the `SUPABASE_LIVE_*`
values without changing test code.

## Consequences

### Positive

- The live path has fewer moving parts: no proxy, no streaming relay, no fixture
  guards. The Docker bundler talks to the real daemon as users' machines do.
- `replay-server.ts` and the replay/record contract are unchanged, so the
  PR-blocking `e2e` suite is unaffected.
- Tests are trivial to add: colocate one `*.live.test.ts` next to the command,
  prepare any state with unasserted setup commands, then assert the target
  command's real outcome.
- Retargeting from staging to Supabox/local is an environment swap
  (`SUPABASE_PROFILE` + `SUPABASE_LIVE_API_URL` + `SUPABASE_LIVE_PROJECT_HOST`
  + token), because assertions key off behavior, not hostnames.

### Negative

- Live mode requires a working Docker daemon on the runner (enforced by a
  `docker info` preflight) — unlike the replay suite, which served Docker
  fixtures and needed no daemon.
- Explicit managed runs provision and tear down one real staging project, so those
  runs are inherently slower and subject to provisioning flake. The default attached
  mode uses the caller-provided Supabox/local project; global setup never deletes it.
  Managed provisioning is mitigated by a CI-level re-run (up to 3×) rather than
  in-setup retry.
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
3. **Keep live tests in `apps/cli-e2e`**: rejected. The replay/record harness and
   its fixtures stay isolated there, while command live tests belong with the
   command implementation and share the CLI package's global setup.
4. **One shared long-lived staging project**: rejected. State would leak between
   runs and overlapping runs would collide; managed mode owns one project per
   run with scoped teardown, while attached mode leaves the caller's project
   untouched.

## Related Decisions

- [Compiled Bun self-dispatch](../../packages/process-compose/docs/architecture.md#compiled-bun-self-dispatch):
  the next CLI e2e harness runs against the compiled binary and therefore exercises its process
  re-entry contract
- [ADR 0011](0011-cli-release-and-distribution-strategy.md): CLI Release & Distribution Strategy

## See Also

- [CLI live-test guidance](../../apps/cli/AGENTS.md)
- [Live environment example](../../apps/cli/live.env.example)
- [Replay/record harness](../../apps/cli-e2e/AGENTS.md)
