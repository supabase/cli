import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";

import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { normalizeKeyringToken } from "../../shared/auth/keyring-token.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { LegacyCredentials } from "./legacy-credentials.service.ts";
import { LegacyInvalidAccessTokenError } from "./legacy-errors.ts";

const KEYRING_SERVICE = "Supabase CLI";
const LEGACY_KEYRING_ACCOUNT = "access-token";
const WSL_OSRELEASE_PATH = "/proc/sys/kernel/osrelease";

const ACCESS_TOKEN_PATTERN = /^sbp_(oauth_)?[a-f0-9]{40}$/;

const INVALID_TOKEN_MESSAGE = "Invalid access token format. Must be like `sbp_0102...1920`.";

type KeyringModule = typeof import("@napi-rs/keyring");
type KeyringEntry = InstanceType<KeyringModule["Entry"]>;

const detectWsl = (fs: FileSystem.FileSystem): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(WSL_OSRELEASE_PATH).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return false;
    const content = yield* fs
      .readFileString(WSL_OSRELEASE_PATH)
      .pipe(Effect.orElseSucceed(() => ""));
    return content.includes("WSL") || content.includes("Microsoft");
  });

const tryKeyringRead = (
  module: KeyringModule,
  account: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.try({
    try: () => {
      for (const entry of [
        new module.Entry(KEYRING_SERVICE, account),
        module.Entry.withTarget(`${KEYRING_SERVICE}:${account}`, KEYRING_SERVICE, account),
      ]) {
        const value = readEntryPassword(entry);
        if (value && value.length > 0) return Option.some(normalizeKeyringToken(value));
      }
      return Option.none<string>();
    },
    catch: () => Option.none<string>(),
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

const tryKeyringWrite = (
  module: KeyringModule,
  account: string,
  token: string,
): Effect.Effect<boolean> =>
  Effect.try({
    try: () => {
      const entry = new module.Entry(KEYRING_SERVICE, account);
      entry.setPassword(token);
      return true;
    },
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false));

const tryKeyringDelete = (module: KeyringModule, account: string): Effect.Effect<boolean> =>
  Effect.try({
    try: () => {
      let deleted = false;
      for (const entry of [
        new module.Entry(KEYRING_SERVICE, account),
        module.Entry.withTarget(`${KEYRING_SERVICE}:${account}`, KEYRING_SERVICE, account),
      ]) {
        const value = readEntryPassword(entry);
        if (!value) continue;
        entry.deleteCredential();
        deleted = true;
      }
      return deleted;
    },
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false));

function readEntryPassword(entry: KeyringEntry): string | null {
  try {
    return entry.getPassword();
  } catch {
    return null;
  }
}

const makeLegacyCredentials = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const cliConfig = yield* LegacyCliConfig;
  const profileAccount = cliConfig.profile;

  // ~/.supabase/access-token — fallback file path
  const fallbackDir = path.join(runtimeInfo.homeDir, ".supabase");
  const fallbackPath = path.join(fallbackDir, "access-token");

  const wsl = yield* detectWsl(fs);
  const keyringModule = wsl
    ? Option.none<KeyringModule>()
    : yield* Effect.tryPromise(() => import("@napi-rs/keyring")).pipe(Effect.option);

  const validate = (token: string): Effect.Effect<string, LegacyInvalidAccessTokenError> =>
    ACCESS_TOKEN_PATTERN.test(token)
      ? Effect.succeed(token)
      : Effect.fail(new LegacyInvalidAccessTokenError({ message: INVALID_TOKEN_MESSAGE }));

  const readKeyring = Effect.gen(function* () {
    if (Option.isNone(keyringModule)) return Option.none<string>();
    const profileResult = yield* tryKeyringRead(keyringModule.value, profileAccount);
    if (Option.isSome(profileResult)) return profileResult;
    return yield* tryKeyringRead(keyringModule.value, LEGACY_KEYRING_ACCOUNT);
  });

  const readFile = Effect.gen(function* () {
    const exists = yield* fs.exists(fallbackPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return Option.none<string>();
    const content = yield* fs.readFileString(fallbackPath).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = content.trim();
    return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed);
  });

  return LegacyCredentials.of({
    getAccessToken: Effect.gen(function* () {
      // Env takes precedence (matches access_token.go:38).
      if (Option.isSome(cliConfig.accessToken)) {
        yield* validate(Redacted.value(cliConfig.accessToken.value));
        return Option.some(cliConfig.accessToken.value);
      }

      // Keyring (profile key, then legacy key). Skipped on WSL.
      const keyringValue = yield* readKeyring;
      if (Option.isSome(keyringValue)) {
        yield* validate(keyringValue.value);
        return Option.some(Redacted.make(keyringValue.value));
      }

      // Filesystem fallback at ~/.supabase/access-token.
      const fileValue = yield* readFile;
      if (Option.isSome(fileValue)) {
        yield* validate(fileValue.value);
        return Option.some(Redacted.make(fileValue.value));
      }

      return Option.none();
    }),

    saveAccessToken: (token: string) =>
      Effect.gen(function* () {
        yield* validate(token);
        if (Option.isSome(keyringModule)) {
          const ok = yield* tryKeyringWrite(keyringModule.value, profileAccount, token);
          if (ok) return;
        }
        yield* fs.makeDirectory(fallbackDir, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
        yield* fs.writeFileString(fallbackPath, token, { mode: 0o600 }).pipe(Effect.orDie);
      }),

    deleteAccessToken: Effect.gen(function* () {
      let anyDeleted = false;
      if (Option.isSome(keyringModule)) {
        if (yield* tryKeyringDelete(keyringModule.value, profileAccount)) anyDeleted = true;
        if (yield* tryKeyringDelete(keyringModule.value, LEGACY_KEYRING_ACCOUNT)) anyDeleted = true;
      }
      const exists = yield* fs.exists(fallbackPath).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        yield* fs.remove(fallbackPath).pipe(Effect.orDie);
        anyDeleted = true;
      }
      return anyDeleted;
    }),
  });
});

export const legacyCredentialsLayer = Layer.effect(LegacyCredentials, makeLegacyCredentials);
