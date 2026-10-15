import { Effect } from "effect";
import { GoProxy } from "../../../command-internal/go-proxy.service.ts";
import { goProjectRefArgs } from "../../../command-internal/go-proxy-target-env.ts";
import type { GenKeysFlags } from "./keys.command.ts";

export const genKeys = Effect.fn("gen.keys")(function* (flags: GenKeysFlags) {
  const proxy = yield* GoProxy;
  const args: string[] = ["gen", "keys"];
  args.push(...(yield* goProjectRefArgs(flags.projectRef)));
  for (const name of flags.overrideName) {
    args.push("--override-name", name);
  }
  yield* proxy.exec(args);
});
