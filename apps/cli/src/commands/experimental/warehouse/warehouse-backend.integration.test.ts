import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { withConfigEnv } from "../../../../tests/helpers/command-mocks.ts";
import { respondToComplete } from "../../../cli/complete.ts";
import { rootCommandForFeatures } from "../../../cli/root.ts";
import { resolveWarehouseEnabled } from "./warehouse-backend.ts";

const resolve = (cwd: string, env: Record<string, string>, args = ["warehouse"]) =>
  withConfigEnv(env, resolveWarehouseEnabled({ cwd, args }));

describe("Warehouse family opt-in", () => {
  it.effect.each([
    { file: "config.toml", content: "[experimental]\nwarehouse = true\n" },
    { file: "config.json", content: '{"experimental":{"warehouse":true}}' },
  ])("reads $file and lets shell configuration override it", ({ file, content }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "warehouse-gate-" });
      yield* fs.makeDirectory(path.join(cwd, "supabase"));
      yield* fs.writeFileString(path.join(cwd, "supabase", file), content);
      expect(yield* resolve(cwd, {})).toBe(true);
      expect(yield* resolve(cwd, { SUPABASE_EXPERIMENTAL_WAREHOUSE: "0" })).toBe(false);
      expect(yield* resolve(cwd, { SUPABASE_EXPERIMENTAL_WAREHOUSE: "" })).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("keeps the family gate independent of the experimental execution gate", () =>
    Effect.gen(function* () {
      expect(
        yield* resolve("/missing", { SUPABASE_EXPERIMENTAL: "1" }, ["warehouse", "--experimental"]),
      ).toBe(false);
      expect(yield* resolve("/missing", { SUPABASE_EXPERIMENTAL_WAREHOUSE: "1" })).toBe(true);
      const error = yield* resolve("/missing", { SUPABASE_EXPERIMENTAL_WAREHOUSE: "invalid" }).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("ExperimentalFeatureFlagError");
      expect(
        yield* resolve("/missing", { SUPABASE_EXPERIMENTAL_WAREHOUSE: "invalid" }, [
          "projects",
          "list",
        ]),
      ).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect.each([[], ["--help"], ["__complete", "wa"]])(
    "gates help and completion for %j",
    (args) =>
      Effect.gen(function* () {
        for (const value of ["0", "1"]) {
          const enabled = yield* resolve(
            "/missing",
            { SUPABASE_EXPERIMENTAL_WAREHOUSE: value },
            args,
          );
          const completion = respondToComplete(
            rootCommandForFeatures({ warehouseEnabled: enabled }),
            ["__complete", "wa"],
          );
          expect(completion?.candidates.some((candidate) => candidate.name === "warehouse")).toBe(
            value === "1",
          );
        }
      }).pipe(Effect.provide(BunServices.layer)),
  );
});
