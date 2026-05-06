import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbTotalTableSizesFlags } from "./total-table-sizes.command.ts";

export const legacyInspectDbTotalTableSizes = Effect.fn("legacy.inspect.db.total-table-sizes")(
  function* (flags: LegacyInspectDbTotalTableSizesFlags) {
    const proxy = yield* LegacyGoProxy;
    const args: string[] = ["inspect", "db", "total-table-sizes"];
    if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
    if (flags.linked) args.push("--linked");
    if (flags.local) args.push("--local");
    yield* proxy.exec(args);
  },
);
