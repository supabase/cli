import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyGenBearerJwtFlags } from "./bearer-jwt.command.ts";

export const legacyGenBearerJwt = Effect.fn("legacy.gen.bearer-jwt")(function* (
  flags: LegacyGenBearerJwtFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["gen", "bearer-jwt"];
  if (Option.isSome(flags.role)) args.push("--role", flags.role.value);
  if (Option.isSome(flags.sub)) args.push("--sub", flags.sub.value);
  if (Option.isSome(flags.exp)) args.push("--exp", flags.exp.value);
  if (Option.isSome(flags.validFor)) args.push("--valid-for", flags.validFor.value);
  if (Option.isSome(flags.payload)) args.push("--payload", flags.payload.value);
  yield* proxy.exec(args);
});
