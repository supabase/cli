# CLI Agent Guide

This file applies to the `apps/cli` workspace. Read it fully before touching any code in this package.

---

## Shell Architecture

There are three source trees under `src/`:

```
src/
├── next/     # New CLI experience (v3 / alpha channel) — do not modify when porting legacy commands
├── legacy/   # Strict 1:1 TypeScript port of the Go CLI (stable channel)
└── shared/   # Cross-cutting primitives used by both shells
```

### Isolation rules

- `next/` and `legacy/` **cannot import each other**. Command trees are fully isolated.
- Both shells import freely from `shared/`.
- **All exported tokens from `legacy/` must be prefixed with `Legacy` or `legacy`** (no exceptions — see naming section below). This prevents IDE auto-complete from suggesting legacy-only exports when working in `next/` and removes ambiguity at import sites.

### Entry points

Each shell has its own entry chain:

```
src/legacy/main.ts  →  legacy/cli/root.ts  →  legacy/commands/…
src/next/main.ts    →  next/cli/root.ts    →  next/commands/…
```

Both call `runCli(root)` from `shared/cli/run.ts`.

---

## Learning more about the "effect" library

This project uses **Effect V4**. The full source code for the `effect` library is in `.repos/effect/`.

Use this for learning more about the library, rather than browsing the code in
`node_modules/`. See `.repos/effect/MIGRATION.md` for V3 → V4 changes.

## `Effect.fn` and `Effect.fnUntraced`

Use **`Effect.fn`** for top-level exported command handlers — tracing is desired. In the legacy shell, prefix the trace name with `legacy.` to distinguish legacy spans from `next/` spans in traces:

```ts
// next/ handler
export const create = Effect.fn("branches.create")(function* (flags: CreateFlags) {
  // ...
});

// legacy/ handler — note the legacy. prefix in the trace name
export const legacyCreate = Effect.fn("legacy.branches.create")(function* (
  flags: LegacyCreateFlags,
) {
  // ...
});
```

Use **`Effect.fnUntraced`** for small internal helpers that don't need individual trace spans:

```ts
const resolveToken = Effect.fnUntraced(function* (flag: Option.Option<string>) {
  // ...
});
```

Do not use `as` casts to paper over Effect or CLI typing issues. Fix the type relationships directly, or restructure the code until the compiler is satisfied without assertions.

---

## Shared Code

Always check `src/shared/` before writing new infrastructure. Do not duplicate what already exists there or in `next/`.

| Path                                   | What it provides                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `shared/cli/run.ts`                    | `runCli()` — CLI execution harness                                              |
| `shared/cli/global-flags.ts`           | `OutputFormatFlag` — `--output-format` global flag                              |
| `shared/output/output.service.ts`      | `Output` service interface                                                      |
| `shared/output/output.layer.ts`        | `outputLayerFor(format)` — three implementations: `text`, `json`, `stream-json` |
| `shared/output/table.ts`               | `outputTable()`, `formatTableRow()`                                             |
| `shared/output/time.ts`                | `formatUtcDate()`, `formatUtcTime()`                                            |
| `shared/output/json-error-handling.ts` | `withJsonErrorHandling` middleware                                              |
| `shared/output/errors.ts`              | `NonInteractiveError`                                                           |
| `shared/runtime/`                      | `Browser`, `Stdin`, `Tty`, `ProcessControl`, `RuntimeInfo` services + layers    |
| `shared/telemetry/`                    | `withCommandInstrumentation`, `Analytics`, tracing                              |

Also check the following `legacy/` infrastructure before writing equivalent helpers from scratch:

