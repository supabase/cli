import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyPostgresConfigDeleteFlags } from "./delete.command.ts";

export const legacyPostgresConfigDelete = Effect.fn("legacy.postgres-config.delete")(function* (
  flags: LegacyPostgresConfigDeleteFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["postgres-config", "delete"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  for (const key of flags.config) {
    args.push("--config", key);
  }
  if (flags.noRestart) args.push("--no-restart");
  yield* proxy.exec(args);
});
