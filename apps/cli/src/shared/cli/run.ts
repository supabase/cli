import { BunServices } from "@effect/platform-bun";
import { ProjectConfigStore } from "@supabase/config";
import { unixHttpClientLayer } from "@supabase/stack/effect";
import { Cause, Console, Effect, Exit, Fiber, Layer, Runtime, Stdio } from "effect";
import { CliError, CliOutput, Command } from "effect/unstable/cli";
import { CLI_VERSION } from "./version.ts";
import { Credentials } from "../../next/auth/credentials.service.ts";
import { jsonCliOutputFormatter } from "../output/json-formatter.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";
import { outputLayerFor } from "../output/output.layer.ts";
import { normalizeCause } from "../output/normalize-error.ts";
import type { OutputFormat } from "../output/types.ts";
import { Output } from "../output/output.service.ts";
import { LegacyGoChildExitError } from "../legacy/legacy-go-child-exit.error.ts";
import { cliConfigLayer } from "../../next/config/cli-config.layer.ts";
import { projectHomeLayer } from "../../next/config/project-home.layer.ts";
import { ProjectLocalServiceVersions } from "../../next/config/project-local-service-versions.service.ts";
import { projectContextLayer } from "../../next/config/project-context.layer.ts";
import { projectLinkStateLayer } from "../../next/config/project-link-state.layer.ts";
import { processControlLayer } from "../runtime/process-control.layer.ts";
import { runtimeInfoLayer } from "../runtime/runtime-info.layer.ts";
import { ttyLayer } from "../runtime/tty.layer.ts";
import { CommandRuntime } from "../runtime/command-runtime.service.ts";
import { ProcessControl } from "../runtime/process-control.service.ts";
import type { Analytics } from "../telemetry/analytics.service.ts";
import { aiToolLayer } from "../telemetry/ai-tool.layer.ts";
import { AiTool } from "../telemetry/ai-tool.service.ts";
import { telemetryRuntimeLayer } from "../telemetry/runtime.layer.ts";
import { tracingLayer } from "../telemetry/tracing.layer.ts";
import { CliArgs } from "./cli-args.service.ts";
import { resolveAgentOutputFormatFromArgs } from "./agent-output.ts";
import type { CliErrorSuggestionContext } from "./subcommand-flag-suggestions.ts";
import { flagAliasesFor, isValueTakingFlagTokenFor } from "./subcommand-flag-suggestions.ts";

// Global flags that consume the following argv token as their value. Keep this in
// sync with the value-taking global flags defined in `shared/cli/global-flags.ts`
// and `legacy/shared/legacy/global-flags.ts`: a value flag missing here would make
// `extractCommandPath` mistake its value for a command-path segment.
const globalFlagsWithValues = new Set([
  "--output-format",
  "--output",
  "-o",
  "--profile",
  "--workdir",
  "--network-id",
  "--dns-resolver",
  "--agent",
]);

