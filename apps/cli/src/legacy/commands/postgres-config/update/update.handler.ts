import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyPostgresConfigUpdateFlags } from "./update.command.ts";

export const legacyPostgresConfigUpdate = Effect.fn("legacy.postgres-config.update")(function* (
  flags: LegacyPostgresConfigUpdateFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["postgres-config", "update"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  for (const value of flags.config) {
    args.push("--config", value);
  }
  if (flags.replaceExistingOverrides) args.push("--replace-existing-overrides");
  if (flags.noRestart) args.push("--no-restart");
  yield* proxy.exec(args);
});
