import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option, PlatformError, Redacted } from "effect";
import { afterEach, beforeEach, vi } from "vitest";

import { LegacyProfileFlag, LegacyWorkdirFlag } from "../../shared/legacy/global-flags.ts";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { legacyCliConfigLayer } from "../config/legacy-cli-config.layer.ts";
import { legacyCredentialsLayer } from "./legacy-credentials.layer.ts";
import { LegacyCredentials } from "./legacy-credentials.service.ts";
import {
  LegacyDeleteTokenError,
  LegacyInvalidAccessTokenError,
  LegacyNotLoggedInError,
} from "./legacy-errors.ts";

// ---------------------------------------------------------------------------
// Keyring mock
// ---------------------------------------------------------------------------

const passwords = new Map<string, string>();
let throwOnSetPassword = false;
let throwOnSetSecret = false;
const throwOnGetPasswordAccounts = new Set<string>();
const throwOnDeleteAccounts = new Set<string>();
const withTargetCalls: string[] = [];

vi.mock("@napi-rs/keyring", () => ({
  findCredentials: (service: string, target?: string) =>
    Array.from(passwords.entries())
      .filter(([key]) =>
        // No target → model the Windows `CredEnumerate("<service>*")` sweep,
        // which matches both the plain (`<service>/…`) and the Go target-shaped
        // (`<service>:<account>/…`) entries by the leading segment. With a
        // target → narrow to that specific Go target (used by readGoWindowsTarget).
        target === undefined
          ? key.split("/")[0]!.startsWith(service)
          : key.startsWith(`${target}/`),
      )
      .map(([key, password]) => ({
        account: key.split("/").at(-1)!,
        password,
      })),
  Entry: class Entry {
    service: string;
    account: string;
    target?: string;
    constructor(service: string, account: string, target?: string) {
      this.service = service;
      this.account = account;
      this.target = target;
    }
    static withTarget(target: string, service: string, account: string) {
      withTargetCalls.push(`${target}/${service}/${account}`);
      return new this(service, account, target);
    }
    key(): string {
      return this.target === undefined
        ? `${this.service}/${this.account}`
        : `${this.target}/${this.service}/${this.account}`;
    }
    getPassword(): string | null {
      const key = this.key();
      if (throwOnGetPasswordAccounts.has(key)) {
        throw new Error("Keyring unavailable");
      }
      return passwords.get(key) ?? null;
    }
    setPassword(value: string): void {
      if (throwOnSetPassword) throw new Error("Keyring unavailable");
      passwords.set(this.key(), value);
    }
    setSecret(value: Uint8Array): void {
      if (throwOnSetSecret) throw new Error("Keyring unavailable");
      passwords.set(this.key(), Buffer.from(value).toString("utf8"));
    }
    deleteCredential(): boolean {
      const key = this.key();
      if (throwOnDeleteAccounts.has(key)) throw new Error("Keyring delete failed");
      if (!passwords.has(key)) throw new Error("not found");
      passwords.delete(key);
      return true;
    }
  },
}));

// ---------------------------------------------------------------------------
// Layer wiring
// ---------------------------------------------------------------------------

let tempHome: string;

