import { BunServices } from "@effect/platform-bun";
import { CliConfigStore } from "@supabase/config/effect";
import {
  Cause,
  Console,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Path,
  Runtime,
  Scope,
  Stdio,
} from "effect";
import { CliError, CliOutput, Command } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";
import { CLI_VERSION } from "./version.ts";
import { Credentials } from "../auth/credentials.service.ts";
import type { CliProjectHome } from "../config/cli-project-home.service.ts";
import type { CliSettings } from "../config/cli-settings.service.ts";
import type { ProjectLinkState } from "../config/project-link-state.service.ts";
import type { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import { jsonCliOutputFormatter } from "../output/json-formatter.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";
import { outputLayerFor } from "../output/output.layer.ts";
import { normalizeCause } from "../output/normalize-error.ts";
import type { OutputFormat } from "../output/types.ts";
import { Output } from "../output/output.service.ts";
import { GoChildExitError } from "../../command-internal/go-child-exit.error.ts";
import {
  GoProxyInvocation,
  goProxyInvocationLayer,
} from "../../command-internal/go-proxy-invocation.ts";
import { cliSettingsLayer } from "../config/cli-settings.layer.ts";
import { cliProjectHomeLayer } from "../config/cli-project-home.layer.ts";
import { CliProjectLocalServiceVersions } from "../config/cli-project-local-service-versions.service.ts";
import { cliProjectContextLayer } from "../config/cli-project-context.layer.ts";
import { projectLinkStateLayer } from "../config/project-link-state.layer.ts";
import { processControlLayer } from "../runtime/process-control.layer.ts";
import { runtimeInfoLayer } from "../runtime/runtime-info.layer.ts";
import { ttyLayer } from "../runtime/tty.layer.ts";
import { CommandRuntime } from "../runtime/command-runtime.service.ts";
import { ProcessControl } from "../runtime/process-control.service.ts";
import type { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import type { Stdin } from "../runtime/stdin.service.ts";
import type { Tty } from "../runtime/tty.service.ts";
import type { Analytics } from "../telemetry/analytics.service.ts";
import { aiToolLayer } from "../telemetry/ai-tool.layer.ts";
import { AiTool } from "../telemetry/ai-tool.service.ts";
import { telemetryRuntimeLayer } from "../telemetry/runtime.layer.ts";
import type { TelemetryRuntime } from "../telemetry/runtime.service.ts";
import { tracingLayer } from "../telemetry/tracing.layer.ts";
import { CliArgs } from "./cli-args.service.ts";
import { GLOBAL_VALUE_FLAG_TOKENS } from "./cobra-flag-groups.ts";
import {
  BOOLEAN_FLAG_VALUES,
  resolveAgentOutputFormatFromArgs,
  ROOT_BOOLEAN_FLAGS,
} from "./agent-output.ts";
import { SuccessTrailer, successTrailerLayer } from "./success-trailer.ts";
import type { CliErrorSuggestionContext } from "./subcommand-flag-suggestions.ts";
import {
  flagAliasesFor,
  isValueTakingFlagTokenFor,
  resolvedCommandPathForArgv,
} from "./subcommand-flag-suggestions.ts";

/**
 * Services available before evaluating the root command. Keep this list explicit: preserving the
 * root command's requirement channel here makes an accidentally unprovided service fail at the
 * shell boundary instead of becoming a runtime missing-service defect.
 */
export type AllowedRunCliServices =
  | Analytics
  | ChildProcessSpawner.ChildProcessSpawner
  | CliArgs
  | CliProjectHome
  | CliSettings
  | CommandRuntime
  | FileSystem.FileSystem
  | Crypto.Crypto
  | Path.Path
  | ProcessControl
  | ProjectLinkState
  | RuntimeInfo
  | Scope.Scope
  | Stdio.Stdio
  | TelemetryRuntime
  | Tty
  | CommandPlatformApiFactory
  | Stdin
  | "effect/unstable/cli/GlobalFlag/linked"
  | "effect/unstable/cli/GlobalFlag/local";

export type CliRootCommand = Command.Command<"supabase", {}, {}, unknown, AllowedRunCliServices>;

// Global flags that consume their following argv token as a value; missing one here would make
// `extractCommandPath` mistake its value for a command-path segment, and leave scanners below
// unable to skip past it. Derived from `PERSISTENT_VALUE_FLAG_NAMES` so the two registries can't
// drift apart.
//
// `extractCommandPath` treats a recognized bare boolean literal (`--debug false`) as consuming a
// token too, but `rootFlagTokens`/`firstPositionalIndex` keep pflag's stricter rule that a bare
// boolean never consumes the next token — don't unify these; they answer different questions.
const globalFlagsWithValues: ReadonlySet<string> = GLOBAL_VALUE_FLAG_TOKENS;

// Commands that run their own foreground signal loop (serve/start daemons) and must not be
// wrapped by the global signal-interrupt handler, which would otherwise race their graceful
// shutdown. Matched by leading command-path segments.
//
// `start` and `db start` are not listed here even though they sound similar: their
// native implementations install no signal handling of their own, and instead rely on the global
// handler's interruption to trigger their own rollback-on-error cleanup. Listing them would let a
// raw Ctrl-C skip that cleanup entirely.
const selfManagedSignalCommands: ReadonlyArray<ReadonlyArray<string>> = [["functions", "serve"]];

/** Positional command-path tokens from argv, skipping global flags and their values. */
export function extractCommandPath(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const commandArgs: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return commandArgs;
    if (arg.startsWith("-")) {
      const [flag] = arg.split("=", 1);
      if (!arg.includes("=") && flag !== undefined && globalFlagsWithValues.has(flag)) {
        index += 1;
      } else if (shortClusterConsumesNextToken(arg, isGlobalValueFlagToken)) {
        index += 1;
      } else if (
        !arg.includes("=") &&
        flag !== undefined &&
        ROOT_BOOLEAN_FLAGS.includes(flag) &&
        BOOLEAN_FLAG_VALUES.has(args[index + 1] ?? "")
      ) {
        index += 1;
      }
      continue;
    }
    commandArgs.push(arg);
  }
  return commandArgs;
}

/**
 * Yields argv tokens that are actual flag occurrences, with their positions,
 * honoring cobra/pflag boundaries: everything after a bare `--` is an operand,
 * and a token consumed as a value-taking global flag's value (`--profile -v`)
 * is not a flag.
 */
export function* rootFlagTokens(
  args: ReadonlyArray<string>,
  isValueTakingToken: (token: string) => boolean = isGlobalValueFlagToken,
): Generator<{ readonly token: string; readonly index: number }> {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return;
    if (!arg.startsWith("-")) continue;
    yield { token: arg, index };
    const [flag] = arg.split("=", 1);
    if (!arg.includes("=") && flag !== undefined && isValueTakingToken(flag)) {
      index += 1;
    } else if (shortClusterConsumesNextToken(arg, isValueTakingToken)) {
      index += 1;
    }
  }
}

