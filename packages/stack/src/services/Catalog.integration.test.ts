import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Redacted } from "effect";
import { makeServiceRecipe } from "./Catalog.ts";

const options = (root: string) => ({
  stackId: "catalog-test",
  instanceId: "instance",
  root,
  cacheRoot: `${root}/cache`,
  runtime: "native" as const,
});

describe("service catalog", () => {
  it.live("validates endpoint names at the service creation boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-ports-" });
        const result = yield* makeServiceRecipe(
          {
            service: "rest",
            config: { databaseUrl: "postgres://db" },
            endpoints: { smtp: { port: "auto" } },
          },
          options(root),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        const misplacedDatabaseVersion = yield* makeServiceRecipe(
          {
            service: "database",
            version: "17",
            config: {
              version: "17",
              databasePassword: Redacted.make("postgres"),
              jwtSecret: Redacted.make("catalog-database-secret-with-at-least-32-chars"),
              jwtExpiry: 3600,
            },
          },
          options(root),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(misplacedDatabaseVersion)).toBe(true);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );

  it.live("rejects Storage creation without a file path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-storage-config-" });
        const error = yield* Effect.flip(
          makeServiceRecipe(
            {
              service: "storage",
              config: { databaseUrl: "postgres://db" },
            },
            options(root),
          ),
        );
        expect(error.operation).toBe("config");
        expect(error.message).toContain("Invalid service creation");
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );
});