function makeLayer(
  opts: {
    env?: Record<string, string | undefined>;
    home?: string;
    platform?: NodeJS.Platform;
  } = {},
) {
  const home = opts.home ?? tempHome;
  const env = { HOME: home, ...opts.env };
  const runtimeInfoLayer = mockRuntimeInfo({
    homeDir: home,
    cwd: home,
    platform: opts.platform,
  });
  const cliConfigLayer = legacyCliConfigLayer.pipe(
    Layer.provide(Layer.succeed(LegacyProfileFlag, "supabase")),
    Layer.provide(Layer.succeed(LegacyWorkdirFlag, Option.none<string>())),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(BunServices.layer),
    Layer.provide(processEnvLayer(env)),
  );
  return legacyCredentialsLayer.pipe(
    Layer.provide(cliConfigLayer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(BunServices.layer),
    Layer.provide(processEnvLayer(env)),
  );
}

beforeEach(() => {
  passwords.clear();
  throwOnSetPassword = false;
  throwOnSetSecret = false;
  throwOnGetPasswordAccounts.clear();
  throwOnDeleteAccounts.clear();
  withTargetCalls.length = 0;
  tempHome = mkdtempSync(join(tmpdir(), "supabase-legacy-creds-"));
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

const VALID_TOKEN = "sbp_" + "a".repeat(40);
const VALID_OAUTH_TOKEN = "sbp_oauth_" + "b".repeat(40);
const encodeGoKeyringBase64 = (token: string) =>
  `go-keyring-base64:${Buffer.from(token).toString("base64")}`;
const goWindowsKey = (account: string) => `Supabase CLI:${account}/Supabase CLI/${account}`;
const encodeGoWindowsPassword = (token: string) => {
  const bytes = Buffer.from(token, "utf8");
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 2) {
    encoded += String.fromCharCode(bytes[index]! | ((bytes[index + 1] ?? 0) << 8));
  }
  return encoded;
};

const expectSomeToken = (token: Option.Option<Redacted.Redacted<string>>, expected: string) => {
  expect(Option.isSome(token)).toBe(true);
  if (Option.isSome(token)) {
    expect(Redacted.value(token.value)).toBe(expected);
  }
};

describe("legacyCredentialsLayer.getAccessToken", () => {
  it.effect("returns the SUPABASE_ACCESS_TOKEN env value (highest precedence)", () => {
    passwords.set("Supabase CLI/supabase", "sbp_" + "9".repeat(40));
    return Effect.gen(function* () {
      const { getAccessToken } = yield* LegacyCredentials;
      const token = yield* getAccessToken;
      expectSomeToken(token, VALID_TOKEN);
    }).pipe(Effect.provide(makeLayer({ env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN } })));
  });

  it.effect("uses the keyring profile account when env is unset", () => {
    passwords.set("Supabase CLI/supabase", VALID_TOKEN);
    return Effect.gen(function* () {
      const { getAccessToken } = yield* LegacyCredentials;
      const token = yield* getAccessToken;
      expectSomeToken(token, VALID_TOKEN);
    }).pipe(Effect.provide(makeLayer()));
  });

  it.effect("decodes Go keyring base64 values from the keyring profile account", () => {
    passwords.set("Supabase CLI/supabase", encodeGoKeyringBase64(VALID_TOKEN));
    return Effect.gen(function* () {
      const { getAccessToken } = yield* LegacyCredentials;
      const token = yield* getAccessToken;
      expectSomeToken(token, VALID_TOKEN);
    }).pipe(Effect.provide(makeLayer()));
  });

  it.effect("reads Windows credentials created by Go keyring", () => {
    passwords.set(goWindowsKey("supabase"), encodeGoWindowsPassword(VALID_TOKEN));
    return Effect.gen(function* () {
      const { getAccessToken } = yield* LegacyCredentials;
      const token = yield* getAccessToken;
      expectSomeToken(token, VALID_TOKEN);
      expect(withTargetCalls).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ platform: "win32" })));
  });

  it.effect("does not search Go Windows targets on other platforms", () => {
    passwords.set(goWindowsKey("supabase"), VALID_TOKEN);
    return Effect.gen(function* () {
      const { getAccessToken } = yield* LegacyCredentials;
      const token = yield* getAccessToken;
      expect(token).toEqual(Option.none());
      expect(withTargetCalls).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ platform: "linux" })));
  });

  it.effect("falls through to the legacy access-token keyring entry", () => {
    passwords.set("Supabase CLI/access-token", VALID_OAUTH_TOKEN);
    return Effect.gen(function* () {
      const { getAccessToken } = yield* LegacyCredentials;
      const token = yield* getAccessToken;
      expectSomeToken(token, VALID_OAUTH_TOKEN);
    }).pipe(Effect.provide(makeLayer()));
  });

  it.effect("falls back to ~/.supabase/access-token when keyring entries miss", () => {
    const supaDir = join(tempHome, ".supabase");
    mkdirSync(supaDir, { recursive: true });
    writeFileSync(join(supaDir, "access-token"), `${VALID_TOKEN}\n`, { mode: 0o600 });
    return Effect.gen(function* () {
      const { getAccessToken } = yield* LegacyCredentials;
      const token = yield* getAccessToken;
      expectSomeToken(token, VALID_TOKEN);
    }).pipe(Effect.provide(makeLayer()));
  });

  it.effect("returns None when no source provides a token", () =>
    Effect.gen(function* () {
      const { getAccessToken } = yield* LegacyCredentials;
      const token = yield* getAccessToken;
      expect(token).toEqual(Option.none());
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("fails with LegacyInvalidAccessTokenError when token format is invalid", () => {
    passwords.set("Supabase CLI/supabase", "not-a-valid-token");
    return Effect.gen(function* () {
      const { getAccessToken } = yield* LegacyCredentials;
      const exit = yield* Effect.exit(getAccessToken);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyInvalidAccessTokenError");
        expect(errorJson).toContain("Invalid access token format");
      }
    }).pipe(Effect.provide(makeLayer()));
  });

  it.effect("falls back to the filesystem when keyring throws", () => {
    throwOnGetPasswordAccounts.add("Supabase CLI/supabase");
    throwOnGetPasswordAccounts.add("Supabase CLI/access-token");
    const supaDir = join(tempHome, ".supabase");
    mkdirSync(supaDir, { recursive: true });
    writeFileSync(join(supaDir, "access-token"), VALID_TOKEN, { mode: 0o600 });
    return Effect.gen(function* () {
      const { getAccessToken } = yield* LegacyCredentials;
      const token = yield* getAccessToken;
      expectSomeToken(token, VALID_TOKEN);
    }).pipe(Effect.provide(makeLayer()));
  });
});

