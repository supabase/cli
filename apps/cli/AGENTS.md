# CLI Agent Guide

This file applies to the `apps/cli` workspace. Read it fully before touching any code in this package.

---

## Shell Architecture

There are three source trees under `src/`:

```
src/
├── legacy/   # The stable Supabase CLI — the authoritative implementation
├── next/     # Experimental v3 shell — frozen; moving to its own branch, will leave this tree
└── shared/   # Cross-cutting primitives used by both shells
```

The names are historical: `legacy/` started as the TypeScript port of the old Go CLI and is now the
main, stable version of the CLI. `next/` is the experimental v3 experience; its development is
moving to a dedicated branch, and the folder will be removed from this tree. **Do not add features
to `next/`** — new work lands in `legacy/` (or `shared/`).

### Isolation rules

- `next/` and `legacy/` **cannot import each other**. Command trees are fully isolated.
- Both shells import freely from `shared/`.
- **All exported tokens from `legacy/` must be prefixed with `Legacy` or `legacy`** (no exceptions — see naming section below). This removes ambiguity at import sites and keeps the two in-tree shells from bleeding into each other while both exist.

### Entry points

Each shell has its own entry chain:

```
src/legacy/main.ts  →  legacy/cli/root.ts  →  legacy/commands/…
src/next/main.ts    →  next/cli/root.ts    →  next/commands/…
```

Both call `runCli(root)` from `shared/cli/run.ts`.

---

## Source of Truth

The Go→TypeScript port is **complete**. `src/legacy/` is the source of truth for the Supabase CLI's
behavior. The old Go CLI (`apps/cli-go/`) is **not** a reference anymore: it survives only as the
residual delegation surface documented in
[`docs/go-cli-porting-status.md`](./docs/go-cli-porting-status.md), and everything Go-related is
slated for cleanup and removal.

What this means in practice:

- The compatibility standard for any change is the legacy shell's **own established behavior** —
  its tests, its `SIDE_EFFECTS.md` files, and its shipped output — not a comparison against Go.
- Consult `apps/cli-go/` only when maintaining one of the still-proxied commands (their flag
  definitions must keep matching the Go binary they forward to).
- **Do not write new comments, doc sections, or helper names framed as "Go parity" or "matches
  Go".** Describe behavior in its own terms. When touching code that carries old Go-parity
  framing, clean it up opportunistically.
- For history: Go source for ported commands was deleted in CLI-1970; the last commit with it
  intact is `7b469f5b3` (`internal/start` was deleted separately in CLI-1966; its pin is
  `a253ccba2`). [ADR 0016](../../docs/adr/0016-legacy-port-completion-and-go-cli-authority-scope.md)
  records the earlier transition policy; this section supersedes its day-to-day guidance.

---

## Learning more about the "effect" library

This project uses **Effect V4**. The full source code for the `effect` library is in `.repos/effect/`.

Use this for learning more about the library, rather than browsing the code in
`node_modules/`. See `.repos/effect/MIGRATION.md` for V3 → V4 changes.

## `Effect.fn` and `Effect.fnUntraced`

Use **`Effect.fn`** for top-level exported command handlers — tracing is desired. In the legacy shell, prefix the trace name with `legacy.` to distinguish legacy spans from `next/` spans in traces:

