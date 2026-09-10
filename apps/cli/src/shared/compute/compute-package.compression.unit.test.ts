import { BunServices } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, vi } from "vitest";
import { ComputeArchiveCompressionError, packageComputeDirectory } from "./compute-package.ts";

const gzipFailure = vi.hoisted(() => new Error("injected gzip failure"));

vi.mock("node:zlib", () => ({
  gzipSync: () => {
    throw gzipFailure;
  },
}));

describe("packageComputeDirectory compression", () => {
  it.live("reports compression failures as typed errors with their cause", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-compute-compression-" });
        const source = path.join(root, "source");
        yield* fs.makeDirectory(source);
        yield* fs.writeFileString(path.join(source, "index.ts"), "export const answer = 42;\n");

        const error = yield* Effect.flip(packageComputeDirectory(source));
        expect(error).toBeInstanceOf(ComputeArchiveCompressionError);
        expect(error).toMatchObject({ cause: gzipFailure });
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );
});
