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

1. **Reconstruct the command definition** — flags, subcommands, and argument types must exactly match the Go CLI (use `.repos/supabase-cli-go/` as the reference).
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

## Legacy Port: Go CLI Output Parity

The legacy shell is a **strict 1:1 port** — not a redesign. The compatibility contract covers:

- Same command paths and flag names
- Same stdout/stderr text, including spacing, casing, and newlines
- Same filesystem side effects (files read and written)
- Same API routes and request shapes
- Same exit codes

When in doubt about expected output or behavior, run the equivalent command against the Go CLI reference at `.repos/supabase-cli-go/` and match it exactly.

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

### `.repos/supabase-cli-go/`

The [old Supabase CLI](https://github.com/supabase/cli) written in Go. When porting a command to the legacy shell, use this as the authoritative source for expected output, flags, and behavior. Match it exactly.
