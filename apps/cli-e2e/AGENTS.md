# cli-e2e

End-to-end test suite for the Supabase CLI, using a local replay/record server to make tests deterministic without hitting staging every time.

## How the replay server works

The relay server (`src/server/replay-server.ts`) has two modes controlled by `RECORD=true`:

**Replay mode** (default, no env vars needed): serves pre-recorded fixtures from `fixtures/`. Every test runs against these fixtures — fast, deterministic, no network.

**Record mode** (`RECORD=true SUPABASE_ACCESS_TOKEN=... SUPABASE_STAGING_URL=...`): proxies every CLI request to the real staging API, records the response, and writes fixture files. Run this when adding new tests or when staging behaviour changes.

### Scenario fixtures vs. recorded fixtures

There are two fixture stores:

| Store             | Path                                          | Used by         | When served                                                |
| ----------------- | --------------------------------------------- | --------------- | ---------------------------------------------------------- |
| Scenario fixtures | `fixtures/scenarios/<slug>/interactions.json` | `testBehaviour` | When a named scenario is active (ordered, strict sequence) |
| Recorded fixtures | `fixtures/recorded/<KEY>/`                    | `testParity`    | Fallback when no scenario is active (sequential queue)     |

`testBehaviour` loads a scenario before each test via `POST /_ctrl/scenario`. The scenario fixture is an ordered list of request/response pairs consumed exactly in order — any mismatch returns a 400. This is the primary fixture mechanism.

`testParity` does not load a scenario. It uses the fallback `serveFromFixtures` path, which reads from `fixtures/recorded/`. Multiple calls to the same endpoint are served from `default.request.json`, then `2.request.json`, `3.request.json`, etc. in order.

### Why `fixtures/recorded/` has numbered files

Every time an API endpoint is called during a recording session, it writes a file:

- 1st call → `default.request.json` / `default.response.json`
- 2nd call → `2.request.json` / `2.response.json`
- etc.

The directory is **cleared on the first call** to each endpoint per session, so re-recording always produces a clean set. Files do not accumulate across runs. The numbered sequence is necessary so parity tests (which call the same endpoint twice — once per CLI target) each get their own fixture entry.

Each endpoint is capped at `MAX_FIXTURE_ENTRIES` (5) — the matcher wraps with
`entries[index % entries.length]`, so additional entries past the cap add bytes
without adding coverage. Polling loops therefore self-truncate.

## Recording hygiene

Recording is destructive. `RECORD=true` wipes both `fixtures/recorded/` and
`fixtures/scenarios/` before any traffic is captured, then repopulates only what
the running tests exercise. The implications:

- A recording run **must exercise every test that should have a fixture**. Don't
  skip tests when recording — anything not run loses its fixtures.
- `test.todo` tests have no scenario file. Either turn the test into a real
  `testBehaviour` before recording, or accept that no fixture is produced.
- Container/image SHAs in URL paths are normalized to `<CONTAINER_ID>` so each
  Docker container does not produce its own fixture directory. If you see
  recording produce many sha-named directories, the normalization rule in
  `placeholder.ts:normalizeUrlPath` is probably stale.
- The `fixture-guard` CI job fails any PR that adds more than 250 files under
  `apps/cli-e2e/fixtures/`. If you trip it, the recorder almost certainly
  captured polling traffic or per-resource interactions that should be
  collapsed via a placeholder.

## Writing tests

### `testBehaviour` — the default for all success and error tests

```typescript
import { testBehaviour } from "./test-context.ts";

testBehaviour("does the thing", async ({ run, projectRef, orgId, apiUrl, workspace }) => {
  const result = await run(["command", "--project-ref", projectRef]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Expected output");
});
```

The `workspace` fixture is what triggers scenario setup — if you destructure `workspace` or `run` (which depends on `workspace`), the scenario is automatically started before the test and cleaned up after.

Available fixtures:

- `run(cmd)` — executes the CLI via the relay server
- `projectRef` — 20-char project ref (real in record mode, default in replay)
- `orgId` — org slug (real in record mode, default in replay)
- `apiUrl` — the relay server base URL, for direct `/_ctrl/` calls
- `workspace` — temp dir, auto-disposed after the test

### `testParity` — verify Go CLI and TS-legacy CLI produce identical output

```typescript
import { testParity } from "./test-context.ts";

testParity(["command", "--flag", PROJECT_REF]);
testParity(["command", "--flag", PROJECT_REF], { failureType: "NON_AUTH" });
```

Always skipped in record mode. Uses `PROJECT_REF` (not `projectRef` from context) because it's static and uses the recorded fallback fixture, not a scenario.

### Error injection tests

Inject errors via `/_ctrl/error-all` before the `run` call:

