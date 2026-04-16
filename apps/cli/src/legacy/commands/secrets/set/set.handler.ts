import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";

interface LegacySecretsSetFlags {
  readonly projectRef: Option.Option<string>;
  readonly envFile: Option.Option<string>;
  readonly secrets: ReadonlyArray<string>;
}

export const legacySecretsSet = Effect.fn("legacy.secrets.set")(function* (
  flags: LegacySecretsSetFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["secrets", "set"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  if (Option.isSome(flags.envFile)) args.push("--env-file", flags.envFile.value);
  args.push(...flags.secrets);
  yield* proxy.exec(args);
});
