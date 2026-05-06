import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbStartFlags } from "./start.command.ts";

export const legacyDbStart = Effect.fn("legacy.db.start")(function* (flags: LegacyDbStartFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "start"];
  if (Option.isSome(flags.fromBackup)) args.push("--from-backup", flags.fromBackup.value);
  yield* proxy.exec(args);
});
