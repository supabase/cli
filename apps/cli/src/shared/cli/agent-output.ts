import { Option } from "effect";
import type { OutputFormat } from "../output/types.ts";

type LegacyOutputFormat = "env" | "pretty" | "json" | "toml" | "yaml";
type AgentOverride = "auto" | "yes" | "no";

interface AgentOutputOptions {
  readonly explicitOutputFormat: Option.Option<OutputFormat>;
  readonly legacyOutputFormat?: Option.Option<LegacyOutputFormat>;
  readonly agentOverride?: AgentOverride;
  readonly detectedAgentName?: Option.Option<string>;
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

export function resolveAgentOutputFormat(options: AgentOutputOptions): OutputFormat {
  const legacyOutputFormat = options.legacyOutputFormat ?? Option.none<LegacyOutputFormat>();
  const agentOverride = options.agentOverride ?? "auto";
  const detectedAgentName = options.detectedAgentName ?? Option.none<string>();
  const isCodingAgent =
    agentOverride === "yes" || (agentOverride !== "no" && Option.isSome(detectedAgentName));

  return Option.getOrElse(options.explicitOutputFormat, () =>
    isCodingAgent && Option.isNone(legacyOutputFormat) ? "json" : "text",
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
  });
}
