import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyStorageMvFlags } from "./mv.command.ts";

export const legacyStorageMv = Effect.fn("legacy.storage.mv")(function* (
  flags: LegacyStorageMvFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["storage", "mv"];
  if (flags.recursive) args.push("--recursive");
  args.push(flags.src, flags.dst);
  yield* proxy.exec(args);
});
