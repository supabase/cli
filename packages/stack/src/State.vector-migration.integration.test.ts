import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Ref,
  Schema,
} from "effect";
import { create, open } from "./effect.ts";
import * as State from "./State.ts";
import { destroyTestStack } from "../tests/stack-cleanup.ts";

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);
const Json = Schema.fromJsonString(Schema.Unknown);
const savedServices = (text: string) =>
  Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        instances: Schema.Array(
          Schema.Struct({ creation: Schema.Struct({ service: Schema.String }) }),
        ),
      }),
    ),
  )(text).pipe(Effect.map(({ instances }) => instances.map(({ creation }) => creation.service)));

const stateFor = (root: string) =>
  Layer.build(State.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, State.Service)),
  );

/** A state document saved before the stack dropped its Vector service kind. */
const legacyDocument = (id: string, projectRoot: string) => ({
  id,
  lifetime: "detached",
  identity: { projectRoot, branchContext: "main", stackName: "local" },
  runtime: "native",
  instances: [
    { id: "analytics", creation: { service: "analytics", config: { backend: "postgres" } } },
    { id: "mail", creation: { service: "mail", config: {} } },
    {
      id: "vector",
      creation: {
        service: "vector",
        config: { analyticsUrl: "http://127.0.0.1:1", configPath: `${projectRoot}/vector.yaml` },
      },
    },
    { id: "vector-owned", creation: { service: "vector", config: {} } },
  ],
  composition: {
    members: [
      { id: "analytics", activation: "eager" },
      { id: "mail", activation: "eager" },
      { id: "vector", activation: "eager" },
      { id: "vector-owned", activation: "eager" },
    ],
    dependencies: [
      {
        from: "analytics",
        to: "vector",
        bindings: [{ output: "url", input: "analyticsUrl" }],
      },
      { from: "analytics", to: "vector-owned" },
      { from: "mail", to: "analytics" },
    ],
  },
  ports: [
    { key: "vector:http", host: "127.0.0.1", port: 24_501 },
    { key: "mail:http", host: "127.0.0.1", port: 24_502 },
  ],
});

const writeLegacyState = Effect.fn("test.writeLegacyState")(function* (
  stateRoot: string,
  id: string,
  projectRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const data = path.join(stateRoot, id, "data");
  yield* fs.makeDirectory(path.join(data, "vector", "runtime", "vector"), { recursive: true });
  yield* fs.writeFileString(path.join(data, "vector", "runtime", "vector", "vector.yaml"), "");
  yield* fs.writeFileString(path.join(data, "vector", "runtime", "vector", "vector-api.yaml"), "");
  yield* fs.writeFileString(
    path.join(data, "vector", "runtime", "vector", "vector.rendered.yaml"),
    "rendered",
  );
  yield* fs.writeFileString(path.join(data, "vector", "pipeline.yaml"), "caller");
  const owned = path.join(data, "vector-owned", "runtime", "vector");
  yield* fs.makeDirectory(path.join(owned, ".vector-write-1"), { recursive: true });
  yield* fs.writeFileString(path.join(owned, "vector-api.yaml"), "");
  const file = path.join(stateRoot, id, "state.json");
  yield* fs.writeFileString(
    file,
    yield* Schema.encodeEffect(Json)(legacyDocument(id, projectRoot)),
  );
  return file;
});

