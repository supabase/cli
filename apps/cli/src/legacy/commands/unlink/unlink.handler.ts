import { Effect } from "effect";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";

export const legacyUnlink = Effect.fn("legacy.unlink")(function* () {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["unlink"]);
});
