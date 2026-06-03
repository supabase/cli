import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";

import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { normalizeKeyringToken } from "../../shared/auth/keyring-token.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { LegacyCredentials } from "./legacy-credentials.service.ts";
import {
  LegacyCredentialDeleteError,
  LegacyDeleteTokenError,
  LegacyInvalidAccessTokenError,
  LegacyNotLoggedInError,
} from "./legacy-errors.ts";

const KEYRING_SERVICE = "Supabase CLI";
const LEGACY_KEYRING_ACCOUNT = "access-token";
const WSL_OSRELEASE_PATH = "/proc/sys/kernel/osrelease";

const ACCESS_TOKEN_PATTERN = /^sbp_(oauth_)?[a-f0-9]{40}$/;

const INVALID_TOKEN_MESSAGE = "Invalid access token format. Must be like `sbp_0102...1920`.";

// Go's `utils.ErrNotLoggedIn` (`access_token.go:19`).
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
// Delete the project database-password entry (keyed by project ref), surfacing a
// real failure while ignoring the "nothing to delete" cases — mirroring Go's
// unlink, which ignores both `keyring.ErrNotFound` AND `credentials.ErrNotSupported`
// (backend unavailable) and only surfaces other errors (`unlink.go:36-40`).
//
// The plain `Entry(service, projectRef)` is the macOS/Linux form and the Windows
// default. On Windows, Go also writes a separate target-shaped credential; it is
// detected via `findCredentials` (a plain `getPassword` does not read the Go
// target reliably) and deleted through the `withTarget` entry. The `withTarget`
// entry is only constructed on Windows — on macOS its first argument is an
// invalid keychain domain and throws.
//
// Each entry is probed before `deleteCredential()`: on macOS deleting an absent
// entry blocks on a Keychain authorization prompt, and an absent read means
// there is nothing to delete (ignorable, per Go). Only a real delete failure is
// surfaced as `LegacyCredentialDeleteError`.
const deleteKeyringEntryStrict = (
  module: KeyringModule,
  account: string,
  platform: RuntimePlatform,
): Effect.Effect<boolean, LegacyCredentialDeleteError> =>
  Effect.gen(function* () {
    let deleted = false;

    const plain = new module.Entry(KEYRING_SERVICE, account);
    if (readEntryPassword(plain)) {
      yield* Effect.try({
        try: () => {
          plain.deleteCredential();
        },
        catch: (cause) =>
          new LegacyCredentialDeleteError({
            message: `failed to delete project credential: ${String(cause)}`,
          }),
      });
      deleted = true;
    }

    if (platform === "win32" && readGoWindowsTarget(module, account)) {
      const target = module.Entry.withTarget(
        goWindowsCredentialTarget(account),
        KEYRING_SERVICE,
        account,
      );
      yield* Effect.try({
        try: () => {
          target.deleteCredential();
        },
        catch: (cause) =>
          new LegacyCredentialDeleteError({
            message: `failed to delete project credential: ${String(cause)}`,
          }),
      });
      deleted = true;
    }

    return deleted;
  });

// Delete the access-token profile entry, distinguishing the three outcomes Go's
// `credentials.StoreProvider.Delete(profile)` collapses into via the
// `access_token.go:110-117` error mapping:
//   - `"deleted"`  — an entry existed and was removed (→ logged out, exit 0);
//   - `"notFound"` — no entry existed (→ Go's `ErrNotLoggedIn`, exit 0);
//   - `LegacyDeleteTokenError` — a real `deleteCredential()` failure (exit 1).
// Like `deleteKeyringEntryStrict`, the entry is probed first so deleting an
// absent macOS entry never blocks on a Keychain prompt, and the Windows
// target-shaped credential is handled separately.
const deleteProfileKeyringEntry = (
  module: KeyringModule,
  account: string,
  platform: RuntimePlatform,
): Effect.Effect<"deleted" | "notFound", LegacyDeleteTokenError> =>
  Effect.gen(function* () {
    let found = false;

    const plain = new module.Entry(KEYRING_SERVICE, account);
    if (readEntryPassword(plain)) {
      yield* Effect.try({
        try: () => {
          plain.deleteCredential();
        },
        catch: (cause) =>
          new LegacyDeleteTokenError({
            message: `failed to delete access token from keyring: ${String(cause)}`,
          }),
      });
      found = true;
    }

    if (platform === "win32" && readGoWindowsTarget(module, account)) {
      const target = module.Entry.withTarget(
        goWindowsCredentialTarget(account),
        KEYRING_SERVICE,
        account,
      );
      yield* Effect.try({
        try: () => {
          target.deleteCredential();
        },
        catch: (cause) =>
          new LegacyDeleteTokenError({
            message: `failed to delete access token from keyring: ${String(cause)}`,
          }),
      });
      found = true;
    }

    return found ? "deleted" : "notFound";
  });

