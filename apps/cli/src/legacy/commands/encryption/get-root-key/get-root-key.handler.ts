import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyEncryptionGetRootKeyFlags } from "./get-root-key.command.ts";

export const legacyEncryptionGetRootKey = Effect.fn("legacy.encryption.get-root-key")(function* (
  flags: LegacyEncryptionGetRootKeyFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["encryption", "get-root-key"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
