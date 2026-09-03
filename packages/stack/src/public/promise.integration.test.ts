// oxlint-disable effecttsgo/async-function -- integration test exercises the Promise facade directly.
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- isolated Promise facade state root.
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- isolated Promise facade state root.
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- isolated Promise facade state root.
import { join } from "node:path";
import { CAPABILITY_NAMES, type CapabilityStatus } from "./Capability.ts";
import { Effect, Redacted, Stream } from "effect";
import type { EffectStack, PrepareStackOptions, StartStackOptions } from "./EffectStack.ts";
import type { StackLogEntry } from "./Logs.ts";
import { StackIdSchema } from "./StackId.ts";
import type { StackStatus } from "./Status.ts";
import { InvalidStackConfigError, StackVersionUnsupportedError } from "./Errors.ts";
import { adaptEffectStack, makePromiseApi, type PromiseStack } from "./PromiseStack.ts";
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
    stop: () => Effect.void,
    destroy: () => Effect.void,
    logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: false }),
    followLogs: () => Stream.empty,
  }) satisfies EffectStack;

describe("Promise stack facade", () => {
  it("prepares a real stack without publishing owner metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "supabase-promise-prepare-"));
    try {
      const project = join(root, "project");
      const stateRoot = join(root, "managed", "stacks");
      await mkdir(project);
      const api = makePromiseApi(NodeServices.layer, {
        stateRoot,
        tempRoot: tmpdir(),
        platform: "posix",
      });
      const stack = await api.createStack({ projectRoot: project, runtime: { kind: "native" } });
      const statePath = join(stateRoot, stack.id, "state.json");
      const before = await readFile(statePath, "utf8");
      await expect(stack.prepare({ capabilities: [] })).resolves.toEqual({ capabilities: [] });
      expect(await readFile(statePath, "utf8")).toBe(before);
      expect(await readdir(join(stateRoot, stack.id))).not.toContain("control.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves prepare validation tags", async () => {
    const root = await mkdtemp(join(tmpdir(), "supabase-promise-prepare-errors-"));
    try {
      const project = join(root, "project");
      await mkdir(project);
      const api = makePromiseApi(NodeServices.layer, {
        stateRoot: join(root, "managed", "stacks"),
        tempRoot: tmpdir(),
        platform: "posix",
      });
      const stack = await api.createStack({ projectRoot: project, runtime: { kind: "native" } });
      await expect(
        stack.prepare({
          config: JSON.parse('{"capabilities":{"rest":{"settings":{"unknown":true}}}}'),
        }),
      ).rejects.toBeInstanceOf(InvalidStackConfigError);
      await expect(
        stack.prepare({ config: { capabilities: { database: { version: "99" } } } }),
      ).rejects.toBeInstanceOf(StackVersionUnsupportedError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns log batches and follows from their cursor", async () => {
    const stack = adaptEffectStack(effectStack());
    const first = await stack.logs({ capabilities: ["auth"], tail: 20 });
    expect(first.entries.every((entry) => entry.source === "auth")).toBe(true);
    const followed = [];
    for await (const entry of stack.followLogs({ capabilities: ["auth"], cursor: first.cursor })) {
      followed.push(entry);
    }
    expect(followed.every((entry) => entry.source === "auth")).toBe(true);
  });

  it("unwraps every credential secret without a lifecycle close operation", async () => {
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
  });

  it("cancels an active async stream and witnesses its finalizer", async () => {
    let finalized = false;
    const entry: StackLogEntry = {
      cursor: { opaque: "v1_1" },
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "auth",
      stream: "stdout",
      message: "active",
    };
    const source: EffectStack = {
      ...effectStack(),
      followLogs: () =>
        Stream.make(entry).pipe(
          Stream.concat(Stream.never),
          Stream.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
    };
    const stack = adaptEffectStack(source);
    const iterator = stack.followLogs()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: entry });
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    expect(finalized).toBe(true);
  });

  it("completes an empty follower immediately", async () => {
    const stack = adaptEffectStack(effectStack());
    const logs = await stack.logs();
    expect(logs.entries).toHaveLength(0);
    const logsIterator = stack.followLogs()[Symbol.asyncIterator]();
    await expect(logsIterator.next()).resolves.toMatchObject({ done: true });
  });

  it("rejects malformed configs asynchronously with a tagged error", async () => {
    const stack = adaptEffectStack(effectStack());
    await expect(
      stack.start({
        config: JSON.parse('{"capabilities":{"rest":{"settings":{"unknown":true}}}}'),
      }),
    ).rejects.toBeInstanceOf(InvalidStackConfigError);
  });

  it("redacts nested config secrets for prepare and start", async () => {
    let preparedConfig: StartStackOptions["config"] | undefined;
    let startedConfig: StartStackOptions["config"] | undefined;
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
    for (const value of [preparedConfig, startedConfig]) {
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
  });
});
