import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Redacted,
  Schema,
} from "effect";
import { createServer, type Server } from "node:net";
import { compileStack, type StackDefinition } from "../model/Compiler.ts";
import { deriveStackId } from "../identity/Identity.ts";
import { StackStateFormatUnsupportedError, StackStateInvalidError } from "../public/Errors.ts";
import {
  makeStackStateStore,
  withRegistryLock,
  PersistedStackStateSchema,
  type PersistedStackState,
} from "./StackStateStore.ts";
import { removeLeaseIfHeld } from "./Ownership.ts";

const bindEphemeral = Effect.callback<Server, Error>((resume) => {
  const server = createServer();
  const onError = (error: Error) => resume(Effect.fail(error));
  const onListening = () => {
    server.off("error", onError);
    resume(Effect.succeed(server));
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen({ host: "127.0.0.1", port: 0 });
  return Effect.sync(() => {
    server.off("error", onError);
    server.off("listening", onListening);
    if (server.listening) server.close(() => undefined);
  });
});

const closeServer = (server: Server) =>
  Effect.callback<void, Error>((resume) => {
    if (!server.listening) return resume(Effect.void);
    server.close((error) =>
      error === undefined ? resume(Effect.void) : resume(Effect.fail(error)),
    );
  });

const layer = NodeServices.layer;
const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(layer));

const identity = {
  projectRoot: "/tmp/project",
  checkoutRoot: "/tmp/project",
  workspaceId: "/tmp/project",
  checkoutId: "/tmp/project",
  branchContext: "ordinary-workspace",
  localProjectKey: ".",
  stackName: "default",
} as const;

const state = (stackId: string, definition?: StackDefinition): PersistedStackState => ({
  format: "supabase-stack-state-v1",
  identity: { ...identity, stackId },
  runtime: { kind: "native" },
  desiredLifecycle: "stopped",
  definition,
  ports: [],
  privatePorts: [],
  secrets: {},
});

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
const jsonText = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value);
const jsonTextSync = (value: unknown) =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

