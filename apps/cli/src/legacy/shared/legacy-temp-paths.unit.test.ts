import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import { legacyTempPaths } from "./legacy-temp-paths.ts";

describe("legacyTempPaths", () => {
  it.effect("maps a workdir to the supabase/.temp/* layout", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const paths = legacyTempPaths(path, "/home/user/project");

      expect(paths.tempDir).toBe("/home/user/project/supabase/.temp");
      expect(paths.projectRef).toBe("/home/user/project/supabase/.temp/project-ref");
      expect(paths.poolerUrl).toBe("/home/user/project/supabase/.temp/pooler-url");
      expect(paths.postgresVersion).toBe("/home/user/project/supabase/.temp/postgres-version");
      expect(paths.restVersion).toBe("/home/user/project/supabase/.temp/rest-version");
      expect(paths.gotrueVersion).toBe("/home/user/project/supabase/.temp/gotrue-version");
      expect(paths.storageVersion).toBe("/home/user/project/supabase/.temp/storage-version");
      expect(paths.storageMigration).toBe("/home/user/project/supabase/.temp/storage-migration");
      expect(paths.linkedProjectCache).toBe(
        "/home/user/project/supabase/.temp/linked-project.json",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("every temp path is nested under tempDir", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const paths = legacyTempPaths(path, "/tmp/wd");
      const { tempDir, ...rest } = paths;
      for (const value of Object.values(rest)) {
        expect(value.startsWith(`${tempDir}/`)).toBe(true);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
