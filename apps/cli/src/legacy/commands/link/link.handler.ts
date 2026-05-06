import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import type { LegacyLinkFlags } from "./link.command.ts";

export const legacyLink = Effect.fn("legacy.link")(function* (flags: LegacyLinkFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["link"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
  if (flags.skipPooler) args.push("--skip-pooler");
  yield* proxy.exec(args);
});
