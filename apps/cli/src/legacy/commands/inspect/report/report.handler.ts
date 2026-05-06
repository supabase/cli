import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectReportFlags } from "./report.command.ts";

export const legacyInspectReport = Effect.fn("legacy.inspect.report")(function* (
  flags: LegacyInspectReportFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["inspect", "report"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  if (flags.outputDir !== ".") args.push("--output-dir", flags.outputDir);
  yield* proxy.exec(args);
});
