import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, vi } from "vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option } from "effect";
import { mockRuntimeInfo } from "../../tests/helpers/mocks.ts";
import { cliConfigLayer } from "../config/cli-config.layer.ts";
import { Credentials } from "./credentials.service.ts";
import { credentialsLayer } from "./credentials.layer.ts";

const passwords = new Map<string, string>();
let throwOnSetPassword = false;
const throwOnGetPasswordAccounts = new Set<string>();
const returnNullForAccounts = new Set<string>();

vi.mock("@napi-rs/keyring", () => ({
  Entry: class Entry {
    service: string;
    account: string;
    constructor(service: string, account: string) {
      this.service = service;
      this.account = account;
    }
    getPassword(): string | null {
      const key = `${this.service}/${this.account}`;
      if (throwOnGetPasswordAccounts.has(key)) {
        throw new Error("Keyring unavailable");
      }
      if (returnNullForAccounts.has(key)) {
        return null;
      }
      if (!passwords.has(key)) {
        throw new Error("No password found");
      }
      return passwords.get(key)!;
    }
    setPassword(password: string): void {
      if (throwOnSetPassword) {
        throw new Error("Keyring unavailable");
      }
      passwords.set(`${this.service}/${this.account}`, password);
    }
  },
}));

function makeLayer(home: string, env: Record<string, string> = {}) {
  const configProviderLayer = ConfigProvider.layer(
    ConfigProvider.fromEnv({ env: { HOME: home, ...env } }),
  );
  const runtimeInfoLayer = mockRuntimeInfo({ homeDir: home });
  const baseLayer = Layer.mergeAll(
    BunServices.layer,
    configProviderLayer,
    runtimeInfoLayer,
    cliConfigLayer.pipe(Layer.provide(runtimeInfoLayer), Layer.provide(configProviderLayer)),
  );
  return credentialsLayer.pipe(Layer.provide(baseLayer));
}

let tempHome: string;

