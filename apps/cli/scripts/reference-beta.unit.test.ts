import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";
import { rootCommand } from "../src/cli/root.ts";
import { docsCommandTree } from "../src/docs/docs-spec.ts";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));

function run(script: string, dir: string) {
  const { FORCE_COLOR: _forceColor, NO_COLOR: _noColor, ...environment } = process.env;
  const result = Bun.spawnSync(["bun", script, dir], { cwd: cliRoot, env: environment });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

describe("reference-beta definitions", () => {
  it.effect(
    "writes one schema-valid file per published command matching the committed copy, and the check rejects a broken file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "reference-beta-" });

        const generated = run("scripts/generate-reference-beta.ts", dir);
        expect(generated.stderr).toContain("match the schema");
        expect(generated.exitCode).toBe(0);
        const files = (yield* fs.readDirectory(dir)).filter((name) => name.endsWith(".md"));
        expect(files).toHaveLength(docsCommandTree(rootCommand).size);
        const committedDir = path.join(cliRoot, "docs/reference-beta/definitions");
        expect((yield* fs.readDirectory(committedDir)).toSorted()).toEqual(files.toSorted());
        for (const name of files) {
          expect(yield* fs.readFileString(path.join(committedDir, name))).toBe(
            yield* fs.readFileString(path.join(dir, name)),
          );
        }

        const target = path.join(dir, "db-push.md");
        const original = yield* fs.readFileString(target);
        yield* fs.writeFileString(
          target,
          original
            .replace("kind: command", "kind: script")
            .replace("id: db-push", "id: db-pull\nunknown: true"),
        );
        const checked = run("scripts/check-reference-beta.ts", dir);
        expect(checked.exitCode).toBe(1);
        expect(checked.stderr).toContain("✗ db-push.md");
        expect(checked.stderr).toContain("/kind must be equal to one of the allowed values");
        expect(checked.stderr).toContain("must NOT have additional properties");
        expect(checked.stderr).toContain("id does not match the file name");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    60_000,
  );
});
