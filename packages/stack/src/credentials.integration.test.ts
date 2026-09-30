import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted } from "effect";
import { tmpdir } from "node:os";
import { create, open } from "./effect.ts";

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

it.live("persists effective credentials across service creation, reopen, and restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-credentials-" });
      const options = {
        projectRoot: root,
        stateRoot: `${root}/state`,
        cacheRoot: `${tmpdir()}/supabase-stack-artifacts`,
        runtime: "native",
      } as const;
      const stack = yield* create(options);
      yield* Effect.addFinalizer(() => stack.destroy.pipe(Effect.orDie));
      const database = yield* stack.services.create({
        service: "database",
        config: {
          version: "17",
          jwtSecret: Redacted.make("credentials-jwt-override"),
          rootKey: Redacted.make("b".repeat(64)),
          jwtExpiry: 3600,
        },
      });
      const expected = {
        jwtSecret: "credentials-jwt-override",
        postgresRootKey: "b".repeat(64),
        databasePassword: "postgres",
      };
      const credentials = yield* stack.credentials.get;
      expect(credentials).toMatchObject(expected);

      const reopened = yield* open({ ...options, id: stack.id });
      expect(yield* reopened.credentials.get).toEqual(credentials);
      yield* database.restart();
      yield* database.ready;
      expect(yield* stack.credentials.get).toEqual(credentials);
    }).pipe(Effect.provide(layer)),
  ),
);

it.live("resolves composition credentials before creating services", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-composition-credentials-" });
      const stack = yield* create({
        projectRoot: root,
        stateRoot: `${root}/state`,
        cacheRoot: `${tmpdir()}/supabase-stack-artifacts`,
        runtime: "native",
      });
      yield* Effect.addFinalizer(() => stack.destroy.pipe(Effect.orDie));

      const created = yield* stack.composition.supabase([
        {
          service: "auth",
          config: {},
          endpoints: { http: { port: "auto" } },
        },
        {
          service: "database",
          config: {
            version: "17",
            jwtSecret: Redacted.make("composition-jwt-override"),
            rootKey: Redacted.make("c".repeat(64)),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" } },
        },
      ]);

      expect(yield* stack.credentials.get).toMatchObject({
        jwtSecret: "composition-jwt-override",
        postgresRootKey: "c".repeat(64),
        databasePassword: "postgres",
      });
      const auth = created.find((service) => service.service === "auth");
      if (auth === undefined) return yield* Effect.die("Auth service was not created");
      const status = yield* auth.status;
      expect(status.config.service).toBe("auth");
      if (status.config.service !== "auth") return yield* Effect.die("Expected Auth config");
      expect(status.config.config.jwtSecret).toBe("composition-jwt-override");
    }).pipe(Effect.provide(layer)),
  ),
);
