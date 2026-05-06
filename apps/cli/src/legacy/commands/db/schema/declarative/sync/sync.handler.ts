import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbSchemaDeclarativeSyncFlags } from "./sync.command.ts";

export const legacyDbSchemaDeclarativeSync = Effect.fn("legacy.db.schema.declarative.sync")(
  function* (flags: LegacyDbSchemaDeclarativeSyncFlags) {
    const proxy = yield* LegacyGoProxy;
    const args: string[] = ["db", "schema", "declarative", "sync"];
    if (flags.noCache) args.push("--no-cache");
    for (const s of flags.schema) {
      args.push("--schema", s);
    }
    if (Option.isSome(flags.file)) args.push("--file", flags.file.value);
    if (Option.isSome(flags.name)) args.push("--name", flags.name.value);
    if (flags.apply) args.push("--apply");
    yield* proxy.exec(args);
  },
);
