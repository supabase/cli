import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyGenSigningKeyFlags } from "./signing-key.command.ts";

export const legacyGenSigningKey = Effect.fn("legacy.gen.signing-key")(function* (
  flags: LegacyGenSigningKeyFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["gen", "signing-key"];
  if (Option.isSome(flags.algorithm)) args.push("--algorithm", flags.algorithm.value);
  if (flags.append) args.push("--append");
  yield* proxy.exec(args);
});
