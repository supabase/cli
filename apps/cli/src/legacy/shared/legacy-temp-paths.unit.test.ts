import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Formatter, Option, Path } from "effect";

import { classifyCliErrorActionability } from "../../shared/telemetry/error-actionability.ts";
import {
  LegacyProjectRefReadError,
  legacyReadProjectRefFile,
  legacyTempPaths,
} from "./legacy-temp-paths.ts";

const readRef = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyReadProjectRefFile(fs, path, workdir);
  }).pipe(Effect.provide(BunServices.layer));

const REF = "abcdefghijklmnopqrst";

describe("legacyTempPaths", () => {
  it.effect("maps a workdir to the supabase/.temp/* layout", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const workdir = path.join(path.sep, "home", "user", "project");
      const tempDir = path.join(workdir, "supabase", ".temp");
      const paths = legacyTempPaths(path, workdir);

      expect(paths.tempDir).toBe(tempDir);
      expect(paths.projectRef).toBe(path.join(tempDir, "project-ref"));
      expect(paths.poolerUrl).toBe(path.join(tempDir, "pooler-url"));
      expect(paths.postgresVersion).toBe(path.join(tempDir, "postgres-version"));
      expect(paths.restVersion).toBe(path.join(tempDir, "rest-version"));
      expect(paths.gotrueVersion).toBe(path.join(tempDir, "gotrue-version"));
      expect(paths.storageVersion).toBe(path.join(tempDir, "storage-version"));
      expect(paths.storageMigration).toBe(path.join(tempDir, "storage-migration"));
      expect(paths.pgmetaVersion).toBe(path.join(tempDir, "pgmeta-version"));
      expect(paths.linkedProjectCache).toBe(path.join(tempDir, "linked-project.json"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("every temp path is nested under tempDir", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const paths = legacyTempPaths(path, "/tmp/wd");
      const { tempDir, ...rest } = paths;
      for (const value of Object.values(rest)) {
        expect(path.dirname(value)).toBe(tempDir);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("legacyReadProjectRefFile", () => {
  it.effect("returns None when the project-ref file is absent (not linked)", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "legacy-ref-" });
      const value = yield* readRef(dir);
      expect(Option.isNone(value)).toBe(true);
      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("returns the trimmed ref when the file holds a value", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "legacy-ref-" });
      const tempDir = path.join(dir, "supabase", ".temp");
      yield* fs.makeDirectory(tempDir, { recursive: true });
      yield* fs.writeFileString(path.join(tempDir, "project-ref"), `  ${REF}\n`);
      const value = yield* readRef(dir);
      expect(Option.getOrNull(value)).toBe(REF);
      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("treats a blank project-ref file as None", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "legacy-ref-" });
      const tempDir = path.join(dir, "supabase", ".temp");
      yield* fs.makeDirectory(tempDir, { recursive: true });
      yield* fs.writeFileString(path.join(tempDir, "project-ref"), "   \n");
      const value = yield* readRef(dir);
      expect(Option.isNone(value)).toBe(true);
      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("fails with LegacyProjectRefReadError when the ref path is unreadable", () => {
    // Returns `failed to load project ref` for a non-not-exist
    // read error. Seeding project-ref as a DIRECTORY makes the
    // read fail with EISDIR (a non-NotFound PlatformError), so it must surface, not
    // collapse to "unlinked".
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "legacy-ref-" });
      yield* fs.makeDirectory(path.join(dir, "supabase", ".temp", "project-ref"), {
        recursive: true,
      });
      const exit = yield* readRef(dir).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Formatter.formatJson(exit.cause);
        expect(json).toContain("LegacyProjectRefReadError");
        expect(json).toContain("failed to load project ref");
      }
      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it("classifies an unreadable ref file as permission without an unrelated command", () => {
    const result = classifyCliErrorActionability(
      new LegacyProjectRefReadError({ message: "failed to load project ref: permission denied" }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("permission");
    expect(result.has_suggestion).toBe(false);
    expect(result.suggestion_type).toBe("none");
    expect(result.suggested_command).toBeUndefined();
  });
});
