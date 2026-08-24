import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";

import { normalizeKeyringToken } from "../../shared/auth/keyring-token.ts";
import { CliConfig } from "../config/cli-config.service.ts";
import { Credentials } from "./credentials.service.ts";

const SERVICE = "Supabase CLI";
const ACCOUNT = "access-token";
const LEGACY_ACCOUNT = "supabase";

type KeyringModule = typeof import("@napi-rs/keyring");

const readKeyringToken = (keyring: KeyringModule, account: string) =>
  Effect.try({
    try: () => {
      const entry = new keyring.Entry(SERVICE, account);
      const token = entry.getPassword();
      return token ? Option.some(Redacted.make(normalizeKeyringToken(token))) : Option.none();
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const writeKeyringToken = (keyring: KeyringModule, account: string, token: string) =>
  Effect.try({
    try: () => {
      const entry = new keyring.Entry(SERVICE, account);
      entry.setPassword(token);
    },
    catch: () => undefined,
  }).pipe(Effect.option);

const deleteKeyringToken = (keyring: KeyringModule, account: string) =>
  Effect.try({
    try: () => {
      const entry = new keyring.Entry(SERVICE, account);
      if (!entry.getPassword()) return false;
      entry.deleteCredential();
      return true;
    },
    catch: () => undefined,
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
  const cliConfig = yield* CliConfig;
  const fallbackDir = cliConfig.supabaseHome;
  const fallbackPath = path.join(fallbackDir, "access-token");

  const keyringModule =
    Option.isSome(cliConfig.noKeyring) && cliConfig.noKeyring.value === "1"
      ? Option.none<typeof import("@napi-rs/keyring")>()
      : yield* Effect.tryPromise(() => import("@napi-rs/keyring")).pipe(Effect.option);

  return Credentials.of({
    // Read current storage first, then fall back to legacy account and finally the filesystem.
    getAccessToken: Effect.gen(function* () {
      if (Option.isSome(keyringModule)) {
        const current = yield* readKeyringToken(keyringModule.value, ACCOUNT);
        if (Option.isSome(current)) return current;
        const legacy = yield* readKeyringToken(keyringModule.value, LEGACY_ACCOUNT);
        if (Option.isSome(legacy)) return legacy;
      }

      const exists = yield* fs.exists(fallbackPath);
      if (exists) {
        const content = yield* fs.readFileString(fallbackPath);
        const trimmed = content.trim();
        if (trimmed) return Option.some(Redacted.make(trimmed));
      }

      return Option.none();
    }).pipe(Effect.orElseSucceed(() => Option.none())),

    // Writes follow the same policy: keyring when possible, filesystem when necessary.
    saveAccessToken: (token: string | Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        const plainToken = typeof token === "string" ? token : Redacted.value(token);
        if (Option.isSome(keyringModule)) {
          const saved = yield* writeKeyringToken(keyringModule.value, ACCOUNT, plainToken);
          if (Option.isSome(saved)) return;
        }

        yield* fs.makeDirectory(fallbackDir, { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(fallbackPath, plainToken, { mode: 0o600 });
      }).pipe(Effect.orDie),

    // Deletes the token from all storage locations. Returns true if anything was deleted.
    deleteAccessToken: Effect.gen(function* () {
      let anyDeleted = false;

      if (Option.isSome(keyringModule)) {
        for (const account of [ACCOUNT, LEGACY_ACCOUNT]) {
          const deleted = yield* deleteKeyringToken(keyringModule.value, account);
          anyDeleted ||= deleted;
        }
      }

      const exists = yield* fs.exists(fallbackPath);
      if (exists) {
        yield* fs.remove(fallbackPath);
        anyDeleted = true;
      }

      return anyDeleted;
    }).pipe(Effect.orDie),
  });
});

export const credentialsLayer = Layer.effect(Credentials, makeCredentials);
