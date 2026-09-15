import { Effect, FileSystem, Layer, Option, Path, Predicate, Redacted } from "effect";

import { normalizeKeyringToken } from "./keyring-token.ts";
import { CliSettings } from "../config/cli-settings.service.ts";
import { Credentials } from "./credentials.service.ts";

const SERVICE = "Supabase CLI";
const ACCOUNT = "access-token";
const LEGACY_ACCOUNT = "supabase";
type KeyringModule = typeof import("@napi-rs/keyring");

const tryKeyringRead = (
  module: KeyringModule,
  account: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.try(() => new module.Entry(SERVICE, account).getPassword()).pipe(
    Effect.option,
    Effect.map(
      Option.flatMap((value) =>
        value === null || value.length === 0 ? Option.none() : Option.some(value),
      ),
    ),
  );

const tryKeyringWrite = (
  module: KeyringModule,
  account: string,
  token: string,
): Effect.Effect<boolean> =>
  Effect.try(() => {
    new module.Entry(SERVICE, account).setPassword(token);
    return true;
  }).pipe(Effect.orElseSucceed(() => false));

const tryKeyringDelete = (module: KeyringModule, account: string): Effect.Effect<boolean> =>
  Effect.try(() => {
    const entry = new module.Entry(SERVICE, account);
    if (!entry.getPassword()) return false;
    entry.deleteCredential();
    return true;
  }).pipe(Effect.orElseSucceed(() => false));

/**
 * credentialsLayer - Token persistence policy for the CLI.
 *
 * The layer prefers keyring-backed storage when available, while preserving a
 * filesystem fallback for no-keyring environments and older installs.
 */
const makeCredentials = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliSettings = yield* CliSettings;
  const fallbackDir = cliSettings.supabaseHome;
  const fallbackPath = path.join(fallbackDir, "access-token");

  const keyringModule =
    Option.isSome(cliSettings.noKeyring) && cliSettings.noKeyring.value === "1"
      ? Option.none<typeof import("@napi-rs/keyring")>()
      : yield* Effect.tryPromise(() => import("@napi-rs/keyring")).pipe(Effect.option);

  return Credentials.of({
    getAccessToken: Effect.gen(function* () {
      if (Option.isSome(keyringModule)) {
        const token = yield* tryKeyringRead(keyringModule.value, ACCOUNT);
        if (Option.isSome(token)) {
          return Option.some(Redacted.make(normalizeKeyringToken(token.value)));
        }
        const legacyToken = yield* tryKeyringRead(keyringModule.value, LEGACY_ACCOUNT);
        if (Option.isSome(legacyToken)) {
          return Option.some(Redacted.make(normalizeKeyringToken(legacyToken.value)));
        }
      }

      const exists = yield* fs.exists(fallbackPath);
      if (exists) {
        const content = yield* fs.readFileString(fallbackPath);
        const trimmed = content.trim();
        if (trimmed) return Option.some(Redacted.make(trimmed));
      }

      return Option.none();
    }),

    saveAccessToken: (token: string | Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        const plainToken = typeof token === "string" ? token : Redacted.value(token);
        if (Option.isSome(keyringModule)) {
          if (yield* tryKeyringWrite(keyringModule.value, ACCOUNT, plainToken)) return;
        }

        yield* fs.makeDirectory(fallbackDir, { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(fallbackPath, plainToken, { mode: 0o600 });
      }),

    deleteAccessToken: Effect.gen(function* () {
      let anyDeleted = false;

      if (Option.isSome(keyringModule)) {
        for (const account of [ACCOUNT, LEGACY_ACCOUNT]) {
          const deleted = yield* tryKeyringDelete(keyringModule.value, account);
          anyDeleted ||= deleted;
        }
      }

      const exists = yield* fs.exists(fallbackPath);
      if (exists) {
        const removed = yield* fs.remove(fallbackPath).pipe(
          Effect.as(true),
          Effect.catchTag("PlatformError", (error) =>
            Predicate.isTagged(error.reason, "NotFound")
              ? Effect.succeed(false)
              : Effect.fail(error),
          ),
        );
        anyDeleted ||= removed;
      }

      return anyDeleted;
    }),
  });
});

export const credentialsLayer = Layer.effect(Credentials, makeCredentials);