describe("saved Vector instance migration", () => {
  it.live("reads a legacy state without Vector and leaves the file for the lease holder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-vector-read-" });
      const state = yield* stateFor(root);
      const file = yield* writeLegacyState(root, "legacy", root);
      const before = yield* fs.readFileString(file);

      const saved = yield* state.read("legacy");

      expect(saved?.instances.map(({ id }) => id)).toEqual(["analytics", "mail"]);
      expect(saved?.composition).toEqual({
        members: [
          { id: "analytics", activation: "eager" },
          { id: "mail", activation: "eager" },
        ],
        dependencies: [{ from: "mail", to: "analytics" }],
      });
      expect(saved?.ports.map(({ key }) => key)).toEqual(["mail:http"]);
      expect((yield* state.list).map(({ id }) => id)).toEqual(["legacy"]);
      expect(yield* fs.readFileString(file)).toBe(before);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("persists the migration once and keeps files a caller owns", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-vector-migrate-" });
      const state = yield* stateFor(root);
      const file = yield* writeLegacyState(root, "legacy", root);
      const data = path.join(root, "legacy", "data");

      yield* state.migrate("legacy");

      const migrated = yield* fs.readFileString(file);
      expect(yield* savedServices(migrated)).toEqual(["analytics", "mail"]);
      expect(yield* Schema.decodeEffect(Schema.fromJsonString(State.SavedStack))(migrated)).toEqual(
        yield* state.read("legacy"),
      );
      expect(yield* fs.exists(path.join(data, "vector", "runtime"))).toBe(false);
      expect(yield* fs.readFileString(path.join(data, "vector", "pipeline.yaml"))).toBe("caller");
      expect(yield* fs.exists(path.join(data, "vector-owned"))).toBe(false);

      yield* state.migrate("legacy");
      expect(yield* fs.readFileString(file)).toBe(migrated);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "retries removing Vector files that a failed migration left after the state is saved again",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-vector-retry-" });
        const failNext = yield* Ref.make(true);
        const injected: FileSystem.FileSystem = {
          ...fs,
          remove: (target, options) =>
            Effect.gen(function* () {
              if (
                target.endsWith("vector.rendered.yaml") &&
                (yield* Ref.getAndSet(failNext, false))
              )
                return yield* PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: target,
                });
              return yield* fs.remove(target, options);
            }),
        };
        const state = yield* stateFor(root).pipe(
          Effect.provideService(FileSystem.FileSystem, injected),
        );
        const file = yield* writeLegacyState(root, "legacy", root);
        const runtime = path.join(root, "legacy", "data", "vector", "runtime");

        yield* state.migrate("legacy");
        const keptFiles = yield* fs.exists(runtime);
        const saved = yield* state.read("legacy");
        if (saved === undefined) return yield* Effect.die("the legacy stack is not saved");
        yield* state.save(saved);
        yield* state.migrate("legacy");

        expect(keptFiles).toBe(true);
        expect(yield* savedServices(yield* fs.readFileString(file))).toEqual(["analytics", "mail"]);
        expect(yield* fs.exists(runtime)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live.skipIf(process.platform === "win32")(
    "keeps Vector-named files that a symlinked data directory reaches outside the stack",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-vector-symlink-" });
        const state = yield* stateFor(root);
        yield* writeLegacyState(root, "legacy", root);
        const outside = path.join(root, "outside", "runtime", "vector");
        yield* fs.makeDirectory(outside, { recursive: true });
        yield* fs.writeFileString(path.join(outside, "vector.yaml"), "outside");
        const data = path.join(root, "legacy", "data");
        yield* fs.symlink(path.join(root, "outside"), path.join(data, "linked-root"));
        yield* fs.makeDirectory(path.join(data, "linked-config", "runtime"), { recursive: true });
        yield* fs.symlink(outside, path.join(data, "linked-config", "runtime", "vector"));

        yield* state.migrate("legacy");

        expect(yield* fs.readFileString(path.join(outside, "vector.yaml"))).toBe("outside");
        expect(yield* fs.exists(path.join(data, "vector", "runtime"))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("keeps Vector-named files in the data directory of a saved instance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-vector-live-" });
      const state = yield* stateFor(root);
      yield* writeLegacyState(root, "legacy", root);
      const mailConfig = path.join(root, "legacy", "data", "mail", "runtime", "vector");
      yield* fs.makeDirectory(mailConfig, { recursive: true });
      yield* fs.writeFileString(path.join(mailConfig, "vector.yaml"), "mail");

      yield* state.migrate("legacy");

      expect(yield* fs.readFileString(path.join(mailConfig, "vector.yaml"))).toBe("mail");
      expect(yield* fs.exists(path.join(root, "legacy", "data", "vector-owned"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("rejects a saved Vector id that escapes the stack without touching other stacks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-vector-escape-" });
      const state = yield* stateFor(root);
      const sibling = path.join(root, "other", "data", "vector", "runtime", "vector");
      yield* fs.makeDirectory(sibling, { recursive: true });
      yield* fs.writeFileString(path.join(sibling, "vector.yaml"), "sibling");
      const escaping = "../../other/data/vector";
      const document = legacyDocument("legacy", root);
      yield* fs.makeDirectory(path.join(root, "legacy", "data"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "legacy", "state.json"),
        yield* Schema.encodeEffect(Json)({
          ...document,
          instances: [
            ...document.instances.filter(({ creation }) => creation.service !== "vector"),
            { id: escaping, creation: { service: "vector", config: {} } },
          ],
          composition: {
            members: [...document.composition.members, { id: escaping, activation: "eager" }],
            dependencies: [],
          },
        }),
      );

      yield* state.migrate("legacy");
      const failure = yield* state.read("legacy").pipe(Effect.flip);

      expect(failure.operation).toBe("decode");
      expect(yield* fs.readFileString(path.join(sibling, "vector.yaml"))).toBe("sibling");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("checks a state without Vector while another operation holds the registry lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-vector-unlocked-" });
      const state = yield* stateFor(root);
      yield* writeLegacyState(root, "legacy", root);
      yield* state.migrate("legacy");
      const callerConfig = path.join(root, "legacy", "data", "vector", "runtime", "vector");
      yield* fs.makeDirectory(callerConfig, { recursive: true });
      yield* fs.writeFileString(path.join(callerConfig, "pipeline.yaml"), "caller");
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* state
        .withLock(Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);

      const checked = yield* state.migrate("legacy").pipe(Effect.timeout("1 second"), Effect.exit);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);

      expect(Exit.isSuccess(checked)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("refuses to migrate a state document copied from another stack", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-vector-copied-" });
      const state = yield* stateFor(root);
      const file = yield* writeLegacyState(root, "copied", root);
      yield* fs.writeFileString(
        file,
        yield* Schema.encodeEffect(Json)(legacyDocument("original", root)),
      );
      const before = yield* fs.readFileString(file);

      const failure = yield* state.migrate("copied").pipe(Effect.flip);

      expect(failure.operation).toBe("identity");
      expect(yield* fs.readFileString(file)).toBe(before);
      expect(yield* fs.exists(path.join(root, "original"))).toBe(false);
      expect(
        yield* fs.exists(path.join(root, "copied", "data", "vector", "runtime", "vector")),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("starts the owner of a legacy stack and drops Vector from its saved state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-vector-owner-" });
      const options = {
        projectRoot: root,
        stateRoot: `${root}/state`,
        cacheRoot: `${root}/cache`,
        runtime: "native",
      } satisfies Parameters<typeof create>[0];
      const created = yield* create(options);
      const file = yield* writeLegacyState(options.stateRoot, created.id, root);

      const stack = yield* open({ ...options, id: created.id, startOwner: true });
      yield* Effect.ensuring(
        Effect.gen(function* () {
          expect((yield* stack.services.list).map(({ id }) => id)).toEqual(["analytics", "mail"]);
          expect(yield* stack.composition.describe).toEqual({
            members: [
              { id: "analytics", activation: "eager" },
              { id: "mail", activation: "eager" },
            ],
            dependencies: [{ from: "mail", to: "analytics" }],
          });
          const migrated = yield* fs.readFileString(file);
          expect(yield* savedServices(migrated)).toEqual(["analytics", "mail"]);

          yield* stack.stop;
          const reopened = yield* open({ ...options, id: created.id, startOwner: true });
          expect((yield* reopened.services.list).map(({ id }) => id)).toEqual([
            "analytics",
            "mail",
          ]);
          expect(yield* fs.readFileString(file)).toBe(migrated);
        }),
        destroyTestStack(stack),
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "starts the owner of a legacy stack whose Vector migration fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-state-vector-failed-" });
        const options = {
          projectRoot: root,
          stateRoot: `${root}/state`,
          cacheRoot: `${root}/cache`,
          runtime: "native",
        } satisfies Parameters<typeof create>[0];
        const created = yield* create(options);
        const file = yield* writeLegacyState(options.stateRoot, created.id, root);
        const legacy = yield* fs.readFileString(file);
        const data = path.join(options.stateRoot, created.id, "data");
        // Unlistable but writable: the migration cannot find Vector files, the owner still runs.
        yield* fs.chmod(data, 0o300);

        const stack = yield* open({ ...options, id: created.id, startOwner: true }).pipe(
          Effect.ensuring(fs.chmod(data, 0o700).pipe(Effect.orDie)),
        );
        yield* Effect.ensuring(
          Effect.gen(function* () {
            expect((yield* stack.services.list).map(({ id }) => id)).toEqual(["analytics", "mail"]);
            expect(yield* fs.readFileString(file)).toBe(legacy);
          }),
          destroyTestStack(stack),
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
