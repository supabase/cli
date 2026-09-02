// oxlint-disable effecttsgo/async-function -- integration test exercises the Promise facade directly.
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { CAPABILITY_NAMES, type CapabilityStatus } from "./Capability.ts";
import { Effect, Redacted, Stream } from "effect";
import type { EffectStack, PrepareStackOptions, StartStackOptions } from "./EffectStack.ts";
import { StackIdSchema } from "./StackId.ts";
import type { StackStatus } from "./Status.ts";
import type { StackLogEntry } from "./Logs.ts";
import {
  InvalidStackConfigError,
  StackLifecycleConflictError,
  StackStateInvalidError,
} from "./Errors.ts";
import { adaptEffectStack, type PromiseStack } from "./PromiseStack.ts";
import { compileStack } from "../model/Compiler.ts";

const stackId = StackIdSchema.make(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);

const capabilities: ReadonlyArray<CapabilityStatus> = CAPABILITY_NAMES.map((name) => ({
  name,
  activation: name === "functions" ? "lazy" : "eager",
  state: name === "functions" ? "ready" : "dormant",
}));

const status: StackStatus = {
  id: stackId,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {
    api: {
      protocol: "http",
      address: "127.0.0.1",
      port: 54321,
      url: "http://127.0.0.1:54321",
    },
  },
  versions: {},
  capabilities,
};

const effectStack = (): EffectStack =>
  ({
    id: stackId,
    status: () => Effect.succeed(status),
    credentials: () =>
      Effect.succeed({
        database: { url: Redacted.make("postgres://secret"), password: Redacted.make("db-pass") },
        api: {
          publishableKey: "publishable",
          secretKey: Redacted.make("secret-key"),
          anonJwt: "anon",
          serviceRoleJwt: Redacted.make("service-role"),
        },
        storage: {
          endpoint: "http://storage",
          region: "local",
          accessKeyId: "access",
          secretAccessKey: Redacted.make("storage-secret"),
        },
      }),
    prepare: (_options?: PrepareStackOptions) => Effect.succeed({ capabilities: [] }),
    start: () => Effect.succeed(status),
    restart: () => Effect.succeed(status),
    stop: () => Effect.void,
    destroy: () => Effect.void,
    close: () => Effect.void,
    watchStatus: () => Stream.make(status),
    logs: () => Stream.make(),
  }) satisfies EffectStack;

