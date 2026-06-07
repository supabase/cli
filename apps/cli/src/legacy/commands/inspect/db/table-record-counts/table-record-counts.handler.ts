import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbTableRecordCountsFlags } from "./table-record-counts.command.ts";

export const legacyInspectDbTableRecordCounts = Effect.fn("legacy.inspect.db.table-record-counts")(
  function* (flags: LegacyInspectDbTableRecordCountsFlags) {
    const proxy = yield* LegacyGoProxy;
    const args: string[] = ["inspect", "db", "table-record-counts"];
    if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
    if (flags.linked) args.push("--linked");
    if (flags.local) args.push("--local");
    yield* proxy.exec(args);
  },
);
