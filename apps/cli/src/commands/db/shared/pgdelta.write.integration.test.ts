import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { useTempWorkdir } from "../../../../tests/helpers/command-mocks.ts";
import { updateDeclarativeSchemaPathsConfig } from "./pgdelta.write.ts";

describe("updateDeclarativeSchemaPathsConfig", () => {
  const tmp = useTempWorkdir("decl-schema-paths-");

  it.effect("sets schema_paths in config.jsonc, keeps comments, and creates no config.toml", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configPath = path.join(tmp.current, "supabase", "config.jsonc");
      yield* fs.makeDirectory(path.join(tmp.current, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        configPath,
        ["{", "  // keep this comment", '  "db": { "port": 54322, },', "}", ""].join("\n"),
      );

      yield* updateDeclarativeSchemaPathsConfig(fs, path, tmp.current, "supabase/schemas");

      const config = yield* fs.readFileString(configPath);
      expect(config).toContain("// keep this comment");
      expect(config).toContain('"port": 54322');
      expect(config).toContain('"schema_paths"');
      expect(config).toContain('"schemas"');
      expect(yield* fs.exists(path.join(tmp.current, "supabase", "config.toml"))).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
