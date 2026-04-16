import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbRoleConnectionsFlags } from "./role-connections.command.ts";

export const legacyInspectDbRoleConnections = Effect.fn("legacy.inspect.db.role-connections")(
  function* (flags: LegacyInspectDbRoleConnectionsFlags) {
    const proxy = yield* LegacyGoProxy;
    const args: string[] = ["inspect", "db", "role-connections"];
    if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
    if (flags.linked) args.push("--linked");
    if (flags.local) args.push("--local");
    yield* proxy.exec(args);
  },
);
