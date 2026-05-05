import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyOrgsListFlags } from "./list.command.ts";

export const legacyOrgsList = Effect.fn("legacy.orgs.list")(function* (
  _flags: LegacyOrgsListFlags,
) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["orgs", "list"]);
});