```typescript
testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
  await fetch(`${apiUrl}/_ctrl/error-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
  });
  const result = await run(["command", "--project-ref", PROJECT_REF]);
  expect(result.exitCode).not.toBe(0);
});
```

Error injection tests can use `PROJECT_REF` directly (not `projectRef`) because no real API call reaches staging — the error is injected before the relay server checks the fixture. Their scenario fixture is always `[]` (empty).

### Tests that can't reliably record

If a test depends on timing (e.g. deleting a project that was just created won't work because it's not yet provisioned), use `skipIf(isRecording)` and write a static fixture instead:

```typescript
import { isRecording } from "./env.ts";

testBehaviour.skipIf(isRecording)(
  "deletes project with --yes flag",
  async ({ run, projectRef }) => {
    const result = await run(["projects", "delete", projectRef, "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Deleted project");
  },
);
```

The fixture for this test is hand-authored in `fixtures/scenarios/<slug>/interactions.json` and is never overwritten by recording.

## Writing assertions that work in both modes

In **replay mode**, fixture data contains the literal placeholder string `<PROJECT_REF>` — the CLI renders it as-is. In **record mode**, the CLI renders the real 20-char ref.

Never assert on the literal placeholder in a way that breaks in record mode:

```typescript
// WRONG — fails in record mode
expect(result.stdout).toContain("<PROJECT_REF>");

// CORRECT — matches real ref in record mode, placeholder in replay
expect(result.stdout).toMatch(/[a-z]{20}|<PROJECT_REF>/);
```

For JSON output assertions, use `toMatchObject` with `expect.any(String)` for ref fields so they pass regardless of whether the value is a real ref or the placeholder.

## Global setup (`tests/setup.ts`)

In **replay mode**: `projectRef` and `orgId` are set to default values (`"aaaaaaaaaaaaaaaaaaaa"` and the same). No API calls are made.

In **record mode**: global setup resolves the org, deletes any orphaned test projects by name (from previous failed runs), creates a fresh `cli-e2e-test` project, and provides its ref via Vitest's `inject()` mechanism. This project is deleted in the global teardown.

The pre-recording cleanup deletes projects named `cli-e2e-test`, `my-project`, and `to-delete` so re-recording never hits a 409 name-conflict. Do not add tests that rely on pre-existing named projects existing on staging.

## Running the suite

```sh
# Replay (no credentials needed)
pnpm nx run @supabase/cli-e2e:test:legacy   # ts-legacy target
pnpm nx run @supabase/cli-e2e:test:go       # go binary target

# Record (requires staging access)
SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_STAGING_URL=https://api.supabase.green \
  pnpm nx run @supabase/cli-e2e:record
```

After recording, replay must pass with no changes between the two commands.

### Sharding (replay only)

CI splits the replay suite across 3 parallel shards via vitest's `--shard`
flag (https://vitest.dev/guide/improving-performance.html#sharding).
Locally, invoke vitest directly so the flag isn't eaten by a `--`
passthrough quirk in `pnpm run` / `nx run-many`:

```sh
pnpm --filter @supabase/cli-e2e exec bun --bun vitest run --shard=1/3
pnpm --filter @supabase/cli-e2e exec bun --bun vitest run --shard=2/3
pnpm --filter @supabase/cli-e2e exec bun --bun vitest run --shard=3/3
```

The custom file sequencer in `vitest.config.ts` (lexicographic) runs
per-process, so each shard still has deterministic intra-shard ordering.

**Sharding is replay-only — never shard a recording run.** The recorder
is a single-job operation; parallel shards would race on the shared
`fixtures/recorded/` directory. The `record` script does not accept
`--shard`.

## Go binary version requirement

The ts-legacy CLI proxies commands to a Go binary (`SUPABASE_GO_BINARY` → bundled package binary → system `supabase`). If you are testing commands that were added to the Go CLI after your system `supabase` binary was installed, `testBehaviour` tests for those commands will fail with "unknown command".

Build the Go CLI from source and point `SUPABASE_GO_BINARY` at it:

```sh
cd apps/cli-go && go build -o /tmp/supabase-test-binary .

# Replay
SUPABASE_GO_BINARY=/tmp/supabase-test-binary pnpm nx run @supabase/cli-e2e:test:legacy

# Record
SUPABASE_GO_BINARY=/tmp/supabase-test-binary \
  SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_STAGING_URL=https://api.supabase.green \
  pnpm nx run @supabase/cli-e2e:record
```

`SUPABASE_GO_BINARY` is inherited by the ts-legacy subprocess via `exec()` in the harness, so you only need to set it once in the shell.

Commands currently requiring this: `telemetry enable`, `telemetry disable`, `telemetry status`.
