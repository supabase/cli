import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";

interface LegacyTestDbFlags {
  readonly paths: ReadonlyArray<string>;
  readonly dbUrl: Option.Option<string>;
  readonly linked: boolean;
  readonly local: boolean;
}

export const legacyTestDb = Effect.fn("legacy.test.db")(function* (flags: LegacyTestDbFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["test", "db"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  args.push(...flags.paths);
  yield* proxy.exec(args);
});