// Best-effort wipe of every entry in the `"Supabase CLI"` keyring namespace —
// the project database-password credentials `link` writes. Mirrors Go's
// `keyring.DeleteAll(namespace)` (`store.go:71`). Never fails: per-entry delete
// errors are swallowed so a single stuck credential can't abort logout.
//
// On Windows, Go stores credentials under the target-shaped name
// `Supabase CLI:<account>` rather than the plain `Entry(service, account)` form
// (see `writeGoWindowsTarget`). So each discovered account is deleted in BOTH
// forms — the plain entry and, on win32, the Go target entry — mirroring the
// individual deletes in `deleteProfileKeyringEntry`. Without this, a Go-written
// project credential would survive `logout` on Windows.
const deleteAllKeyringEntries = (
  module: KeyringModule,
  platform: RuntimePlatform,
): Effect.Effect<void> =>
  Effect.sync(() => {
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
      if (platform === "win32" && readGoWindowsTarget(module, account)) {
        deleteGoWindowsTarget(module, account);
      }
    }
  });

const makeLegacyCredentials = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const cliConfig = yield* LegacyCliConfig;
  const profileAccount = cliConfig.profile;

  // ~/.supabase/access-token — fallback file path
  const fallbackDir = path.join(runtimeInfo.homeDir, ".supabase");
  const fallbackPath = path.join(fallbackDir, "access-token");

  // `SUPABASE_NO_KEYRING=1` disables the OS keyring entirely (matches `next/`'s
  // credentials layer and the cli-e2e harness, which sets it). Without this, any
  // unconditional keyring access — e.g. `unlink`'s credential delete — blocks on a
  // Keychain authorization prompt in non-interactive / CI contexts.
  const noKeyring = process.env["SUPABASE_NO_KEYRING"] === "1";
  const wsl = yield* detectWsl(fs);
  const keyringModule =
    wsl || noKeyring
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
      // Reproduce Go's `utils.DeleteAccessToken` (`access_token.go:100-119`) in
      // its exact order.

      // 1. Always remove the fallback token file first. A missing file is
      //    ignored (Go's `errors.Is(err, os.ErrNotExist)`); any other removal
      //    failure aborts before the keyring is touched.
      const exists = yield* fs.exists(fallbackPath).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        yield* fs.remove(fallbackPath).pipe(
          Effect.catch((error) =>
            Effect.fail(
              new LegacyDeleteTokenError({
                message: `failed to remove access token file: ${error.message}`,
              }),
            ),
          ),
        );
      }

      // 2. Best-effort delete of the legacy `access-token` keyring account.
      //    Go debug-logs and ignores any error here — never affects the result.
      if (Option.isSome(keyringModule)) {
        yield* tryKeyringDelete(keyringModule.value, LEGACY_KEYRING_ACCOUNT, runtimeInfo.platform);
      }

      // 3. Delete the profile keyring account — this alone decides the outcome.
      //    No keyring backend (WSL / `SUPABASE_NO_KEYRING` / unsupported) maps to
      //    Go's `ErrNotSupported`/`ErrUnsupportedPlatform` → `ErrNotLoggedIn`.
      if (Option.isNone(keyringModule)) {
        return yield* Effect.fail(new LegacyNotLoggedInError({ message: NOT_LOGGED_IN_MESSAGE }));
      }
      const outcome = yield* deleteProfileKeyringEntry(
        keyringModule.value,
        profileAccount,
        runtimeInfo.platform,
      );
      if (outcome === "notFound") {
        return yield* Effect.fail(new LegacyNotLoggedInError({ message: NOT_LOGGED_IN_MESSAGE }));
      }
    }),

    deleteAllProjectCredentials: Effect.gen(function* () {
      if (Option.isNone(keyringModule)) return;
      yield* deleteAllKeyringEntries(keyringModule.value, runtimeInfo.platform);
    }),

    deleteProjectCredential: (projectRef: string) =>
      Effect.gen(function* () {
        // WSL / no keyring module: treated as `ErrNotSupported` — a no-op success.
        if (Option.isNone(keyringModule)) return false;
        return yield* deleteKeyringEntryStrict(
          keyringModule.value,
          projectRef,
          runtimeInfo.platform,
        );
      }),
  });
});

export const legacyCredentialsLayer = Layer.effect(LegacyCredentials, makeLegacyCredentials);
