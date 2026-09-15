import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, vi } from "vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, PlatformError, Redacted } from "effect";
import {
  mockCliProjectContext,
  mockRuntimeInfo,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";
import { cliSettingsLayer } from "../config/cli-settings.layer.ts";
import { Credentials } from "./credentials.service.ts";
import { credentialsLayer } from "./credentials.layer.ts";

const passwords = new Map<string, string>();
let throwOnSetPassword = false;
const throwOnGetPasswordAccounts = new Set<string>();
const returnNullForAccounts = new Set<string>();
const throwOnDeletePasswordAccounts = new Set<string>();
const encodeGoKeyringBase64 = (token: string) =>
  `go-keyring-base64:${Buffer.from(token).toString("base64")}`;

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
    deleteCredential(): boolean {
      const key = `${this.service}/${this.account}`;
      if (throwOnDeletePasswordAccounts.has(key)) {
        throw new Error("Keyring unavailable");
      }
      if (!passwords.has(key)) {
        throw new Error("No entry found");
      }
      passwords.delete(key);
      return true;
    }
  },
}));

function makeLayer(
  home: string,
  env: Record<string, string> = {},
  fsLayer: Layer.Layer<FileSystem.FileSystem> = BunServices.layer,
) {
  const runtimeInfoLayer = mockRuntimeInfo({ homeDir: home });
  const cliProjectContextLayer = mockCliProjectContext();
  const envLayer = processEnvLayer({ HOME: home, ...env });
  const baseLayer = Layer.mergeAll(
    runtimeInfoLayer,
    cliProjectContextLayer,
    cliSettingsLayer.pipe(
      Layer.provide(runtimeInfoLayer),
      Layer.provide(cliProjectContextLayer),
      Layer.provide(envLayer),
    ),
  );
  return credentialsLayer.pipe(
    Layer.provide(fsLayer),
    Layer.provide(BunServices.layer),
    Layer.provide(baseLayer),
  );
}

let tempHome: string;

