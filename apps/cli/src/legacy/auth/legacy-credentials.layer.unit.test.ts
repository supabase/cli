import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Redacted } from "effect";
import { afterEach, beforeEach, vi } from "vitest";

import { LegacyProfileFlag, LegacyWorkdirFlag } from "../../shared/legacy/global-flags.ts";
import { mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { legacyCliConfigLayer } from "../config/legacy-cli-config.layer.ts";
import { legacyCredentialsLayer } from "./legacy-credentials.layer.ts";
import { LegacyCredentials } from "./legacy-credentials.service.ts";
import { LegacyInvalidAccessTokenError } from "./legacy-errors.ts";

// ---------------------------------------------------------------------------
// Keyring mock
// ---------------------------------------------------------------------------

const passwords = new Map<string, string>();
let throwOnSetPassword = false;
const throwOnGetPasswordAccounts = new Set<string>();

vi.mock("@napi-rs/keyring", () => ({
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
    deleteCredential(): boolean {
      const key = this.key();
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

function makeLayer(opts: { env?: Record<string, string | undefined>; home?: string } = {}) {
  const home = opts.home ?? tempHome;
  const env = { HOME: home, ...opts.env };
  const runtimeInfoLayer = mockRuntimeInfo({ homeDir: home, cwd: home });
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
  throwOnGetPasswordAccounts.clear();
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
    passwords.set(goWindowsKey("supabase"), VALID_TOKEN);
    return Effect.gen(function* () {
      const { getAccessToken } = yield* LegacyCredentials;
      const token = yield* getAccessToken;
      expectSomeToken(token, VALID_TOKEN);
    }).pipe(Effect.provide(makeLayer()));
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

describe("legacyCredentialsLayer.deleteAccessToken", () => {
  it.effect("returns false when no token is stored anywhere", () =>
    Effect.gen(function* () {
      const { deleteAccessToken } = yield* LegacyCredentials;
      expect(yield* deleteAccessToken).toBe(false);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("removes both keyring entries plus the filesystem file", () => {
    passwords.set("Supabase CLI/supabase", VALID_TOKEN);
    passwords.set("Supabase CLI/access-token", VALID_OAUTH_TOKEN);
    passwords.set(goWindowsKey("supabase"), VALID_TOKEN);
    const supaDir = join(tempHome, ".supabase");
    mkdirSync(supaDir, { recursive: true });
    writeFileSync(join(supaDir, "access-token"), VALID_TOKEN, { mode: 0o600 });
    return Effect.gen(function* () {
      const { deleteAccessToken } = yield* LegacyCredentials;
      expect(yield* deleteAccessToken).toBe(true);
      expect(passwords.has("Supabase CLI/supabase")).toBe(false);
      expect(passwords.has("Supabase CLI/access-token")).toBe(false);
      expect(passwords.has(goWindowsKey("supabase"))).toBe(false);
      expect(existsSync(join(supaDir, "access-token"))).toBe(false);
    }).pipe(Effect.provide(makeLayer()));
  });
});

// Suppress unused-import nag — referenced in JSDoc.
void LegacyInvalidAccessTokenError;
