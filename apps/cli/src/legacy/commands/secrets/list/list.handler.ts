import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";

interface LegacySecretsListFlags {
  readonly projectRef: Option.Option<string>;
}

export const legacySecretsList = Effect.fn("legacy.secrets.list")(function* (
  flags: LegacySecretsListFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["secrets", "list"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
