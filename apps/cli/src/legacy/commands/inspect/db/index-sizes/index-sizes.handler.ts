import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbIndexSizesFlags } from "./index-sizes.command.ts";

export const legacyInspectDbIndexSizes = Effect.fn("legacy.inspect.db.index-sizes")(function* (
  flags: LegacyInspectDbIndexSizesFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["inspect", "db", "index-sizes"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  yield* proxy.exec(args);
});
