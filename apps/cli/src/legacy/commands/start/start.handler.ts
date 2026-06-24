import { Effect, Option } from "effect";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import type { LegacyStartFlags } from "./start.command.ts";

export const legacyStart = Effect.fn("legacy.start")(function* (flags: LegacyStartFlags) {
  const proxy = yield* LegacyGoProxy;
  const output = yield* LegacyOutputFlag;
  const args: string[] = ["start"];
  for (const name of flags.exclude) args.push("--exclude", name);
  if (flags.ignoreHealthCheck) args.push("--ignore-health-check");
  if (flags.preview) args.push("--preview");

  if (Option.isSome(output) && output.value === "json") {
    yield* proxy.execCapture(args, { stdin: "inherit" });
    yield* proxy.exec(["status"]);
    return;
  }

  yield* proxy.exec(args);
});