const isGlobalValueFlagToken = (token: string): boolean => globalFlagsWithValues.has(token);

/**
 * The full value-taking-token predicate for a real invocation: the global
 * flags plus the resolved leaf command's own value flags — pflag parses with
 * the resolved command's complete flagset, so `login --name --debug` hands
 * `--debug` to `--name` and never sets the debug flag.
 */
function valueTakingFlagTokenPredicateForArgv(
  rootCommand: Command.Command.Any,
  args: ReadonlyArray<string>,
): (token: string) => boolean {
  const leafPredicate = isValueTakingFlagTokenFor(
    rootCommand,
    resolvedCommandPathForArgv(rootCommand, extractCommandPath(args)),
  );
  return (token) => isGlobalValueFlagToken(token) || leafPredicate(token);
}

/** Whether `token` is an occurrence of the long or exact-short boolean flag `name`, bare or valued (`--help`, `--help=false`). */
function isFlagOccurrence(token: string, name: string): boolean {
  return token === name || token.startsWith(`${name}=`);
}

/**
 * pflag's `ParseBool` true spellings, used to resolve `--version=<value>` here. This answers a
 * different question than `BOOLEAN_FLAG_VALUES` (`agent-output.ts`), which asks whether the
 * shipped parser accepts the value at all — the two sets must not be merged.
 */
