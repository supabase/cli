import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyOrgsCreateFlags } from "./create.command.ts";

export const legacyOrgsCreate = Effect.fn("legacy.orgs.create")(function* (
  flags: LegacyOrgsCreateFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["orgs", "create", flags.name];
  yield* proxy.exec(args);
});
