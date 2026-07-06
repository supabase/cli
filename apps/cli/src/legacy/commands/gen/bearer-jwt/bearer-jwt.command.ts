import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyGenBearerJwt } from "./bearer-jwt.handler.ts";

const config = {
  role: Flag.string("role").pipe(Flag.withDescription("Postgres role to use."), Flag.optional),
  sub: Flag.string("sub").pipe(Flag.withDescription("User ID to impersonate."), Flag.optional),
  exp: Flag.string("exp").pipe(
    Flag.withDescription("Expiry timestamp for this token (RFC3339 format)."),
    Flag.optional,
  ),
  validFor: Flag.string("valid-for").pipe(
    Flag.withDescription("Validity duration for this token."),
    Flag.optional,
  ),
  payload: Flag.string("payload").pipe(
    Flag.withDescription("Custom claims in JSON format."),
    Flag.optional,
  ),
} as const;

export type LegacyGenBearerJwtFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyGenBearerJwtCommand = Command.make("bearer-jwt", config).pipe(
  Command.withDescription("Generate a Bearer Auth JWT for accessing Data API."),
  Command.withShortDescription("Generate a Bearer Auth JWT for accessing Data API"),
  Command.withHandler((flags) => legacyGenBearerJwt(flags)),
);