const PFLAG_BOOL_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);

/**
 * pflag reads a single-dash token as a cluster of shorthand flags until a
 * value-taking shorthand consumes the rest of the cluster as its value.
 */
function* shortClusterFlagNames(
  token: string,
  isValueTakingToken: (token: string) => boolean,
): Generator<string> {
  if (!token.startsWith("-") || token.startsWith("--")) return;
  for (let rest = token.slice(1); rest.length > 0; rest = rest.slice(1)) {
    const short = `-${rest[0]!}`;
    if (isValueTakingToken(short)) return;
    if (rest[1] === "=") {
      yield short;
      return;
    }
    yield short;
  }
}

/** Whether a short cluster ends in a value-taking shorthand with no inline value, which pflag satisfies with the NEXT argv token (`-ho json`). */
function shortClusterConsumesNextToken(
  token: string,
  isValueTakingToken: (token: string) => boolean,
): boolean {
  if (!token.startsWith("-") || token.startsWith("--")) return false;
  for (let rest = token.slice(1); rest.length > 0; rest = rest.slice(1)) {
    if (isValueTakingToken(`-${rest[0]!}`)) return rest.length === 1;
    if (rest[1] === "=") return false;
  }
  return false;
}

/**
 * Index of the first positional token — pflag's view, with flags and their
 * consumed values skipped and everything from a bare `--` on positional —
 * or `args.length` when there is none.
 */
function firstPositionalIndex(
  args: ReadonlyArray<string>,
  isValueTakingToken: (token: string) => boolean,
): number {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return index + 1;
    if (!arg.startsWith("-")) return index;
    const [flag] = arg.split("=", 1);
    if (!arg.includes("=") && flag !== undefined && isValueTakingToken(flag)) {
      index += 1;
    } else if (shortClusterConsumesNextToken(arg, isValueTakingToken)) {
      index += 1;
    }
  }
  return args.length;
}

/**
 * Whether argv sets the root `--version` flag, in any spelling pflag marks as changed: bare,
 * valued (`--version=false` included), or followed by a space-form operand (`--version true`,
 * since the version built-in is served before the stray operand is validated). A subcommand's
 * own `--version` (`db reset --version x`) does not count, since a positional precedes it.
 */
export function hasRootVersionFlag(
  args: ReadonlyArray<string>,
  isValueTakingToken: (token: string) => boolean = isGlobalValueFlagToken,
): boolean {
  const positional = firstPositionalIndex(args, isValueTakingToken);
  for (const { token, index } of rootFlagTokens(args, isValueTakingToken)) {
    if (index >= positional) continue;
    if (isFlagOccurrence(token, "--version")) return true;
  }
  return false;
}

/**
 * Whether this argv resolves to a built-in action — help at any depth, or the root version —
 * without ever running a command handler. Help counts on presence, regardless of value. The
 * version flag resolves pflag-style, last value wins: a true value counts as the version
 * built-in, `--version=false <leaf>` counts as running the leaf, and only a bare invocation with
 * no positional falls back to the root's help. Used only by the upgrade-notice checks below.
 */