// Commands that run their own foreground signal loop (serve/start daemons) and must
// NOT be wrapped in the global signal-interrupt handler, which would otherwise race
// their graceful shutdown. Matched by leading command-path segments.
//
// Top-level `start` (["start"]) is deliberately NOT listed here: it used to proxy to the
// Go binary, which managed SIGINT/SIGTERM itself, but the native TypeScript `legacyStart`
// installs no signal handling of its own — excluding it left Ctrl-C mid-bring-up as a raw,
// unhandled OS signal that hard-kills the process, skipping every Effect finalizer
// including `legacyRollbackStart`. Go's own `start` DID roll back on SIGINT
// (`cmd/root.go:99,155` wraps every command's context with `signal.NotifyContext`;
// formerly `internal/start/start.go:73-82`, which rolled back on any non-nil `run()`
// error, including the `context.Canceled` a SIGINT produces — internal/start was
// deleted as unreachable in CLI-1966, last present at commit a253ccba2), so native
// `start` must participate in the global
// wrapper to match. This list is matched purely against argv command-path segments — it has
// no notion of which shell (legacy vs next) registered the matching command, so `next start`
// (a completely different command tree that happens to share the literal path `["start"]`)
// needs its OWN exemption, passed via `RunCliOptions.additionalSelfManagedSignalCommands` from
// `next/cli/main.ts` — see that call site's comment for why.
//
// `["db", "start"]` (top-level `db start`) is ALSO deliberately not listed here, for the exact
// same reason as `start` above: it used to proxy container bootstrap to the hidden Go
// `db __db-bootstrap --mode start` seam, which held SIGINT/SIGTERM itself, but CLI-1954's
// native port (`legacy/commands/db/start/start.handler.ts` -> `legacyStartDatabase`) installs
// no signal handling of its own — it relies on the SAME `Effect.onError(() =>
// legacyRollbackStart(...))` wrapper `supabase start` uses, which only ever fires when this
// process's own fiber is interrupted (by `Fiber.interrupt` below, or by an ordinary typed
// failure) — a raw, unhandled OS signal skips it entirely, exactly like the `start` case above.
//
// `["db", "reset"]` was ALSO listed here once, for the same reason `db start` used to be:
// its local path drove the hidden `db __db-bootstrap --mode recreate`/`--mode await-storage`
// seam via a bespoke DIRECT `ChildProcess.make` spawn (not through `LegacyGoProxy`), which
// held SIGINT/SIGTERM/SIGHUP itself while the Go child recreated the container — the global
// handler's own `Fiber.interrupt` would otherwise race that child's Docker cleanup and lose
// its real exit status. CLI-1955 removed that seam entirely: `db reset --local` is now fully
// native TS (`legacy/shared/db-bootstrap/recreate-local-database.ts`), installing no signal
// handling of its own. Its only remaining Go child is the niche `--experimental` remote
// delegate, via the SAME `LegacyGoProxy.exec`/`execCapture` every other unlisted legacy
// command already uses safely alongside this global handler — so `db reset` was removed from
// this list too, matching `db start`'s own precedent exactly.
const selfManagedSignalCommands: ReadonlyArray<ReadonlyArray<string>> = [["functions", "serve"]];

/** Positional command-path tokens from argv, skipping global flags and their values. */
export function extractCommandPath(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const commandArgs: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("-")) {
      const [flag] = arg.split("=", 1);
      if (!arg.includes("=") && flag !== undefined && globalFlagsWithValues.has(flag)) {
        index += 1;
      }
      continue;
    }
    commandArgs.push(arg);
  }
  return commandArgs;
}

/** Whether argv sets the ROOT `--version`/`-v` flag — not a subcommand's flag of the same name, and not a token consumed as a value-taking global flag's value (`--profile -v`). */
export function hasRootVersionFlag(args: ReadonlyArray<string>): boolean {
  if (extractCommandPath(args).length > 0) return false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--version" || arg === "-v") return true;
    if (!arg.startsWith("-")) continue;
    const [flag] = arg.split("=", 1);
    if (!arg.includes("=") && flag !== undefined && globalFlagsWithValues.has(flag)) {
      index += 1;
    }
  }
  return false;
}

/** Whether the global signal-interrupt handler should wrap this invocation. */
export function shouldUseGlobalSignalInterrupt(
  args: ReadonlyArray<string>,
  additionalSelfManagedCommands: ReadonlyArray<ReadonlyArray<string>> = [],
): boolean {
  const commandPath = extractCommandPath(args);
  return ![...selfManagedSignalCommands, ...additionalSelfManagedCommands].some((command) =>
    command.every((segment, index) => commandPath[index] === segment),
  );
}

function formatterLayerFor(
  rootCommand: Command.Command.Any,
  args: ReadonlyArray<string>,
  format: OutputFormat,
) {
  const context = { rootCommand, args };
  return format === "json" || format === "stream-json"
    ? CliOutput.layer(jsonCliOutputFormatter(context))
    : CliOutput.layer(textCliOutputFormatter(context));
}

