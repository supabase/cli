import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyEncryptionUpdateRootKeyFlags } from "./update-root-key.command.ts";

export const legacyEncryptionUpdateRootKey = Effect.fn("legacy.encryption.update-root-key")(
  function* (flags: LegacyEncryptionUpdateRootKeyFlags) {
    const proxy = yield* LegacyGoProxy;
    const args: string[] = ["encryption", "update-root-key"];
    if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
    yield* proxy.exec(args);
  },
);
