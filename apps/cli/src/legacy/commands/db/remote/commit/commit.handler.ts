import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbRemoteCommitFlags } from "./commit.command.ts";

export const legacyDbRemoteCommit = Effect.fn("legacy.db.remote.commit")(function* (
  flags: LegacyDbRemoteCommitFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "remote", "commit"];
  for (const s of flags.schema) {
    args.push("--schema", s);
  }
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
  yield* proxy.exec(args);
});