/**
 * Process exit code for a failed CLI run, matching Go cobra's exit-code
 * mapping. Delegates to Effect's own `Runtime` exit-code protocol (the same
 * one `Runtime.defaultTeardown` uses) rather than hand-rolling `ShowHelp`
 * classification: `CliError.ShowHelp` declares
 * `[Runtime.errorExitCode] = this.errors.length ? 1 : 0`, so a bare group
 * command's default handler failing with `ShowHelp({ errors: [] })` (no
 * subcommand given, e.g. `supabase branches`) reads as exit `0` here — matching
 * Go cobra's non-`Runnable()` handling, which internally returns
 * `flag.ErrHelp` and `ExecuteC()` maps that to "print help, return nil error".
 * A `ShowHelp` with a non-empty `errors` array (a genuine parse/validation
 * failure) reads as exit `1`, and any other failure (including a `Cause.die`
 * defect with no typed `ShowHelp` marker at all) falls back to
 * `Runtime.getErrorExitCode`'s default of `1`. An explicit `--help` invocation
 * never reaches this function — it's handled earlier as a successful
 * `GlobalFlag.Action` and exits 0 via the success path.
 */
export function exitCodeForFailure(cause: Cause.Cause<unknown>): number {
  if (Cause.hasInterruptsOnly(cause)) return 130;
  return Runtime.getErrorExitCode(Cause.squash(cause));
}

/**
 * Whether `handledProgram` should render its generic `output.fail` stderr line
 * for a failed run, given the run's cause and the exit code `exitCodeForFailure`
 * already computed for it. False for a clean exit (`0`), an interrupt (`130`),
 * and a `LegacyGoChildExitError` (CLI-1879) — a delegated Go child already wrote
 * its own detailed failure to the inherited stderr, so a second generic line
 * here would be a line Go itself never prints.
 *
 * Checked by concrete type, NOT Effect's shared `[Runtime.errorReported]`
 * marker: `CliError.ShowHelp` also sets that marker to `false`, for an
 * unrelated reason (the CLI framework already rendered help/usage text) —
 * gating on the marker would ALSO suppress `normalizeCause`'s Go-parity
 * rendering for a `MissingOption` wrapped in `ShowHelp` (e.g. `Error: required
 * flag(s) "type" not set`), a real parity regression. See the test suite for
 * the regression this guards.
 */
export function shouldReportFailure(cause: Cause.Cause<unknown>, exitCode: number): boolean {
  if (exitCode === 0 || exitCode === 130) return false;
  return !(Cause.squash(cause) instanceof LegacyGoChildExitError);
}

/**
 * A single `Console.log`/`Console.error` call captured while
 * `withoutParseErrorHelpDump` runs, so it can be replayed once the run's
 * outcome is known instead of being written immediately.
 */
interface BufferedConsoleWrite {
  readonly method: "log" | "error";
  readonly args: ReadonlyArray<unknown>;
}

/**
 * A `Console.Console` that captures `log`/`error` calls into `sink` instead
 * of writing them, and forwards every other method straight through to the
 * real console. The vendored `effect` CLI library's parser only ever calls
 * `log`/`error` (`showHelp()` and the `Help`/`Version`/`Completions`
 * `GlobalFlag.Action`s in `Command.ts`) — the rest are implemented so this
 * stays a faithful `Console.Console` rather than a partial stand-in.
 */
function bufferingConsole(sink: Array<BufferedConsoleWrite>): Console.Console {
  const real = globalThis.console;
  return {
    assert: real.assert.bind(real),
    clear: real.clear.bind(real),
    count: real.count.bind(real),
    countReset: real.countReset.bind(real),
    debug: real.debug.bind(real),
    dir: real.dir.bind(real),
    dirxml: real.dirxml.bind(real),
    error: (...args: ReadonlyArray<unknown>) => {
      sink.push({ method: "error", args });
    },
    group: real.group.bind(real),
    groupCollapsed: real.groupCollapsed.bind(real),
    groupEnd: real.groupEnd.bind(real),
    info: real.info.bind(real),
    log: (...args: ReadonlyArray<unknown>) => {
      sink.push({ method: "log", args });
    },
    table: real.table.bind(real),
    time: real.time.bind(real),
    timeEnd: real.timeEnd.bind(real),
    timeLog: real.timeLog.bind(real),
    trace: real.trace.bind(real),
    warn: real.warn.bind(real),
  };
}

