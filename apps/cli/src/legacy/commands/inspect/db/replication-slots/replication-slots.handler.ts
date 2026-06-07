import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbReplicationSlotsFlags } from "./replication-slots.command.ts";

export const legacyInspectDbReplicationSlots = Effect.fn("legacy.inspect.db.replication-slots")(
  function* (flags: LegacyInspectDbReplicationSlotsFlags) {
    const proxy = yield* LegacyGoProxy;
    const args: string[] = ["inspect", "db", "replication-slots"];
    if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
    if (flags.linked) args.push("--linked");
    if (flags.local) args.push("--local");
    yield* proxy.exec(args);
  },
);
