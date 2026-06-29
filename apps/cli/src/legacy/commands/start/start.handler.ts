import { Effect, Option } from "effect";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { LegacyStartFlags } from "./start.command.ts";

const helperStatusEnv: Record<string, string> = { SUPABASE_TELEMETRY_DISABLED: "1" };

function machineStatusOutput(
  outputFormat: "text" | "json" | "stream-json",
  legacyOutput: "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv" | undefined,
) {
  switch (legacyOutput) {
    case "env":
    case "json":
    case "toml":
    case "yaml":
      return legacyOutput;
    case undefined:
      return outputFormat === "json" || outputFormat === "stream-json" ? "json" : undefined;
    case "pretty":
    case "table":
    case "csv":
      return undefined;
  }
}

function parseJsonOutput(json: string) {
  return Effect.sync(() => {
    const data: unknown = JSON.parse(json);
    return data;
  });
}

export const legacyStart = Effect.fn("legacy.start")(function* (flags: LegacyStartFlags) {
  const proxy = yield* LegacyGoProxy;
  const output = yield* Output;
  const legacyOutput = Option.getOrUndefined(yield* LegacyOutputFlag);
  const args: string[] = ["start"];
  for (const name of flags.exclude) args.push("--exclude", name);
  if (flags.ignoreHealthCheck) args.push("--ignore-health-check");
  if (flags.preview) args.push("--preview");

  const statusOutput = machineStatusOutput(output.format, legacyOutput);
  if (statusOutput !== undefined) {
    yield* proxy.execCapture(args, { stdin: "inherit" });
    const statusArgs = ["status", "--output", statusOutput];
    for (const name of flags.exclude) statusArgs.push("--exclude", name);
    if (flags.ignoreHealthCheck) statusArgs.push("--ignore-health-check");
    if (output.format === "stream-json" && legacyOutput === undefined) {
      const statusJson = yield* proxy.execCapture(statusArgs, { env: helperStatusEnv });
      const status = yield* parseJsonOutput(statusJson);
      yield* output.event({ type: "result", data: status, timestamp: new Date().toISOString() });
    } else {
      yield* proxy.exec(statusArgs, { env: helperStatusEnv });
    }
    return;
  }

  yield* proxy.exec(args);
});
