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
type RuntimePlatform = NodeJS.Platform;

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
  platform: RuntimePlatform,
): Effect.Effect<Option.Option<string>> =>
  Effect.try({
    try: () => {
      const entry = new module.Entry(KEYRING_SERVICE, account);
      const value = readEntryPassword(entry);
      if (value && value.length > 0) return Option.some(normalizeKeyringToken(value));

      if (platform === "win32") {
        const goWindowsValue = readGoWindowsTarget(module, account);
        if (goWindowsValue && goWindowsValue.length > 0) {
          return Option.some(normalizeKeyringToken(goWindowsValue));
        }
      }

      return Option.none<string>();
    },
    catch: () => Option.none<string>(),
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

const tryKeyringWrite = (
  module: KeyringModule,
  account: string,
  token: string,
  platform: RuntimePlatform,
): Effect.Effect<boolean> =>
  Effect.try({
    try: () => {
      if (platform === "win32") {
        return writeGoWindowsTarget(module, account, token);
      }

      const entry = new module.Entry(KEYRING_SERVICE, account);
      entry.setPassword(token);
      return true;
    },
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false));

const tryKeyringDelete = (
  module: KeyringModule,
  account: string,
  platform: RuntimePlatform,
): Effect.Effect<boolean> =>
  Effect.try({
    try: () => {
      let deleted = false;

      const entry = new module.Entry(KEYRING_SERVICE, account);
      const value = readEntryPassword(entry);
      if (value) {
        entry.deleteCredential();
        deleted = true;
      }

      if (platform === "win32" && readGoWindowsTarget(module, account)) {
        deleted = deleteGoWindowsTarget(module, account) || deleted;
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

function goWindowsCredentialTarget(account: string): string {
  return `${KEYRING_SERVICE}:${account}`;
}

function readGoWindowsTarget(module: KeyringModule, account: string): string | null {
  try {
    const credentials = module.findCredentials(KEYRING_SERVICE, goWindowsCredentialTarget(account));
    const credential = credentials.find((item) => item.account === account);
    return credential ? normalizeGoWindowsPassword(credential.password) : null;
  } catch {
    return null;
  }
}

function normalizeGoWindowsPassword(value: string): string {
  const direct = normalizeKeyringToken(value);
  if (ACCESS_TOKEN_PATTERN.test(direct)) return direct;

  // Go writes Windows CredentialBlob values as raw UTF-8 bytes. The TS keyring
  // search API can surface those bytes packed into UTF-16 code units, so unpack
  // each code unit back into the original byte sequence before validation.
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    bytes.push(code & 0xff);
    const high = (code >> 8) & 0xff;
    if (high !== 0) bytes.push(high);
  }
  return Buffer.from(bytes).toString("utf8");
}

function writeGoWindowsTarget(module: KeyringModule, account: string, token: string): boolean {
  try {
    const entry = module.Entry.withTarget(
      goWindowsCredentialTarget(account),
      KEYRING_SERVICE,
      account,
    );
    entry.setSecret(Buffer.from(token, "utf8"));
    return true;
  } catch {
    return false;
  }
}

function deleteGoWindowsTarget(module: KeyringModule, account: string): boolean {
  try {
    const entry = module.Entry.withTarget(
      goWindowsCredentialTarget(account),
      KEYRING_SERVICE,
      account,
    );
    return entry.deleteCredential();
  } catch {
    return false;
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
    const profileResult = yield* tryKeyringRead(
      keyringModule.value,
      profileAccount,
      runtimeInfo.platform,
    );
    if (Option.isSome(profileResult)) return profileResult;
    return yield* tryKeyringRead(keyringModule.value, LEGACY_KEYRING_ACCOUNT, runtimeInfo.platform);
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
          const ok = yield* tryKeyringWrite(
            keyringModule.value,
            profileAccount,
            token,
            runtimeInfo.platform,
          );
          if (ok) return;
        }
        yield* fs.makeDirectory(fallbackDir, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
        yield* fs.writeFileString(fallbackPath, token, { mode: 0o600 }).pipe(Effect.orDie);
      }),

    deleteAccessToken: Effect.gen(function* () {
      let anyDeleted = false;
      if (Option.isSome(keyringModule)) {
        if (yield* tryKeyringDelete(keyringModule.value, profileAccount, runtimeInfo.platform)) {
          anyDeleted = true;
        }
        if (
          yield* tryKeyringDelete(keyringModule.value, LEGACY_KEYRING_ACCOUNT, runtimeInfo.platform)
        ) {
          anyDeleted = true;
        }
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
