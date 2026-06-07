import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbSchemaDeclarativeGenerateFlags } from "./generate.command.ts";

export const legacyDbSchemaDeclarativeGenerate = Effect.fn("legacy.db.schema.declarative.generate")(
  function* (flags: LegacyDbSchemaDeclarativeGenerateFlags) {
    const proxy = yield* LegacyGoProxy;
    const args: string[] = ["db", "schema", "declarative", "generate"];
    if (flags.noCache) args.push("--no-cache");
    if (flags.overwrite) args.push("--overwrite");
    if (flags.reset) args.push("--reset");
    for (const s of flags.schema) {
      args.push("--schema", s);
    }
    if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
    if (flags.linked) args.push("--linked");
    if (flags.local) args.push("--local");
    if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
    yield* proxy.exec(args);
  },
);
