import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyGenKeysFlags } from "./keys.command.ts";

export const legacyGenKeys = Effect.fn("legacy.gen.keys")(function* (flags: LegacyGenKeysFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["gen", "keys"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  for (const name of flags.overrideName) {
    args.push("--override-name", name);
  }
  yield* proxy.exec(args);
});
