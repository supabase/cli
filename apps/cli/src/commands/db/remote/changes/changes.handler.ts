import { Effect, Option } from "effect";
import { GoProxy } from "../../../../command-internal/go-proxy.service.ts";
import { goProjectTarget } from "../../../../command-internal/go-proxy-target-env.ts";
import type { DbRemoteChangesFlags } from "./changes.command.ts";

export const dbRemoteChanges = Effect.fn("db.remote.changes")(function* (
  flags: DbRemoteChangesFlags,
) {
  const proxy = yield* GoProxy;
  const args: string[] = ["db", "remote", "changes"];
  for (const s of flags.schema) {
    args.push("--schema", s);
  }
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
  const target = Option.isNone(flags.dbUrl)
    ? yield* goProjectTarget(Option.none())
    : { args: [], env: {} };
  args.push(...target.args);
  yield* proxy.exec(args, { env: target.env });
});
