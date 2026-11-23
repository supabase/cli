import { NodeCrypto, NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { HttpClient } from "effect/http";
import { makeStandaloneService } from "../../tests/standalone-service.ts";
import { selection } from "../../tests/pins.ts";
import { makeServiceRecipe } from "./Catalog.ts";

const options = (root: string, runtime: "native" | "docker" = "native") => ({
  stackId: "catalog-studio",
  instanceId: "studio",
  root,
  cacheRoot: `${root}/cache`,
  runtime,
  claimNativePort: () => Effect.succeed(true),
});

const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NodeHttpClient.layerNodeHttp);

describe("studio recipe", () => {
  it.live(
    "rejects a functionsRoot that resolves inside a sibling instance under the same data root",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-studio-reject-" });
          // Ownership is by location: Studio's functionsRoot is a caller path and must live
          // outside the stack's data root, not merely outside this instance's own instance root.
          const siblingInstance = `${root}/functions-instance`;
          yield* fs.makeDirectory(siblingInstance, { recursive: true });
          const recipe = yield* makeServiceRecipe(
            {
              service: "studio",
              pin: selection.studio,
              config: { functionsRoot: siblingInstance },
            },
            options(root),
          );
          const studio = yield* makeStandaloneService(recipe.definition, {
            id: "studio",
            config: recipe.creation,
          });
          const failure = yield* studio.start.pipe(Effect.flip);
          expect(failure.message).toContain("resolves inside the owned data root");
        }),
      ).pipe(Effect.provide(services)),
  );

  it.live("runs the launcher named by executable with Studio's environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const client = yield* HttpClient.HttpClient;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-studio-launcher-" });
        const launcher = `${root}/studio-launcher`;
        yield* fs.writeFileString(
          launcher,
          `#!${process.execPath}\n` +
            `require("node:http").createServer((_request, response) => response.end(process.env.STUDIO_PG_META_URL + " " + process.env.POSTGRES_ENGINE)).listen(Number(process.env.PORT), process.env.HOSTNAME);\n`,
        );
        yield* fs.chmod(launcher, 0o755);
        const recipe = yield* makeServiceRecipe(
          {
            service: "studio",
            pin: selection.studio,
            config: {
              executable: launcher,
              pgmetaUrl: "http://127.0.0.1:1/pg",
              postgresEngine: "spark",
            },
          },
          options(root),
        );
        const studio = yield* makeStandaloneService(recipe.definition, {
          id: "studio",
          config: recipe.creation,
        });

        yield* studio.start;
        yield* studio.ready;
        const { port } = yield* recipe.endpoint("http");
        const response = yield* client.get(`http://127.0.0.1:${port}/api/platform/profile`);

        expect(yield* response.text).toBe("http://127.0.0.1:1/pg spark");
        yield* studio.stop;
      }),
    ).pipe(Effect.provide(services)),
  );

  it.live(
    "falls back to the pinned build, which may run in a container, without an executable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-studio-pinned-" });
          const named = yield* makeServiceRecipe(
            { service: "studio", pin: selection.studio, config: { executable: `${root}/studio` } },
            options(root, "docker"),
          );
          const pinned = yield* makeServiceRecipe(
            { service: "studio", pin: selection.studio, config: {} },
            options(root, "docker"),
          );

          const prepare = (recipe: typeof named) =>
            (recipe.definition.prepare?.(recipe.creation) ?? Effect.void).pipe(Effect.flip);
          const namedFailure = yield* prepare(named);
          const pinnedFailure = yield* prepare(pinned);

          expect(namedFailure.message).toContain("needs the native runtime");
          expect(pinnedFailure.message).toContain("Container runtime unavailable");
        }),
      ).pipe(Effect.provide(services)),
  );
});
