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
import { compileStack, seedServiceRegistry } from "../model/Compiler.ts";
import { deriveStackId } from "../identity/Identity.ts";
import { StackStateFormatUnsupportedError, StackStateInvalidError } from "../public/Errors.ts";
import {
  makeStackStateStore,
  withRegistryLock,
  PersistedStackStateSchema,
  type PersistedStackState,
} from "./StackStateStore.ts";
import { removeLeaseIfHeld } from "./Ownership.ts";
import { AUTH_JWT_SECRET_SLOT, resolveSecrets } from "./SecretStore.ts";
import { ServiceInstanceIdSchema } from "../public/ServiceInstanceId.ts";

const layer = NodeServices.layer;
const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(layer));

const identity = {
  projectRoot: "/tmp/project",
  branchContext: "ordinary-workspace",
  stackName: "default",
} as const;

const state = (): PersistedStackState => ({
  format: "supabase-stack-state-v2",
  identity,
  runtime: { kind: "native" },
  preparation: "on-demand",
  security: {
    jwt: {
      issuer: null,
      expirySeconds: 3600,
      signing: { kind: "symmetric", secret: { slot: AUTH_JWT_SECRET_SLOT } },
    },
  },
  listeners: {},
  registry: { initialized: true, instances: [], defaultInstanceIds: {} },
  ports: [],
  privatePorts: [],
  secrets: {},
});
const instanceId = ServiceInstanceIdSchema.make("11111111-1111-4111-8111-111111111111");

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
const jsonText = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value);
const jsonTextSync = (value: unknown) =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const completeStateFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-state-" });
  const store = yield* makeStackStateStore({ stateRoot: root });
  const stackId = yield* deriveStackId(identity);
  const compiled = yield* compileStack({
    projectRoot: "/tmp/project",
    runtime: { kind: "native" },
    config: {
      preparation: "on-demand",
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
  const seeded = yield* seedServiceRegistry(
    compiled.definition,
    { projectRoot: identity.projectRoot, path, runtime: { kind: "native" } },
    compiled.sourceConfig,
    compiled.secrets,
  );
  const resolved = yield* resolveSecrets(
    { declarations: seeded.secretSlots },
    undefined,
    "unconfigured",
  );
  const complete: PersistedStackState = {
    ...state(),
    registry: seeded.registry,
    secrets: resolved.persisted,
  };
  yield* store.initialize(stackId, complete);
  const encoded = yield* Schema.encodeEffect(PersistedStackStateSchema)(complete);
  return { fs, path, store, root, stackId, complete, encoded };
});

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

  it.live("round-trips an initialized registry and its resolved secrets", () =>
    withPlatform(
      Effect.gen(function* () {
        const { store, stackId, complete } = yield* completeStateFixture;
        expect(complete.preparation).toBe("on-demand");
        expect(yield* store.read(stackId)).toEqual(complete);
      }),
    ),
  );

  it.live("rejects malformed nested state documents without rewriting them", () =>
    withPlatform(
      Effect.gen(function* () {
        const { fs, path, store, root, stackId, encoded } = yield* completeStateFixture;
        const statePath = path.join(root, stackId, "state.json");
        const invalidDocuments = [
          {
            ...encoded,
            registry: {
              ...encoded.registry,
              instances: encoded.registry.instances.map((instance) =>
                instance.service === "auth"
                  ? {
                      ...instance,
                      config: {
                        ...instance.config,
                        settings: { ...instance.config.settings, unknown: true },
                      },
                    }
                  : instance,
              ),
            },
          },
          {
            ...encoded,
            registry: {
              ...encoded.registry,
              instances: encoded.registry.instances.map((instance) =>
                instance.service === "functions"
                  ? {
                      ...instance,
                      config: {
                        ...instance.config,
                        settings: {
                          ...instance.config.settings,
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
                    }
                  : instance,
              ),
            },
          },
          { ...encoded, preparation: "invalid" },
          { ...encoded, identity: { ...encoded.identity, stackId } },
          { ...encoded, secrets: { "": { policy: "managed", value: "x" } } },
        ];
        for (const invalid of invalidDocuments) {
          const text = yield* jsonText(invalid);
          yield* fs.writeFileString(statePath, text);
          expect(errorOf(yield* store.read(stackId).pipe(Effect.exit))).toBeInstanceOf(
            StackStateInvalidError,
          );
          expect(yield* fs.readFileString(statePath)).toBe(text);
        }
      }),
    ),
  );

  it.live("rejects overlapping public and private ports at the persistence boundary", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-state-overlap-" });
        const value = {
          ...identity,
          projectRoot: root,
        };
        const stackId = yield* deriveStackId(value);
        const store = yield* makeStackStateStore({ stateRoot: root });
        const before = { ...state(), identity: value };
        yield* store.initialize(stackId, before);
        const candidate = {
          ...before,
          ports: [
            {
              owner: "stack" as const,
              binding: "api" as const,
              address: "127.0.0.1",
              port: 23_100,
              intent: "exact" as const,
            },
          ],
          privatePorts: [
            { instanceId, workloadId: `${instanceId}:database`, binding: "primary", port: 23_100 },
          ],
        };
        const result = yield* store.replace(stackId, candidate).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        const error = errorOf(result);
        expect(error).toBeInstanceOf(StackStateInvalidError);
        expect(error?.message).toContain("overlap");
        expect(yield* store.read(stackId)).toEqual(before);
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

  it.live("treats a state document disappearing during read as an absent stack", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-read-race-" });
        const stackId = yield* deriveStackId(identity);
        const store = yield* makeStackStateStore({ stateRoot: root });
        yield* store.initialize(stackId, state());
        const statePath = path.join(root, stackId, "state.json");
        const racingFs: FileSystem.FileSystem = {
          ...fs,
          readFileString: (candidate, encoding) =>
            candidate === statePath
              ? fs.remove(candidate).pipe(Effect.andThen(fs.readFileString(candidate, encoding)))
              : fs.readFileString(candidate, encoding),
        };
        const racingStore = yield* makeStackStateStore({ stateRoot: root }).pipe(
          Effect.provideService(FileSystem.FileSystem, racingFs),
        );

        expect(yield* racingStore.read(stackId)).toBeUndefined();
      }),
    ),
  );

  it.live("does not recover a runtime remnant that contains an owner lock", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-live-remnant-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const stackId = yield* deriveStackId(identity);
        const runtime = path.join(root, stackId, "runtime");
        const ownerLock = path.join(runtime, "owner.lock");
        yield* fs.makeDirectory(runtime, { recursive: true });
        yield* fs.writeFileString(ownerLock, "live");

        const readExit = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(readExit)).toBeInstanceOf(StackStateInvalidError);
        const recovered = yield* store.recoverRuntimeRemnant(stackId).pipe(Effect.exit);

        expect(errorOf(recovered)).toBeInstanceOf(StackStateInvalidError);
        expect(yield* fs.exists(ownerLock)).toBe(true);
        expect(yield* fs.exists(runtime)).toBe(true);
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
        yield* store.initialize(stackId, state());
        yield* fs.writeFileString(
          path.join(root, stackId, "state.json"),
          yield* jsonText({ ...state(), format: "supabase-stack-state-v1" }),
        );
        const unsupported = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(unsupported)).toBeInstanceOf(StackStateFormatUnsupportedError);
        yield* fs.writeFileString(
          path.join(root, stackId, "state.json"),
          yield* jsonText({ ...state(), format: 1 }),
        );
        const malformed = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(malformed)).toBeInstanceOf(StackStateFormatUnsupportedError);
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
        const original = state();
        const forged = {
          ...original,
          identity: { ...original.identity, projectRoot: "/tmp/forged" },
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
        const oldValue = state();
        const newValue = {
          ...oldValue,
          preparation: "background" as const,
          ports: [
            {
              owner: "stack" as const,
              binding: "api" as const,
              address: "127.0.0.1",
              port: 24_321,
              intent: "exact" as const,
            },
          ],
          secrets: { "secret:test": { policy: "managed" as const, value: "new-value" } },
        };
        yield* store.initialize(stackId, oldValue);
        const updates = Array.from({ length: 8 }, (_, index) =>
          store.replace(stackId, index % 2 === 0 ? oldValue : newValue),
        );
        const writer = Effect.forEach(updates, (update) => update, { concurrency: 1 });
        const readers = Effect.forEach(Array.from({ length: 32 }), () => store.read(stackId), {
          concurrency: 8,
        });
        const [, observations] = yield* Effect.all([writer, readers], { concurrency: 2 });
        for (const observation of observations) {
          expect([oldValue, newValue]).toContainEqual(observation);
        }
      }),
    ),
  );

  it.live("serializes concurrent read-modify-write updates without losing fields", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "supabase-stack-update-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const stackId = yield* deriveStackId(identity);
        yield* store.initialize(stackId, state());

        yield* Effect.all(
          [
            store.update(stackId, (current) =>
              Effect.succeed({
                ...current,
                ports: [
                  {
                    owner: "stack",
                    binding: "api",
                    address: "127.0.0.1",
                    port: 24_321,
                    intent: "exact",
                  },
                ],
              }),
            ),
            store.update(stackId, (current) =>
              Effect.succeed({
                ...current,
                privatePorts: [
                  { instanceId, workloadId: `${instanceId}:rest`, binding: "http", port: 24_322 },
                ],
              }),
            ),
          ],
          { concurrency: 2 },
        );

        expect(yield* store.read(stackId)).toMatchObject({
          ports: [
            { owner: "stack", binding: "api", address: "127.0.0.1", port: 24_321, intent: "exact" },
          ],
          privatePorts: [
            { instanceId, workloadId: `${instanceId}:rest`, binding: "http", port: 24_322 },
          ],
        });
      }),
    ),
  );

  it.live("does not write when an update transform fails or state is missing", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "supabase-stack-update-invalid-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const stackId = yield* deriveStackId(identity);
        const original = state();
        yield* store.initialize(stackId, original);

        const failed = yield* store
          .update(stackId, () =>
            Effect.fail(new StackStateInvalidError({ message: "invalid update" })),
          )
          .pipe(Effect.exit);
        expect(errorOf(failed)).toBeInstanceOf(StackStateInvalidError);
        expect(yield* store.read(stackId)).toEqual(original);

        yield* store.cleanup(stackId);
        const missing = yield* store
          .update(stackId, (current) => Effect.succeed(current))
          .pipe(Effect.exit);
        expect(errorOf(missing)).toBeInstanceOf(StackStateInvalidError);
      }),
    ),
  );
});
