import { Option } from "effect";
import type { OutputFormat } from "../output/types.ts";
import { GLOBAL_VALUE_FLAG_TOKENS } from "./cobra-flag-groups.ts";

// The union of every legacy command's `--output` values (see
// `shared/legacy/global-flags.ts`): resource commands use `env|pretty|json|toml|yaml`,
// `db query` adds `table|csv`. An explicit legacy `-o` of any of these suppresses the
// coding-agent JSON auto-default below. (`next/` never sets `-o`, so this stays inert
// there.)
type LegacyOutputFormat = "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";
type AgentOverride = "auto" | "yes" | "no";

interface AgentOutputOptions {
  readonly explicitOutputFormat: Option.Option<OutputFormat>;
  readonly legacyOutputFormat?: Option.Option<LegacyOutputFormat>;
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

function legacyOutputFormatFromArg(value: string | undefined): Option.Option<LegacyOutputFormat> {
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

// These predicates run pre-parse to pick the formatter a built-in ACTION
// renders through, so they must also know the CLI library's built-in flags:
// `--completions bash --version` serves the Version action (Version precedes
// Completions), and missing entries here rendered it as JSON under agent
// detection instead of the plain version line. The flag set is the shared
// derived registry, not a fourth hand-written copy (issue #6482).
function isRootValueFlag(arg: string): boolean {
  return GLOBAL_VALUE_FLAG_TOKENS.has(arg);
}

function isRootValueFlagWithInlineValue(arg: string): boolean {
  // Attached `-o<value>` — kept from the pre-derivation predicate; the
  // shipped parser rejects this spelling, so it only ever classifies argv
  // that already fails the parse.
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
 * Inline values the CLI's boolean primitive ACCEPTS (lowercase only) — an
 * acceptance set: any of these serves the flag's action, `=false` included.
 * `run.ts`'s `PFLAG_BOOL_TRUE` answers a DIFFERENT question (ParseBool
 * truthiness, for the pflag-modeled upgrade-notice scans); do not merge them.
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

// An action flag's own inline value must be one the boolean primitive
// accepts: `--version=true` (any accepted value, `false` included) serves the
// Version action, while `--version=bogus` fails the flag's own parse — no
// action is served, and the error keeps the agent JSON envelope.
function isBooleanActionOccurrence(arg: string, name: string): boolean {
  if (arg === name) return true;
  return arg.startsWith(`${name}=`) && BOOLEAN_FLAG_VALUES.has(arg.slice(name.length + 1));
}

// Inline spellings count for the skipped booleans with ANY value: the Version
// action is scanned on presence before `--wizard=bogus` ever parses, so even
// an invalid inline value there still renders the plain version line.
function isRootBooleanFlag(arg: string): boolean {
  return ROOT_BOOLEAN_FLAGS.some((name) => isFlagOccurrence(arg, name));
}

// Deliberately bails at the first token that is not a known root flag
// (subcommand names included): the renderer serves the Version action at any
// depth, but several leaves declare their own `--version` (e.g. `db reset`),
// so `<group> --version` resolving conservatively to JSON is the accepted
// trade-off, ledgered with the walk-consolidation follow-up.
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
  const legacyOutputFormat = options.legacyOutputFormat ?? Option.none<LegacyOutputFormat>();
  const detectedAgentName = options.detectedAgentName ?? Option.none<string>();
  const agentOverride = options.agentOverride ?? "auto";
  const isCodingAgent =
    agentOverride === "yes" || (agentOverride === "auto" && Option.isSome(detectedAgentName));

  return Option.getOrElse(options.explicitOutputFormat, () =>
    isCodingAgent && Option.isNone(legacyOutputFormat) && !options.isBuiltInTextRequest
      ? "json"
      : "text",
  );
}

export function resolveAgentOutputFormatFromArgs(
  args: ReadonlyArray<string>,
  detectedAgentName: Option.Option<string>,
): OutputFormat {
  const explicitOutputFormat = outputFormatFromArg(readLongFlag(args, "--output-format"));
  const legacyOutputFormat = legacyOutputFormatFromArg(readOutputFlag(args));
  const agentOverride = agentOverrideFromArg(readLongFlag(args, "--agent"));

  return resolveAgentOutputFormat({
    explicitOutputFormat,
    legacyOutputFormat,
    agentOverride,
    detectedAgentName,
    isBuiltInTextRequest: isBuiltInTextRequest(args),
  });
}
