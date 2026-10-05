import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { makeStandaloneService } from "../../tests/standalone-service.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import {
  noContainerClaims,
  noDirectoryClaims,
  noPublicPortReservations,
} from "../../tests/claims.ts";

const options = (root: string) => ({
  stackId: "catalog-studio",
  instanceId: "studio",
  root,
  cacheRoot: `${root}/cache`,
  runtime: "native" as const,
  containerClaims: noContainerClaims,
  directoryClaims: noDirectoryClaims,
  isPubliclyReserved: noPublicPortReservations,
});

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
            { service: "studio", config: { functionsRoot: siblingInstance } },
            options(root),
          );
          const studio = yield* makeStandaloneService(recipe.definition, {
            id: "studio",
            config: recipe.creation,
          });
          const failure = yield* studio.start.pipe(Effect.flip);
          expect(failure.message).toContain("resolves inside the owned data root");
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );
});
