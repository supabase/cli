import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { mockOutput, mockStdin, mockTty } from "../../../tests/helpers/mocks.ts";
import { initProject } from "./project-init.ts";
import { INIT_README_TEMPLATE } from "./project-init.templates.ts";

const makeTempProjectDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "supabase-init-readme-" }),
);

function runInit(cwd: string, force = false) {
  const out = mockOutput({ format: "text", interactive: false });
  const layer = Layer.mergeAll(out.layer, mockTty(), mockStdin(false), BunServices.layer);
  return initProject({
    cwd,
    force,
    useOrioledb: false,
    interactive: false,
    yes: false,
    withVscodeSettings: false,
    withIntellijSettings: false,
  }).pipe(Effect.provide(layer));
}

describe("initProject README", () => {
  it.effect("writes supabase/README.md outside a git repo", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempProjectDir;

      yield* runInit(cwd);

      expect(yield* fs.readFileString(path.join(cwd, "supabase", "README.md"))).toBe(
        INIT_README_TEMPLATE,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("keeps an existing README when re-initializing with --force", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempProjectDir;
      const readmePath = path.join(cwd, "supabase", "README.md");
      yield* fs.makeDirectory(path.join(cwd, "supabase"), { recursive: true });
      yield* fs.writeFileString(readmePath, "# My project notes\n");

      yield* runInit(cwd, true);

      expect(yield* fs.readFileString(readmePath)).toBe("# My project notes\n");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("leaves the paths the README says appear later uncreated", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempProjectDir;

      yield* runInit(cwd);

      const created = yield* fs.readDirectory(path.join(cwd, "supabase"));
      expect(created).not.toContain("migrations");
      expect(created).not.toContain("functions");
      expect(created).not.toContain("seed.sql");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
