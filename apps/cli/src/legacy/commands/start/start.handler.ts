import { Effect, Option } from "effect";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { LegacyStartFlags } from "./start.command.ts";

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
    case "pretty":
    case undefined:
      return outputFormat === "json" || outputFormat === "stream-json" ? "json" : undefined;
    case "table":
    case "csv":
      return undefined;
  }
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
    yield* proxy.exec(["status", "--output", statusOutput]);
    return;
  }

  yield* proxy.exec(args);
});
