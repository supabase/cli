import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyStorageLsFlags } from "./ls.command.ts";

export const legacyStorageLs = Effect.fn("legacy.storage.ls")(function* (
  flags: LegacyStorageLsFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["storage", "ls"];
  if (flags.recursive) args.push("--recursive");
  if (Option.isSome(flags.path)) args.push(flags.path.value);
  yield* proxy.exec(args);
});
