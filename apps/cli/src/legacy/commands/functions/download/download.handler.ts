import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyFunctionsDownloadFlags } from "./download.command.ts";

export const legacyFunctionsDownload = Effect.fn("legacy.functions.download")(function* (
  flags: LegacyFunctionsDownloadFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["functions", "download"];
  if (Option.isSome(flags.functionName)) args.push(flags.functionName.value);
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  if (flags.useApi) args.push("--use-api");
  if (flags.useDocker) args.push("--use-docker");
  if (flags.legacyBundle) args.push("--legacy-bundle");
  yield* proxy.exec(args);
});
