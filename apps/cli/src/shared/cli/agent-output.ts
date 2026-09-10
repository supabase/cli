import { Option } from "effect";
import type { OutputFormat } from "../output/types.ts";
import { GLOBAL_VALUE_FLAG_TOKENS } from "./cobra-flag-groups.ts";

// Every command's `--output` value (see `command-internal/global-flags.ts`): resource commands
// accept `env|pretty|json|toml|yaml`, `db query` adds `table|csv`. An explicit `-o` value
// suppresses the coding-agent JSON auto-default below.
type GoOutputFormat = "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";
type AgentOverride = "auto" | "yes" | "no";

interface AgentOutputOptions {
  readonly explicitOutputFormat: Option.Option<OutputFormat>;
  readonly goOutputFormat?: Option.Option<GoOutputFormat>;
  readonly agentOverride?: AgentOverride;
  readonly detectedAgentName?: Option.Option<string>;
  readonly isBuiltInTextRequest?: boolean;
}

function readLongFlag(args: ReadonlyArray<string>, name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === name) {
      return args[i + 1];
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
}

function readOutputFlag(args: ReadonlyArray<string>): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--output" || arg === "-o") {
      return args[i + 1];
    }
    if (arg.startsWith("--output=")) {
      return arg.slice("--output=".length);
    }
    if (arg.startsWith("-o=")) {
      return arg.slice("-o=".length);
    }
    if (arg.length > 2 && arg.startsWith("-o")) {
      return arg.slice("-o".length);
    }
  }
}

function outputFormatFromArg(value: string | undefined): Option.Option<OutputFormat> {
  switch (value) {
    case "text":
    case "json":
    case "stream-json":
      return Option.some(value);
    default:
      return Option.none();
  }
}

function goOutputFormatFromArg(value: string | undefined): Option.Option<GoOutputFormat> {
  switch (value) {
    case "env":
    case "pretty":
    case "json":
    case "toml":
    case "yaml":
    case "table":
    case "csv":
      return Option.some(value);
    default:
      return Option.none();
  }
}

function agentOverrideFromArg(value: string | undefined): AgentOverride {
  switch (value) {
    case "yes":
    case "no":
      return value;
    default:
      return "auto";
  }
}

// These predicates run pre-parse to pick the formatter a built-in action renders through, so
// they must mirror the CLI library's own flags: `--completions bash --version` serves the
// Version action, and missing an entry here would render agent JSON instead of the plain
// version line.
function isRootValueFlag(arg: string): boolean {
  return GLOBAL_VALUE_FLAG_TOKENS.has(arg);
}

function isRootValueFlagWithInlineValue(arg: string): boolean {
  // The shipped parser rejects `-o<value>` (no `=`), so this only classifies argv that
  // already fails to parse.
  if (arg.length > 2 && arg.startsWith("-o")) return true;
  for (const token of GLOBAL_VALUE_FLAG_TOKENS) {
    if (arg.startsWith(`${token}=`)) return true;
  }
  return false;
}

export const ROOT_BOOLEAN_FLAGS: ReadonlyArray<string> = [
  "--debug",
  "--experimental",
  "--yes",
  "--create-ticket",
  "--wizard",
];

/** Bare or inline (`--flag` / `--flag=<value>`) occurrence of `name`. */
function isFlagOccurrence(arg: string, name: string): boolean {
  return arg === name || arg.startsWith(`${name}=`);
}

/**
 * Inline values the CLI's boolean primitive accepts (lowercase only); any of these serves the
 * flag's action, including `=false`.
 *
 * Distinct from `run.ts`'s `PFLAG_BOOL_TRUE`, which answers ParseBool truthiness for the
 * pflag-modeled upgrade-notice scans — do not merge them.
 */
export const BOOLEAN_FLAG_VALUES: ReadonlySet<string> = new Set([
  "true",
  "false",
  "1",
  "0",
  "yes",
  "no",
  "y",
  "n",
  "on",
  "off",
]);

// The action flag's own inline value must be one the boolean primitive accepts:
// `--version=true` serves the Version action, but `--version=bogus` fails to parse, so no
// action fires and the error keeps the agent JSON envelope.
function isBooleanActionOccurrence(arg: string, name: string): boolean {
  if (arg === name) return true;
  return arg.startsWith(`${name}=`) && BOOLEAN_FLAG_VALUES.has(arg.slice(name.length + 1));
}

// Skipped booleans count on presence, so an invalid inline value like `--wizard=bogus` still
// lets `--version` scan through and render the plain version line.
function isRootBooleanFlag(arg: string): boolean {
  return ROOT_BOOLEAN_FLAGS.some((name) => isFlagOccurrence(arg, name));
}

// Bails at the first token that isn't a known root flag, subcommand names included: some
// leaves declare their own `--version` (e.g. `db reset`), so `<group> --version` resolving
// conservatively to JSON is the accepted trade-off.
function hasRootVersionRequest(args: ReadonlyArray<string>): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined || arg === "--") {
      return false;
    }
    if (isBooleanActionOccurrence(arg, "--version") || isBooleanActionOccurrence(arg, "-v")) {
      return true;
    }
    if (isRootValueFlag(arg)) {
      i++;
      continue;
    }
    if (ROOT_BOOLEAN_FLAGS.includes(arg)) {
      // The parser consumes a space-separated boolean literal too
      // (`--wizard false --version` still serves Version), so skip it.
      const next = args[i + 1];
      if (next !== undefined && BOOLEAN_FLAG_VALUES.has(next)) i++;
      continue;
    }
    if (isRootValueFlagWithInlineValue(arg) || isRootBooleanFlag(arg)) {
      continue;
    }
    return false;
  }
  return false;
}

function hasHelpRequest(args: ReadonlyArray<string>): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (isBooleanActionOccurrence(arg, "--help") || isBooleanActionOccurrence(arg, "-h"))
      return true;
  }
  return false;
}

export function isBuiltInTextRequest(args: ReadonlyArray<string>): boolean {
  return hasHelpRequest(args) || hasRootVersionRequest(args);
}

export function resolveAgentOutputFormat(options: AgentOutputOptions): OutputFormat {
  const goOutputFormat = options.goOutputFormat ?? Option.none<GoOutputFormat>();
  const detectedAgentName = options.detectedAgentName ?? Option.none<string>();
  const agentOverride = options.agentOverride ?? "auto";
  const isCodingAgent =
    agentOverride === "yes" || (agentOverride === "auto" && Option.isSome(detectedAgentName));

  return Option.getOrElse(options.explicitOutputFormat, () =>
    isCodingAgent && Option.isNone(goOutputFormat) && !options.isBuiltInTextRequest
      ? "json"
      : "text",
  );
}

export function resolveAgentOutputFormatFromArgs(
  args: ReadonlyArray<string>,
  detectedAgentName: Option.Option<string>,
): OutputFormat {
  const explicitOutputFormat = outputFormatFromArg(readLongFlag(args, "--output-format"));
  const goOutputFormat = goOutputFormatFromArg(readOutputFlag(args));
  const agentOverride = agentOverrideFromArg(readLongFlag(args, "--agent"));

  return resolveAgentOutputFormat({
    explicitOutputFormat,
    goOutputFormat,
    agentOverride,
    detectedAgentName,
    isBuiltInTextRequest: isBuiltInTextRequest(args),
  });
}
