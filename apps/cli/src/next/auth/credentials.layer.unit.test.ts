import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, PlatformError, Redacted } from "effect";
import { beforeEach, vi } from "vitest";

import {
  mockProjectContext,
  mockRuntimeInfo,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";
import { cliConfigLayer } from "../config/cli-config.layer.ts";
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

function makeLayer(home: string, env: Record<string, string> = {}) {
  const runtimeInfoLayer = mockRuntimeInfo({ homeDir: home });
  const projectContextLayer = mockProjectContext();
  const envLayer = processEnvLayer({ HOME: home, ...env });
  const configuredCliConfigLayer = cliConfigLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(projectContextLayer),
    Layer.provide(envLayer),
    Layer.provideMerge(BunServices.layer),
  );
  const baseLayer = Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    projectContextLayer,
    envLayer,
    configuredCliConfigLayer,
  );
  return credentialsLayer.pipe(Layer.provide(baseLayer));
}

const withTempHome = <A, E>(
  body: (
    home: string,
    fs: FileSystem.FileSystem,
    path: Path.Path,
  ) => Effect.Effect<A, E, Credentials>,
  env: Record<string, string> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-creds-test-" });
      return yield* body(home, fs, path).pipe(Effect.orDie, Effect.provide(makeLayer(home, env)));
    }).pipe(Effect.provide(BunServices.layer)),
  );