export function hasRootHelpOrVersionFlag(
  args: ReadonlyArray<string>,
  isValueTakingToken: (token: string) => boolean = isGlobalValueFlagToken,
): boolean {
  const positional = firstPositionalIndex(args, isValueTakingToken);
  let version: boolean | undefined;
  for (const { token, index } of rootFlagTokens(args, isValueTakingToken)) {
    if (isFlagOccurrence(token, "--help") || isFlagOccurrence(token, "-h")) return true;
    const shortFlags = [...shortClusterFlagNames(token, isValueTakingToken)];
    if (shortFlags.includes("-h")) return true;
    if (index < positional) {
      if (token === "--version") version = true;
      else if (token.startsWith("--version=")) {
        version = PFLAG_BOOL_TRUE.has(token.slice("--version=".length));
      }
    }
  }
  if (version === undefined) return false;
  return version || positional >= args.length;
}

/** The last value a root-level `--<name>`/`--<name>=<value>` occurrence sets. `name` must be a value-taking global flag, whose space-form value the token walk already skips. */
export function lastGlobalFlagValue(
  args: ReadonlyArray<string>,
  name: string,
  isValueTakingToken: (token: string) => boolean = isGlobalValueFlagToken,
): string | undefined {
  let value: string | undefined;
  for (const { token, index } of rootFlagTokens(args, isValueTakingToken)) {
    if (token === name) value = args[index + 1];
    else if (token.startsWith(`${name}=`)) value = token.slice(name.length + 1);
  }
  return value;
}

