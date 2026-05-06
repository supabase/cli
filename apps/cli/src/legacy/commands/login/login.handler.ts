import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import type { LegacyLoginFlags } from "./login.command.ts";

export const legacyLogin = Effect.fn("legacy.login")(function* (flags: LegacyLoginFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["login"];
  if (Option.isSome(flags.token)) args.push("--token", flags.token.value);
  if (Option.isSome(flags.name)) args.push("--name", flags.name.value);
  if (flags.noBrowser) args.push("--no-browser");
  yield* proxy.exec(args);
});
