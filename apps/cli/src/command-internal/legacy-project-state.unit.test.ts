import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { classifyCliErrorActionability } from "../shared/telemetry/error-actionability.ts";
import { legacyProjectStateLayer } from "./legacy-project-state.layer.ts";
import { legacyProjectStatePaths } from "./legacy-project-state.paths.ts";
import { LegacyProjectState, ProjectRefReadError } from "./legacy-project-state.service.ts";

const services = legacyProjectStateLayer.pipe(Layer.provideMerge(NodeServices.layer));

const readRef = (workdir: string) =>
  Effect.gen(function* () {
    const state = yield* LegacyProjectState;
    return yield* state.readProjectRef(workdir);
  });

const REF = "abcdefghijklmnopqrst";

describe("legacyProjectStatePaths", () => {
  it.effect("maps a workdir to the supabase/.temp/* layout", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const workdir = path.join(path.sep, "home", "user", "project");
      const tempDir = path.join(workdir, "supabase", ".temp");
      const paths = legacyProjectStatePaths(path, workdir);

      expect(paths.tempDir).toBe(tempDir);
      expect(paths.projectRef).toBe(path.join(tempDir, "project-ref"));
      expect(paths.poolerUrl).toBe(path.join(tempDir, "pooler-url"));
      expect(paths.postgresVersion).toBe(path.join(tempDir, "postgres-version"));
      expect(paths.restVersion).toBe(path.join(tempDir, "rest-version"));
      expect(paths.gotrueVersion).toBe(path.join(tempDir, "gotrue-version"));
      expect(paths.storageVersion).toBe(path.join(tempDir, "storage-version"));
      expect(paths.storageMigration).toBe(path.join(tempDir, "storage-migration"));
      expect(paths.linkedProjectCache).toBe(path.join(tempDir, "linked-project.json"));
      expect(paths.cliLatest).toBe(path.join(tempDir, "cli-latest"));
      expect(paths.pgdeltaDir).toBe(path.join(tempDir, "pgdelta"));
      expect(paths.startSecretsDir).toBe(path.join(tempDir, "start-secrets"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("every temp path is nested under tempDir", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const paths = legacyProjectStatePaths(path, "/tmp/wd");
      const { tempDir, ...rest } = paths;
      for (const value of Object.values(rest)) {
        expect(path.dirname(value)).toBe(tempDir);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("LegacyProjectState file access", () => {
  it.effect("writes a state file, reads it back, and removes the directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* LegacyProjectState;
      const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-state-" });

      yield* state.write(workdir, "postgresVersion", "17.0.0");
      expect(yield* state.read(workdir, "postgresVersion")).toBe("17.0.0");
      expect(yield* state.exists(workdir, "postgresVersion")).toBe(true);

      yield* state.remove(workdir, "postgresVersion");
      expect(yield* state.exists(workdir, "postgresVersion")).toBe(false);

      yield* state.write(workdir, "restVersion", "v1");
      yield* state.removeAll(workdir);
      expect(yield* fs.exists(state.paths(workdir).tempDir)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});

describe("LegacyProjectState.readProjectRef", () => {
  const workdir = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ref-" });
    const tempDir = path.join(dir, "supabase", ".temp");
    return { fs, dir, tempDir, refPath: path.join(tempDir, "project-ref") };
  });

  it.effect("returns None when the project-ref file is absent (not linked)", () =>
    Effect.gen(function* () {
      const { dir } = yield* workdir;
      expect(Option.isNone(yield* readRef(dir))).toBe(true);
    }).pipe(Effect.provide(services)),
  );

  it.effect("returns the trimmed ref when the file holds a value", () =>
    Effect.gen(function* () {
      const { fs, dir, tempDir, refPath } = yield* workdir;
      yield* fs.makeDirectory(tempDir, { recursive: true });
      yield* fs.writeFileString(refPath, `  ${REF}\n`);
      expect(Option.getOrNull(yield* readRef(dir))).toBe(REF);
    }).pipe(Effect.provide(services)),
  );

  it.effect("treats a blank project-ref file as None", () =>
    Effect.gen(function* () {
      const { fs, dir, tempDir, refPath } = yield* workdir;
      yield* fs.makeDirectory(tempDir, { recursive: true });
      yield* fs.writeFileString(refPath, "   \n");
      expect(Option.isNone(yield* readRef(dir))).toBe(true);
    }).pipe(Effect.provide(services)),
  );

  it.effect("fails with ProjectRefReadError when the ref path is unreadable", () =>
    Effect.gen(function* () {
      // Seeding project-ref as a directory makes the read fail with EISDIR, which must surface
      // rather than collapse to "unlinked".
      const { fs, dir, refPath } = yield* workdir;
      yield* fs.makeDirectory(refPath, { recursive: true });
      const error = yield* Effect.flip(readRef(dir));
      expect(error).toBeInstanceOf(ProjectRefReadError);
      expect(error.message).toMatch(/^failed to load project ref: /);
    }).pipe(Effect.provide(services)),
  );

  it("classifies an unreadable ref file as permission without an unrelated command", () => {
    const result = classifyCliErrorActionability(
      new ProjectRefReadError({ message: "failed to load project ref: permission denied" }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("permission");
    expect(result.has_suggestion).toBe(false);
    expect(result.suggestion_type).toBe("none");
    expect(result.suggested_command).toBeUndefined();
  });
});
