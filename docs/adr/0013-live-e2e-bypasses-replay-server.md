# 0013. Live E2E Tests Bypass the Replay Server

**Status**: accepted
**Date**: 2026-06-16

## Problem

`apps/cli-e2e` is a replay/record harness. Replay tests use recorded HTTP and
Docker fixtures, so they do not exercise a real Management API, project data
plane, or Docker bundler. The CLI needs a small, non-blocking golden-path suite
that crosses those boundaries for real.

## Decision

Live tests are collocated under `apps/cli` as `*.live.test.ts` and run directly
against a configured platform URL. They never route through the replay server.

Local Docker-stack lifecycle tests are ordinary `*.e2e.test.ts` tests. They use
the existing e2e global setup and registered-stack cleanup and do not require a
platform token. A live test means the command under assertion reaches the
Management API, its provisioned project, or that project's data plane. Docker
is a runner prerequisite, including for live `functions deploy`; there is no
Docker-specific live fixture.

The live global setup requires `SUPABASE_LIVE_API_URL` and
`SUPABASE_ACCESS_TOKEN`, then:

1. Creates one uniquely named disposable project through the typed Effect
   `@supabase/api` client pointed at the configured URL.
2. Waits for `ACTIVE_HEALTHY`, resolves API keys and pooler connection details,
   creates a storage bucket, and derives the project host from the returned
   database host.
3. Writes a temporary YAML profile containing the same API URL and project
   host, and injects it into every CLI subprocess in the serial suite.
4. Deletes exactly that project and the temporary profile during teardown.

`SUPABASE_LIVE_KEEP_PROJECT=1` skips project deletion for debugging but never
skips temporary profile cleanup. Provisioning failure attempts cleanup of the
exact project it created.

All three supported targets—Supabox, a Docker-hosted API platform, and staging—
implement the same HTTP API contract. Retargeting a run only changes
`SUPABASE_LIVE_API_URL` and its access token. The live workflow keeps a Docker
preflight, one serial attempt, a 20-minute bound, and a scoped leftover-project
sweeper.

## Consequences

The live path has no fixture proxy, host-rewrite layer, attached/managed mode,
ambient profile, project-ref gate, or capability-specific skip wrapper. The
single extended Vitest fixture is imported as `test` from
`apps/cli/tests/helpers/live.ts`; its context exposes `cli`, `project`, and an
isolated workspace. Setup and teardown may invoke other commands, but each
assertion stays focused on one command.

Replay/record behavior and fixtures in `apps/cli-e2e` remain unchanged.
