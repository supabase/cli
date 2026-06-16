import { Option } from "effect";
import type { OutputFormat } from "../output/types.ts";

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

function isRootValueFlag(arg: string): boolean {
  return (
    arg === "--output-format" ||
    arg === "--output" ||
    arg === "-o" ||
    arg === "--profile" ||
    arg === "--workdir" ||
    arg === "--network-id" ||
    arg === "--dns-resolver" ||
    arg === "--agent"
  );
}

function isRootValueFlagWithInlineValue(arg: string): boolean {
  return (
    arg.startsWith("--output-format=") ||
    arg.startsWith("--output=") ||
    arg.startsWith("-o=") ||
    (arg.length > 2 && arg.startsWith("-o")) ||
    arg.startsWith("--profile=") ||
    arg.startsWith("--workdir=") ||
    arg.startsWith("--network-id=") ||
    arg.startsWith("--dns-resolver=") ||
    arg.startsWith("--agent=")
  );
}

function isRootBooleanFlag(arg: string): boolean {
  return (
    arg === "--debug" || arg === "--experimental" || arg === "--yes" || arg === "--create-ticket"
  );
}

function hasRootVersionRequest(args: ReadonlyArray<string>): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined || arg === "--") {
      return false;
    }
    if (arg === "--version" || arg === "-v") {
      return true;
    }
    if (isRootValueFlag(arg)) {
      i++;
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
    if (arg === "--help" || arg === "-h") return true;
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
