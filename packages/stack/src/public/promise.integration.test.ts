import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { CAPABILITY_NAMES, type CapabilityStatus } from "./Capability.ts";
import { Data, Effect, FileSystem, Path, Redacted, Schema, Stream } from "effect";
import type { EffectStack, PrepareStackOptions, StartStackOptions } from "./EffectStack.ts";
import type { LogQuery, StackLogEntry } from "./Logs.ts";
import { StackIdSchema } from "./StackId.ts";
import type { ArtifactPreparationStatus, StackStatus } from "./Status.ts";
import { InvalidStackConfigError, StackVersionUnsupportedError } from "./Errors.ts";
import { adaptEffectStack, makePromiseApi, type PromiseStack } from "./PromiseStack.ts";
import { compileStack } from "../model/Compiler.ts";
class StreamFixtureError extends Data.TaggedError("StreamFixtureError")<{
  readonly cause: unknown;
}> {}
const malformedConfig = Schema.decodeSync(Schema.fromJsonString(Schema.Any))(
  '{"capabilities":{"rest":{"settings":{"unknown":true}}}}',
);
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
  artifacts: [],
};
const effectStack = (): EffectStack =>
  ({
    id: stackId,
    status: Effect.succeed(status),
    credentials: Effect.succeed({
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
    stop: Effect.void,
    destroy: Effect.void,
    logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: false }),
    followLogs: () => Stream.empty,
  }) satisfies EffectStack;
