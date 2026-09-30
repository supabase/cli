import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import serviceImagesDockerfile from "./Dockerfile" with { type: "text" };

// The Go tree still `go:embed`s its own copy for a dependency that hasn't been removed
// yet; this keeps the two copies in sync until apps/cli-go is deleted, at which point
// this test should be deleted alongside it.
describe("Go Dockerfile sync guard", () => {
  it.effect("keeps the Go tree's embedded Dockerfile byte-identical to the TS-owned copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const goDockerfile = yield* fs.readFileString(
        path.resolve(import.meta.dirname, "../../../../cli-go/pkg/config/templates/Dockerfile"),
      );
      expect(goDockerfile).toBe(serviceImagesDockerfile);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
