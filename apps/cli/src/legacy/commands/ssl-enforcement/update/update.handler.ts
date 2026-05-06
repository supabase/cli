import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacySslEnforcementUpdateFlags } from "./update.command.ts";

export const legacySslEnforcementUpdate = Effect.fn("legacy.ssl-enforcement.update")(function* (
  flags: LegacySslEnforcementUpdateFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["ssl-enforcement", "update"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  if (flags.enableDbSslEnforcement) args.push("--enable-db-ssl-enforcement");
  if (flags.disableDbSslEnforcement) args.push("--disable-db-ssl-enforcement");
  yield* proxy.exec(args);
});
