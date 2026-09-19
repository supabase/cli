import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, PlatformError, Redacted } from "effect";

import { CommandCredentials } from "../auth/command-credentials.service.ts";
import { InvalidAccessTokenError } from "../auth/errors.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { resolveAccessToken } from "./resolve-token.ts";

const settings = (accessToken: Option.Option<Redacted.Redacted<string>>) =>
  Layer.succeed(CommandSettings, {
    profile: "supabase",
    profileEnvValue: Option.none(),
    supabaseHome: "/tmp/supabase-cli-resolve-token/.supabase",
    apiUrl: "https://api.supabase.com",
    projectHost: "supabase.co",
    poolerHost: "supabase.com",
    dashboardUrl: "https://supabase.com/dashboard",
    accessToken,
    projectId: Option.none(),
    workdir: "/tmp/supabase-cli-resolve-token",
    explicitWorkdir: false,
    workdirEnvValue: Option.none(),
    dbPassword: Option.none(),
    githubToken: Option.none(),
    userAgent: "SupabaseCLI/test",
  });

const credentials = (
  getAccessToken: Effect.Effect<
    Option.Option<Redacted.Redacted<string>>,
    InvalidAccessTokenError | PlatformError.PlatformError
  >,
) =>
  Layer.succeed(CommandCredentials, {
    getAccessToken,
    saveAccessToken: () => Effect.void,
    deleteAccessToken: Effect.void,
    deleteAllProjectCredentials: Effect.void,
    deleteProjectCredential: () => Effect.succeed(false),
  });

const resolve = (
  accessToken: Option.Option<Redacted.Redacted<string>>,
  getAccessToken: Effect.Effect<
    Option.Option<Redacted.Redacted<string>>,
    InvalidAccessTokenError | PlatformError.PlatformError
  >,
) =>
  resolveAccessToken.pipe(
    Effect.provide(Layer.mergeAll(settings(accessToken), credentials(getAccessToken))),
  );

describe("resolveAccessToken", () => {
  it.effect("falls back to no token for an invalid stored token", () =>
    Effect.gen(function* () {
      const token = yield* resolve(
        Option.none(),
        Effect.fail(
          new InvalidAccessTokenError({ message: "stored token is invalid", source: "stored" }),
        ),
      );
      expect(Option.isNone(token)).toBe(true);
    }),
  );

  it.effect("returns no token when credentials are absent", () =>
    Effect.gen(function* () {
      const token = yield* resolve(Option.none(), Effect.succeed(Option.none()));
      expect(Option.isNone(token)).toBe(true);
    }),
  );

  it.effect("preserves a credential storage permission failure", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        resolve(
          Option.none(),
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "readFileString",
              description: "permission denied",
              pathOrDescriptor: "/tmp/supabase-cli-resolve-token/access-token",
            }),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(PlatformError.PlatformError);
        }
      }
    }),
  );

  it.effect("prefers an explicit token without reading stored credentials", () =>
    Effect.gen(function* () {
      const token = Redacted.make("sbp_explicit");
      const resolved = yield* resolve(
        Option.some(token),
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
            description: "permission denied",
          }),
        ),
      );
      expect(Option.isSome(resolved)).toBe(true);
      if (Option.isSome(resolved)) expect(Redacted.value(resolved.value)).toBe("sbp_explicit");
    }),
  );
});