/**
 * How `withoutParseErrorHelpDump` should dispose of its buffered
 * `Console.log`/`Console.error` writes, given how the wrapped effect failed:
 *
 * - `"flush-unchanged"` — success, or a "clean" `ShowHelp` (`errors: []` —
 *   an explicit `--help` or a bare group command with no subcommand, both
 *   of which map to exit `0` per `exitCodeForFailure` above), or any other
 *   failure. Those buffered writes (if any, there normally are none outside
 *   the two `ShowHelp` cases) are the actual intended output.
 * - `"drop"` — a genuine parse/validation failure Go cobra's
 *   `PersistentPreRunE` already suppresses usage for: `ValidateRequiredFlags`
 *   (cobra `command.go:1007`), which sets `cmd.SilenceUsage = true`
 *   (`apps/cli-go/cmd/root.go:97`) BEFORE it runs. This library's
 *   `MissingOption` is the one tag that maps to that stage — see CLI-1901 —
 *   but ONLY when the flag was never given at all. A required flag that IS
 *   present on argv but missing its value (e.g. `sso add --type` with
 *   nothing after it) also raises `MissingOption` in this library (it has no
 *   distinct "value required" tag), yet Go's own pflag raises a DIFFERENT,
 *   earlier `ParseFlags`-time error for that input (`flag needs an
 *   argument: --type`) which does NOT get `SilenceUsage` treatment — verified
 *   against the real binary (`apps/cli-go/supabase-go sso add --type`: full
 *   usage block on stderr, vs `sso add --project-ref x` with `--type` never
 *   mentioned at all: bare `required flag(s) "type" not set`, no usage). See
 *   `isMissingFlagTokenPresent` below for how this case is distinguished from
 *   a genuinely-absent flag.
 * - `"flush-help-doc-to-stderr"` — every other genuine parse/validation
 *   failure (`UnrecognizedOption`, `InvalidValue`, `MissingArgument`,
 *   `UnknownSubcommand`; multiple simultaneous errors also lands here).
 *   These map to cobra's `ParseFlags`/`ValidateArgs` (`command.go:919,968`),
 *   which run BEFORE `PersistentPreRunE` — Go still shows a usage block for
 *   these, just on stderr, never stdout (verified against the real
 *   `apps/cli-go/supabase-go` binary, e.g. `branches --bogus-flag` and
 *   `sso add --type bogus`). The help doc this library renders isn't
 *   byte-identical to cobra's shorter usage template (that would need a
 *   second formatter, out of scope for CLI-1901), but showing SOME usage
 *   content on the RIGHT stream is closer to Go than showing none at all.
 *
 * In every "genuine failure" case, the buffered `Console.error` write (the
 * library's own duplicate render of the errors) is always dropped — this
 * repo's own `handledProgram` + `normalizeCause` already render the single
 * Go-parity line for it (see `withoutParseErrorHelpDump` below).
 */
export type ParseErrorConsoleDisposition = "flush-unchanged" | "drop" | "flush-help-doc-to-stderr";

