import { Effect } from "effect";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import type { LegacyStartFlags } from "./start.command.ts";

export const legacyStart = Effect.fn("legacy.start")(function* (flags: LegacyStartFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["start"];
  for (const name of flags.exclude) args.push("--exclude", name);
  if (flags.ignoreHealthCheck) args.push("--ignore-health-check");
  if (flags.preview) args.push("--preview");
  yield* proxy.exec(args);
});
