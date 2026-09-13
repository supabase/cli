import { Effect, FileSystem, Layer, Option, Path, Redacted, Result } from "effect";

import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { normalizeKeyringToken } from "../shared/auth/keyring-token.ts";
import { DebugLogger, type DebugLoggerShape } from "../command-internal/debug-logger.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { supabaseHome } from "../config/profile-file.ts";
import { ACCESS_TOKEN_PATTERN, validateAccessToken } from "./access-token.ts";
import { CommandCredentials } from "./command-credentials.service.ts";
import { CredentialDeleteError, DeleteTokenError, NotLoggedInError } from "./errors.ts";

const KEYRING_SERVICE = "Supabase CLI";
const LEGACY_KEYRING_ACCOUNT = "access-token";
const WSL_OSRELEASE_PATH = "/proc/sys/kernel/osrelease";

const NOT_LOGGED_IN_MESSAGE = "You were not logged in, nothing to do.";

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

      if (platform === "win32" && probeWindowsTarget(module, account) !== "absent") {
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

// `Entry.withTarget` is avoided as a probe since its constructor writes an empty placeholder. A
// `findCredentials` throw is ambiguous, so it's reported as `"unknown"`, never assumed present.
type WindowsTargetProbe = "present" | "absent" | "unknown";

function probeWindowsTarget(module: KeyringModule, account: string): WindowsTargetProbe {
  try {
    const credentials = module.findCredentials(KEYRING_SERVICE, goWindowsCredentialTarget(account));
    // An empty password is an orphaned placeholder, not a real credential.
    const credential = credentials.find(
      (item) => item.account === account && item.password.length > 0,
    );
    return credential ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

// Constructing `withTarget` always leaves something at that target — the real
// credential, or the placeholder — so a delete that follows is never a
// legitimate "nothing to delete": any non-success is surfaced.
const deleteProbedWindowsTarget = <E>(
  module: KeyringModule,
  account: string,
  onFailure: (cause: unknown) => E,
): Effect.Effect<boolean, E> =>
  Effect.gen(function* () {
    const result = yield* Effect.try(() =>
      module.Entry.withTarget(
        goWindowsCredentialTarget(account),
        KEYRING_SERVICE,
        account,
      ).deleteCredential(),
    ).pipe(Effect.result);
    if (Result.isSuccess(result) && result.success) return true;
    const cause = Result.isFailure(result) ? result.failure : "credential was not removed";
    return yield* Effect.fail(onFailure(cause));
  });

function normalizeGoWindowsPassword(value: string): string {
  const direct = normalizeKeyringToken(value);
  if (ACCESS_TOKEN_PATTERN.test(direct)) return direct;

  // Go writes Windows CredentialBlob values as raw UTF-8 bytes, which the keyring search API
  // can surface packed into UTF-16 code units; unpack each back into the original byte sequence.
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
// Deletes the project database-password keyring entry, ignoring "nothing to delete" and
// surfacing only a real failure. Each entry is probed first, since deleting an absent macOS
// entry blocks on a Keychain prompt; on Windows a separate `withTarget` entry is also probed.
const deleteKeyringEntryStrict = (
  module: KeyringModule,
  account: string,
  platform: RuntimePlatform,
): Effect.Effect<boolean, CredentialDeleteError> =>
  Effect.gen(function* () {
    let deleted = false;

    const plain = new module.Entry(KEYRING_SERVICE, account);
    if (readEntryPassword(plain)) {
      yield* Effect.try({
        try: () => {
          plain.deleteCredential();
        },
        catch: (cause) =>
          new CredentialDeleteError({
            message: `failed to delete project credential: ${String(cause)}`,
          }),
      });
      deleted = true;
    }

    if (platform === "win32" && probeWindowsTarget(module, account) !== "absent") {
      const removed = yield* deleteProbedWindowsTarget(
        module,
        account,
        (cause) =>
          new CredentialDeleteError({
            message: `failed to delete project credential: ${String(cause)}`,
          }),
      );
      deleted ||= removed;
    }

    return deleted;
  });

// Deletes the profile's access-token keyring entry. Returns "notFound" when nothing existed
// (not an error) so the caller can treat that as already logged out.
const deleteProfileKeyringEntry = (
  module: KeyringModule,
  account: string,
  platform: RuntimePlatform,
): Effect.Effect<"deleted" | "notFound", DeleteTokenError> =>
  Effect.gen(function* () {
    let found = false;

    const plain = new module.Entry(KEYRING_SERVICE, account);
    if (readEntryPassword(plain)) {
      yield* Effect.try({
        try: () => {
          plain.deleteCredential();
        },
        catch: (cause) =>
          new DeleteTokenError({
            message: `failed to delete access token from keyring: ${String(cause)}`,
          }),
      });
      found = true;
    }

    if (platform === "win32" && probeWindowsTarget(module, account) !== "absent") {
      const removed = yield* deleteProbedWindowsTarget(
        module,
        account,
        (cause) =>
          new DeleteTokenError({
            message: `failed to delete access token from keyring: ${String(cause)}`,
          }),
      );
      found ||= removed;
    }

    return found ? "deleted" : "notFound";
  });

// Best-effort wipe of the "Supabase CLI" keyring namespace; errors are swallowed so one stuck
// credential can't abort logout. Windows credentials are also written under a separate
// target-shaped form, invisible to the plain enumeration, so they're swept separately.
const deleteAllKeyringEntries = (
  module: KeyringModule,
  platform: RuntimePlatform,
): Effect.Effect<void> =>
  Effect.sync(() => {
    if (platform === "win32") {
      try {
        const entries = module.findCredentials(
          KEYRING_SERVICE,
          `${goWindowsCredentialTarget("")}*`,
        );
        for (const { account } of entries) {
          deleteGoWindowsTarget(module, account);
        }
      } catch {
        // best-effort
      }
    }

    let entries: ReadonlyArray<{ account: string }>;
    try {
      entries = module.findCredentials(KEYRING_SERVICE);
    } catch {
      return;
    }
    for (const { account } of entries) {
      try {
        new module.Entry(KEYRING_SERVICE, account).deleteCredential();
      } catch {
        // best-effort per entry
      }
    }
  });

// `SUPABASE_NO_KEYRING=1` disables the OS keyring entirely; without it, unconditional keyring
// access blocks on a Keychain authorization prompt in non-interactive/CI contexts.
const loadKeyringModule = (
  fs: FileSystem.FileSystem,
): Effect.Effect<Option.Option<KeyringModule>> =>
  Effect.gen(function* () {
    const noKeyring = process.env["SUPABASE_NO_KEYRING"] === "1";
    const wsl = yield* detectWsl(fs);
    return wsl || noKeyring
      ? Option.none<KeyringModule>()
      : yield* Effect.tryPromise(() => import("@napi-rs/keyring")).pipe(Effect.option);
  });

// Keyring chain for a given profile account: profile key first, then the legacy `access-token`
// key. Callers must pass the already-reconciled profile name.
const readKeyringForAccount = (
  keyringModule: Option.Option<KeyringModule>,
  profileAccount: string,
  platform: RuntimePlatform,
  debugLogger: DebugLoggerShape,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    if (Option.isNone(keyringModule)) return Option.none<string>();
    const profileResult = yield* tryKeyringRead(keyringModule.value, profileAccount, platform);
    if (Option.isSome(profileResult)) {
      yield* debugLogger.debug(`Using access token for profile: ${profileAccount}`);
      return profileResult;
    }
    const legacyResult = yield* tryKeyringRead(
      keyringModule.value,
      LEGACY_KEYRING_ACCOUNT,
      platform,
    );
    if (Option.isSome(legacyResult)) {
      yield* debugLogger.debug("Using access token from credentials store...");
    }
    return legacyResult;
  });

const readFallbackFile = (
  fs: FileSystem.FileSystem,
  fallbackPath: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(fallbackPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return Option.none<string>();
    const content = yield* fs.readFileString(fallbackPath).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = content.trim();
    return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed);
  });

/**
 * Resolves an access token for an explicit profile account: env token → keyring (profile
 * account, then legacy account) → fallback file. Used by commands that reconcile a
 * pflag-effective profile after `CommandCredentials` already captured a different one at
 * construction. Fails with the same validation error as `resolveAccessToken`.
 */
export const accessTokenForProfile = Effect.fnUntraced(function* (profileAccount: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const cliSettings = yield* CommandSettings;
  // Keeps the logger optional — a no-op outside the real CLI tree.
  const debugLogger: DebugLoggerShape = Option.getOrElse(
    yield* Effect.serviceOption(DebugLogger),
    () => ({ debug: () => Effect.void, http: () => Effect.void }),
  );

  if (Option.isSome(cliSettings.accessToken)) {
    yield* debugLogger.debug("Using access token from env var...");
    yield* validateAccessToken(Redacted.value(cliSettings.accessToken.value));
    return Option.some(cliSettings.accessToken.value);
  }

  const keyringModule = yield* loadKeyringModule(fs);
  const keyringValue = yield* readKeyringForAccount(
    keyringModule,
    profileAccount,
    runtimeInfo.platform,
    debugLogger,
  );
  if (Option.isSome(keyringValue)) {
    yield* validateAccessToken(keyringValue.value);
    return Option.some(Redacted.make(keyringValue.value));
  }

  const fallbackPath = path.join(supabaseHome(runtimeInfo.homeDir), "access-token");
  const fileValue = yield* readFallbackFile(fs, fallbackPath);
  if (Option.isSome(fileValue)) {
    yield* debugLogger.debug(`Using access token from file: ${fallbackPath}`);
    yield* validateAccessToken(fileValue.value);
    return Option.some(Redacted.make(fileValue.value));
  }

  return Option.none<Redacted.Redacted<string>>();
});

const makeCommandCredentials = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const cliSettings = yield* CommandSettings;
  const debugLogger = yield* DebugLogger;
  const profileAccount = cliSettings.profile;

  // <SUPABASE_HOME or ~/.supabase>/access-token — fallback file path
  const fallbackDir = supabaseHome(runtimeInfo.homeDir);
  const fallbackPath = path.join(fallbackDir, "access-token");

  const keyringModule = yield* loadKeyringModule(fs);

  const readKeyring = readKeyringForAccount(
    keyringModule,
    profileAccount,
    runtimeInfo.platform,
    debugLogger,
  );

  const readFile = readFallbackFile(fs, fallbackPath);

  return CommandCredentials.of({
    getAccessToken: Effect.gen(function* () {
      if (Option.isSome(cliSettings.accessToken)) {
        yield* debugLogger.debug("Using access token from env var...");
        yield* validateAccessToken(Redacted.value(cliSettings.accessToken.value), "env");
        return Option.some(cliSettings.accessToken.value);
      }

      // Skipped on WSL.
      const keyringValue = yield* readKeyring;
      if (Option.isSome(keyringValue)) {
        yield* validateAccessToken(keyringValue.value, "stored");
        return Option.some(Redacted.make(keyringValue.value));
      }

      const fileValue = yield* readFile;
      if (Option.isSome(fileValue)) {
        yield* debugLogger.debug(`Using access token from file: ${fallbackPath}`);
        yield* validateAccessToken(fileValue.value, "stored");
        return Option.some(Redacted.make(fileValue.value));
      }

      return Option.none();
    }),

    saveAccessToken: (token: string) =>
      Effect.gen(function* () {
        yield* validateAccessToken(token);
        if (Option.isSome(keyringModule)) {
          const ok = yield* tryKeyringWrite(
            keyringModule.value,
            profileAccount,
            token,
            runtimeInfo.platform,
          );
          if (ok) return;
        }
        // The containing directory is world-readable (0755); only the token file itself must
        // be private (0600).
        yield* fs.makeDirectory(fallbackDir, { recursive: true, mode: 0o755 }).pipe(Effect.orDie);
        yield* fs.writeFileString(fallbackPath, token, { mode: 0o600 }).pipe(Effect.orDie);
      }),

    deleteAccessToken: Effect.gen(function* () {
      // Removes the fallback token file first; a missing file is ignored, but any other
      // failure aborts before the keyring is touched.
      const exists = yield* fs.exists(fallbackPath).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        yield* fs.remove(fallbackPath).pipe(
          Effect.catch((error) =>
            Effect.fail(
              new DeleteTokenError({
                message: `failed to remove access token file: ${error.message}`,
              }),
            ),
          ),
        );
      }

      // Best-effort delete of the legacy `access-token` keyring account; errors here don't
      // affect the result.
      if (Option.isSome(keyringModule)) {
        yield* tryKeyringDelete(keyringModule.value, LEGACY_KEYRING_ACCOUNT, runtimeInfo.platform);
      }

      // Deleting the profile keyring account decides the outcome; no keyring backend (WSL,
      // `SUPABASE_NO_KEYRING`, unsupported) maps to `NotLoggedInError`.
      if (Option.isNone(keyringModule)) {
        return yield* Effect.fail(new NotLoggedInError({ message: NOT_LOGGED_IN_MESSAGE }));
      }
      const outcome = yield* deleteProfileKeyringEntry(
        keyringModule.value,
        profileAccount,
        runtimeInfo.platform,
      );
      if (outcome === "notFound") {
        return yield* Effect.fail(new NotLoggedInError({ message: NOT_LOGGED_IN_MESSAGE }));
      }
    }),

    deleteAllProjectCredentials: Effect.gen(function* () {
      if (Option.isNone(keyringModule)) return;
      yield* deleteAllKeyringEntries(keyringModule.value, runtimeInfo.platform);
    }),

    deleteProjectCredential: (projectRef: string) =>
      Effect.gen(function* () {
        // WSL or no keyring module: no-op success, nothing to delete.
        if (Option.isNone(keyringModule)) return false;
        return yield* deleteKeyringEntryStrict(
          keyringModule.value,
          projectRef,
          runtimeInfo.platform,
        );
      }),
  });
});

export const commandCredentialsLayer = Layer.effect(CommandCredentials, makeCommandCredentials);
