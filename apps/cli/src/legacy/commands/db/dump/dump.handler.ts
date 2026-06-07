import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbDumpFlags } from "./dump.command.ts";

export const legacyDbDump = Effect.fn("legacy.db.dump")(function* (flags: LegacyDbDumpFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "dump"];
  if (flags.dryRun) args.push("--dry-run");
  if (flags.dataOnly) args.push("--data-only");
  if (flags.useCopy) args.push("--use-copy");
  for (const t of flags.exclude) {
    args.push("--exclude", t);
  }
  if (flags.roleOnly) args.push("--role-only");
  if (flags.keepComments) args.push("--keep-comments");
  if (Option.isSome(flags.file)) args.push("--file", flags.file.value);
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
  for (const s of flags.schema) {
    args.push("--schema", s);
  }
  yield* proxy.exec(args);
});
