import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbRemoteChangesFlags } from "./changes.command.ts";

export const legacyDbRemoteChanges = Effect.fn("legacy.db.remote.changes")(function* (
  flags: LegacyDbRemoteChangesFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "remote", "changes"];
  for (const s of flags.schema) {
    args.push("--schema", s);
  }
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
  yield* proxy.exec(args);
});