| Path                                                    | What it provides                                                                                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legacy/config/legacy-cli-config.layer.ts`              | `LegacyCliConfig` — resolves `SUPABASE_PROFILE` (built-in name **or** YAML file path), `--workdir`, `--experimental`, project-id from `supabase/config.toml`                              |
| `legacy/config/legacy-project-ref.layer.ts`             | `LegacyProjectRefResolver` — `--project-ref` flag → env → `supabase/.temp/project-ref` file → prompt; matches Go's resolver order                                                         |
| `legacy/telemetry/legacy-telemetry-state.layer.ts`      | `LegacyTelemetryState.flush` — writes `~/.supabase/telemetry.json`, runs in every command's `Effect.ensuring`                                                                             |
| `legacy/telemetry/legacy-linked-project-cache.layer.ts` | `LegacyLinkedProjectCache.cache(ref)` — writes `<workdir>/supabase/.temp/linked-project.json` after `--project-ref` resolves; bypasses generated schema validation (uses raw HTTP client) |
| `legacy/auth/legacy-http-debug.layer.ts`                | `legacyHttpClientLayer` — wraps the HTTP transport with a `--debug` stderr logger in Go's `log.LstdFlags` format                                                                          |
| `legacy/output/legacy-glamour-table.ts`                 | `renderGlamourTable(headers, rows)` — byte-exact ASCII match for Go's `glamour.RenderTable(..., AsciiStyle)`                                                                              |

---

## Phase 0: Go Binary Wrapper

Before any command is natively implemented in TypeScript, the first step for each command is to **wrap** it: define the command in the TS command tree and proxy all invocations to the bundled Go binary via subprocess.

### Proxy handler pattern

A proxy handler passes argv through to the Go binary, forwarding stdin/stdout/stderr and propagating the exit code. Use the shared `LegacyGoProxy` service:

```ts
// src/legacy/commands/orgs/list/list.handler.ts (Phase 0 proxy)
export const legacyOrgsList = Effect.fn("legacy.orgs.list")(function* (
  _flags: LegacyOrgsListFlags,
) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["orgs", "list"]);
});
```

### When wrapping a command

For each command added to the Phase 0 wrapper, complete all three steps:

1. **Reconstruct the command definition** — flags, subcommands, and argument types must exactly match the Go CLI (use `apps/cli-go/` as the reference).
2. **Write a proxy handler** — forward invocations to the Go binary via `LegacyGoProxy`.
3. **Update `docs/go-cli-porting-status.md`** — mark the command as `wrapped`.

### When porting a command (Phase 1+)

When replacing a proxy handler with a native TS implementation:

1. Implement the business logic in `<command>.handler.ts` using Effect services (see Legacy Port sections below).
2. Update `docs/go-cli-porting-status.md` — mark the command as `ported`.

---

## Legacy Port: File Structure and Naming

### Directory layout

One directory per top-level command under `src/legacy/commands/`:

```
src/legacy/commands/<command>/
  <command>.command.ts   # Effect CLI Command definition, flag wiring, layer provision
  <command>.handler.ts   # Phase 0: proxy handler. Phase 1+: native Effect implementation
  <command>.errors.ts    # Domain error types (Data.TaggedError) — add when porting
  SIDE_EFFECTS.md        # Required for every legacy command — see section below
```

When a command grows beyond a single handler file, follow the optional helper-file shape that emerged from the backups port:

```
src/legacy/commands/<command>/
  <command>.command.ts        # Effect CLI Command + flag wiring + layer provide
  <command>.handler.ts        # native Effect handler
  <command>.errors.ts         # Data.TaggedError types
  <command>.layers.ts         # runtime layer composition for the command family
  <command>.format.ts         # text formatters (timestamps, regions, booleans)
  <command>.encoders.ts       # Go-compatible JSON / YAML / TOML / env encoders
  SIDE_EFFECTS.md
```

The `.format.ts` and `.encoders.ts` files should be pure functions with no Effect or service dependencies — that keeps them unit-testable and makes Go-parity rules explicit (e.g. JSON key sort order, env-var SCREAMING_SNAKE_CASE flattening, empty arrays coerced to null).

Commands with subcommands use nested directories:

```
src/legacy/commands/branches/
  branches.command.ts       # Group command (Command.withSubcommands)
  create/
    create.command.ts
    create.handler.ts
    …
  list/
    …
```

Register every command in `src/legacy/cli/root.ts`:

```ts
import { legacyBranchesCommand } from "../commands/branches/branches.command.ts";