describe("Promise stack facade", () => {
  it.live("prepares a real stack without publishing owner metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-promise-prepare-" });
      const project = path.join(root, "project");
      const stateRoot = path.join(root, "managed", "stacks");
      yield* fs.makeDirectory(project);
      const api = makePromiseApi(NodeServices.layer, {
        stateRoot,
        tempRoot: "/tmp",
        platform: "posix",
      });
      const stack = yield* Effect.promise(() =>
        api.createStack({ projectRoot: project, runtime: { kind: "native" } }),
      );
      const statePath = path.join(stateRoot, stack.id, "state.json");
      const before = yield* fs.readFileString(statePath);
      yield* Effect.promise(() =>
        expect(stack.prepare({ capabilities: [] })).resolves.toEqual({ capabilities: [] }),
      );
      expect(yield* fs.readFileString(statePath)).toBe(before);
      expect(yield* fs.readDirectory(path.join(stateRoot, stack.id))).not.toContain("control.json");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("preserves prepare validation tags", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-promise-prepare-errors-",
      });
      const project = path.join(root, "project");
      yield* fs.makeDirectory(project);
      const api = makePromiseApi(NodeServices.layer, {
        stateRoot: path.join(root, "managed", "stacks"),
        tempRoot: "/tmp",
        platform: "posix",
      });
      const stack = yield* Effect.promise(() =>
        api.createStack({ projectRoot: project, runtime: { kind: "native" } }),
      );
      yield* Effect.promise(() =>
        expect(
          stack.prepare({
            config: malformedConfig,
          }),
        ).rejects.toBeInstanceOf(InvalidStackConfigError),
      );
      yield* Effect.promise(() =>
        expect(
          stack.prepare({ config: { capabilities: { database: { version: "99" } } } }),
        ).rejects.toBeInstanceOf(StackVersionUnsupportedError),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("returns log batches and follows from their cursor", () =>
    Effect.gen(function* () {
      const initial: StackLogEntry = {
        cursor: { opaque: "v1_0" },
        timestamp: "2026-01-01T00:00:00.000Z",
        source: "auth",
        stream: "stdout",
        message: "initial",
      };
      const followedEntry: StackLogEntry = {
        ...initial,
        cursor: { opaque: "v1_1" },
        message: "followed",
      };
      let logsQuery: LogQuery | undefined;
      let followQuery: LogQuery | undefined;
      const stack = adaptEffectStack({
        ...effectStack(),
        logs: (query) =>
          Effect.sync(() => {
            logsQuery = query;
            return { entries: [initial], cursor: { opaque: "v1_0" }, running: true };
          }),
        followLogs: (query) => {
          followQuery = query;
          return Stream.succeed(followedEntry);
        },
      });
      const first = yield* Effect.promise(() => stack.logs({ capabilities: ["auth"], tail: 20 }));
      expect(first.entries).toEqual([initial]);
      expect(logsQuery).toEqual({ capabilities: ["auth"], tail: 20 });
      const followed = yield* Stream.fromAsyncIterable(
        stack.followLogs({ capabilities: ["auth"], cursor: first.cursor }),
        (cause) => new StreamFixtureError({ cause }),
      ).pipe(Stream.runCollect);
      expect(followed).toEqual([followedEntry]);
      expect(followQuery).toEqual({ capabilities: ["auth"], cursor: { opaque: "v1_0" } });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("unwraps every credential secret without a lifecycle close operation", () =>
    Effect.gen(function* () {
      const stack: PromiseStack = adaptEffectStack(effectStack());
      yield* Effect.promise(() =>
        expect(stack.credentials()).resolves.toEqual({
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
        }),
      );
      expect(Symbol.asyncDispose in stack).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("cancels an active async stream and witnesses its finalizer", () =>
    Effect.gen(function* () {
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
      yield* Effect.promise(() =>
        expect(iterator.next()).resolves.toEqual({ done: false, value: entry }),
      );
      yield* Effect.promise(() =>
        expect(iterator.return?.()).resolves.toMatchObject({ done: true }),
      );
      expect(finalized).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("forwards prepare progress through the Promise facade", () =>
    Effect.gen(function* () {
      const progress: Array<ArtifactPreparationStatus> = [];
      const stack = adaptEffectStack({
        ...effectStack(),
        prepare: (options?: PrepareStackOptions) =>
          Effect.sync(() => {
            options?.onProgress?.({
              workloadId: "rest:rest",
              capability: "rest",
              state: "downloading",
            });
            return { capabilities: [] };
          }),
      });
      yield* Effect.promise(() =>
        expect(stack.prepare({ onProgress: (status) => progress.push(status) })).resolves.toEqual({
          capabilities: [],
        }),
      );
      expect(progress).toEqual([
        { workloadId: "rest:rest", capability: "rest", state: "downloading" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("completes an empty follower immediately", () =>
    Effect.gen(function* () {
      const stack = adaptEffectStack(effectStack());
      const logs = yield* Effect.promise(() => stack.logs());
      expect(logs.entries).toHaveLength(0);
      const logsIterator = stack.followLogs()[Symbol.asyncIterator]();
      yield* Effect.promise(() =>
        expect(logsIterator.next()).resolves.toMatchObject({ done: true }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("rejects malformed configs asynchronously with a tagged error", () =>
    Effect.gen(function* () {
      const stack = adaptEffectStack(effectStack());
      yield* Effect.promise(() =>
        expect(
          stack.start({
            config: malformedConfig,
          }),
        ).rejects.toBeInstanceOf(InvalidStackConfigError),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("redacts nested config secrets for prepare and start", () =>
    Effect.gen(function* () {
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
      yield* Effect.promise(() => stack.prepare({ config }));
      yield* Effect.promise(() => stack.start({ config }));
      for (const value of [preparedConfig, startedConfig]) {
        const auth = value?.capabilities?.auth;
        const functions = value?.capabilities?.functions;
        const authSettings = auth !== undefined && "settings" in auth ? auth.settings : undefined;
        const functionSettings =
          functions !== undefined && "settings" in functions ? functions.settings : undefined;
        expect(Redacted.isRedacted(authSettings?.external?.github?.secret)).toBe(true);
        expect(Redacted.isRedacted(functionSettings?.edge_runtime?.secrets?.EDGE_TOKEN)).toBe(true);
        expect(Redacted.isRedacted(functionSettings?.functions?.hello?.env?.FUNCTION_TOKEN)).toBe(
          true,
        );
      }
      if (startedConfig === undefined)
        return yield* Effect.die("Expected Promise start to capture config");
      const compiled = yield* compileStack({
        projectRoot: "/tmp/promise-facade-project",
        runtime: { kind: "native" },
        config: startedConfig,
      }).pipe(Effect.provide(NodeServices.layer));
      expect(compiled.definition.capabilities.functions.settings.functions_root).toBe(
        "/tmp/promise-facade-project/supabase/functions",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
