import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyGenTypesFlags } from "./types.command.ts";

export const legacyGenTypes = Effect.fn("legacy.gen.types")(function* (flags: LegacyGenTypesFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["gen", "types"];
  if (flags.local) args.push("--local");
  if (flags.linked) args.push("--linked");
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (Option.isSome(flags.projectId)) args.push("--project-id", flags.projectId.value);
  if (Option.isSome(flags.lang)) args.push("--lang", flags.lang.value);
  for (const s of flags.schema) {
    args.push("--schema", s);
  }
  if (Option.isSome(flags.swiftAccessControl))
    args.push("--swift-access-control", flags.swiftAccessControl.value);
  if (flags.postgrestV9Compat) args.push("--postgrest-v9-compat");
  yield* proxy.exec(args);
});