export const legacyRoot = Command.make("supabase").pipe(
  Command.withSubcommands([
    helloLegacyCommand,
    legacyBranchesCommand, // ← add here
  ]),
  // ...
);
```

### Mandatory `Legacy`/`legacy` prefix on all exports

Every exported token from a `legacy/` file must carry the `Legacy` (PascalCase) or `legacy` (camelCase/kebab) prefix — no exceptions, even for symbols that are only used within `legacy/`. This makes the constraint unconditional and prevents auto-complete pollution in `next/`:

| Export kind                    | Convention                                                  |
| ------------------------------ | ----------------------------------------------------------- |
| Command constant               | `export const legacyBranchesCommand`                        |
| Handler function               | `export const legacyCreate`                                 |
| Error class                    | `export class LegacyBranchAlreadyExistsError`               |
| Service class                  | `export class LegacyProjectState`                           |
| Layer                          | `export const legacyCredentialsLayer`                       |
| Integration test setup helpers | `function setupLegacyTty()`, `function setupLegacyNonTty()` |
| Type aliases                   | `export type LegacyCreateFlags`                             |

Do **not** export a bare `create` or `branchesCommand` from a `legacy/` file.

### Reusing `next/` implementations

Many Management API commands in `next/commands/` have already been implemented. The handler logic is Effect-based and shell-agnostic. **Check `next/commands/` before writing a handler from scratch.** You can often copy a handler file verbatim and:

1. Rename the exported function (add `legacy` prefix)
2. Adjust the trace name to `legacy.<command>.<subcommand>`
3. Fix import paths (`../../shared/` → `../../../shared/`, etc.)

---

## Legacy Port: Hoist Before You Duplicate

Before writing handler code for a new port, scan the already-ported commands for overlapping logic. If two commands need the same helper (HTTP-error mapping, output encoder, formatter, runtime layer composition), hoist it instead of inlining a copy.

Decision rule:

- **Used by one command only** → keep it in the command's own directory (e.g. `backups/backups.errors.ts`).
- **Used by ≥2 commands in the same command family** → keep it in the family root (e.g. `backups/backups.encoders.ts` is shared by `list` and `restore`).
- **Used by ≥2 commands across families** → hoist to `src/legacy/shared/` (create the directory if it doesn't exist) and refactor the existing call sites in the same change. Do not leave the older command using its inlined copy while the new command uses the hoisted version.

Concrete examples worth watching for as more commands land:

- HTTP-error → tagged-error mapping (`backups.errors.ts:mapLegacyBackupHttpError`) — almost every Management API command will need this shape.
- Go-compatible JSON / YAML / TOML / env encoders (`backups.encoders.ts`) — the flag `--output {json,yaml,toml,env}` is supported by many Go subcommands.
- Glamour-table rendering helpers and column padding — currently in `legacy/output/legacy-glamour-table.ts`, already correctly hoisted.
- Timestamp / region / boolean formatters (`backups.format.ts`) — likely shared the moment a second command renders a backup/project/region field.

This rule is consistent with the repo-wide **Refactoring Policy** ("delete obsolete helpers, shims, and parallel code paths as part of the refactor") — it just makes the policy concrete for the legacy-port workflow.

### `Config.Validate` parity has one home

Go's `Config.Validate` (`apps/cli-go/pkg/config/config.go:989-1190`) is ported exactly once: `src/legacy/shared/legacy-config-validate.ts` (`legacyValidateResolvedConfig`). Both the db/migration loader (`legacy-db-config.toml-read.ts`) and the status/stop resolver (`legacy-local-config-values.ts`) build a `LegacyConfigValidationInput` from their own pipelines and call it — do not add per-command reimplementations of these checks. When a Go validation branch or message changes, change it there. `legacy-config-validate.parity.unit.test.ts` feeds the same broken configs through both real pipelines and asserts identical error strings; extend it when adding a branch both callers share.

---

## Legacy Port: Go CLI Output Parity

The legacy shell is a **strict 1:1 port** — not a redesign. The compatibility contract covers:

- Same command paths and flag names
- Same stdout/stderr text, including spacing, casing, and newlines
- Same filesystem side effects (files read and written)
- Same API routes and request shapes
- Same exit codes

When in doubt about expected output or behavior, run the equivalent command against the Go CLI reference at `apps/cli-go/` and match it exactly.

---

## Legacy Port: Go Parity Checklist

When porting a Management-API-style command, verify each item before marking the command as `ported`:

1. **Telemetry + linked-project writes run on every invocation** — Go uses `PersistentPostRun` (see `apps/cli-go/cmd/root.go:176`). Wrap the handler body in `.pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush))` so both files are written on success **and** failure. See `backups/list/list.handler.ts:74-114` as the canonical pattern.

2. **Errors go to stderr in text mode, byte-matching Go's template** — `Output.fail` now writes a frame-free message to stderr followed by the "Try rerunning the command with --debug to get more details." suggestion when `--debug` is unset. Don't reintroduce clack's `■ … │` frame. Reference: commits `ee041834`, `cf4f574b`.

3. **`--debug` logs every HTTP request on stderr** — Format `"HTTP YYYY/MM/DD HH:MM:SS <METHOD>: <URL>\n"` (Go's `log.LstdFlags|log.Lmsgprefix`). Provided automatically by `legacyHttpClientLayer`; ensure that layer (not the raw `HttpClient.layer`) is what every legacy command's runtime composes. Reference: commit `39cfec20`.

4. **`SUPABASE_PROFILE` is dual-mode** — accept either a built-in name (`supabase`, `supabase-staging`, `supabase-local`) **or** a filesystem path to a YAML file with `api_url:` / `gotrue_url:` / `db_url:` keys. cli-e2e harness relies on the file-path mode. Reference: commit `288c2937`.

5. **`Layer.provide` does not share to siblings inside `Layer.mergeAll`** — if two sibling layers each require `LegacyCliConfig`, provide it to both explicitly. Smoke-test the bundled binary (`bun run build && ./dist/supabase-legacy …`) when changing production layer wiring; in-process tests don't always catch the missing-service panic. Reference: commit `a816b12e`, `backups.layers.ts:32-46`.

6. **Both `--output` (Go) and `--output-format` (TS) must be honored** — Go's `--output` (`pretty|json|yaml|toml|env`) takes priority when set. Pattern in `backups/list/list.handler.ts:85-113`: branch on `goOutputFlag` first, then fall through to TS `--output-format` text/json/stream-json.

7. **PostHog telemetry payload matches Go 1:1** — see the next section.

---

## Legacy Port: Telemetry Parity

The legacy shell sends the same PostHog events to the same product analytics pipeline as the Go CLI. Drift is silent (no test will catch it) and breaks dashboards. The rules:

- **The canonical catalog is `shared/telemetry/event-catalog.ts`** — a 1:1 mirror of `apps/cli-go/internal/telemetry/events.go`. Reference its exported constants (`EventCommandExecuted`, `PropFlags`, `EnvSignalPresenceKeys`, …) instead of writing bare strings. When the Go catalog changes, update the TS catalog in the same PR.
- **Native legacy commands wrap with `withLegacyCommandInstrumentation`** (from `legacy/telemetry/legacy-command-instrumentation.ts`) — _not_ the shared `withCommandInstrumentation`. The legacy variant emits Go-shape properties: a single `flags` map (vs `flags_used`/`flag_values`), `is_agent: boolean` (vs `ai_tool: string`), and `env_signals`.
- **Pass `flags` to the wrapper** so boolean flag values can be detected and logged verbatim: `handler(flags).pipe(withLegacyCommandInstrumentation({ flags }), ...)`. Sensitive values become the literal string `"<redacted>"` to match Go.
- **Use `safeFlags: ["flag-name"]`** to whitelist flags that Go marks with `markFlagTelemetrySafe` (grep `apps/cli-go/cmd/*.go`). Today these are `--project-ref` (sso, branches, link, functions, projects/api-keys), `--project-id` (gen/types), `--org-id` (projects/create), and `--version` (migration/squash).
- **Pass `config` (the command's own flag config record) to the wrapper** if it has any `Flag.choice`/`Flag.choiceWithValue` flags: `withLegacyCommandInstrumentation({ flags, config })`. Every choice flag declared in that command's own `config` is auto-detected and treated as safe, mirroring Go's `isEnumFlag` (`cmd/root_analytics.go:110-116`), which checks `flag.Value.(*utils.EnumFlag)` unconditionally — no per-flag `safeFlags` entry needed, and it stays correct as choices are added or removed. This does NOT cover global/root flags (`--output`, `--dns-resolver`, `--agent` in `shared/legacy/global-flags.ts`) even though Go's equivalents are also `EnumFlag` — see CLI-1904.
- **Global/persistent flags (`shared/legacy/global-flags.ts`) resolve automatically** — the wrapper reads `legacyGlobalFlagValues` (via `Effect.serviceOption`, so it's a no-op outside the real CLI tree) and falls back to it whenever a changed flag name isn't in the handler's own `flags` record, mirroring Go's `changedFlags()` walking `cmd.Parent()`'s `PersistentFlags()` (`cmd/root_analytics.go:53-76`). No per-command wiring needed. Boolean globals (`--debug`, `--yes`, `--experimental`, `--create-ticket`) therefore already report their real value through the existing boolean-is-safe rule — but ONLY when a command's own `flags` record doesn't already declare that CLI name (a command's own flag always wins, e.g. `db diff`'s local `--output`); the three global choice flags (`--output`, `--dns-resolver`, `--agent`) still redact until CLI-1904 teaches the safety pipeline about global `EnumFlag`s.
- **Proxy handlers (`LegacyGoProxy.exec`) must NOT wrap with any instrumentation.** The Go subprocess fires its own telemetry; a TS wrapper would double-count `cli_command_executed`.
- **When promoting a command from proxy to native, reproduce every `phtelemetry.*` call in the Go counterpart.** Grep `apps/cli-go/internal/<command>/` for `service.Capture`, `service.Alias`, `service.Identify`, `service.GroupIdentify`, and `TrackUpgradeSuggested`. The current Go custom events that legacy ports must reproduce when natively ported:

  | Command                                                       | Event                   | Identity / groups                                                                                                  | Go source                                     |
  | ------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
  | `login`                                                       | `cli_login_completed`   | `analytics.alias(gotrueId, deviceId)` after token persists                                                         | `internal/login/login.go:283-296`             |
  | `link`                                                        | `cli_project_linked`    | `analytics.groupIdentify("organization", slug, …)` + `analytics.groupIdentify("project", ref, …)` after link write | `internal/link/link.go:60`                    |
  | `start`                                                       | `cli_stack_started`     | none — fired after stack health check passes                                                                       | `internal/start/start.go:1245`                |
  | `sso/{list,create,update,remove}`, `branches/{create,update}` | `cli_upgrade_suggested` | none — payload is `{feature_key, org_slug}`, fired inside billing-gate error branch                                | 7 call-sites under `internal/{sso,branches}/` |

  Reference pattern for login: `next/commands/login/login.handler.ts:38-62`.

- **Tracing layer is local-only observability**, not PostHog. Span names (`legacy.<command>.<sub>`) and the NDJSON exporter never leave the user's machine. No parity implication.

---

## Legacy Port: File Location Compatibility

The legacy shell bridges two worlds: it must behave exactly like the Go CLI for existing users, and it must lay the groundwork for a seamless upgrade to the next shell.

**Dual write requirement:** Where a legacy command writes state to disk, it must write to **both**:

1. **The Go CLI paths** — the exact file locations the Go CLI already uses, so existing scripts, dotfiles, and tooling that depend on those paths continue to work.
2. **The `next/` paths** — the file locations that `next/` services and layers expect to read, so a user who upgrades to the next experience finds their state already in place.

When these two sets of paths are the same (they often are via shared services), no extra work is needed. When they differ, the legacy handler must write to both.

**Corollary:** When a `next/` service or layer changes where or how it reads or writes a file, the author must verify that the corresponding legacy command still produces files at the updated location and update it if necessary before merging. This check is required even when file I/O goes through a shared service — confirm the shared service covers both paths.

---

## Legacy Port: Side-effect Documentation

`SIDE_EFFECTS.md` is a **legacy-only artifact**. Do not create these files in `next/`.

Every legacy command port must include a `SIDE_EFFECTS.md` in its command directory covering:

- **Files read and written** — exact paths (with `~/` or CWD-relative notation), format, when
- **API routes called** — method, path, request body shape, response shape
- **Environment variables consumed**
- **Exit codes** — including error conditions

Use the template at `src/legacy/SIDE_EFFECTS_TEMPLATE.md`. This document is the compatibility checklist for the port and the primary input to the E2E test suite.

---

## Output Format: `--output-format`

The `--output-format` global flag is defined in `shared/cli/global-flags.ts` (`OutputFormatFlag`) and is already wired into `legacy/cli/root.ts`. It accepts three values:

| Value            | Description                                                             |
| ---------------- | ----------------------------------------------------------------------- |
| `text` (default) | Human-readable terminal output with spinners, tables, prompts           |
| `json`           | Single JSON object emitted to stdout on completion                      |
| `stream-json`    | NDJSON events streamed to stdout (`log`, `progress`, `result`, `error`) |

**Every legacy command handler must handle all three formats.** The `json` and `stream-json` modes provide machine-readable output for scripted workflows and AI agents.

### Pattern: branch on `output.format`

```ts
if (output.format !== "text") {
  // json / stream-json — emit structured result
  yield * output.success("Branch created", { ...branch });
  return;
}

// text — human-readable table + outro
yield * outputTable(BRANCH_HEADERS, [branch], formatRow);
yield * output.outro(`Branch "${branch.name}" created.`);
```

### Pattern: always wrap API calls in `output.task`

Wrap every async API call in `output.task` so the terminal does not appear to hang in text mode. In `json`/`stream-json` mode the task is a no-op — the spinner is suppressed automatically:

```ts
const creating = yield * output.task("Creating branch...");

const branch = yield * api.createBranch(params).pipe(Effect.tapError(() => creating.fail()));

yield * creating.clear(); // dismiss without a message
// OR
yield * creating.succeed("Branch created");
```

### Invariant: `-o json|yaml|toml|env` must suppress the spinner (CLI-1546)

The Go-compat `-o`/`--output` flag (`LegacyOutputFlag`, values `env|pretty|json|toml|yaml`) is **independent** of `--output-format`. It does not change `output.format`, so a command run with `-o json` (and no `--output-format`) keeps `output.format === "text"` and the spinner gate `output.format === "text"` stays `true`. If the plain `textOutputLayer` is active, clack writes spinner ANSI (e.g. the hide-cursor `\x1b[?25l`) to **stdout** and corrupts the machine payload the handler emits via `output.raw` — exactly the CLI-1546 regression (`branches list -o json` → broken `JSON.parse`).

`legacy/cli/root.ts` therefore selects **`legacyQuietProgressTextOutputLayer`** (in `legacy/output/`) for any Go machine format (`json|yaml|toml|env`). It is a legacy-only wrapper over the shared `textOutputLayer` that no-ops only `task` and `progress`; everything else — `format: "text"`, `raw`, logs, and error rendering (red text on **stderr**) — delegates unchanged, so Go output parity is preserved exactly.

Rules:

- **stdout is payload-only whenever a machine format is requested** (`-o json|yaml|toml|env` or `--output-format json|stream-json`). All progress/diagnostic output goes to stderr.
- **Do not** fix spinner-on-stdout by routing the shared spinner to stderr or otherwise editing `shared/output/output.layer.ts` — that changes `next/` text rendering. Keep the fix legacy-scoped.
- A handler reaching this path still emits its machine payload through the Go encoder (`output.raw(encodeGoJson(...))` etc.), checked **before** the `output.format` branch, so output stays byte-identical to before — minus the spinner.

---

## Testing

Use `bun run test` (not `bun test`) to run tests. The `package.json` `test` script runs all Vitest projects with coverage enabled for the `core` project.

Use `bun run test:core` for the main in-process suite, and `bun run test:e2e` for the sequential subprocess suite.

Always run the relevant unit and integration tests automatically for the command or workspace you changed.
Do not run the full e2e suite automatically. Only run e2e when the user asks, or when you need extra confidence for the command you touched.
When running e2e automatically, run only the targeted `*.e2e.test.ts` file(s) for the command you changed.

When running the CLI from source, always invoke it as `bun src/supabase.ts ...` directly. Do not use `bun run src/supabase.ts` because of Bun bug #11400.

Command handler integration tests must achieve **100% branch coverage**.

Read https://www.effect.solutions/testing for Effect testing patterns. Note that the guide targets Effect V3 — adapt to V4 APIs using the source code in `.repos/effect/packages/effect/` and `.repos/effect/packages/vitest/`.

### Test categories

- `*.unit.test.ts` belongs to the `unit` Vitest project and is the default for unit-style and other fast in-process tests.
- `*.integration.test.ts` belongs to the `integration` project and is for in-process integration tests that exercise real handler or service behavior with layered dependency replacement.
- `*.e2e.test.ts` belongs to the `e2e` Vitest project and is for black-box CLI subprocess tests.
- `*.live.test.ts` belongs to the `live` Vitest project and is for black-box CLI subprocess tests that run against a **real, running Supabase platform or local Docker stack** — see "Live tests" below.

### Testing policy

- Prefer integration tests over unit tests for command behavior.
- New command behavior should usually be covered in `*.integration.test.ts` first.
- Prefer the highest-level in-process test that exercises the real behavior with stable, local feedback.
- Use `*.unit.test.ts` for pure logic, parsing, formatting, small state machines, and narrow edge cases that are awkward or noisy to cover through handlers.
- Unit-style tests should prefer real collaborators and avoid mocking by default.
- Small fakes are acceptable only at true boundaries such as filesystem, env, clock, TTY, process, browser, or network.
- If a test needs multiple service replacements or `Layer.mergeAll(...)`, it likely belongs in `*.integration.test.ts`.
- Prefer assertions on outputs and accumulated state over spy-heavy interaction tests.
- Keep `*.e2e.test.ts` focused on golden paths, CLI surface behavior, and subprocess correctness, not branch-by-branch coverage.
- **Forbidden pattern (do not add):** spawning the CLI to assert that `--help` renders a flag. Help text is dynamic over flag wiring and is exercised by the integration test's flag parser. The two backups e2e files removed alongside this guidance update are the canonical example of what not to write.

### Live tests (`*.live.test.ts`)

Live tests are black-box CLI subprocess tests — like `*.e2e.test.ts`, but run against a **real backend** instead of local fakes/mocks: either the real Management API (a full [supabox](https://github.com/supabase/supabox) platform stack) or a real local Docker dev stack (`supabase start`'s actual containers). They are the highest-fidelity, most expensive tier — reserved for the small set of behaviors that only a genuinely running backend can prove (auth round-trips, real Docker label filtering, real container lifecycle), not for anything an integration test can already cover with mocks.

- **Where they run:** authored in this repo, but executed by the [`supabase/cli-e2e-ci`](https://github.com/supabase/cli-e2e-ci) harness, which builds this CLI, brings up a full supabox stack (and has a real Docker daemon, since that's how supabox itself runs), and invokes the `live` Vitest project (`nx run-many -t test:live`). They never run as part of the default unit/integration/e2e loop, and locally they no-op unless the live environment is configured (see below) — there is no need to stand up supabox yourself to develop other code.
- **Add one whenever you add or change a command whose correctness genuinely depends on a real backend** — a new Management API command, or a change to `start`/`stop`/`status`'s real Docker interaction. Colocate it with the command, same as `*.e2e.test.ts`: `src/legacy/commands/<command>/[<subcommand>/]<subcommand>.live.test.ts`.
- **Gating:** every live suite must be wrapped in one of `tests/helpers/live.ts`'s `describe.skipIf` gates so the file is inert (skipped, not failed) outside the cli-e2e-ci runner:
  - `describeLive` — runs whenever `SUPABASE_ACCESS_TOKEN` is set (the live env is configured at all). Reuse this even for commands that don't call the Management API themselves (e.g. `stop`/`status`) — it doubles as the "we're in the full cli-e2e-ci runner, which also has a real Docker daemon" signal, and there is no dedicated Docker-availability gate today.
  - `describeLiveProject` — additionally requires a provisioned project (`SUPABASE_LIVE_PROJECT_REF`); use for project-scoped Management API commands (branches, functions, project-scoped db).
  - `describeLiveDataPlane` — additionally requires the project's own Postgres instance to be `ACTIVE_HEALTHY`; use for commands that talk to the project's data plane (migration, db, storage).
- **Invocation:** use `runSupabaseLive(args, options?)` (wraps `runSupabase` with the `legacy` entrypoint and the live profile/timeout defaults) rather than calling `runSupabase` directly, so every live test picks up the same environment plumbing.
- **Local-dev-stack live tests** (`start`/`stop`/`status`, and anything else that manages real Docker containers rather than calling the Management API) follow the same file/gating convention but don't need `SUPABASE_PROFILE`/project-ref machinery. Pattern: `mkdtemp` a project dir, `runSupabaseLive(["init"], { cwd })` to generate a real Go-schema `config.toml`, `runSupabaseLive(["start", ...])` to bring up (a lightweight subset of) the real stack, exercise the command under test, then clean up in `afterEach` (best-effort `stop --no-backup` + `rm` the temp dir) so a failed assertion never leaks containers onto the CI runner. See `commands/stop/stop.live.test.ts` and `commands/status/status.live.test.ts` for the canonical example.
- **Keep the suite small and golden-path only** — same philosophy as `*.e2e.test.ts`, but even more so given the cost of a real backend. One or two scenarios per command is normal; branch-by-branch coverage belongs in `*.integration.test.ts`.
- Timeouts are generous by default (`testTimeout`/`hookTimeout: 300_000` for the whole `live` project) because real platform/Docker operations are slow — pass an explicit per-`test()` timeout when a scenario needs less (or, for a real local-stack `start`, close to the full budget).

---

## Go CLI Parity Tracking

When you add or change CLI commands, subcommands, flags, or parameters in the **legacy shell**, always update [`docs/go-cli-porting-status.md`](./docs/go-cli-porting-status.md).

- Update status when a Go leaf command moves between `missing`, `partial`, and `ported`.
- Update missing or extra flag/parameter notes when the command surface changes — including when you add or remove a flag on an already-ported TS command.
- Keep the tracker focused on final leaf commands, not command groups.
- If you add a TS-native command with no direct Go equivalent (for example `dev`), record it in the TS-only section instead of marking a Go command as ported.

---

## Code quality

After finishing any task or refactor, always run all quality checks before considering the work done:

```sh
bun run test
bun run --parallel "*:check"
```

---

## Reference repos

### `.repos/lalph/`

[lalph](https://github.com/tim-smart/lalph) is a CLI written by Tim Smart, a core maintainer of Effect, using Effect V4. Study its source code to determine good practices and patterns when building CLI applications with Effect.

### `.repos/effect-patterns/`

[effect-patterns](https://github.com/effect-ts-community/effect-patterns) contains practical patterns for structuring Effect services, layers, and error handling. Note that the code targets **Effect V3** — adapt the idioms to V4 APIs using `.repos/effect/MIGRATION.md` and the V4 source code.

### `apps/cli-go/`

The [old Supabase CLI](https://github.com/supabase/cli) written in Go. When porting a command to the legacy shell, use this as the authoritative source for expected output, flags, and behavior. Match it exactly.