describe("legacyCredentialsLayer.saveAccessToken", () => {
  it.effect("rejects invalid token formats up front", () =>
    Effect.gen(function* () {
      const { saveAccessToken } = yield* LegacyCredentials;
      const exit = yield* Effect.exit(saveAccessToken("nope"));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause)).toContain("LegacyInvalidAccessTokenError");
      }
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("writes to the keyring profile entry when available", () =>
    Effect.gen(function* () {
      const { saveAccessToken } = yield* LegacyCredentials;
      yield* saveAccessToken(VALID_TOKEN);
      expect(passwords.get("Supabase CLI/supabase")).toBe(VALID_TOKEN);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("writes Windows credentials where Go keyring reads them", () =>
    Effect.gen(function* () {
      const { saveAccessToken } = yield* LegacyCredentials;
      yield* saveAccessToken(VALID_TOKEN);
      expect(passwords.get(goWindowsKey("supabase"))).toBe(VALID_TOKEN);
      expect(passwords.has("Supabase CLI/supabase")).toBe(false);
    }).pipe(Effect.provide(makeLayer({ platform: "win32" }))),
  );

  it.effect("falls back to the shared token file when Windows target writes fail", () => {
    throwOnSetSecret = true;
    return Effect.gen(function* () {
      const { saveAccessToken } = yield* LegacyCredentials;
      yield* saveAccessToken(VALID_TOKEN);
      expect(passwords.has(goWindowsKey("supabase"))).toBe(false);
      expect(passwords.has("Supabase CLI/supabase")).toBe(false);
      const content = readFileSync(join(tempHome, ".supabase", "access-token"), "utf-8");
      expect(content).toBe(VALID_TOKEN);
    }).pipe(Effect.provide(makeLayer({ platform: "win32" })));
  });

  it.effect("falls back to the filesystem when the keyring write throws", () => {
    throwOnSetPassword = true;
    return Effect.gen(function* () {
      const { saveAccessToken } = yield* LegacyCredentials;
      yield* saveAccessToken(VALID_TOKEN);
      const content = readFileSync(join(tempHome, ".supabase", "access-token"), "utf-8");
      expect(content).toBe(VALID_TOKEN);
    }).pipe(Effect.provide(makeLayer()));
  });
});

// Go's `utils.DeleteAccessToken` (`access_token.go:100-119`) collapses three
// outcomes — logged out / not-logged-in / real failure — into the file +
// legacy-keyring + profile-keyring sequence. These cases assert the TS port
// reproduces that ordering and tri-state exactly (parity note 1).
describe("legacyCredentialsLayer.deleteAccessToken", () => {
  const seedTokenFile = (home: string, token = VALID_TOKEN) => {
    const supaDir = join(home, ".supabase");
    mkdirSync(supaDir, { recursive: true });
    writeFileSync(join(supaDir, "access-token"), token, { mode: 0o600 });
  };
  const tokenFileExists = (home: string) => existsSync(join(home, ".supabase", "access-token"));

  it.effect("logged in via keyring profile entry → deletes file + entry, succeeds", () => {
    passwords.set("Supabase CLI/supabase", VALID_TOKEN);
    passwords.set("Supabase CLI/access-token", VALID_OAUTH_TOKEN);
    seedTokenFile(tempHome);
    return Effect.gen(function* () {
      const { deleteAccessToken } = yield* LegacyCredentials;
      yield* deleteAccessToken;
      expect(passwords.has("Supabase CLI/supabase")).toBe(false);
      expect(passwords.has("Supabase CLI/access-token")).toBe(false);
      expect(tokenFileExists(tempHome)).toBe(false);
    }).pipe(Effect.provide(makeLayer()));
  });

  it.effect(
    "keyring profile entry absent → LegacyNotLoggedInError even though the file was removed",
    () => {
      seedTokenFile(tempHome);
      return Effect.gen(function* () {
        const { deleteAccessToken } = yield* LegacyCredentials;
        const exit = yield* Effect.exit(deleteAccessToken);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain("LegacyNotLoggedInError");
          expect(JSON.stringify(exit.cause)).toContain("You were not logged in, nothing to do.");
        }
        // File is still removed first (Go's deliberate ordering).
        expect(tokenFileExists(tempHome)).toBe(false);
      }).pipe(Effect.provide(makeLayer()));
    },
  );

  it.effect(
    "keyring unavailable (SUPABASE_NO_KEYRING) with token in file → removes file, still NotLoggedIn",
    () => {
      seedTokenFile(tempHome);
      return Effect.gen(function* () {
        const { deleteAccessToken } = yield* LegacyCredentials;
        const exit = yield* Effect.exit(deleteAccessToken);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain("LegacyNotLoggedInError");
        }
        expect(tokenFileExists(tempHome)).toBe(false);
      }).pipe(Effect.provide(makeLayer({ env: { SUPABASE_NO_KEYRING: "1" } })));
    },
  );

  it.effect(
    "file remove error (non-ENOENT) → LegacyDeleteTokenError before touching keyring",
    () => {
      const home = tempHome;
      const env = { HOME: home };
      const tokenPath = join(home, ".supabase", "access-token");
      // Seed a profile keyring entry to prove the keyring is never touched once
      // the file removal fails.
      passwords.set("Supabase CLI/supabase", VALID_TOKEN);
      const runtimeInfoLayer = mockRuntimeInfo({ homeDir: home, cwd: home });
      const fsLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: (p) => Effect.succeed(p === tokenPath),
          remove: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "remove",
                description: "permission denied",
                pathOrDescriptor: tokenPath,
              }),
            ),
        }),
      );
      const cliConfigLayer = legacyCliConfigLayer.pipe(
        Layer.provide(Layer.succeed(LegacyProfileFlag, "supabase")),
        Layer.provide(Layer.succeed(LegacyWorkdirFlag, Option.none<string>())),
        Layer.provide(runtimeInfoLayer),
        Layer.provide(BunServices.layer),
        Layer.provide(processEnvLayer(env)),
      );
      const layer = legacyCredentialsLayer.pipe(
        Layer.provide(cliConfigLayer),
        Layer.provide(runtimeInfoLayer),
        Layer.provide(fsLayer),
        Layer.provide(BunServices.layer),
        Layer.provide(processEnvLayer(env)),
      );
      return Effect.gen(function* () {
        const { deleteAccessToken } = yield* LegacyCredentials;
        const exit = yield* Effect.exit(deleteAccessToken);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain("LegacyDeleteTokenError");
          expect(JSON.stringify(exit.cause)).toContain("failed to remove access token file");
        }
        expect(passwords.has("Supabase CLI/supabase")).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("real profile-keyring delete error → LegacyDeleteTokenError", () => {
    passwords.set("Supabase CLI/supabase", VALID_TOKEN);
    throwOnDeleteAccounts.add("Supabase CLI/supabase");
    return Effect.gen(function* () {
      const { deleteAccessToken } = yield* LegacyCredentials;
      const exit = yield* Effect.exit(deleteAccessToken);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause)).toContain("LegacyDeleteTokenError");
        expect(JSON.stringify(exit.cause)).toContain("failed to delete access token from keyring");
      }
    }).pipe(Effect.provide(makeLayer()));
  });

  it.effect("win32: deletes both the plain and the Go Windows target entries", () => {
    passwords.set("Supabase CLI/supabase", VALID_TOKEN);
    passwords.set(goWindowsKey("supabase"), VALID_TOKEN);
    return Effect.gen(function* () {
      const { deleteAccessToken } = yield* LegacyCredentials;
      yield* deleteAccessToken;
      expect(passwords.has("Supabase CLI/supabase")).toBe(false);
      expect(passwords.has(goWindowsKey("supabase"))).toBe(false);
    }).pipe(Effect.provide(makeLayer({ platform: "win32" })));
  });

  it.effect("legacy-keyring delete error is swallowed and does not change the outcome", () => {
    passwords.set("Supabase CLI/supabase", VALID_TOKEN);
    passwords.set("Supabase CLI/access-token", VALID_OAUTH_TOKEN);
    throwOnDeleteAccounts.add("Supabase CLI/access-token");
    return Effect.gen(function* () {
      const { deleteAccessToken } = yield* LegacyCredentials;
      yield* deleteAccessToken;
      expect(passwords.has("Supabase CLI/supabase")).toBe(false);
    }).pipe(Effect.provide(makeLayer()));
  });
});

