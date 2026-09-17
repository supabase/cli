import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { describe, expect, it } from "@effect/vitest";
import { FunctionFilesError, planFunctionFiles } from "./FunctionFiles.ts";

const withFixture = <A>(
  use: (services: {
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly root: string;
  }) => Effect.Effect<A, FunctionFilesError | PlatformError, FileSystem.FileSystem | Path.Path>,
): Effect.Effect<A, FunctionFilesError | PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporaryRoot = yield* fs.makeTempDirectory({ prefix: "function-files-" });
    const root = yield* fs.realPath(temporaryRoot);
    return yield* Effect.acquireUseRelease(
      Effect.succeed(root),
      (fixtureRoot) => use({ fs, path, root: fixtureRoot }),
      (fixtureRoot) => fs.remove(fixtureRoot, { recursive: true, force: true }).pipe(Effect.ignore),
    );
  });

describe("planFunctionFiles", () => {
  it.effect("discovers entrypoint imports, import-map targets, and static files", () =>
    withFixture(({ fs, path, root }) =>
      Effect.gen(function* () {
        const projectRoot = path.join(root, "project");
        const functionDir = path.join(projectRoot, "supabase", "functions", "hello");
        const sharedDir = path.join(projectRoot, "shared");
        yield* fs.makeDirectory(path.join(functionDir, "public"), { recursive: true });
        yield* fs.makeDirectory(sharedDir, { recursive: true });
        const entrypoint = path.join(functionDir, "index.ts");
        const sibling = path.join(functionDir, "sibling.ts");
        const importMap = path.join(functionDir, "deno.json");
        const shared = path.join(sharedDir, "mod.ts");
        const staticFile = path.join(functionDir, "public", "hello.txt");
        yield* fs.writeFileString(entrypoint, 'import "./sibling.ts"; import "@shared/mod.ts";\n');
        yield* fs.writeFileString(sibling, "export const sibling = true;\n");
        yield* fs.writeFileString(shared, "export const shared = true;\n");
        yield* fs.writeFileString(staticFile, "hello\n");
        yield* fs.writeFileString(importMap, '{"imports":{"@shared/":"../../../shared/"}}');
        const plan = yield* planFunctionFiles({
          projectRoot,
          sourceRoot: projectRoot,
          entrypoint,
          importMap,
          staticFiles: [path.join(functionDir, "public", "*.txt")],
        });
        const paths = plan.files.map((file) => file.hostPath);
        expect(paths).toEqual(
          expect.arrayContaining([entrypoint, importMap, sibling, shared, staticFile]),
        );
        expect(plan.files.some((file) => file.hostPath === shared && file.externalScope)).toBe(
          false,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("mounts an external scope file without following its imports", () =>
    withFixture(({ fs, path, root }) =>
      Effect.gen(function* () {
        const projectRoot = path.join(root, "project");
        const functionDir = path.join(projectRoot, "supabase", "functions", "hello");
        const externalDir = path.join(root, "external");
        yield* fs.makeDirectory(functionDir, { recursive: true });
        yield* fs.makeDirectory(externalDir, { recursive: true });
        const entrypoint = path.join(functionDir, "index.ts");
        const importMap = path.join(functionDir, "deno.json");
        const external = path.join(externalDir, "mod.ts");
        const externalDependency = path.join(externalDir, "dependency.ts");
        yield* fs.writeFileString(entrypoint, "Deno.serve(() => new Response('ok'));\n");
        yield* fs.writeFileString(external, 'export { dependency } from "./dependency.ts";\n');
        yield* fs.writeFileString(externalDependency, "export const dependency = true;\n");
        yield* fs.writeFileString(
          importMap,
          '{"scopes":{"./":{"@external":"../../../../external/mod.ts"}}}',
        );
        const plan = yield* planFunctionFiles({
          projectRoot,
          sourceRoot: projectRoot,
          entrypoint,
          importMap,
          staticFiles: [],
        });
        expect(plan.files.find((file) => file.hostPath === external)).toMatchObject({
          targetPath: external,
          externalScope: true,
          kind: "file",
        });
        expect(plan.files.some((file) => file.hostPath === externalDependency)).toBe(false);
        expect(plan.warnings).toContain(
          `WARN: Mounting import map scope target outside the project root: ${external}\n`,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