beforeEach(() => {
  passwords.clear();
  throwOnSetPassword = false;
  throwOnGetPasswordAccounts.clear();
  returnNullForAccounts.clear();
  throwOnDeletePasswordAccounts.clear();
  tempHome = mkdtempSync(join(tmpdir(), "supabase-creds-test-"));
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe("Credentials", () => {
  const expectSomeToken = (token: Option.Option<Redacted.Redacted<string>>, expected: string) => {
    expect(Option.isSome(token)).toBe(true);
    if (Option.isSome(token)) {
      expect(Redacted.value(token.value)).toBe(expected);
    }
  };

  describe("getAccessToken", () => {
    it.effect("reads from current account", () => {
      passwords.set("Supabase CLI/access-token", "current-token");
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expectSomeToken(token, "current-token");
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("decodes Go keyring base64 values from current account", () => {
      passwords.set("Supabase CLI/access-token", encodeGoKeyringBase64("current-token"));
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expectSomeToken(token, "current-token");
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("falls back to legacy account when current is missing", () => {
      passwords.set("Supabase CLI/supabase", "legacy-token");
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expectSomeToken(token, "legacy-token");
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("prefers current account over legacy", () => {
      passwords.set("Supabase CLI/access-token", "current-token");
      passwords.set("Supabase CLI/supabase", "legacy-token");
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expectSomeToken(token, "current-token");
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
        expectSomeToken(token, "fs-token-123");
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("returns Some from filesystem in no-keyring mode", () => {
      const supaDir = join(tempHome, ".supabase");
      mkdirSync(supaDir, { recursive: true });
      writeFileSync(join(supaDir, "access-token"), "fs-only-token", { mode: 0o600 });
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expectSomeToken(token, "fs-only-token");
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
        expectSomeToken(token, "fs-fallback-token");
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("falls through when keyring returns empty passwords for both accounts", () => {
      passwords.set("Supabase CLI/access-token", "");
      passwords.set("Supabase CLI/supabase", "");
      const supaDir = join(tempHome, ".supabase");
      mkdirSync(supaDir, { recursive: true });
      writeFileSync(join(supaDir, "access-token"), "fs-empty-keyring-fallback", { mode: 0o600 });
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expectSomeToken(token, "fs-empty-keyring-fallback");
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("surfaces a filesystem read failure instead of treating it as no token", () => {
      throwOnGetPasswordAccounts.add("Supabase CLI/access-token");
      throwOnGetPasswordAccounts.add("Supabase CLI/supabase");
      const failingFs = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: (_path: string) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "exists",
                description: "permission denied",
              }),
            ),
          readFileString: (_path: string) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readFileString",
                description: "permission denied",
              }),
            ),
        }),
      );
      const runtimeInfoLayer = mockRuntimeInfo({ homeDir: tempHome });
      const cliProjectContextLayer = mockCliProjectContext();
      const envLayer = processEnvLayer({ HOME: tempHome, SUPABASE_NO_KEYRING: "1" });
      const layer = credentialsLayer.pipe(
        Layer.provide(failingFs),
        Layer.provide(BunServices.layer),
        Layer.provide(runtimeInfoLayer),
        Layer.provide(cliProjectContextLayer),
        Layer.provide(
          cliSettingsLayer.pipe(
            Layer.provide(runtimeInfoLayer),
            Layer.provide(cliProjectContextLayer),
            Layer.provide(envLayer),
          ),
        ),
      );
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const exit = yield* Effect.exit(getAccessToken);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) expect(error.value).toBeInstanceOf(PlatformError.PlatformError);
        }
      }).pipe(Effect.provide(layer));
    });
  });

  describe("saveAccessToken", () => {
    it.effect("surfaces a fallback directory write failure as PlatformError", () => {
      const failingFs = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          makeDirectory: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "makeDirectory",
                description: "permission denied",
              }),
            ),
        }),
      );
      return Effect.gen(function* () {
        const { saveAccessToken } = yield* Credentials;
        const exit = yield* Effect.exit(saveAccessToken("write-failure-token"));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) expect(error.value).toBeInstanceOf(PlatformError.PlatformError);
        }
      }).pipe(Effect.provide(makeLayer(tempHome, { SUPABASE_NO_KEYRING: "1" }, failingFs)));
    });

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

  describe("deleteAccessToken", () => {
    it.effect("surfaces a fallback file delete failure as PlatformError", () => {
      const failingFs = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: () => Effect.succeed(true),
          remove: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "remove",
                description: "permission denied",
              }),
            ),
        }),
      );
      return Effect.gen(function* () {
        const { deleteAccessToken } = yield* Credentials;
        const exit = yield* Effect.exit(deleteAccessToken);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) expect(error.value).toBeInstanceOf(PlatformError.PlatformError);
        }
      }).pipe(Effect.provide(makeLayer(tempHome, { SUPABASE_NO_KEYRING: "1" }, failingFs)));
    });

    it.effect("returns false when no token exists anywhere", () => {
      return Effect.gen(function* () {
        const { deleteAccessToken } = yield* Credentials;
        const deleted = yield* deleteAccessToken;
        expect(deleted).toBe(false);
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("deletes current keyring account and returns true", () => {
      passwords.set("Supabase CLI/access-token", "my-token");
      return Effect.gen(function* () {
        const { deleteAccessToken } = yield* Credentials;
        const deleted = yield* deleteAccessToken;
        expect(deleted).toBe(true);
        expect(passwords.has("Supabase CLI/access-token")).toBe(false);
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("deletes legacy keyring account when current is absent", () => {
      passwords.set("Supabase CLI/supabase", "legacy-token");
      return Effect.gen(function* () {
        const { deleteAccessToken } = yield* Credentials;
        const deleted = yield* deleteAccessToken;
        expect(deleted).toBe(true);
        expect(passwords.has("Supabase CLI/supabase")).toBe(false);
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("deletes both keyring accounts when both exist", () => {
      passwords.set("Supabase CLI/access-token", "current-token");
      passwords.set("Supabase CLI/supabase", "legacy-token");
      return Effect.gen(function* () {
        const { deleteAccessToken } = yield* Credentials;
        const deleted = yield* deleteAccessToken;
        expect(deleted).toBe(true);
        expect(passwords.has("Supabase CLI/access-token")).toBe(false);
        expect(passwords.has("Supabase CLI/supabase")).toBe(false);
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("deletes filesystem token and returns true", () => {
      throwOnDeletePasswordAccounts.add("Supabase CLI/access-token");
      throwOnDeletePasswordAccounts.add("Supabase CLI/supabase");
      const supaDir = join(tempHome, ".supabase");
      mkdirSync(supaDir, { recursive: true });
      writeFileSync(join(supaDir, "access-token"), "fs-token", { mode: 0o600 });
      return Effect.gen(function* () {
        const { deleteAccessToken } = yield* Credentials;
        const deleted = yield* deleteAccessToken;
        expect(deleted).toBe(true);
        expect(existsSync(join(supaDir, "access-token"))).toBe(false);
      }).pipe(Effect.provide(makeLayer(tempHome)));
    });

    it.effect("deletes filesystem token in no-keyring mode", () => {
      const supaDir = join(tempHome, ".supabase");
      mkdirSync(supaDir, { recursive: true });
      writeFileSync(join(supaDir, "access-token"), "fs-token", { mode: 0o600 });
      return Effect.gen(function* () {
        const { deleteAccessToken } = yield* Credentials;
        const deleted = yield* deleteAccessToken;
        expect(deleted).toBe(true);
        expect(existsSync(join(supaDir, "access-token"))).toBe(false);
      }).pipe(Effect.provide(makeLayer(tempHome, { SUPABASE_NO_KEYRING: "1" })));
    });
  });
});