describe("atomic stack state", () => {
  it.live("rejects a competing registry action while the lease is held", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-registry-busy-" });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let ran = false;
        const first = yield* Effect.forkChild(
          withRegistryLock(
            root,
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(entered);
        const competing = yield* withRegistryLock(
          root,
          Effect.sync(() => {
            ran = true;
            return undefined;
          }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(competing)).toBe(true);
        expect(ran).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
      }),
    ),
  );

  it.live("does not let a stale registry release remove a successor lock", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-registry-fence-",
        });
        const path = yield* Path.Path;
        const lockPath = path.join(root, ".stack-registry.lock");
        yield* fs.writeFileString(
          lockPath,
          jsonTextSync({ format: "supabase-stack-lease-v1", token: "successor", port: 45_678 }),
        );
        yield* removeLeaseIfHeld(fs, lockPath, "stale-owner");
        expect(yield* fs.readFileString(lockPath)).toContain("successor");
      }),
    ),
  );

  it.live("reclaims a registry lock whose lease was released by a crashed process", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-registry-" });
        const stale = yield* bindEphemeral;
        const address = stale.address();
        if (address === null || typeof address === "string")
          return yield* new StackStateInvalidError({ message: "missing lease port" });
        yield* fs.writeFileString(
          path.join(root, ".stack-registry.lock"),
          jsonTextSync({
            format: "supabase-stack-lease-v1",
            token: "old-registry",
            port: address.port,
          }),
        );
        yield* closeServer(stale);
        const result = yield* withRegistryLock(root, Effect.succeed("recovered"));
        expect(result).toBe("recovered");
        expect(yield* fs.exists(path.join(root, ".stack-registry.lock"))).toBe(false);
      }),
    ),
  );

  it.live("fails closed immediately for malformed registry state", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-registry-invalid-",
        });
        yield* fs.writeFileString(path.join(root, ".stack-registry.lock"), "not-json");
        const result = yield* withRegistryLock(root, Effect.void).pipe(Effect.exit);
        expect(errorOf(result)).toBeInstanceOf(StackStateInvalidError);
      }),
    ),
  );

  it.live("round-trips a compiled complete definition and rejects nested unknowns", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-state-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const stackId = yield* deriveStackId(identity);
        const compiled = yield* compileStack({
          projectRoot: "/tmp/project",
          runtime: { kind: "native" },
          config: {
            capabilities: {
              auth: {
                settings: {
                  secret_key: Redacted.make("state-secret"),
                  email: {
                    template: { confirm: { subject: "Confirm" } },
                    notification: { welcome: { enabled: true } },
                  },
                },
              },
              functions: { settings: { functions: { hello: { verify_jwt: false } } } },
            },
          },
        });
        const complete = state(stackId, compiled.definition);
        yield* store.initialize(stackId, complete);
        expect(yield* store.read(stackId)).toEqual(complete);
        const materialized = { ...complete };
        yield* store.replace(stackId, materialized);
        expect(yield* store.read(stackId)).toEqual(materialized);
        yield* store.replace(stackId, complete);

        const encoded = yield* Schema.encodeEffect(PersistedStackStateSchema)(complete);
        const statePath = path.join(root, stackId, "state.json");
        const nestedUnknown = {
          ...encoded,
          definition: {
            ...encoded.definition,
            capabilities: {
              ...encoded.definition?.capabilities,
              auth: {
                ...encoded.definition?.capabilities.auth,
                settings: {
                  ...encoded.definition?.capabilities.auth.settings,
                  email: {
                    ...encoded.definition?.capabilities.auth.settings.email,
                    template: {
                      ...encoded.definition?.capabilities.auth.settings.email?.template,
                      confirm: {
                        ...encoded.definition?.capabilities.auth.settings.email?.template?.confirm,
                        unknown: true,
                      },
                    },
                  },
                },
              },
            },
          },
        };
        yield* fs.writeFileString(statePath, yield* jsonText(nestedUnknown));
        const unknownExit = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(unknownExit)).toBeInstanceOf(StackStateInvalidError);

        const missingDefault = {
          ...encoded,
          definition: {
            ...encoded.definition,
            capabilities: {
              ...encoded.definition?.capabilities,
              functions: {
                ...encoded.definition?.capabilities.functions,
                settings: {
                  ...encoded.definition?.capabilities.functions.settings,
                  functions: {
                    ...encoded.definition?.capabilities.functions.settings.functions,
                    hello: {
                      ...encoded.definition?.capabilities.functions.settings.functions?.hello,
                      verify_jwt: undefined,
                    },
                  },
                },
              },
            },
          },
        };
        yield* fs.writeFileString(statePath, yield* jsonText(missingDefault));
        const missingDefaultExit = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(missingDefaultExit)).toBeInstanceOf(StackStateInvalidError);

        const invalidRecordKey = {
          ...encoded,
          definition: {
            ...encoded.definition,
            capabilities: {
              ...encoded.definition?.capabilities,
              functions: {
                ...encoded.definition?.capabilities.functions,
                settings: {
                  ...encoded.definition?.capabilities.functions.settings,
                  functions: {
                    "bad.slug": {
                      enabled: true,
                      verify_jwt: true,
                      import_map: null,
                      entrypoint: null,
                      static_files: null,
                      env: {},
                    },
                  },
                },
              },
            },
          },
        };
        yield* fs.writeFileString(statePath, yield* jsonText(invalidRecordKey));
        const recordExit = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(recordExit)).toBeInstanceOf(StackStateInvalidError);

        const invalidSecret = {
          ...encoded,
          secrets: { "": { policy: "managed", value: "x" } },
        };
        yield* fs.writeFileString(statePath, yield* jsonText(invalidSecret));
        const secretExit = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(secretExit)).toBeInstanceOf(StackStateInvalidError);
      }),
    ),
  );

  it.live("fails closed when identity remnants exist without state and cleans exact identity", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-remnant-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const stackId = yield* deriveStackId(identity);
        yield* fs.makeDirectory(path.join(root, stackId, "data"), { recursive: true });
        const sibling = yield* deriveStackId({ ...identity, stackName: "sibling" });
        yield* fs.makeDirectory(path.join(root, sibling, "data"), { recursive: true });
        const missing = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(missing)).toBeInstanceOf(StackStateInvalidError);
        yield* store.cleanup(stackId);
        expect(yield* fs.exists(path.join(root, stackId))).toBe(false);
        expect(yield* fs.exists(path.join(root, sibling, "data"))).toBe(true);
      }),
    ),
  );

  it.live("rejects unsupported state formats", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-format-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const stackId = yield* deriveStackId(identity);
        yield* store.initialize(stackId, state(stackId));
        yield* fs.writeFileString(
          path.join(root, stackId, "state.json"),
          yield* jsonText({ ...state(stackId), format: "supabase-stack-state-v2" }),
        );
        const unsupported = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(unsupported)).toBeInstanceOf(StackStateFormatUnsupportedError);
        yield* fs.writeFileString(
          path.join(root, stackId, "state.json"),
          yield* jsonText({ ...state(stackId), format: 1 }),
        );
        const malformed = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(malformed)).toBeInstanceOf(StackStateInvalidError);
      }),
    ),
  );

  it.live("rejects a forged identity tuple before writing", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-identity-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const stackId = yield* deriveStackId(identity);
        const original = state(stackId);
        const forged = {
          ...original,
          identity: { ...original.identity, workspaceId: "/tmp/forged" },
        };
        const exit = yield* store.initialize(stackId, forged).pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(StackStateInvalidError);
        expect(yield* fs.exists(path.join(root, stackId))).toBe(false);
      }),
    ),
  );

  it.live("exposes only complete old or new values during repeated writes", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "supabase-stack-atomic-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const stackId = yield* deriveStackId(identity);
        yield* store.initialize(stackId, state(stackId));
        const updates = Array.from({ length: 8 }, () => store.replace(stackId, state(stackId)));
        const writer = Effect.forEach(updates, (update) => update, { concurrency: 1 });
        const readers = Effect.forEach(Array.from({ length: 32 }), () => store.read(stackId), {
          concurrency: 8,
        });
        const [, observations] = yield* Effect.all([writer, readers], { concurrency: 2 });
        for (const observation of observations) {
          expect(observation).toBeDefined();
          if (observation === undefined) continue;
          expect(observation.format).toBe("supabase-stack-state-v1");
          expect(observation.identity.stackId).toBe(stackId);
          expect(Array.isArray(observation.ports)).toBe(true);
          expect(observation.secrets).toEqual({});
        }
      }),
    ),
  );
});
