import { Data, Runtime } from "effect";

/**
 * A spawned `supabase-go` child process — via `LegacyGoProxy.exec`/`execCapture`,
 * or the hidden `db __db-bootstrap` seam (`legacy-db-bootstrap.seam.layer.ts`) —
 * exited non-zero, or could not be spawned at all (binary not found).
 *
 * Carries the child's exact exit code through Effect's `Runtime.errorExitCode`
 * marker, so both `runCli` (`shared/cli/run.ts`, text mode) and
 * `withJsonErrorHandling` (`shared/output/json-error-handling.ts`, `json`/
 * `stream-json` mode) map the process's own exit code to this EXACT number —
 * not a generic `1` — and only AFTER every `Effect.ensuring` finalizer between
 * the call site and there has already run (telemetry flush, command
 * instrumentation). Calling `ProcessControl.exit()` directly from deep inside a
 * handler skips those finalizers entirely (`process.exit()` halts the process
 * before the Effect runtime can unwind the remaining scopes) — this error type
 * lets the child's status flow through the normal Effect failure channel
 * instead, all the way up to the single `ProcessControl.exit()` call `runCli`
 * itself makes once finalizers are done. See CLI-1879.
 *
 * `runCli`'s `handledProgram` special-cases this exact class (an `instanceof`
 * check, not a shared Effect marker) to skip its generic `output.fail` stderr
 * line in text mode — the child already wrote its own detailed failure (or,
 * for the not-found case, `LegacyGoProxy`'s own specific diagnostic) to the
 * parent's inherited stderr, and Go itself never prints a second, generic line
 * on top of that. This is deliberately NOT keyed on Effect's shared
 * `[Runtime.errorReported]` marker: `CliError.ShowHelp` also sets that marker
 * to `false` for an unrelated reason (the CLI framework already rendered
 * help/usage text), and gating on the marker there would ALSO suppress
 * `normalizeCause`'s Go-parity rendering for a `MissingOption` wrapped in
 * `ShowHelp` (e.g. `Error: required flag(s) "type" not set`) — a real parity
 * regression. `withJsonErrorHandling` has no such collision (it runs upstream
 * of `runCli`, catching every error uniformly) and still emits the structured
 * JSON error envelope for this error like any other.
 *
 * The envelope's `message` is deliberately generic (`"supabase-go exited with
 * code N (see stderr for details)"`) rather than the child's specific failure
 * reason: the child's real detail is on stderr (see above), which a
 * machine-output consumer reading only stdout won't see — this is an accepted,
 * TS-only tradeoff (Go itself has no JSON error-envelope concept to match
 * against here), not a parity gap.
 *
 * Invariant: `exitCode` must be a real non-zero child exit status (1-255,
 * matching `ChildProcessSpawner.ExitCode`'s POSIX range), never `0` — every
 * construction site guards on `exitCode !== 0` (or hardcodes `1` for the
 * binary-not-found case) before constructing this error, since a `0` here
 * would be a failure that both `runCli` and `withJsonErrorHandling` read back
 * as a *successful* exit.
 */
export class LegacyGoChildExitError extends Data.TaggedError("LegacyGoChildExitError")<{
  readonly exitCode: number;
  readonly message: string;
}> {
  override readonly [Runtime.errorExitCode] = this.exitCode;
}
