import { Effect } from "effect";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";

export const legacyLogout = Effect.fn("legacy.logout")(function* () {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["logout"]);
});
