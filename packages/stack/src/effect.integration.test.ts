import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted } from "effect";
import { create, discover, open, type DatabaseInstance, type ServiceInstance } from "./effect.ts";

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

it.live("registers and discovers saved definitions without inventing live observations", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-api-" });
    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "native",
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);
    const entries = yield* discover(options);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.definition.id).toBe(stack.id);
    expect(entries[0]?.host).toBeUndefined();
    expect(entries[0]?.definition.instances).toEqual([]);
    expect(yield* stack.services.list).toEqual([]);
    expect(yield* stack.composition.describe).toEqual({ members: [], dependencies: [] });
    expect((yield* discover(options))[0]?.host).toBeUndefined();
    const duplicate = yield* Effect.flip(create(options));
    expect(duplicate.message).toContain("already exists");
    const reopened = yield* open({ ...options, id: stack.id });
    expect(reopened.id).toBe(stack.id);
    const missing = yield* Effect.flip(open({ ...options, id: "missing" }));
    expect(missing.message).toContain("does not exist");

    const database = stack.services.create({
      service: "database",
      config: {
        version: "17",
        databasePassword: Redacted.make("test"),
        jwtSecret: Redacted.make("test"),
        jwtExpiry: 3600,
      },
    });
    const rest = stack.services.create({
      service: "rest",
      config: { databaseUrl: "postgres://external" },
    });
    expectTypeOf<Effect.Success<typeof database>>().toEqualTypeOf<DatabaseInstance>();
    expectTypeOf<Effect.Success<typeof rest>>().toEqualTypeOf<ServiceInstance<"rest">>();
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