beforeEach(() => {
  passwords.clear();
  throwOnSetPassword = false;
  throwOnGetPasswordAccounts.clear();
  returnNullForAccounts.clear();
  throwOnDeletePasswordAccounts.clear();
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
      return withTempHome(() =>
        Effect.gen(function* () {
          const { getAccessToken } = yield* Credentials;
          const token = yield* getAccessToken;
          expectSomeToken(token, "current-token");
        }),
      );
    });

    it.effect("decodes Go keyring base64 values from current account", () => {
      passwords.set("Supabase CLI/access-token", encodeGoKeyringBase64("current-token"));
      return withTempHome(() =>
        Effect.gen(function* () {
          const { getAccessToken } = yield* Credentials;
          const token = yield* getAccessToken;
          expectSomeToken(token, "current-token");
        }),
      );
    });

    it.effect("falls back to legacy account when current is missing", () => {
      passwords.set("Supabase CLI/supabase", "legacy-token");
      return withTempHome(() =>
        Effect.gen(function* () {
          const { getAccessToken } = yield* Credentials;
          const token = yield* getAccessToken;
          expectSomeToken(token, "legacy-token");
        }),
      );
    });

    it.effect("prefers current account over legacy", () => {
      passwords.set("Supabase CLI/access-token", "current-token");
      passwords.set("Supabase CLI/supabase", "legacy-token");
      return withTempHome(() =>
        Effect.gen(function* () {
          const { getAccessToken } = yield* Credentials;
          const token = yield* getAccessToken;
          expectSomeToken(token, "current-token");
        }),
      );
    });

    it.effect("returns none when no token found anywhere", () =>
      withTempHome(() =>
        Effect.gen(function* () {
          const { getAccessToken } = yield* Credentials;
          const token = yield* getAccessToken;
          expect(token).toEqual(Option.none());
        }),
      ),
    );

    it.effect("falls back to filesystem when keyring throws", () => {
      throwOnGetPasswordAccounts.add("Supabase CLI/access-token");
      throwOnGetPasswordAccounts.add("Supabase CLI/supabase");
      return withTempHome((home, fs, path) =>
        Effect.gen(function* () {
          const supaDir = path.join(home, ".supabase");
          yield* fs.makeDirectory(supaDir, { recursive: true });
          yield* fs.writeFileString(path.join(supaDir, "access-token"), "fs-token-123", {
            mode: 0o600,
          });
          const { getAccessToken } = yield* Credentials;
          const token = yield* getAccessToken;
          expectSomeToken(token, "fs-token-123");
        }),
      );
    });

    it.effect("returns Some from filesystem in no-keyring mode", () =>
      withTempHome(
        (home, fs, path) =>
          Effect.gen(function* () {
            const supaDir = path.join(home, ".supabase");
            yield* fs.makeDirectory(supaDir, { recursive: true });
            yield* fs.writeFileString(path.join(supaDir, "access-token"), "fs-only-token", {
              mode: 0o600,
            });
            const { getAccessToken } = yield* Credentials;
            const token = yield* getAccessToken;
            expectSomeToken(token, "fs-only-token");
          }),
        { SUPABASE_NO_KEYRING: "1" },
      ),
    );

    it.effect("returns None when filesystem file is empty", () => {
      throwOnGetPasswordAccounts.add("Supabase CLI/access-token");
      throwOnGetPasswordAccounts.add("Supabase CLI/supabase");
      return withTempHome((home, fs, path) =>
        Effect.gen(function* () {
          const supaDir = path.join(home, ".supabase");
          yield* fs.makeDirectory(supaDir, { recursive: true });
          yield* fs.writeFileString(path.join(supaDir, "access-token"), "", { mode: 0o600 });
          const { getAccessToken } = yield* Credentials;
          const token = yield* getAccessToken;
          expect(token).toEqual(Option.none());
        }),
      );
    });

    it.effect("returns None when filesystem file has only whitespace", () => {
      throwOnGetPasswordAccounts.add("Supabase CLI/access-token");
      throwOnGetPasswordAccounts.add("Supabase CLI/supabase");
      return withTempHome((home, fs, path) =>
        Effect.gen(function* () {
          const supaDir = path.join(home, ".supabase");
          yield* fs.makeDirectory(supaDir, { recursive: true });
          yield* fs.writeFileString(path.join(supaDir, "access-token"), "   \n  \t  ", {
            mode: 0o600,
          });
          const { getAccessToken } = yield* Credentials;
          const token = yield* getAccessToken;
          expect(token).toEqual(Option.none());
        }),
      );
    });

    it.effect("falls through when keyring returns null for both accounts", () => {
      returnNullForAccounts.add("Supabase CLI/access-token");
      returnNullForAccounts.add("Supabase CLI/supabase");
      return withTempHome((home, fs, path) =>
        Effect.gen(function* () {
          const supaDir = path.join(home, ".supabase");
          yield* fs.makeDirectory(supaDir, { recursive: true });
          yield* fs.writeFileString(path.join(supaDir, "access-token"), "fs-fallback-token", {
            mode: 0o600,
          });
          const { getAccessToken } = yield* Credentials;
          const token = yield* getAccessToken;
          expectSomeToken(token, "fs-fallback-token");
        }),
      );
    });

    it.effect("returns None when filesystem check fails unexpectedly (orElseSucceed branch)", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-creds-test-" });
          const failingFs = Layer.succeed(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              exists: (path) =>
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "exists",
                    description: "permission denied",
                    pathOrDescriptor: path,
                  }),
                ),
              readFileString: (path) =>
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readFileString",
                    description: "permission denied",
                    pathOrDescriptor: path,
                  }),
                ),
            }),
          );
          const runtimeInfoLayer = mockRuntimeInfo({ homeDir: home });
          const projectContextLayer = mockProjectContext();
          const layer = credentialsLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                failingFs,
                BunServices.layer,
                runtimeInfoLayer,
                projectContextLayer,
                processEnvLayer({ HOME: home }),
                cliConfigLayer.pipe(
                  Layer.provide(runtimeInfoLayer),
                  Layer.provide(projectContextLayer),
                  Layer.provideMerge(BunServices.layer),
                ),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const { getAccessToken } = yield* Credentials;
            const token = yield* getAccessToken;
            expect(token).toEqual(Option.none());
          }).pipe(Effect.provide(layer));
        }).pipe(Effect.provide(BunServices.layer)),
      ),
    );
  });

  describe("saveAccessToken", () => {
    it.effect("saves to keyring when available", () =>
      withTempHome(() =>
        Effect.gen(function* () {
          const { saveAccessToken } = yield* Credentials;
          yield* saveAccessToken("new-token");
          expect(passwords.get("Supabase CLI/access-token")).toBe("new-token");
        }),
      ),
    );

    it.effect("falls back to filesystem when setPassword throws", () => {
      throwOnSetPassword = true;
      return withTempHome((home, fs, path) =>
        Effect.gen(function* () {
          const { saveAccessToken } = yield* Credentials;
          yield* saveAccessToken("fallback-token");
          const content = yield* fs.readFileString(path.join(home, ".supabase", "access-token"));
          expect(content).toBe("fallback-token");
        }),
      );
    });

    it.effect("saves to filesystem in no-keyring mode", () =>
      withTempHome(
        (home, fs, path) =>
          Effect.gen(function* () {
            const { saveAccessToken } = yield* Credentials;
            yield* saveAccessToken("no-keyring-token");
            const content = yield* fs.readFileString(path.join(home, ".supabase", "access-token"));
            expect(content).toBe("no-keyring-token");
          }),
        { SUPABASE_NO_KEYRING: "1" },
      ),
    );

    it.effect("creates .supabase directory if missing", () => {
      throwOnSetPassword = true;
      return withTempHome((home, fs, path) =>
        Effect.gen(function* () {
          expect(yield* fs.exists(path.join(home, ".supabase"))).toBe(false);
          const { saveAccessToken } = yield* Credentials;
          yield* saveAccessToken("create-dir-token");
          expect(yield* fs.exists(path.join(home, ".supabase"))).toBe(true);
        }),
      );
    });
  });

  describe("deleteAccessToken", () => {
    it.effect("returns false when no token exists anywhere", () =>
      withTempHome(() =>
        Effect.gen(function* () {
          const { deleteAccessToken } = yield* Credentials;
          const deleted = yield* deleteAccessToken;
          expect(deleted).toBe(false);
        }),
      ),
    );

    it.effect("deletes current keyring account and returns true", () => {
      passwords.set("Supabase CLI/access-token", "my-token");
      return withTempHome(() =>
        Effect.gen(function* () {
          const { deleteAccessToken } = yield* Credentials;
          const deleted = yield* deleteAccessToken;
          expect(deleted).toBe(true);
          expect(passwords.has("Supabase CLI/access-token")).toBe(false);
        }),
      );
    });

    it.effect("deletes legacy keyring account when current is absent", () => {
      passwords.set("Supabase CLI/supabase", "legacy-token");
      return withTempHome(() =>
        Effect.gen(function* () {
          const { deleteAccessToken } = yield* Credentials;
          const deleted = yield* deleteAccessToken;
          expect(deleted).toBe(true);
          expect(passwords.has("Supabase CLI/supabase")).toBe(false);
        }),
      );
    });

    it.effect("deletes both keyring accounts when both exist", () => {
      passwords.set("Supabase CLI/access-token", "current-token");
      passwords.set("Supabase CLI/supabase", "legacy-token");
      return withTempHome(() =>
        Effect.gen(function* () {
          const { deleteAccessToken } = yield* Credentials;
          const deleted = yield* deleteAccessToken;
          expect(deleted).toBe(true);
          expect(passwords.has("Supabase CLI/access-token")).toBe(false);
          expect(passwords.has("Supabase CLI/supabase")).toBe(false);
        }),
      );
    });

    it.effect("deletes filesystem token and returns true", () => {
      throwOnDeletePasswordAccounts.add("Supabase CLI/access-token");
      throwOnDeletePasswordAccounts.add("Supabase CLI/supabase");
      return withTempHome((home, fs, path) =>
        Effect.gen(function* () {
          const supaDir = path.join(home, ".supabase");
          yield* fs.makeDirectory(supaDir, { recursive: true });
          yield* fs.writeFileString(path.join(supaDir, "access-token"), "fs-token", {
            mode: 0o600,
          });
          const { deleteAccessToken } = yield* Credentials;
          const deleted = yield* deleteAccessToken;
          expect(deleted).toBe(true);
          expect(yield* fs.exists(path.join(supaDir, "access-token"))).toBe(false);
        }),
      );
    });

    it.effect("deletes filesystem token in no-keyring mode", () =>
      withTempHome(
        (home, fs, path) =>
          Effect.gen(function* () {
            const supaDir = path.join(home, ".supabase");
            yield* fs.makeDirectory(supaDir, { recursive: true });
            yield* fs.writeFileString(path.join(supaDir, "access-token"), "fs-token", {
              mode: 0o600,
            });
            const { deleteAccessToken } = yield* Credentials;
            const deleted = yield* deleteAccessToken;
            expect(deleted).toBe(true);
            expect(yield* fs.exists(path.join(supaDir, "access-token"))).toBe(false);
          }),
        { SUPABASE_NO_KEYRING: "1" },
      ),
    );
  });
});
