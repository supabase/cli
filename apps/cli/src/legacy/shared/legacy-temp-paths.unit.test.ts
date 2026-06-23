import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option, Path } from "effect";

import { legacyReadProjectRefFile, legacyTempPaths } from "./legacy-temp-paths.ts";

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
    const dir = mkdtempSync(join(tmpdir(), "legacy-ref-"));
    return readRef(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.isNone(v)).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("returns the trimmed ref when the file holds a value", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-ref-"));
    mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(dir, "supabase", ".temp", "project-ref"), `  ${REF}\n`);
    return readRef(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.getOrNull(v)).toBe(REF);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("treats a blank project-ref file as None", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-ref-"));
    mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(dir, "supabase", ".temp", "project-ref"), "   \n");
    return readRef(dir).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          expect(Option.isNone(v)).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("fails with LegacyProjectRefReadError when the ref path is unreadable", () => {
    // Go's LoadProjectRef returns `failed to load project ref` for a non-not-exist
    // read error (project_ref.go:71-72). Seeding project-ref as a DIRECTORY makes the
    // read fail with EISDIR (a non-NotFound PlatformError), so it must surface, not
    // collapse to "unlinked".
    const dir = mkdtempSync(join(tmpdir(), "legacy-ref-"));
    mkdirSync(join(dir, "supabase", ".temp", "project-ref"), { recursive: true });
    return readRef(dir).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyProjectRefReadError");
            expect(json).toContain("failed to load project ref");
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});
