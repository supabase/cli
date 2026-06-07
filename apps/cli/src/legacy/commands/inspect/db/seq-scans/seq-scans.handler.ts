import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbSeqScansFlags } from "./seq-scans.command.ts";

export const legacyInspectDbSeqScans = Effect.fn("legacy.inspect.db.seq-scans")(function* (
  flags: LegacyInspectDbSeqScansFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["inspect", "db", "seq-scans"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  yield* proxy.exec(args);
});
