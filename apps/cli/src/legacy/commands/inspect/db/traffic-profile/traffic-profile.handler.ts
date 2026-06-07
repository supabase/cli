import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";

interface LegacyInspectDbTrafficProfileFlags {
  readonly dbUrl: Option.Option<string>;
  readonly linked: boolean;
  readonly local: boolean;
}

export const legacyInspectDbTrafficProfile = Effect.fn("legacy.inspect.db.traffic-profile")(
  function* (flags: LegacyInspectDbTrafficProfileFlags) {
    const proxy = yield* LegacyGoProxy;
    const args: string[] = ["inspect", "db", "traffic-profile"];
    if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
    if (flags.linked) args.push("--linked");
    if (flags.local) args.push("--local");
    yield* proxy.exec(args);
  },
);
