import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import type { LegacyBootstrapFlags } from "./bootstrap.command.ts";

export const legacyBootstrap = Effect.fn("legacy.bootstrap")(function* (
  flags: LegacyBootstrapFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["bootstrap"];
  if (Option.isSome(flags.template)) args.push(flags.template.value);
  if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
  yield* proxy.exec(args);
});