/**
 * Whether `option`'s canonical long-form flag token (`--option` or
 * `--option=...`), or one of its short/long `aliases` (e.g. `-t`), appears
 * anywhere in the raw argv this run was invoked with BEFORE the `--`
 * operand terminator (if any) — used to tell a genuinely-absent required
 * flag (Go: `SilenceUsage`-suppressed) apart from one that's present but
 * missing its value (Go: a `ParseFlags`-time error, usage still shown). See
 * the `"drop"` case on `ParseErrorConsoleDisposition` above for the full
 * rationale. `aliases` come from `flagAliasesFor` (see
 * `classifyParseErrorConsoleOutput` below), already formatted with their
 * leading dash(es).
 *
 * Tokens after a literal `--` are always positional operands, never a flag
 * occurrence for ANY option — this mirrors the vendored `effect` CLI
 * library's own lexer, which treats `--` the same way (`internal/lexer.ts`,
 * `argv.indexOf("--")`). Without this cutoff, a command like
 * `migration repair -- 20230101000000 --status` (a required `Flag.choice`,
 * `legacy/commands/migration/repair/repair.command.ts`) would have its
 * trailing `--status` positional argument misread as evidence the `--status`
 * flag was given, flipping a genuinely-absent-flag failure (Go: no usage
 * shown) into a "present but missing its value" one (Go: usage shown) — see
 * CLI-1901.
 *
 * That `--` cutoff is only genuine when the scan reaches `--` as a LIVE
 * token, not when it was itself consumed as the VALUE of an immediately
 * preceding value-taking flag. Go/pflag's `parseArgs` (`flag.go`) only
 * recognizes `--` as the terminator when it's at the FRONT of the remaining
 * args on a fresh iteration; `parseLongArg`'s value branch pops the very
 * next raw token with no shape check at all, so a literal `--` right after a
 * value-taking flag gets swallowed as that flag's value and never reaches
 * the terminator check — e.g. `sso add --project-ref -- --type` hands the
 * literal string `--` to `--project-ref`, and parsing resumes normally on
 * `--type` (which then fails with pflag's OWN `ValueRequiredError` — a
 * `ParseFlags`-time error, usage still shown — since nothing follows it).
 * The scan below therefore folds the terminator check into the very same
 * loop that already skips consumed-value tokens, rather than precomputing
 * `args.indexOf("--")` up front — a Codex review finding on CLI-1901.
 *
 * `isValueTakingToken` (from `isValueTakingFlagTokenFor`, OR'd with
 * `globalFlagsWithValues` at the `classifyParseErrorConsoleOutput` call site
 * below) lets the scan skip a token immediately consumed as the VALUE of a
 * preceding value-taking flag — local OR global — instead of mistaking that
 * consumed token (or a consumed literal `--`, per above) for `option`'s own
 * occurrence. Go/pflag's `parseLongArg` (`flag.go`) unconditionally consumes
 * the very next argv entry as a value-taking flag's value, even when that
 * entry itself looks like another flag — e.g. `sso add --project-ref --type`
 * hands the literal string `--type` to `--project-ref`, so `--type` is never
 * seen as its own occurrence in Go, and its `MissingOption` failure keeps
 * Go's `SilenceUsage` treatment (no usage shown). The vendored `effect`
 * parser does NOT replicate that eager consumption (it only treats a
 * following token as a value when the lexer tags it `Value`, never a
 * flag-shaped token — `internal/parser.ts`'s `consumeFlagValueWithTokens`),
 * so without this skip the raw scan would find the literal `--type` token
 * and wrongly flush the help doc for an input Go shows no usage for — a
 * Codex review finding on CLI-1901.
 */
function isMissingFlagTokenPresent(
  option: string,
  args: ReadonlyArray<string>,
  aliases: ReadonlyArray<string> = [],
  isValueTakingToken: (token: string) => boolean = () => false,
): boolean {
  const tokens = [`--${option}`, ...aliases];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    // A literal "--" only terminates flag parsing when reached as a LIVE
    // token here — if the previous iteration already skipped it as a
    // value-taking flag's consumed value (below), this line never runs for
    // it, matching pflag's own ordering (see the doc comment above).
    if (arg === "--") break;
    if (tokens.some((token) => arg === token || arg.startsWith(`${token}=`))) return true;
    const equalIndex = arg.indexOf("=");
    const bareToken = equalIndex === -1 ? arg : arg.slice(0, equalIndex);
    if (equalIndex === -1 && isValueTakingToken(bareToken)) {
      // Go/pflag consumes the following argv entry as `bareToken`'s value
      // unconditionally — even a literal "--" — so skip it here too, before
      // the next iteration's terminator check ever sees it.
      index++;
    }
  }
  return false;
}

export function classifyParseErrorConsoleOutput(
  cause: Cause.Cause<unknown>,
  context: CliErrorSuggestionContext,
): ParseErrorConsoleDisposition {
  const error = Cause.squash(cause);
  if (!CliError.isCliError(error) || error._tag !== "ShowHelp" || error.errors.length === 0) {
    return "flush-unchanged";
  }
  // `isValueTakingFlagTokenFor` only inspects the resolved LEAF command's own
  // flags, so it has no visibility into value-taking GLOBAL flags (`--network-id`,
  // `--profile`, etc. — see `globalFlagsWithValues` above). Without OR-ing those
  // in, a global value flag consuming the very next token (e.g.
  // `migration repair --network-id --status --local <version>` handing the
  // literal `--status` to `--network-id`, per pflag's `parseLongArg`) would
  // leave the required `status` flag looking "present" to the scan below, even
  // though Go/pflag never sees it as its own occurrence and suppresses usage
  // for it (`SilenceUsage`) — a Codex review finding on CLI-1901.
  const isLeafValueTakingToken = isValueTakingFlagTokenFor(context.rootCommand, error.commandPath);
  const isValueTakingToken = (token: string) =>
    globalFlagsWithValues.has(token) || isLeafValueTakingToken(token);
  const isSuppressedMissingFlag = (inner: (typeof error.errors)[number]) =>
    inner._tag === "MissingOption" &&
    !isMissingFlagTokenPresent(
      inner.option,
      context.args,
      flagAliasesFor(context.rootCommand, error.commandPath, inner.option),
      isValueTakingToken,
    );
  return error.errors.every(isSuppressedMissingFlag) ? "drop" : "flush-help-doc-to-stderr";
}

