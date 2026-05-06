import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";

interface LegacySecretsUnsetFlags {
  readonly projectRef: Option.Option<string>;
  readonly names: ReadonlyArray<string>;
}

export const legacySecretsUnset = Effect.fn("legacy.secrets.unset")(function* (
  flags: LegacySecretsUnsetFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["secrets", "unset"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  args.push(...flags.names);
  yield* proxy.exec(args);
});
