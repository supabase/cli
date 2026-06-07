import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbTableIndexSizesFlags } from "./table-index-sizes.command.ts";

export const legacyInspectDbTableIndexSizes = Effect.fn("legacy.inspect.db.table-index-sizes")(
  function* (flags: LegacyInspectDbTableIndexSizesFlags) {
    const proxy = yield* LegacyGoProxy;
    const args: string[] = ["inspect", "db", "table-index-sizes"];
    if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
    if (flags.linked) args.push("--linked");
    if (flags.local) args.push("--local");
    yield* proxy.exec(args);
  },
);
