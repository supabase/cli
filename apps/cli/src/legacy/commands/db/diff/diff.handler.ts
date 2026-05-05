import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbDiffFlags } from "./diff.command.ts";

export const legacyDbDiff = Effect.fn("legacy.db.diff")(function* (flags: LegacyDbDiffFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "diff"];
  if (flags.useMigra) args.push("--use-migra");
  if (flags.usePgAdmin) args.push("--use-pgadmin");
  if (flags.usePgSchema) args.push("--use-pg-schema");
  if (flags.usePgDelta) args.push("--use-pg-delta");
  if (Option.isSome(flags.from)) args.push("--from", flags.from.value);
  if (Option.isSome(flags.to)) args.push("--to", flags.to.value);
  if (Option.isSome(flags.output)) args.push("--output", flags.output.value);
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  if (Option.isSome(flags.file)) args.push("--file", flags.file.value);
  for (const s of flags.schema) {
    args.push("--schema", s);
  }
  for (const p of flags.paths) {
    args.push(String(p));
  }
  yield* proxy.exec(args);
});
