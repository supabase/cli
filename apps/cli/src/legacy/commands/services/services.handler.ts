import { Effect } from "effect";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import type { LegacyServicesFlags } from "./services.command.ts";

export const legacyServices = Effect.fn("legacy.services")(function* (_flags: LegacyServicesFlags) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["services"]);
});
