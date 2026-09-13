# CLI Agent Guide

This file applies to the `apps/cli` workspace. Read it fully before touching code here. The
repository root [`AGENTS.md`](../../AGENTS.md) owns common Effect, quality, package, and testing
rules, including the [comment policy](../../AGENTS.md#comments); this guide records contracts
specific to the CLI.

## Source tree and ownership

Keep top-level commands in `src/commands/`, shared command-family
helpers in the family directory, cross-family helpers in `src/command-internal/`, and universal
infrastructure in `src/shared/`. The entrypoint is `src/main.ts` → `src/cli/root.ts` → commands.

Keep opt-in command implementations under `src/commands/experimental/` (for example, `compute/`
and `stack/`). This folder organizes source code; it does not register an `experimental` command
namespace. `src/cli/root.ts` owns the public command tree and feature-flag registration.

Use the existing command shape:

```text
src/commands/<command>/
  <command>.command.ts   # command definition, flags, layer provision
  <command>.handler.ts   # command implementation
  <command>.errors.ts    # domain errors
  SIDE_EFFECTS.md        # required compatibility contract
```

Register every command in `src/cli/root.ts`. Keep `.format.ts` and `.encoders.ts` pure. Use
`Effect.fn` for exported command handlers and `Effect.fnUntraced` for small internal helpers;
tracing is local observability and span names follow `<command>.<sub>`. Read `src/shared/` and the
command-level infrastructure under
`src/config/`, `src/auth/`, `src/telemetry/`, `src/output/`, and `src/command-internal/` before
adding an equivalent helper.

### Hoist Before You Duplicate

When two commands need the same responsibility, share it at the narrowest common owner. Hoist
only when a second concrete consumer exists, and move existing call sites together when the
responsibility should evolve as one. Do not automatically extract every helper used twice.

Config validation has one home: `src/command-internal/config-validate.ts` and
`validateResolvedConfig`. Both config pipelines use it; extend the parity test when shared
validation changes. `resolveEmailTemplateContentPath` rejects absolute paths, traversal, and
symlinks escaping the project root; every `content_path` consumer gets this containment.

## CLI compatibility

The established CLI surface is a contract: command paths, flags, output text and streams,
filesystem paths, API routes and request shapes, exit codes, and telemetry event timing and
payloads. Use current tests, command `SIDE_EFFECTS.md`, and shipped behavior as the source of
truth. Update tests and side-effect documentation with intentional behavior changes.

State locations are also public: preserve `~/.supabase/…`, `<workdir>/supabase/.temp/…`, and
native keyring entries. Do not move or rename them.

Every command has a `SIDE_EFFECTS.md` based on the [template](src/SIDE_EFFECTS_TEMPLATE.md), documenting exact
files and formats, API calls and shapes, environment variables, and exit codes. Keep it accurate;
it is the command compatibility checklist and an input to E2E coverage.

Every applicable command must preserve these invariants:

1. `linkedProjectCache.cache(ref)` and `telemetryState.flush` run through `Effect.ensuring`, on
   success and failure. Follow the pattern in `commands/backups/list/list.handler.ts`.
2. Text-mode errors use `Output.fail` on stderr and retain the suggestion when `--debug` is unset;
   do not restore clack frames.
3. The HTTP debug layer logs every request on stderr in the established timestamp format.
4. `SUPABASE_PROFILE` accepts built-in names and YAML files using the
   [profile loader's schema](src/command-internal/profile-load.ts). Both the
   [E2E harness](../../packages/cli-test-helpers/src/harness.ts) and
   [live fixture](tests/helpers/live.ts) depend on file-path mode.
5. Sibling layers in `Layer.mergeAll` each receive required services explicitly. Every production
   effect graph retaining `promptYesNo`'s `Stdin` requirement provides `stdinLayer`, even when
   runtime guards avoid its non-TTY branch. Paths that can enter that branch require a CLI build
   and a targeted piped-input binary test; handler-only tests do not prove this wiring.
6. Honor both output flags. `-o`/`--output` takes precedence over
   `--output-format`; a new command may reject `--output` with guidance to use
   `--output-format`, as established by `config diff` and `config pull`.
7. Preserve telemetry names, timing, identity, and payloads; see [Telemetry](#telemetry).

## Experimental feature registration

Resolve opt-in booleans with `command-internal/experimental-feature.ts`: environment `1`/`0`
overrides the project setting, and an unset or empty value uses the config. Invalid environment
values are typed failures on applicable command paths. Disabled families are absent from the
command tree, help, and completion; enabled help is marked experimental and stays out of stable
generated command documentation. Environment opt-ins do not write project configuration.
Keep config-discovery failure policy explicit and cover TOML, JSON, precedence, and disabled
behavior.

Experimental paths may change outside the stable compatibility promise, but before renaming a
family identify published config, disk, server, and telemetry boundaries and record the approved
compatibility decision in the PR. For the Compute transition, no local compatibility aliases or
migrations are required. Compute error tags intentionally start new fingerprints; server-owned
contracts remain unchanged. Update tests, generated schemas, and side-effect documentation.

## Go delegation

- TypeScript owns CLI behavior. Consult `apps/cli-go` only for existing delegated
  operations listed in [the delegation document](docs/go-cli-porting-status.md); do not expand delegation.
- Native replacements must preserve the public command, flags, output, side effects,
  and exit behavior. Update the delegation document when removing a Go dependency.
- Emit command telemetry exactly once: bare proxies rely on Go telemetry;
  instrumented TypeScript handlers suppress child telemetry.

## Telemetry

> The string passed to `Data.TaggedError("...")` is the PostHog `error_fingerprint` identity
> (`tag:<TagName>`); preserve it when renaming classes.
> [`src/shared/telemetry/error-tag-stability.unit.test.ts`](src/shared/telemetry/error-tag-stability.unit.test.ts)
> compares every CLI and `@supabase/config` tag with the committed snapshot.

Native commands use `withCommandTelemetry` from `telemetry/command-telemetry.ts`, not shared
`withCommandInstrumentation`; pass the handler's `flags`, and pass its own `config` when it has
choice flags. Preserve the established property shape (`flags`, `is_agent`, and `env_signals`),
use canonical names and keys from the [event catalog](src/shared/telemetry/event-catalog.ts), and redact sensitive values.

`safeFlags` may include only values that carry no user data. Keep the established safe project,
project-id, org-id, and version cases. When `--project-ref` also accepts branch names, whitelist
only values matching `PROJECT_REF_PATTERN`; never log a user-created branch name. Global boolean
and choice flags are resolved by the wrapper from `globalFlagValues`; a command-local flag wins,
so a local path-valued `--output` remains redacted. Keep free-form user content redacted.

Do not remove, rename, or reshape custom events. Preserve login aliasing after token persistence,
link project and organization identity after the link write (including branch-link metadata),
stack-started after health succeeds, and upgrade-suggested billing-gate events with their existing
envelope and payload semantics. Use the catalog and the relevant command `SIDE_EFFECTS.md` for
the complete current event contract.

## Error classification

`src/shared/telemetry/error-actionability.ts` owns the closed actionability vocabulary. Export every
new error class in `apps/cli/src` and give it its own `[ErrorActionabilityId]` getter, using an
existing typed preset or `statusCodeActionability(this.status)`. Branch only on fields the error carries;
never parse messages. Declarations contain no user-controlled paths, SQL, refs, hosts, URLs,
tokens, or response bodies. Use the module's closed fingerprint suffixes for materially distinct
causes, and keep getters valid for field-less probes.

Plain `Error` subclasses declare `static readonly [ErrorActionabilityFingerprintId]` equal to the
export name; tagged errors use their tag. Errors from `@supabase/stack`, `@supabase/config`,
`@supabase/api`, or Effect use a typed `_tag` adapter in `externalActionabilityByTag`. Treat
`error-actionability-coverage.unit.test.ts` failures as missing classification, not as a reason to
loosen the guard.

## Output

`--output-format` has text and machine-readable modes. Every handler supports all configured modes.
In machine modes, emit structured results and keep stdout machine-readable. Wrap asynchronous API
work in `output.task`; it is a no-op when progress is suppressed, and failures must fail the task.

The `-o`/`--output` machine-format flag is independent of `--output-format`. For machine
formats, `cli/root.ts` selects `quietProgressTextOutputLayer`: it suppresses only task/progress
while delegating text format, raw payloads, logs, and stderr error rendering to the established
text layer. Therefore stdout is payload-only for either machine flag. Do not change the shared text
layer to move spinners; that would change text output globally. Handlers check `--output` first and
use established encoders before the `output.format` branch.

## Tests

Follow the root testing philosophy and use the package scripts in `package.json`. Cover meaningful
command outcomes and failures; do not add assertions solely to reach a coverage percentage. Run
relevant unit and integration tests for changed behavior, and use targeted E2E only when the
subprocess boundary is part of the behavior. Keep help-text coverage in integration tests through
the flag parser, never a subprocess smoke test.

Keep CLI tests hermetic: real filesystem layers that use `RuntimeInfo.homeDir` or
`TelemetryRuntime.configDir` pin per-test temp paths with `useTempWorkdir`; real command settings
or credentials layers also use `isolatedHomeLayer` so ambient `SUPABASE_HOME`, `SUPABASE_PROFILE`,
and tokens cannot leak.

Use `*.unit.test.ts` for pure logic and narrow edge cases, `*.integration.test.ts` for handlers and
service behavior with realistic layered replacements, `*.e2e.test.ts` for local subprocess and
Docker-stack behavior, and `*.live.test.ts` only when the command reaches the real platform or
data plane. Live tests use the existing `tests/helpers/live.ts` fixture and its suite-owned project
and resources. They require `SUPABASE_LIVE_API_URL` and `SUPABASE_ACCESS_TOKEN`; set
`SUPABASE_LIVE_KEEP_PROJECT=1` only when retaining the project for debugging. The setup and
tenant-host details live in [`tests/helpers/live-env.ts`](tests/helpers/live-env.ts) and
[`tests/helpers/live-project.ts`](tests/helpers/live-project.ts). Keep one explicit golden path per
command, run serially, and clean up exactly what the suite owns. Local Docker E2E needs no platform
credentials; `functions deploy` and `functions download` remain live despite Docker being a
runner prerequisite.

From `apps/cli`, use `pnpm dev <args>` to run `src/main.ts`. For production layer changes, run
`pnpm exec turbo run supabase#build` from the repository root, then smoke-test `apps/cli/dist/supabase`.
Do not run the full E2E suite automatically.