```ts
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

Always check `src/shared/` before writing new infrastructure. Do not duplicate what already exists there.

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
| `shared/telemetry/`                    | `withCommandInstrumentation`, `Analytics`, tracing, `error-actionability.ts`    |

Also check the following `legacy/` infrastructure before writing equivalent helpers from scratch:

| Path                                                    | What it provides                                                                                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legacy/config/legacy-cli-settings.layer.ts`            | `LegacyCliSettings` — resolves `SUPABASE_PROFILE` (built-in name **or** YAML file path), `--workdir`, `--experimental`, project-id from `supabase/config.toml`                            |
| `legacy/config/legacy-project-ref.layer.ts`             | `LegacyProjectRefResolver` — `--project-ref` flag → env → `supabase/.temp/project-ref` file → prompt                                                                                      |
| `legacy/telemetry/legacy-telemetry-state.layer.ts`      | `LegacyTelemetryState.flush` — writes `~/.supabase/telemetry.json`, runs in every command's `Effect.ensuring`                                                                             |
| `legacy/telemetry/legacy-linked-project-cache.layer.ts` | `LegacyLinkedProjectCache.cache(ref)` — writes `<workdir>/supabase/.temp/linked-project.json` after `--project-ref` resolves; bypasses generated schema validation (uses raw HTTP client) |
| `legacy/auth/legacy-http-debug.layer.ts`                | `legacyHttpClientLayer` — wraps the HTTP transport with a `--debug` stderr logger (`log.LstdFlags`-style timestamp format)                                                                |
| `legacy/output/legacy-glamour-table.ts`                 | `renderGlamourTable(headers, rows)` — the CLI's established ASCII table format                                                                                                            |
| `legacy/shared/legacy-upgrade-notice.ts`                | `legacyUpgradeNoticeHook` — post-success upgrade notice (GitHub latest-release fetch, 10h `supabase/.temp/cli-latest` cache, `SUPABASE_NO_UPDATE_NOTIFIER` opt-out)                       |

---

## The Go Delegation Surface

A small, fixed set of commands still proxies to a bundled Go binary — the full list lives in
[`docs/go-cli-porting-status.md`](./docs/go-cli-porting-status.md). This surface only shrinks:
**never add a new command or flag path that delegates to the Go binary.** The direction of travel
is removing these remnants, not extending them.

While a proxied command exists, its TS command/flag definition gates which invocations reach the
Go binary and must keep matching that binary exactly — this is the one remaining case where
`apps/cli-go/` is authoritative.

A proxy handler passes argv through to the Go binary, forwarding stdin/stdout/stderr and propagating the exit code, via the shared `LegacyGoProxy` service:

```ts
export const legacyOrgsList = Effect.fn("legacy.orgs.list")(function* (
  _flags: LegacyOrgsListFlags,
) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["orgs", "list"]);
});
```

Shrinking the surface means replacing a wrapper with a **native TS implementation** — it does not
license removing the user-facing command. Several wrapped commands are retained indefinitely
precisely because dropping them was ruled a breaking change (CLI-1964; see the "Why it stays"
column in the delegation table). Deleting a public command path is a product decision, never a
cleanup task.

When replacing a wrapper natively:

1. Implement the business logic in `<command>.handler.ts` using Effect services (see the sections below).
2. Reproduce the old behavior (output, side effects, telemetry) from the **current in-tree Go source** in `apps/cli-go/` — that is the shipped implementation, and it can differ from the pre-trim snapshot (e.g. the `db remote --password` precedence entry in `docs/go-cli-divergences.md`). The pinned commits (`7b469f5b3`, `a253ccba2`) are only for commands whose Go source was already deleted.
3. Update `docs/go-cli-porting-status.md` — the delegation surface table must stay accurate.

---

## File Structure and Naming

### Directory layout

One directory per top-level command under `src/legacy/commands/`:

```
src/legacy/commands/<command>/
  <command>.command.ts   # Effect CLI Command definition, flag wiring, layer provision
  <command>.handler.ts   # native Effect implementation (or residual Go proxy)
  <command>.errors.ts    # Domain error types (Data.TaggedError)
  SIDE_EFFECTS.md        # Required for every legacy command — see section below
```

When a command grows beyond a single handler file, follow the optional helper-file shape:

```
src/legacy/commands/<command>/
  <command>.command.ts        # Effect CLI Command + flag wiring + layer provide
  <command>.handler.ts        # native Effect handler
  <command>.errors.ts         # Data.TaggedError types
  <command>.layers.ts         # runtime layer composition for the command family
  <command>.format.ts         # text formatters (timestamps, regions, booleans)
  <command>.encoders.ts       # machine-format encoders (JSON / YAML / TOML / env)
  <command>.go-payload.ts     # struct specs that drive `-o yaml|toml` key casing (CLI-1975)
  SIDE_EFFECTS.md
```