/**
 * Wraps `Command.runWith(rootCommand, ...)(args)` so the vendored `effect`
 * CLI library's OWN `Console.log`/`Console.error` writes are captured
 * instead of reaching the real console, then disposed of per
 * `classifyParseErrorConsoleOutput` once the run's outcome is known:
 * dropped entirely for a missing-required-flag failure, replayed to stderr
 * (never stdout) for every other genuine parse/validation failure, and
 * replayed unchanged for everything else. Either way, the library's own
 * duplicate error render never survives — this repo's own `handledProgram`
 * + `normalizeCause` already render the single Go-parity line for it. That
 * fixes both halves of CLI-1901 (the stdout help dump and the duplicate
 * error line) from this one call site, without patching the vendored
 * library itself.
 *
 * TODO: remove this whole buffering/classification dance once upstream
 * Effect-TS/effect#6313 is fixed — https://github.com/Effect-TS/effect/issues/6313.
 * `runWith` has no supported way to opt out of, or redirect, its own
 * `showHelp` console writes; everything below exists only to work around
 * that gap from the outside.
 *
 * The "flush unchanged" outcome covers success, `--help`, `--version`,
 * `--completions`, and the bare-group-command help dump, all of which stay
 * untouched.
 *
 * Safe to wrap the entire `runWith` call — parsing AND the eventual command
 * handler, not just the parse phase that can actually raise `ShowHelp`: no
 * command handler in this codebase writes through `effect`'s `Console`
 * service directly (they go through the `Output` service instead). One
 * indirect exception is known — `@supabase/config`'s `loadProjectConfigFile`
 * emits its deprecated-config-section warnings via `Console.error`, and is
 * reachable from handlers through `ProjectConfigStore`/`loadProjectConfig` —
 * so it pins itself to the real console (`Effect.provideService(Console.Console,
 * globalThis.console)`) rather than relying on whatever `Console.Console` is
 * ambient here; see CLI-1901 and that package's `io.ts` for why (a
 * long-running command like `functions serve` would otherwise have the
 * warning buffered for its entire session instead of shown at startup).
 * Any other handler writing through `Console` directly would need the same
 * treatment — buffering here never delays or drops real command output
 * ONLY as long as that invariant holds. Note that Effect's OWN default
 * logger (`Effect.log*`) DOES resolve through this same `Console` reference
 * (`Logger.withConsoleLog`/`withConsoleError`) — this codebase has no
 * `Effect.log*` call sites today, but if one is ever added to a handler, its
 * output would be buffered too (deferred to end-of-run on the "flush
 * unchanged" path, or dropped on a genuine parse failure — which never runs
 * a handler in the first place, so that half is moot).
 */
export function withoutParseErrorHelpDump<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  context: CliErrorSuggestionContext,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const sink: Array<BufferedConsoleWrite> = [];
    const exit = yield* effect.pipe(
      Effect.provideService(Console.Console, bufferingConsole(sink)),
      Effect.exit,
    );
    const disposition = Exit.isFailure(exit)
      ? classifyParseErrorConsoleOutput(exit.cause, context)
      : "flush-unchanged";
    if (disposition === "drop") {
      return yield* exit;
    }
    for (const write of sink) {
      // The library's own duplicate error render never survives a genuine
      // parse failure — only its help-doc `log` write gets a second look,
      // redirected to stderr instead of its original stdout-bound method.
      if (disposition === "flush-help-doc-to-stderr" && write.method === "error") continue;
      const method = disposition === "flush-help-doc-to-stderr" ? "error" : write.method;
      yield* Console.consoleWith((console) =>
        Effect.sync(() => {
          console[method](...write.args);
        }),
      );
    }
    return yield* exit;
  });
}

