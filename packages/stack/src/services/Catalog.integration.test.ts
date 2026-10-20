import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Redacted } from "effect";
import { selection } from "../../tests/pins.ts";
import { makeServiceRecipe } from "./Catalog.ts";

const options = (root: string) => ({
  stackId: "catalog-recipe",
  instanceId: "instance",
  root,
  cacheRoot: `${root}/cache`,
  runtime: "native" as const,
  claimNativePort: () => Effect.succeed(true),
});

describe("service catalog", () => {
  it.live("validates endpoint names and the artifact pin at the service creation boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-ports-" });
        const result = yield* makeServiceRecipe(
          {
            service: "rest",
            pin: selection.rest,
            config: { databaseUrl: "postgres://db" },
            endpoints: { smtp: { port: "auto" } },
          },
          options(root),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        const unpinnedDatabase = yield* makeServiceRecipe(
          {
            service: "database",
            config: {
              databasePassword: Redacted.make("postgres"),
              jwtSecret: Redacted.make("catalog-database-secret-with-at-least-32-chars"),
              jwtExpiry: 3600,
            },
          },
          options(root),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(unpinnedDatabase)).toBe(true);
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
              pin: selection.storage,
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