describe("Promise stack facade", () => {
  it("unwraps every credential secret and exposes explicit close without async disposal", async () => {
    const stack: PromiseStack = adaptEffectStack(effectStack());

    await expect(stack.credentials()).resolves.toEqual({
      database: { url: "postgres://secret", password: "db-pass" },
      api: {
        publishableKey: "publishable",
        secretKey: "secret-key",
        anonJwt: "anon",
        serviceRoleJwt: "service-role",
      },
      storage: {
        endpoint: "http://storage",
        region: "local",
        accessKeyId: "access",
        secretAccessKey: "storage-secret",
      },
    });
    expect(Symbol.asyncDispose in stack).toBe(false);
    await expect(stack.close()).resolves.toBeUndefined();
    await expect(stack.close()).resolves.toBeUndefined();
  });

  it("cancels an async stream when the consumer returns early", async () => {
    const stack = adaptEffectStack(effectStack());
    const iterator = stack.watchStatus()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    await stack.close();
  });

  it("removes naturally completed streams and rejects new streams after close", async () => {
    const stack = adaptEffectStack(effectStack());
    const statusIterator = stack.watchStatus()[Symbol.asyncIterator]();
    await expect(statusIterator.next()).resolves.toMatchObject({ done: false });
    await expect(statusIterator.next()).resolves.toMatchObject({ done: true });
    const logsIterator = stack.logs()[Symbol.asyncIterator]();
    await expect(logsIterator.next()).resolves.toMatchObject({ done: true });
    await stack.close();
    await expect(stack.watchStatus()[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(
      StackLifecycleConflictError,
    );
    await expect(stack.logs()[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(
      StackLifecycleConflictError,
    );
  });

  it("rejects malformed configs asynchronously with a tagged error", async () => {
    const stack = adaptEffectStack(effectStack());
    await expect(
      stack.start({
        config: JSON.parse('{"capabilities":{"rest":{"settings":{"unknown":true}}}}'),
      }),
    ).rejects.toBeInstanceOf(InvalidStackConfigError);
    await stack.close();
  });

  it("redacts nested config secrets for prepare, start, and restart", async () => {
    let preparedConfig: StartStackOptions["config"] | undefined;
    let startedConfig: StartStackOptions["config"] | undefined;
    let restartedConfig: StartStackOptions["config"] | undefined;
    const source: EffectStack = {
      ...effectStack(),
      prepare: (options?: PrepareStackOptions) =>
        Effect.sync(() => {
          preparedConfig = options?.config;
          return { capabilities: [] };
        }),
      start: (options?: StartStackOptions) =>
        Effect.sync(() => {
          startedConfig = options?.config;
          return status;
        }),
      restart: (options?: StartStackOptions) =>
        Effect.sync(() => {
          restartedConfig = options?.config;
          return status;
        }),
    };
    const stack = adaptEffectStack(source);
    const config = {
      capabilities: {
        database: { settings: { vault: { DB_PASSWORD: "vault-secret" } } },
        storage: { settings: { buckets: { assets: { public: false } } } },
        auth: { settings: { external: { github: { secret: "github-secret" } } } },
        functions: {
          settings: {
            edge_runtime: { secrets: { EDGE_TOKEN: "edge-secret" } },
            functions: {
              hello: { env: { FUNCTION_TOKEN: "function-secret" }, static_files: ["index.html"] },
            },
          },
        },
      },
    };

    await stack.prepare({ config });
    await stack.start({ config });
    await stack.restart({ config });
    for (const value of [preparedConfig, startedConfig, restartedConfig]) {
      const database = value?.capabilities?.database?.settings;
      const auth = value?.capabilities?.auth;
      const functions = value?.capabilities?.functions;
      const authSettings = auth !== undefined && "settings" in auth ? auth.settings : undefined;
      const functionSettings =
        functions !== undefined && "settings" in functions ? functions.settings : undefined;
      expect(Redacted.isRedacted(database?.vault?.DB_PASSWORD)).toBe(true);
      expect(Redacted.isRedacted(authSettings?.external?.github?.secret)).toBe(true);
      expect(Redacted.isRedacted(functionSettings?.edge_runtime?.secrets?.EDGE_TOKEN)).toBe(true);
      expect(Redacted.isRedacted(functionSettings?.functions?.hello?.env?.FUNCTION_TOKEN)).toBe(
        true,
      );
    }
    if (startedConfig === undefined) throw new Error("Expected Promise start to capture config");
    const compiled = await Effect.runPromise(
      compileStack({
        projectRoot: "/tmp/promise-facade-project",
        runtime: { kind: "native" },
        config: startedConfig,
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(compiled.definition.capabilities.functions.settings.functions_root).toBe(
      "/tmp/promise-facade-project/supabase/functions",
    );
    await stack.close();
  });

  it("always closes the underlying handle when active stream cancellation rejects", async () => {
    let underlyingClosed = false;
    const cancellationError = new Error("stream cancellation failed");
    const entry: StackLogEntry = {
      cursor: { opaque: "1" },
      timestamp: "now",
      source: "functions",
      stream: "stdout",
      message: "running",
    };
    const foreignStream: AsyncIterable<StackLogEntry> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: entry }),
        return: async () => {
          throw cancellationError;
        },
      }),
    };
    const source: EffectStack = {
      ...effectStack(),
      logs: () =>
        Stream.fromAsyncIterable(
          foreignStream,
          (error) => new StackStateInvalidError({ message: String(error) }),
        ),
      close: () =>
        Effect.sync(() => {
          underlyingClosed = true;
        }),
    };
    const stack = adaptEffectStack(source);
    const iterator = stack.logs()[Symbol.asyncIterator]();
    await iterator.next();
    await expect(stack.close()).rejects.toThrow("Failed to close stack handle");
    expect(underlyingClosed).toBe(true);
    await expect(stack.status()).rejects.toThrow("Stack handle is closed");
    await expect(stack.close()).rejects.toThrow("Failed to close stack handle");
  });
});