The `.format.ts` and `.encoders.ts` files should be pure functions with no Effect or service dependencies — that keeps them unit-testable and makes encoding rules explicit (e.g. JSON key sort order, env-var SCREAMING_SNAKE_CASE flattening, empty arrays coerced to null). The `*.go-payload.ts` struct specs are now the canonical definition of `-o yaml|toml` key casing — they are no longer re-synced from any Go source.

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

Every exported token from a `legacy/` file must carry the `Legacy` (PascalCase) or `legacy` (camelCase/kebab) prefix — no exceptions, even for symbols that are only used within `legacy/`:

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

---

## Hoist Before You Duplicate

Before writing handler code for a new command, scan the existing commands for overlapping logic. If two commands need the same helper (HTTP-error mapping, output encoder, formatter, runtime layer composition), hoist it instead of inlining a copy.

Decision rule:

- **Used by one command only** → keep it in the command's own directory (e.g. `backups/backups.errors.ts`).
- **Used by ≥2 commands in the same command family** → keep it in the family root (e.g. `backups/backups.encoders.ts` is shared by `list` and `restore`).
- **Used by ≥2 commands across families** → hoist to `src/legacy/shared/` and refactor the existing call sites in the same change. Do not leave the older command using its inlined copy while the new command uses the hoisted version.

Concrete examples worth watching for:

- HTTP-error → tagged-error mapping (`backups.errors.ts:mapLegacyBackupHttpError`) — almost every Management API command needs this shape.
- Machine-format encoders (`backups.encoders.ts`) — the `--output {json,yaml,toml,env}` flag is supported by many subcommands.
- Glamour-table rendering helpers and column padding — in `legacy/output/legacy-glamour-table.ts`, already correctly hoisted.
- Timestamp / region / boolean formatters (`backups.format.ts`) — shared the moment a second command renders a backup/project/region field.

This rule is consistent with the repo-wide **Refactoring Policy** ("delete obsolete helpers, shims, and parallel code paths as part of the refactor").

### Config validation has one home

Config validation is implemented exactly once: `src/legacy/shared/legacy-config-validate.ts` (`legacyValidateResolvedConfig`). Both the db/migration loader (`legacy-db-config.toml-read.ts`) and the status/stop resolver (`legacy-local-config-values.ts`) build a `LegacyConfigValidationInput` from their own pipelines and call it — do not add per-command reimplementations of these checks. When a validation branch or message changes, change it there. `legacy-config-validate.parity.unit.test.ts` feeds the same broken configs through both real pipelines and asserts identical error strings; extend it when adding a branch both callers share.

---

## Behavioral Stability Contract

The legacy shell is the stable CLI millions of scripts and CI pipelines depend on. Its established
surface is a compatibility contract:

- Command paths and flag names
- stdout/stderr text, including spacing, casing, and newlines
- Filesystem side effects (files read and written)
- API routes and request shapes
- Exit codes
- Telemetry semantics (which events fire, when, and their payload shape)

The standard for "established behavior" is the shell's own tests, each command's
`SIDE_EFFECTS.md`, and what current releases actually emit. Do not change this surface casually;
when a change is intentional, update the tests and `SIDE_EFFECTS.md` in the same change.

This contract does not constrain internal refactors, new flags/features, or bug fixes that leave
the established surface unchanged — treat those like any other TypeScript workspace.

---

## Legacy Shell Invariants

Verify each applicable item when adding or reworking a command:

1. **Telemetry + linked-project writes run on every invocation** — wrap the handler body in `.pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush))` so both files are written on success **and** failure. See `backups/list/list.handler.ts:74-114` as the canonical pattern.

2. **Errors go to stderr in text mode** — `Output.fail` writes a frame-free message to stderr followed by the "Try rerunning the command with --debug to get more details." suggestion when `--debug` is unset. Don't reintroduce clack's `■ … │` frame. Reference: commits `ee041834`, `cf4f574b`.

