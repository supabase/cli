import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyStorageCpFlags } from "./cp.command.ts";

export const legacyStorageCp = Effect.fn("legacy.storage.cp")(function* (
  flags: LegacyStorageCpFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["storage", "cp"];
  if (flags.recursive) args.push("--recursive");
  if (flags.local) args.push("--local");
  if (flags.linked) args.push("--linked");
  if (Option.isSome(flags.cacheControl)) args.push("--cache-control", flags.cacheControl.value);
  if (Option.isSome(flags.contentType)) args.push("--content-type", flags.contentType.value);
  if (Option.isSome(flags.jobs)) args.push("--jobs", String(flags.jobs.value));
  args.push(flags.src, flags.dst);
  yield* proxy.exec(args);
});