function projectContextLayerFor(runtimeLayer: Layer.Layer<never>) {
  return projectContextLayer.pipe(Layer.provide(runtimeLayer), Layer.provide(BunServices.layer));
}

function cliConfigLayerFor(runtimeLayer: Layer.Layer<never>) {
  return cliConfigLayer.pipe(
    Layer.provide(projectContextLayerFor(runtimeLayer)),
    Layer.provide(runtimeLayer),
  );
}

function projectHomeLayerFor(runtimeLayer: Layer.Layer<never>) {
  return projectHomeLayer.pipe(
    Layer.provide(cliConfigLayerFor(runtimeLayer)),
    Layer.provide(projectContextLayerFor(runtimeLayer)),
    Layer.provide(runtimeLayer),
    Layer.provide(BunServices.layer),
  );
}

type AnyAnalyticsLayer = Layer.Layer<Analytics, never, any>;

export interface RunCliOptions {
  readonly analyticsLayer: AnyAnalyticsLayer;
  /**
   * Extra command paths (on top of the shared `selfManagedSignalCommands` list) that must NOT
   * be wrapped in the global signal-interrupt handler for this shell specifically — see
   * `next/cli/main.ts`'s own `start` exemption for why a shell needs this instead of just
   * adding to the shared list.
   */
  readonly additionalSelfManagedSignalCommands?: ReadonlyArray<ReadonlyArray<string>>;
  /**
   * Runs just before the process exits on any invocation that exits 0 — the
   * seam for the legacy shell's upgrade notice. Must never fail, and cannot
   * change the exit code.
   */
  readonly afterSuccess?: (args: ReadonlyArray<string>) => Effect.Effect<void>;
}

function cliProgramFor(
  rootCommand: Command.Command.Any,
  args: ReadonlyArray<string>,
  options: RunCliOptions,
  outputFormat: OutputFormat,
) {
  const runtimeLayer = Layer.mergeAll(processControlLayer, runtimeInfoLayer, ttyLayer);
  const fallbackCommandLayer = Layer.mergeAll(
    // Root command env inference currently leaks some subcommand-provided services.
    Layer.succeed(Credentials, {
      getAccessToken: Effect.die("unexpected root credentials access"),
      saveAccessToken: () => Effect.die("unexpected root credentials write"),
      deleteAccessToken: Effect.die("unexpected root credentials deletion"),
    }),
    Layer.succeed(ProjectLocalServiceVersions, {
      load: Effect.die("unexpected root project local service versions access"),
    }),
    Layer.succeed(ProjectConfigStore, {
      load: () => Effect.die("unexpected root project config access"),
      loadFile: () => Effect.die("unexpected root project config file access"),
      save: () => Effect.die("unexpected root project config write"),
    }),
    Layer.succeed(
      CommandRuntime,
      CommandRuntime.of({
        commandPath: ["root"],
        commandRunId: "root-command-run-id",
      }),
    ),
  );
  return withoutParseErrorHelpDump(Command.runWith(rootCommand, { version: CLI_VERSION })(args), {
    rootCommand,
    args,
  }).pipe(
    Effect.provide(formatterLayerFor(rootCommand, args, outputFormat)),
    Effect.provide(options.analyticsLayer),
    Effect.provide(tracingLayer),
    Effect.provide(telemetryRuntimeLayer),
    Effect.provide(cliConfigLayerFor(runtimeLayer)),
    Effect.provide(projectHomeLayerFor(runtimeLayer)),
    Effect.provide(projectContextLayerFor(runtimeLayer)),
    Effect.provide(projectLinkStateLayer),
    Effect.provide(runtimeLayer),
    Effect.provide(unixHttpClientLayer),
    Effect.provide(fallbackCommandLayer),
    Effect.provide(Layer.succeed(CliArgs, { args })),
    Effect.provide(BunServices.layer),
  );
}

