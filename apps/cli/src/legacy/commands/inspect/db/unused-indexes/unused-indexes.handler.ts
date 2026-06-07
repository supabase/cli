import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbUnusedIndexesFlags } from "./unused-indexes.command.ts";

export const legacyInspectDbUnusedIndexes = Effect.fn("legacy.inspect.db.unused-indexes")(
  function* (flags: LegacyInspectDbUnusedIndexesFlags) {
    const proxy = yield* LegacyGoProxy;
    const args: string[] = ["inspect", "db", "unused-indexes"];
    if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
    if (flags.linked) args.push("--linked");
    if (flags.local) args.push("--local");
    yield* proxy.exec(args);
  },
);
