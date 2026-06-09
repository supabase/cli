import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import { legacyTempPaths } from "./legacy-temp-paths.ts";

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