describe("legacyCredentialsLayer.deleteAllProjectCredentials", () => {
  it.effect("deletes every Supabase CLI keyring entry", () => {
    passwords.set("Supabase CLI/abcdefghijklmnopqrs1", "secret-1");
    passwords.set("Supabase CLI/abcdefghijklmnopqrs2", "secret-2");
    return Effect.gen(function* () {
      const { deleteAllProjectCredentials } = yield* LegacyCredentials;
      yield* deleteAllProjectCredentials;
      expect(passwords.has("Supabase CLI/abcdefghijklmnopqrs1")).toBe(false);
      expect(passwords.has("Supabase CLI/abcdefghijklmnopqrs2")).toBe(false);
    }).pipe(Effect.provide(makeLayer()));
  });

  it.effect("no-ops when the keyring is unavailable", () => {
    passwords.set("Supabase CLI/abcdefghijklmnopqrs1", "secret-1");
    return Effect.gen(function* () {
      const { deleteAllProjectCredentials } = yield* LegacyCredentials;
      yield* deleteAllProjectCredentials;
      expect(passwords.has("Supabase CLI/abcdefghijklmnopqrs1")).toBe(true);
    }).pipe(Effect.provide(makeLayer({ env: { SUPABASE_NO_KEYRING: "1" } })));
  });

  it.effect("win32: deletes Go target-shaped project credentials", () => {
    // Go stores Windows project credentials under `Supabase CLI:<ref>`, not the
    // plain `Supabase CLI/<ref>` form. The sweep must delete the target form too.
    passwords.set(goWindowsKey("abcdefghijklmnopqrs1"), "secret-1");
    return Effect.gen(function* () {
      const { deleteAllProjectCredentials } = yield* LegacyCredentials;
      yield* deleteAllProjectCredentials;
      expect(passwords.has(goWindowsKey("abcdefghijklmnopqrs1"))).toBe(false);
    }).pipe(Effect.provide(makeLayer({ platform: "win32" })));
  });

  it.effect("never fails even when an individual delete throws", () => {
    passwords.set("Supabase CLI/abcdefghijklmnopqrs1", "secret-1");
    throwOnDeleteAccounts.add("Supabase CLI/abcdefghijklmnopqrs1");
    return Effect.gen(function* () {
      const { deleteAllProjectCredentials } = yield* LegacyCredentials;
      const exit = yield* Effect.exit(deleteAllProjectCredentials);
      expect(exit._tag).toBe("Success");
    }).pipe(Effect.provide(makeLayer()));
  });
});

// Suppress unused-import nag — referenced in JSDoc / used in assertions above.
void LegacyInvalidAccessTokenError;
void LegacyDeleteTokenError;
void LegacyNotLoggedInError;