beforeEach(() => {
  passwords.clear();
  throwOnSetPassword = false;
  throwOnGetPasswordAccounts.clear();
  returnNullForAccounts.clear();
  tempHome = mkdtempSync(join(tmpdir(), "supa-creds-test-"));
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe("Credentials", () => {
  describe("getAccessToken", () => {
    it.effect("reads from current account", () => {
      passwords.set("Supabase CLI/access-token", "current-token");
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expect(token).toEqual(Option.some("current-token"));
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("falls back to legacy account when current is missing", () => {
      passwords.set("Supabase CLI/supabase", "legacy-token");
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expect(token).toEqual(Option.some("legacy-token"));
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("prefers current account over legacy", () => {
      passwords.set("Supabase CLI/access-token", "current-token");
      passwords.set("Supabase CLI/supabase", "legacy-token");
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expect(token).toEqual(Option.some("current-token"));
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("returns none when no token found anywhere", () => {
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expect(token).toEqual(Option.none());
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("falls back to filesystem when keyring throws", () => {
      throwOnGetPasswordAccounts.add("Supabase CLI/access-token");
      throwOnGetPasswordAccounts.add("Supabase CLI/supabase");
      const supaDir = join(tempHome, ".supabase");
      mkdirSync(supaDir, { recursive: true });
      writeFileSync(join(supaDir, "access-token"), "fs-token-123", { mode: 0o600 });
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expect(token).toEqual(Option.some("fs-token-123"));
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("returns Some from filesystem in no-keyring mode", () => {
      const supaDir = join(tempHome, ".supabase");
      mkdirSync(supaDir, { recursive: true });
      writeFileSync(join(supaDir, "access-token"), "fs-only-token", { mode: 0o600 });
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expect(token).toEqual(Option.some("fs-only-token"));
      }).pipe(Effect.provide(makeLayer(tempHome, { SUPABASE_NO_KEYRING: "1" })));
    });

    it.effect("returns None when filesystem file is empty", () => {
      throwOnGetPasswordAccounts.add("Supabase CLI/access-token");
      throwOnGetPasswordAccounts.add("Supabase CLI/supabase");
      const supaDir = join(tempHome, ".supabase");
      mkdirSync(supaDir, { recursive: true });
      writeFileSync(join(supaDir, "access-token"), "", { mode: 0o600 });
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expect(token).toEqual(Option.none());
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("returns None when filesystem file has only whitespace", () => {
      throwOnGetPasswordAccounts.add("Supabase CLI/access-token");
      throwOnGetPasswordAccounts.add("Supabase CLI/supabase");
      const supaDir = join(tempHome, ".supabase");
      mkdirSync(supaDir, { recursive: true });
      writeFileSync(join(supaDir, "access-token"), "   \n  \t  ", { mode: 0o600 });
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expect(token).toEqual(Option.none());
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("falls through when keyring returns null for both accounts", () => {
      returnNullForAccounts.add("Supabase CLI/access-token");
      returnNullForAccounts.add("Supabase CLI/supabase");
      const supaDir = join(tempHome, ".supabase");
      mkdirSync(supaDir, { recursive: true });
      writeFileSync(join(supaDir, "access-token"), "fs-fallback-token", { mode: 0o600 });
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        // keyring returns null (falsy) for both → falls through to filesystem
        expect(token).toEqual(Option.some("fs-fallback-token"));
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect(
      "returns None when filesystem check fails unexpectedly (orElseSucceed branch)",
      () => {
        throwOnGetPasswordAccounts.add("Supabase CLI/access-token");
        throwOnGetPasswordAccounts.add("Supabase CLI/supabase");
        const failingFs = Layer.succeed(FileSystem.FileSystem, {
          exists: (_path: string) => Effect.fail(new Error("permission denied") as any),
          readFileString: (_path: string) => Effect.fail(new Error("permission denied") as any),
        } as any);
        const configProviderLayer = ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { HOME: tempHome } }),
        );
        const runtimeInfoLayer = mockRuntimeInfo({ homeDir: tempHome });
        const layer = credentialsLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              failingFs,
              BunServices.layer,
              configProviderLayer,
              runtimeInfoLayer,
              cliConfigLayer.pipe(
                Layer.provide(runtimeInfoLayer),
                Layer.provide(configProviderLayer),
              ),
            ),
          ),
        );
        return Effect.gen(function* () {
          const { getAccessToken } = yield* Credentials;
          const token = yield* getAccessToken;
          expect(token).toEqual(Option.none());
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("saveAccessToken", () => {
    it.effect("saves to keyring when available", () => {
      return Effect.gen(function* () {
        const { saveAccessToken } = yield* Credentials;
        yield* saveAccessToken("new-token");
        expect(passwords.get("Supabase CLI/access-token")).toBe("new-token");
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("falls back to filesystem when setPassword throws", () => {
      throwOnSetPassword = true;
      return Effect.gen(function* () {
        const { saveAccessToken } = yield* Credentials;
        yield* saveAccessToken("fallback-token");
        const content = readFileSync(join(tempHome, ".supabase", "access-token"), "utf-8");
        expect(content).toBe("fallback-token");
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("saves to filesystem in no-keyring mode", () => {
      return Effect.gen(function* () {
        const { saveAccessToken } = yield* Credentials;
        yield* saveAccessToken("no-keyring-token");
        const content = readFileSync(join(tempHome, ".supabase", "access-token"), "utf-8");
        expect(content).toBe("no-keyring-token");
      }).pipe(Effect.provide(makeLayer(tempHome, { SUPABASE_NO_KEYRING: "1" })));
    });

    it.effect("creates .supabase directory if missing", () => {
      throwOnSetPassword = true;
      return Effect.gen(function* () {
        expect(existsSync(join(tempHome, ".supabase"))).toBe(false);
        const { saveAccessToken } = yield* Credentials;
        yield* saveAccessToken("create-dir-token");
        expect(existsSync(join(tempHome, ".supabase"))).toBe(true);
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });
  });
});