/** Whether the global signal-interrupt handler should wrap this invocation. */
export function shouldUseGlobalSignalInterrupt(args: ReadonlyArray<string>): boolean {
  const commandPath = extractCommandPath(args);
  return !selfManagedSignalCommands.some((command) =>
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
 * Process exit code for a failed CLI run. Delegates to Effect's own `Runtime` exit-code protocol
 * rather than hand-rolling classification: a bare group command's default handler failing with
 * `ShowHelp({ errors: [] })` (no subcommand given) reads as exit `0`; a `ShowHelp` with a
 * non-empty `errors` array, or any other failure, falls back to exit `1`. An explicit `--help`
 * invocation never reaches this function — it exits 0 via the success path.
 */
export function exitCodeForFailure(cause: Cause.Cause<unknown>): number {
  if (Cause.hasInterruptsOnly(cause)) return 130;
  return Runtime.getErrorExitCode(Cause.squash(cause));
}

/**
 * Whether `handledProgram` should render its generic `output.fail` stderr line for a failed run.
 * False for a clean exit (`0`), an interrupt (`130`), and a `GoChildExitError` — a delegated Go
 * child already wrote its own failure to the inherited stderr, so a second line here would be
 * redundant. Checked by concrete type rather than Effect's shared `[Runtime.errorReported]`
 * marker, since `CliError.ShowHelp` also sets that marker `false` for an unrelated reason and
 * would otherwise suppress real error rendering too.
 */
export function shouldReportFailure(cause: Cause.Cause<unknown>, exitCode: number): boolean {
  if (exitCode === 0 || exitCode === 130) return false;
  return !(Cause.squash(cause) instanceof GoChildExitError);
}

/**
 * A single `Console.log`/`Console.error` call captured while `withoutParseErrorHelpDump` runs, so
 * it can be replayed once the run's outcome is known instead of being written immediately.
 */
interface BufferedConsoleWrite {
  readonly method: "log" | "error";
  readonly args: ReadonlyArray<unknown>;
}

/**
 * A `Console.Console` that captures `log`/`error` calls into `sink` instead of writing them, and
 * forwards every other method straight through to the real console. The vendored CLI library only
 * ever calls `log`/`error`, but every method is implemented so this stays a faithful
 * `Console.Console` rather than a partial stand-in.
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
 * How `withoutParseErrorHelpDump` disposes of its buffered `Console` writes for a failed run.
 * `"drop"` applies only when a required flag was never given at all (see
 * `isMissingFlagTokenPresent`) — a required flag that's present but missing its value is a
 * different, earlier parse error and must render normally. Every other genuine parse/validation
 * failure gets its help doc redirected to stderr instead of stdout; the library's own duplicate
 * error line is always dropped, since `handledProgram`/`normalizeCause` render that separately.
 */
export type ParseErrorConsoleDisposition = "flush-unchanged" | "drop" | "flush-help-doc-to-stderr";

/**
 * Whether `option`'s flag token, or one of its `aliases`, appears anywhere in argv before a live
 * `--` terminator — used to tell a genuinely-absent required flag (usage suppressed) apart from
 * one that's present but missing its value (a separate, earlier parse error that still shows
 * usage). `isValueTakingToken` skips tokens consumed as another flag's value (including a literal
 * `--`), so a consumed token is never mistaken for `option`'s own occurrence.
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
    // A literal "--" only terminates parsing when reached live — if it was already skipped as a
    // value-taking flag's consumed value below, this check never runs for it.
    if (arg === "--") break;
    if (tokens.some((token) => arg === token || arg.startsWith(`${token}=`))) return true;
    const equalIndex = arg.indexOf("=");
    const bareToken = equalIndex === -1 ? arg : arg.slice(0, equalIndex);
    if (equalIndex === -1 && isValueTakingToken(bareToken)) {
      // pflag consumes the following argv entry as `bareToken`'s value unconditionally — even a
      // literal "--" — so skip it here too, before the terminator check ever sees it.
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
  // `isValueTakingFlagTokenFor` only inspects the resolved leaf command's own flags, so
  // value-taking global flags (`--network-id`, `--profile`, etc.) must be OR'd in — otherwise a
  // global flag consuming the very next token could leave a genuinely-required flag looking
  // "present" to the scan below.
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
 * Wraps `Command.runWith(rootCommand, ...)(args)` so the vendored CLI library's own
 * `Console.log`/`Console.error` writes are captured instead of reaching the real console, then
 * disposed of per `classifyParseErrorConsoleOutput`: dropped for a missing-required-flag failure,
 * replayed to stderr for other parse/validation failures, and replayed unchanged otherwise. Safe
 * to wrap the whole call since no handler here writes through `Console` directly except
 * `@supabase/config`'s `loadCliConfigFile`, which pins itself to the real console.
 *
 * TODO: remove once https://github.com/Effect-TS/effect/issues/6313 is fixed upstream.
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
      // The library's own duplicate error render never survives a genuine parse failure — only
      // its help-doc `log` write gets a second look, redirected to stderr.
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

function cliProjectContextLayerFor(runtimeLayer: Layer.Layer<never>) {
  return cliProjectContextLayer.pipe(Layer.provide(runtimeLayer), Layer.provide(BunServices.layer));
}

function cliSettingsLayerFor(runtimeLayer: Layer.Layer<never>) {
  return cliSettingsLayer.pipe(
    Layer.provide(cliProjectContextLayerFor(runtimeLayer)),
    Layer.provide(runtimeLayer),
  );
}

function cliProjectHomeLayerFor(runtimeLayer: Layer.Layer<never>) {
  return cliProjectHomeLayer.pipe(
    Layer.provide(cliSettingsLayerFor(runtimeLayer)),
    Layer.provide(cliProjectContextLayerFor(runtimeLayer)),
    Layer.provide(runtimeLayer),
    Layer.provide(BunServices.layer),
  );
}

type AnyAnalyticsLayer = Layer.Layer<Analytics, never, any>;

export interface RunCliOptions {
  /** Runs after runtime services are installed and before command parsing. */
  readonly beforeParse?: Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>;
  readonly analyticsLayer: AnyAnalyticsLayer;
  /**
   * Runs just before the process exits on any invocation that exits 0 — the seam for the CLI's
   * upgrade notice. `cleanShowHelp` marks the exit-0 `ShowHelp` failure branch (a bare group
   * command). Must never fail, and cannot change the exit code.
   */
  readonly afterSuccess?: (
    args: ReadonlyArray<string>,
    info: {
      readonly cleanShowHelp: boolean;
      readonly delegatedToGo: boolean;
      readonly workingDirectory?: string;
      /** Value-taking-token predicate for this argv (global + resolved leaf flags) — see `valueTakingFlagTokenPredicateForArgv`. */
      readonly isValueTakingFlagToken: (token: string) => boolean;
    },
  ) => Effect.Effect<void>;
}

function cliProgramFor<
  Name extends string,
  Input,
  ContextInput,
  E,
  R extends AllowedRunCliServices,
>(
  rootCommand: Command.Command<Name, Input, ContextInput, E, R>,
  args: ReadonlyArray<string>,
  options: RunCliOptions,
  outputFormat: OutputFormat,
) {
  const runtimeLayer = Layer.mergeAll(processControlLayer, runtimeInfoLayer, ttyLayer);
  const fallbackCommandLayer = Layer.mergeAll(
    // Root command env inference leaks some subcommand-provided services; these stand-ins die
    // if a root-level invocation ever touches them.
    Layer.succeed(Credentials, {
      getAccessToken: Effect.die("unexpected root credentials access"),
      saveAccessToken: () => Effect.die("unexpected root credentials write"),
      deleteAccessToken: Effect.die("unexpected root credentials deletion"),
    }),
    Layer.succeed(CliProjectLocalServiceVersions, {
      load: Effect.die("unexpected root project local service versions access"),
    }),
    Layer.succeed(CliConfigStore, {
      load: () => Effect.die("unexpected root cli-config access"),
      loadFile: () => Effect.die("unexpected root cli-config file access"),
      save: () => Effect.die("unexpected root cli-config write"),
    }),
    Layer.succeed(
      CommandRuntime,
      CommandRuntime.of({
        commandPath: ["root"],
        commandRunId: "root-command-run-id",
      }),
    ),
  );
  const commandProgram = options.beforeParse ?? Effect.void;
  return withoutParseErrorHelpDump(
    commandProgram.pipe(
      Effect.andThen(Command.runWith(rootCommand, { version: CLI_VERSION })(args)),
    ),
    {
      rootCommand,
      args,
    },
  ).pipe(
    Effect.provide(formatterLayerFor(rootCommand, args, outputFormat)),
    Effect.provide(options.analyticsLayer),
    Effect.provide(tracingLayer),
    Effect.provide(telemetryRuntimeLayer),
    Effect.provide(cliSettingsLayerFor(runtimeLayer)),
    Effect.provide(cliProjectHomeLayerFor(runtimeLayer)),
    Effect.provide(cliProjectContextLayerFor(runtimeLayer)),
    Effect.provide(projectLinkStateLayer),
    Effect.provide(runtimeLayer),
    Effect.provide(fallbackCommandLayer),
    Effect.provide(Layer.succeed(CliArgs, { args })),
    Effect.provide(BunServices.layer),
  );
}

export async function runCli<
  Name extends string,
  Input,
  ContextInput,
  E,
  R extends AllowedRunCliServices,
>(rootCommand: Command.Command<Name, Input, ContextInput, E, R>, options: RunCliOptions) {
  const args = await Effect.runPromise(
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      return yield* stdio.args;
    }).pipe(Effect.provide(BunServices.layer)),
  );

  // Same shape `formatterLayerFor` builds below, so `normalizeCause`'s fallback path can reuse
  // `formatCliErrorsForDisplay` and surface the same subcommand-flag hint the formatters would.
  const suggestionContext = { rootCommand, args };
  const useGlobalSignalInterrupt = shouldUseGlobalSignalInterrupt(args);
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
      yield* processControl.holdSignals(["SIGINT", "SIGTERM"]);
      const cliFiber = yield* cliProgram.pipe(Effect.forkScoped);
      const outcome = yield* Effect.raceFirst(
        Fiber.await(cliFiber).pipe(Effect.map((exit) => ({ _tag: "cli" as const, exit }))),
        processControl
          .awaitSignal()
          .pipe(Effect.map((signal) => ({ _tag: "signal" as const, signal }))),
      );

      if (outcome._tag === "signal") {
        // SIGHUP must also stay held once cleanup begins.
        yield* Effect.scoped(
          processControl.holdSignals(["SIGHUP"]).pipe(Effect.andThen(Fiber.interrupt(cliFiber))),
        );
        return yield* Effect.interrupt;
      }

      return yield* outcome.exit;
    }),
  ).pipe(
    Effect.provide(processControlLayer),
    Effect.provide(runtimeInfoLayer),
    Effect.provide(ttyLayer),
    Effect.provide(BunServices.layer),
  );

  const selfManagedSignalProgram = Effect.scoped(
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      yield* processControl.holdSignals(["SIGINT", "SIGTERM"]);
      return yield* cliProgram;
    }),
  ).pipe(Effect.provide(processControlLayer));

  const handledRuntimeLayer = Layer.mergeAll(processControlLayer, runtimeInfoLayer, ttyLayer);

  const handledProgram = <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ): Effect.Effect<never, unknown, never> =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const goProxyInvocation = yield* GoProxyInvocation;
      const output = yield* Output;
      const successTrailer = yield* SuccessTrailer;
      const exit = yield* program.pipe(Effect.exit);
      const afterSuccessHook = options.afterSuccess;
      const afterSuccess = (code: number, cleanShowHelp: boolean) =>
        code === 0
          ? Effect.gen(function* () {
              const trailers = yield* successTrailer.takeAll;
              if (afterSuccessHook !== undefined || trailers.length > 0) {
                yield* Effect.scoped(
                  processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]).pipe(
                    Effect.andThen(
                      Effect.gen(function* () {
                        if (afterSuccessHook !== undefined) {
                          const delegatedToGo = yield* goProxyInvocation.wasDelegated;
                          const workingDirectory = yield* successTrailer.workingDirectory;
                          yield* afterSuccessHook(args, {
                            cleanShowHelp,
                            delegatedToGo,
                            workingDirectory,
                            isValueTakingFlagToken: valueTakingFlagTokenPredicateForArgv(
                              rootCommand,
                              args,
                            ),
                          });
                        }

                        yield* Effect.forEach(trailers, (text) => output.raw(text, "stderr"), {
                          discard: true,
                        });
                      }),
                    ),
                  ),
                );
              }
            })
          : Effect.void;
      if (Exit.isFailure(exit)) {
        const exitCode = exitCodeForFailure(exit.cause);
        // See `shouldReportFailure` and `exitCodeForFailure` for the exit-code/reporting rules; a
        // literal `--help` never reaches this branch — it exits 0 via the success path below.
        if (shouldReportFailure(exit.cause, exitCode)) {
          yield* output.fail(normalizeCause(exit.cause, suggestionContext));
        }
        yield* afterSuccess(exitCode, true);
        return yield* processControl.exit(exitCode);
      }
      const exitCode = yield* processControl.getExitCode;
      yield* afterSuccess(exitCode ?? 0, false);
      return yield* processControl.exit(exitCode ?? 0);
    }).pipe(
      Effect.provide(outputLayerFor(outputFormat)),
      Effect.provide(telemetryRuntimeLayer),
      Effect.provide(cliProjectHomeLayerFor(handledRuntimeLayer)),
      Effect.provide(cliSettingsLayerFor(handledRuntimeLayer)),
      Effect.provide(cliProjectContextLayerFor(handledRuntimeLayer)),
      Effect.provide(processControlLayer),
      Effect.provide(runtimeInfoLayer),
      Effect.provide(ttyLayer),
      Effect.provide(BunServices.layer),
      Effect.provide(goProxyInvocationLayer),
      Effect.provide(successTrailerLayer),
    );

  if (useGlobalSignalInterrupt) {
    await Effect.runPromise(handledProgram(signalAwareProgram));
  } else {
    await Effect.runPromise(handledProgram(selfManagedSignalProgram));
  }
}
