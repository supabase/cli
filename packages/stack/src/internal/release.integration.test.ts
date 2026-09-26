import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { sourceDigest } from "./release.ts";

it.live("digests only regular module files, ignoring dangling editor lock links", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-release-digest-" });
    yield* fs.makeDirectory(path.join(root, "nested"));
    yield* fs.writeFileString(path.join(root, "nested", "Module.ts"), "export const a = 1;\n");
    const clean = yield* sourceDigest(root);

    yield* fs.symlink("user@host.1234:1700000000", path.join(root, "nested", ".#Module.ts"));
    yield* fs.makeDirectory(path.join(root, "folder.ts"));

    expect(yield* sourceDigest(root)).toBe(clean);
    yield* fs.writeFileString(path.join(root, "nested", "Module.ts"), "export const a = 2;\n");
    expect(yield* sourceDigest(root)).not.toBe(clean);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