3. **`--debug` logs every HTTP request on stderr** — format `"HTTP YYYY/MM/DD HH:MM:SS <METHOD>: <URL>\n"`. Provided automatically by `legacyHttpClientLayer`; ensure that layer (not the raw `HttpClient.layer`) is what every legacy command's runtime composes. Reference: commit `39cfec20`.

4. **`SUPABASE_PROFILE` is dual-mode** — accept either a built-in name (`supabase`, `supabase-staging`, `supabase-local`) **or** a filesystem path to a YAML file with `api_url:` / `gotrue_url:` / `db_url:` keys. cli-e2e harness relies on the file-path mode. Reference: commit `288c2937`.

5. **`Layer.provide` does not share to siblings inside `Layer.mergeAll`** — if two sibling layers each require `LegacyCliSettings`, provide it to both explicitly. Smoke-test the bundled binary (`bun run build && ./dist/supabase-legacy …`) when changing production layer wiring; in-process tests don't always catch the missing-service panic. Reference: commit `a816b12e`, `backups.layers.ts:32-46`.

6. **Both `--output` (legacy machine formats) and `--output-format` must be honored** — `--output` (`pretty|json|yaml|toml|env`) takes priority when set. Pattern in `backups/list/list.handler.ts:85-113`: branch on the `--output` flag first, then fall through to `--output-format` text/json/stream-json.

7. **Telemetry follows the established catalog and payload shapes** — see the next section.

---

## Telemetry

The legacy shell sends PostHog events to the product analytics pipeline. Drift is silent (no test will catch it) and breaks dashboards. The rules:

