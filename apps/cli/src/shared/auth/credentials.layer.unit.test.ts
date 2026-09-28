import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { beforeEach, vi } from "vitest";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Redacted,
} from "effect";
import { useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
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

const tempHome = useTempWorkdir("supabase-creds-test-");

const writeFallbackToken = (content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const supaDir = path.join(tempHome.current, ".supabase");
    yield* fs.makeDirectory(supaDir, { recursive: true });
    yield* fs.writeFileString(path.join(supaDir, "access-token"), content, { mode: 0o600 });
  });

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
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expectSomeToken(token, "current-token");
      }).pipe(Effect.provide(makeLayer(tempHome.current)));
    });

    it.effect("decodes Go keyring base64 values from current account", () => {
      passwords.set("Supabase CLI/access-token", encodeGoKeyringBase64("current-token"));
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expectSomeToken(token, "current-token");
      }).pipe(Effect.provide(makeLayer(tempHome.current)));
    });

    it.effect("falls back to legacy account when current is missing", () => {
      passwords.set("Supabase CLI/supabase", "legacy-token");
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expectSomeToken(token, "legacy-token");
      }).pipe(Effect.provide(makeLayer(tempHome.current)));
    });

    it.effect("prefers current account over legacy", () => {
      passwords.set("Supabase CLI/access-token", "current-token");
      passwords.set("Supabase CLI/supabase", "legacy-token");
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expectSomeToken(token, "current-token");
      }).pipe(Effect.provide(makeLayer(tempHome.current)));
    });

    it.effect("returns none when no token found anywhere", () => {
      return Effect.gen(function* () {
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expect(token).toEqual(Option.none());
      }).pipe(Effect.provide(makeLayer(tempHome.current)));
    });

    it.effect("falls back to filesystem when keyring throws", () => {
      throwOnGetPasswordAccounts.add("Supabase CLI/access-token");
      throwOnGetPasswordAccounts.add("Supabase CLI/supabase");
      return Effect.gen(function* () {
        yield* writeFallbackToken("fs-token-123");
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expectSomeToken(token, "fs-token-123");
      }).pipe(Effect.provide(Layer.mergeAll(makeLayer(tempHome.current), BunServices.layer)));
    });

    it.effect("returns Some from filesystem in no-keyring mode", () => {
      return Effect.gen(function* () {
        yield* writeFallbackToken("fs-only-token");
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expectSomeToken(token, "fs-only-token");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeLayer(tempHome.current, { SUPABASE_NO_KEYRING: "1" }),
            BunServices.layer,
          ),
        ),
      );
    });

    it.effect("returns None when filesystem file is empty", () => {
      throwOnGetPasswordAccounts.add("Supabase CLI/access-token");
      throwOnGetPasswordAccounts.add("Supabase CLI/supabase");
      return Effect.gen(function* () {
        yield* writeFallbackToken("");
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expect(token).toEqual(Option.none());
      }).pipe(Effect.provide(Layer.mergeAll(makeLayer(tempHome.current), BunServices.layer)));
    });

    it.effect("returns None when filesystem file has only whitespace", () => {
      throwOnGetPasswordAccounts.add("Supabase CLI/access-token");
      throwOnGetPasswordAccounts.add("Supabase CLI/supabase");
      return Effect.gen(function* () {
        yield* writeFallbackToken("   \n  \t  ");
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expect(token).toEqual(Option.none());
      }).pipe(Effect.provide(Layer.mergeAll(makeLayer(tempHome.current), BunServices.layer)));
    });

    it.effect("falls through when keyring returns null for both accounts", () => {
      returnNullForAccounts.add("Supabase CLI/access-token");
      returnNullForAccounts.add("Supabase CLI/supabase");
      return Effect.gen(function* () {
        yield* writeFallbackToken("fs-fallback-token");
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        // keyring returns null (falsy) for both → falls through to filesystem
        expectSomeToken(token, "fs-fallback-token");
      }).pipe(Effect.provide(Layer.mergeAll(makeLayer(tempHome.current), BunServices.layer)));
    });

    it.effect("falls through when keyring returns empty passwords for both accounts", () => {
      passwords.set("Supabase CLI/access-token", "");
      passwords.set("Supabase CLI/supabase", "");
      return Effect.gen(function* () {
        yield* writeFallbackToken("fs-empty-keyring-fallback");
        const { getAccessToken } = yield* Credentials;
        const token = yield* getAccessToken;
        expectSomeToken(token, "fs-empty-keyring-fallback");
      }).pipe(Effect.provide(Layer.mergeAll(makeLayer(tempHome.current), BunServices.layer)));
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
      const runtimeInfoLayer = mockRuntimeInfo({ homeDir: tempHome.current });
      const cliProjectContextLayer = mockCliProjectContext();
      const envLayer = processEnvLayer({ HOME: tempHome.current, SUPABASE_NO_KEYRING: "1" });
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
      }).pipe(Effect.provide(makeLayer(tempHome.current, { SUPABASE_NO_KEYRING: "1" }, failingFs)));
    });

    it.effect("saves to keyring when available", () => {
      return Effect.gen(function* () {
        const { saveAccessToken } = yield* Credentials;
        yield* saveAccessToken("new-token");
        expect(passwords.get("Supabase CLI/access-token")).toBe("new-token");
      }).pipe(Effect.provide(makeLayer(tempHome.current)));
    });

    it.effect("falls back to filesystem when setPassword throws", () => {
      throwOnSetPassword = true;
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* Effect.gen(function* () {
          const { saveAccessToken } = yield* Credentials;
          yield* saveAccessToken("fallback-token");
        }).pipe(Effect.provide(makeLayer(tempHome.current)));
        const content = yield* fs.readFileString(
          path.join(tempHome.current, ".supabase", "access-token"),
        );
        expect(content).toBe("fallback-token");
      }).pipe(Effect.provide(BunServices.layer));
    });

    it.effect("saves to filesystem in no-keyring mode", () => {
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* Effect.gen(function* () {
          const { saveAccessToken } = yield* Credentials;
          yield* saveAccessToken("no-keyring-token");
        }).pipe(Effect.provide(makeLayer(tempHome.current, { SUPABASE_NO_KEYRING: "1" })));
        const content = yield* fs.readFileString(
          path.join(tempHome.current, ".supabase", "access-token"),
        );
        expect(content).toBe("no-keyring-token");
      }).pipe(Effect.provide(BunServices.layer));
    });

    it.effect("creates .supabase directory if missing", () => {
      throwOnSetPassword = true;
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        expect(yield* fs.exists(path.join(tempHome.current, ".supabase"))).toBe(false);
        yield* Effect.gen(function* () {
          const { saveAccessToken } = yield* Credentials;
          yield* saveAccessToken("create-dir-token");
        }).pipe(Effect.provide(makeLayer(tempHome.current)));
        expect(yield* fs.exists(path.join(tempHome.current, ".supabase"))).toBe(true);
      }).pipe(Effect.provide(BunServices.layer));
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
      }).pipe(Effect.provide(makeLayer(tempHome.current, { SUPABASE_NO_KEYRING: "1" }, failingFs)));
    });

    it.effect("returns false when no token exists anywhere", () => {
      return Effect.gen(function* () {
        const { deleteAccessToken } = yield* Credentials;
        const deleted = yield* deleteAccessToken;
        expect(deleted).toBe(false);
      }).pipe(Effect.provide(makeLayer(tempHome.current)));
    });

    it.effect("deletes current keyring account and returns true", () => {
      passwords.set("Supabase CLI/access-token", "my-token");
      return Effect.gen(function* () {
        const { deleteAccessToken } = yield* Credentials;
        const deleted = yield* deleteAccessToken;
        expect(deleted).toBe(true);
        expect(passwords.has("Supabase CLI/access-token")).toBe(false);
      }).pipe(Effect.provide(makeLayer(tempHome.current)));
    });

    it.effect("deletes legacy keyring account when current is absent", () => {
      passwords.set("Supabase CLI/supabase", "legacy-token");
      return Effect.gen(function* () {
        const { deleteAccessToken } = yield* Credentials;
        const deleted = yield* deleteAccessToken;
        expect(deleted).toBe(true);
        expect(passwords.has("Supabase CLI/supabase")).toBe(false);
      }).pipe(Effect.provide(makeLayer(tempHome.current)));
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
      }).pipe(Effect.provide(makeLayer(tempHome.current)));
    });

    it.effect("deletes filesystem token and returns true", () => {
      throwOnDeletePasswordAccounts.add("Supabase CLI/access-token");
      throwOnDeletePasswordAccounts.add("Supabase CLI/supabase");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeFallbackToken("fs-token");
        const deleted = yield* Effect.gen(function* () {
          const { deleteAccessToken } = yield* Credentials;
          return yield* deleteAccessToken;
        }).pipe(Effect.provide(makeLayer(tempHome.current)));
        expect(deleted).toBe(true);
        expect(yield* fs.exists(path.join(tempHome.current, ".supabase", "access-token"))).toBe(
          false,
        );
      }).pipe(Effect.provide(BunServices.layer));
    });

    it.effect("deletes filesystem token in no-keyring mode", () => {
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeFallbackToken("fs-token");
        const deleted = yield* Effect.gen(function* () {
          const { deleteAccessToken } = yield* Credentials;
          return yield* deleteAccessToken;
        }).pipe(Effect.provide(makeLayer(tempHome.current, { SUPABASE_NO_KEYRING: "1" })));
        expect(deleted).toBe(true);
        expect(yield* fs.exists(path.join(tempHome.current, ".supabase", "access-token"))).toBe(
          false,
        );
      }).pipe(Effect.provide(BunServices.layer));
    });
  });
});
