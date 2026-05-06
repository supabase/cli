import { Effect } from "effect";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import type { LegacyStatusFlags } from "./status.command.ts";

export const legacyStatus = Effect.fn("legacy.status")(function* (flags: LegacyStatusFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["status"];
  for (const override of flags.overrideName) args.push("--override-name", override);
  yield* proxy.exec(args);
});