- **The canonical catalog is `shared/telemetry/event-catalog.ts`.** Reference its exported constants (`EventCommandExecuted`, `PropFlags`, `EnvSignalPresenceKeys`, …) instead of writing bare strings. The TS catalog is the source of truth for event names and property keys.
- **Native legacy commands wrap with `withLegacyCommandInstrumentation`** (from `legacy/telemetry/legacy-command-instrumentation.ts`) — _not_ the shared `withCommandInstrumentation`. The legacy variant emits the established property shape: a single `flags` map (vs `flags_used`/`flag_values`), `is_agent: boolean` (vs `ai_tool: string`), and `env_signals`.
- **Pass `flags` to the wrapper** so boolean flag values can be detected and logged verbatim: `handler(flags).pipe(withLegacyCommandInstrumentation({ flags }), ...)`. Sensitive values become the literal string `"<redacted>"`.
- **Use `safeFlags: ["flag-name"]`** to whitelist flags whose values are safe to log verbatim. The established list: `--project-ref` (sso, branches, link, functions, projects/api-keys), `--project-id` (gen/types), `--org-id` (projects/create), and `--version` (migration/squash). Extend it only for flags whose values carry no user data.
- **Pass `config` (the command's own flag config record) to the wrapper** if it has any `Flag.choice`/`Flag.choiceWithValue` flags: `withLegacyCommandInstrumentation({ flags, config })`. Every choice flag declared in that command's own `config` is auto-detected and treated as safe — closed enums carry no user data — and it stays correct as choices are added or removed. A command's own `config` only ever contains its own locally-declared flags, so this cannot cover the 3 global choice flags (`--output`, `--dns-resolver`, `--agent` in `shared/legacy/global-flags.ts`) — those are handled separately, see below.
- **Global/persistent flags (`shared/legacy/global-flags.ts`) resolve automatically** — the wrapper reads `legacyGlobalFlagValues` (via `Effect.serviceOption`, so it's a no-op outside the real CLI tree) and falls back to it whenever a changed flag name isn't in the handler's own `flags` record. No per-command wiring needed. This gives two flag families their real value automatically, via the boolean-is-safe rule and the choice-is-safe rule (`GLOBAL_CHOICE_FLAG_NAMES` — CLI-1904) respectively:
  - Boolean globals: `--debug`, `--yes`, `--experimental`, `--create-ticket`.
  - Choice globals: `--output`, `--dns-resolver`, `--agent`.

  Both rules apply ONLY when a command's own `flags` record doesn't already declare that CLI name — a command's own flag always wins. Example: `db diff` declares its own local `output: Flag.string("output")` (a file path, not a choice) in its `flags` record, so `db diff --output diff.sql` stays redacted.

- **Proxy handlers (`LegacyGoProxy.exec`) must NOT wrap with any instrumentation.** The Go subprocess fires its own telemetry; a TS wrapper would double-count `cli_command_executed`.
- **Custom events are established behavior — do not drop, rename, or reshape them.** Beyond `cli_command_executed`, the legacy shell fires:

  | Command                                                                                                                                       | Event                   | Identity / groups                                                                                                                          |
  | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
  | `login`                                                                                                                                       | `cli_login_completed`   | `analytics.alias(gotrueId, deviceId)` after token persists                                                                                 |
  | `link`                                                                                                                                        | `cli_project_linked`    | `analytics.groupIdentify("organization", slug, …)` + `analytics.groupIdentify("project", ref, …)` after link write                         |
  | `start`                                                                                                                                       | `cli_stack_started`     | none — fired after stack health check passes                                                                                               |
  | `sso/{list,create,update,remove}`, `branches/{create,update}`, `hostnames/{create,activate,get,reverify}`, `vanity_subdomains/{activate,get}` | `cli_upgrade_suggested` | none — payload is `{feature_key, org_slug}`, fired inside billing-gate error branch (envelope-first; hostnames + vanity get envelope-only) |

  See `legacy/commands/login/` (handler + `SIDE_EFFECTS.md`) for the reference pattern.

  `link` extension (CLI-2167): when `link` resolves a branch name/UUID (`[ref-or-branch]`
  positional or `--project-ref`) to its project ref, it additionally fires `cli_project_linked`
  with `linked_via: "branch"` and `parent_project_ref` set, plus a `project` group association (no
  `groupIdentify` call, since no org/name metadata exists for a branch).

- **Tracing layer is local-only observability**, not PostHog. Span names (`legacy.<command>.<sub>`) and the NDJSON exporter never leave the user's machine. No compatibility implication.

---

## File Location Compatibility

The CLI's on-disk state locations are part of the compatibility contract: existing scripts,
dotfiles, and tooling depend on the exact paths the stable CLI has always used (`~/.supabase/…`,
`<workdir>/supabase/.temp/…`, native keyring entries). Do not move or rename these files.

While `next/` remains in this tree, a legacy command that writes state must also write to the
locations `next/` services expect to read (when they differ — they are often the same via shared
services), so state stays portable. This dual-write obligation leaves with `next/` when it moves
to its own branch.

---

## Side-effect Documentation

`SIDE_EFFECTS.md` is a **legacy-only artifact**. Do not create these files in `next/`.

Every legacy command must have a `SIDE_EFFECTS.md` in its command directory covering:

- **Files read and written** — exact paths (with `~/` or CWD-relative notation), format, when
- **API routes called** — method, path, request body shape, response shape
- **Environment variables consumed**
- **Exit codes** — including error conditions

Use the template at `src/legacy/SIDE_EFFECTS_TEMPLATE.md`. This document is the command's compatibility checklist and the primary input to the E2E test suite. Keep it accurate when changing a command's behavior.

---

## Error Classification

Every error the CLI raises carries a classification used for KPI reporting: is this failure the user's to fix, an external service problem, or a CLI bug? `shared/telemetry/error-actionability.ts` owns the closed vocabulary. Classification is declared on the error class itself and is never inferred later from message text. This applies to both shells.

**When you add an error class anywhere in `apps/cli/src`**, export it and give it an own `[ErrorActionabilityId]` getter:

```ts
export class LegacyThingMissingError extends Data.TaggedError("LegacyThingMissingError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
```

- **Reuse a preset from `actionability`** rather than assembling fields by hand: `authLogin`, `authToken`, `provideFlags`, `invalidInput`, `invalidConfig`, `dbConnection`, `dbFinding`, `migrationDrift`, `permission`, `accountAccess`, `planLimit`, `projectNotLinked`, `missingProjectRef`, `relinkProject`, `dockerNotRunning`, `startStack`, `stopStack`, `externalNetwork`, `apiStatus`, `cancelled`, `internalPanic`, `impossibleState`, `unknown`. For an error carrying a Management API status, return `statusCodeActionability(this.status)` instead of mapping status codes yourself.
- **Branch only on typed fields the error already carries** — `this.status`, a closed `reason` union, a boolean the producer set. Never parse `message`.
- **Nothing user-controlled may appear in a declaration.** The result is sent to PostHog, so no paths, SQL, project refs, hostnames, URLs, tokens, or response bodies — only closed enum values.
- **Split materially different causes with `fingerprint_suffix`**, choosing a value from `CLI_ERROR_FINGERPRINT_SUFFIXES` (module-private — extend it in place), so unrelated failures sharing one class do not group together as repeats.
- **An instance-dependent getter must stay valid when its fields are absent** — the drift guard evaluates it against a field-less probe.
- **A plain `Error` subclass (no `_tag`) also declares its fingerprint identifier**: `static readonly [ErrorActionabilityFingerprintId] = "<ExportName>"`, matching the export name exactly. Tagged errors skip this — their fingerprint comes from the tag. The static identifier is what keeps `error:` fingerprints stable in minified release builds, where `constructor.name` is renamed.

**Errors defined outside `apps/cli/src`** (`@supabase/stack`, `@supabase/config`, `@supabase/process-compose`, `@supabase/api`, `effect`) cannot carry a declaration. Add a structural adapter keyed by `_tag` to `externalActionabilityByTag` in that same module, branching on the producer's typed fields.

`error-actionability-coverage.unit.test.ts` enforces this. It scans every `TaggedError("Tag")`, every `*Error("Tag")` factory, and every `class X extends Error` under `apps/cli/src`, and fails when a class is unexported, has no own declaration, or is untagged without its matching static fingerprint identifier. A failure there is the guard working: classify the new error rather than loosening the guard, because `unknown` in production telemetry must mean a genuinely unforeseen failure, not one nobody categorized.

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

The legacy machine-format `-o`/`--output` flag (`LegacyOutputFlag`, values `env|pretty|json|toml|yaml`) is **independent** of `--output-format`. It does not change `output.format`, so a command run with `-o json` (and no `--output-format`) keeps `output.format === "text"` and the spinner gate `output.format === "text"` stays `true`. If the plain `textOutputLayer` is active, clack writes spinner ANSI (e.g. the hide-cursor `\x1b[?25l`) to **stdout** and corrupts the machine payload the handler emits via `output.raw` — exactly the CLI-1546 regression (`branches list -o json` → broken `JSON.parse`).

`legacy/cli/root.ts` therefore selects **`legacyQuietProgressTextOutputLayer`** (in `legacy/output/`) for any machine format (`json|yaml|toml|env`). It is a legacy-only wrapper over the shared `textOutputLayer` that no-ops only `task` and `progress`; everything else — `format: "text"`, `raw`, logs, and error rendering (red text on **stderr**) — delegates unchanged, so established output stays byte-identical.

Rules:

- **stdout is payload-only whenever a machine format is requested** (`-o json|yaml|toml|env` or `--output-format json|stream-json`). All progress/diagnostic output goes to stderr.
- **Do not** fix spinner-on-stdout by routing the shared spinner to stderr or otherwise editing `shared/output/output.layer.ts` — that changes `next/` text rendering. Keep the fix legacy-scoped.
- A handler reaching this path still emits its machine payload through the established encoders (`output.raw(encodeGoJson(...))` etc.), checked **before** the `output.format` branch, so output stays byte-identical — minus the spinner.

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
- `*.live.test.ts` belongs to the `live` Vitest project and is for black-box CLI subprocess tests whose asserted command reaches a real Supabase platform or project data plane — see "Live tests" below.

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
- **Hermeticity:** a test whose layer graph includes a real filesystem (`BunServices.layer`) and code that reads or writes under `RuntimeInfo.homeDir` or `TelemetryRuntime.configDir` must pin those paths to a per-test temp dir — never rely on the mock defaults (`mockRuntimeInfo` / `mockTelemetryRuntime` default to a path that is intentionally never created). Use `useLegacyTempWorkdir` for the temp dir, and `legacyIsolatedHomeLayer` (in `tests/helpers/legacy-mocks.ts`) when the test builds the real `legacyCliSettingsLayer` / `legacyCredentialsLayer`, since those also resolve `SUPABASE_HOME` / `SUPABASE_PROFILE` / tokens from ambient `process.env`.
- **Forbidden pattern (do not add):** spawning the CLI to assert that `--help` renders a flag. Help text is dynamic over flag wiring and is exercised by the integration test's flag parser. The two backups e2e files removed alongside this guidance update are the canonical example of what not to write.

### Live tests (`*.live.test.ts`)

Live tests are black-box CLI subprocess tests whose asserted command reaches a
real Management API, its suite-owned project, or that project's data plane.
They are serial, explicit, and expensive; keep them to one golden path per
command. The file name selects the live Vitest project and the file imports one
extended fixture as `test` from `tests/helpers/live.ts`:

```ts
import { expect } from "vitest";
import { test } from "../../../../../tests/helpers/live.ts";

test("lists projects", async ({ cli, project }) => {
  const result = await cli(["projects", "list", "--output-format", "json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain(project.ref);
});
```

Global setup requires `SUPABASE_LIVE_API_URL` and `SUPABASE_ACCESS_TOKEN`,
provisions one disposable project through the typed Effect `@supabase/api`
client, waits for `ACTIVE_HEALTHY`, resolves project wiring, writes a temporary
YAML profile, and shares it across the serial suite. Teardown deletes exactly
that project and the temporary profile. Supabox, a Docker-hosted API platform,
and staging are interchangeable; changing the URL and token retargets the
run. `SUPABASE_LIVE_KEEP_PROJECT=1` keeps the project for debugging.
`SUPABASE_LIVE_API_URL` configures the Management API only; tenant data-plane
URLs retain the profile contract `https://<ref>.<project_host>`, with
`project_host` derived from the provisioned project's database host.

Local Docker-stack lifecycle tests (`start`, `stop`, `status`, `db start`,
`db diff`, declarative sync, and `functions dev`) are `*.e2e.test.ts`, use
`runSupabase` plus the existing e2e stack cleanup, and require no platform
credentials. `functions deploy` remains live because its assertion is remote
deployment and invocation, even though Docker is a runner prerequisite.

Setup/teardown may invoke other commands, but assertions stay focused on the
one command named by the test. The live workflow runs one serial attempt with a
20-minute bound, retains Docker preflight, and sweeps only projects owned by
that run after crashes.

---

## Compatibility Docs

- [`docs/go-cli-porting-status.md`](./docs/go-cli-porting-status.md) documents the residual Go
  delegation surface. Update it only when that surface shrinks (a wrapper is replaced natively or
  removed).
- [`docs/go-cli-divergences.md`](./docs/go-cli-divergences.md) is a **frozen historical record** of
  where the TS port intentionally diverged from the old Go CLI. Do not add new entries — new
  flags and features are simply new CLI behavior, documented through help text, tests, and
  `SIDE_EFFECTS.md` like anything else.

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

The remnants of the [old Go Supabase CLI](https://github.com/supabase/cli). It contains **only**
the residual delegation surface (the still-proxied commands listed in
[`docs/go-cli-porting-status.md`](./docs/go-cli-porting-status.md)) and is slated for cleanup and
eventual removal. It is not a reference for anything else — consult it only when maintaining a
proxied command's flag definition, which must keep matching the Go binary it forwards to. For the
history of any deleted Go command source, use the pinned commits `7b469f5b3` (general) and
`a253ccba2` (`internal/start`).