export async function runCli(rootCommand: Command.Command.Any, options: RunCliOptions) {
  const args = await Effect.runPromise(
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      return yield* stdio.args;
    }).pipe(Effect.provide(BunServices.layer)),
  );

  // Same `{ rootCommand, args }` shape `formatterLayerFor` builds below, so
  // `normalizeCause`'s single-render fallback path (CLI-1901) can reuse
  // `formatCliErrorsForDisplay` and surface the same subcommand-flag hint the
  // text/json formatters would have shown before the vendored library's own
  // duplicate render was suppressed.
  const suggestionContext = { rootCommand, args };
  const useGlobalSignalInterrupt = shouldUseGlobalSignalInterrupt(
    args,
    options.additionalSelfManagedSignalCommands,
  );
  const outputFormat = await Effect.runPromise(
    Effect.gen(function* () {
      const aiTool = yield* AiTool;
      return resolveAgentOutputFormatFromArgs(args, aiTool.name);
    }).pipe(Effect.provide(aiToolLayer)),
  );
  const cliProgram = cliProgramFor(rootCommand, args, options, outputFormat);

  const signalAwareProgram = Effect.scoped(
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const cliFiber = yield* cliProgram.pipe(Effect.forkScoped);
      const outcome = yield* Effect.raceFirst(
        Fiber.await(cliFiber).pipe(Effect.map((exit) => ({ _tag: "cli" as const, exit }))),
        processControl
          .awaitSignal()
          .pipe(Effect.map((signal) => ({ _tag: "signal" as const, signal }))),
      );

      if (outcome._tag === "signal") {
        yield* Fiber.interrupt(cliFiber);
        return yield* Effect.interrupt;
      }

      return yield* outcome.exit;
    }),
  ).pipe(
    Effect.provide(processControlLayer),
    Effect.provide(runtimeInfoLayer),
    Effect.provide(ttyLayer),
    Effect.provide(unixHttpClientLayer),
    Effect.provide(BunServices.layer),
  );

  const handledRuntimeLayer = Layer.mergeAll(processControlLayer, runtimeInfoLayer, ttyLayer);

  const handledProgram = <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ): Effect.Effect<never, unknown, never> =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const output = yield* Output;
      const exit = yield* program.pipe(Effect.exit);
      // Runs on every exit-0 invocation (`--help` included), like Go's
      // `Execute()` tail. Signals stay held so a Ctrl-C during the ≤3s-bounded
      // hook cannot turn an already-successful command into exit 130.
      const afterSuccess = (code: number) =>
        code === 0 && options.afterSuccess !== undefined
          ? Effect.scoped(
              processControl
                .holdSignals(["SIGINT", "SIGTERM", "SIGHUP"])
                .pipe(Effect.andThen(options.afterSuccess(args))),
            )
          : Effect.void;
      if (Exit.isFailure(exit)) {
        const exitCode = exitCodeForFailure(exit.cause);
        // See `shouldReportFailure` for the reporting rules (and why they're
        // NOT keyed on Effect's shared `[Runtime.errorReported]` marker).
        // Literal `--help` never reaches this branch — it's handled as a
        // successful `GlobalFlag.Action` and exits 0 via the success path
        // below. See `exitCodeForFailure` for why a "clean" ShowHelp failure
        // (e.g. a bare group command with no subcommand) also maps to exit 0.
        if (shouldReportFailure(exit.cause, exitCode)) {
          yield* output.fail(normalizeCause(exit.cause, suggestionContext));
        }
        yield* afterSuccess(exitCode);
        return yield* processControl.exit(exitCode);
      }
      const exitCode = yield* processControl.getExitCode;
      yield* afterSuccess(exitCode ?? 0);
      return yield* processControl.exit(exitCode ?? 0);
    }).pipe(
      Effect.provide(outputLayerFor(outputFormat)),
      Effect.provide(telemetryRuntimeLayer),
      Effect.provide(projectHomeLayerFor(handledRuntimeLayer)),
      Effect.provide(cliConfigLayerFor(handledRuntimeLayer)),
      Effect.provide(projectContextLayerFor(handledRuntimeLayer)),
      Effect.provide(processControlLayer),
      Effect.provide(runtimeInfoLayer),
      Effect.provide(ttyLayer),
      Effect.provide(unixHttpClientLayer),
      Effect.provide(BunServices.layer),
    );

  if (useGlobalSignalInterrupt) {
    await Effect.runPromise(handledProgram(signalAwareProgram));
  } else {
    await Effect.runPromise(handledProgram(cliProgram));
  }
}
