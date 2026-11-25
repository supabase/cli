import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError } from "effect";
import { writeDocsReference } from "./write-docs-reference.ts";

it.effect("restores the previous spec when replacing the sidebar fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "docs-rollback-" });
    const spec = path.join(parent, "commands.yaml");
    const sidebar = path.join(parent, "sections.json");
    const previousSpec = "version: '1.0.0'\n";
    const previousSidebar = '[{"id":"previous"}]\n';
    const nextSpec = "version: '2.0.0'\n";
    yield* fs.writeFileString(spec, previousSpec);
    yield* fs.writeFileString(sidebar, previousSidebar);
    const destinations = {
      spec: { parent, target: spec, info: yield* fs.stat(spec) },
      sidebar: { parent, target: sidebar, info: yield* fs.stat(sidebar) },
    };
    const renameError = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "rename",
      pathOrDescriptor: sidebar,
    });
    const failure = yield* writeDocsReference(destinations, nextSpec, "[]").pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            to === sidebar
              ? Effect.gen(function* () {
                  expect(yield* fs.readFileString(spec)).toBe(nextSpec);
                  return yield* renameError;
                })
              : fs.rename(from, to),
        }),
      ),
      Effect.flip,
    );

    expect(failure).toBe(renameError);
    expect(yield* fs.readFileString(spec)).toBe(previousSpec);
    expect(yield* fs.readFileString(sidebar)).toBe(previousSidebar);
  }).pipe(Effect.provide(BunServices.layer)),
);
