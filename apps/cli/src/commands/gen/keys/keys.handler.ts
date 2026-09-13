import { Effect, Option } from "effect";
import { GoProxy } from "../../../command-internal/go-proxy.service.ts";
import type { GenKeysFlags } from "./keys.command.ts";

export const genKeys = Effect.fn("gen.keys")(function* (flags: GenKeysFlags) {
  const proxy = yield* GoProxy;
  const args: string[] = ["gen", "keys"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  for (const name of flags.overrideName) {
    args.push("--override-name", name);
  }
  yield* proxy.exec(args);
});
