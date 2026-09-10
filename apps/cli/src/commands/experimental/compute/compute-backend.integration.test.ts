import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { respondToComplete } from "../../../cli/complete.ts";
import { rootCommandForFeatures } from "../../../cli/root.ts";
import { resolveComputeEnabled } from "./compute-backend.ts";

const resolve = (input: Parameters<typeof resolveComputeEnabled>[0]) =>
  resolveComputeEnabled(input).pipe(Effect.provide(BunServices.layer));

const project = Effect.fnUntraced(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-compute-routing-" });
  for (const [relative, content] of Object.entries(files)) {
    const path = pathService.join(root, relative);
    yield* fs.makeDirectory(pathService.dirname(path), { recursive: true });
    yield* fs.writeFileString(path, content);
  }
  return root;
});

describe("resolveComputeEnabled", () => {
  it.effect("uses environment overrides without reading configuration", () =>
    Effect.gen(function* () {
      expect(
        yield* resolve({
          args: ["compute"],
          cwd: "/missing",
          env: { SUPABASE_EXPERIMENTAL_COMPUTE: "1" },
        }),
      ).toBe(true);
      expect(
        yield* resolve({
          args: ["compute"],
          cwd: "/missing",
          env: { SUPABASE_EXPERIMENTAL_COMPUTE: "0" },
        }),
      ).toBe(false);
    }),
  );

  it.effect("reads JSON and prefers it over TOML", () => {
    return Effect.gen(function* () {
      const root = yield* project({
        "supabase/config.toml": "[experimental]\ncompute = false\n",
        "supabase/config.json": '{"experimental":{"compute":true}}',
      });
      expect(yield* resolve({ args: ["compute"], cwd: root, env: {} })).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect("finds a JSON-only ancestor and respects explicit workdirs", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* project({ "supabase/config.json": '{"experimental":{"compute":true}}' });
      const child = path.join(root, "nested");
      yield* fs.makeDirectory(child);
      const explicit = yield* project({
        "supabase/config.toml": "[experimental]\ncompute = false\n",
      });
      expect(yield* resolve({ args: ["compute"], cwd: child, env: {} })).toBe(true);
      expect(
        yield* resolve({ args: ["compute", "--workdir", explicit], cwd: child, env: {} }),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect("keeps default workdir selection aligned with the TOML command reader", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* project({ "supabase/config.toml": "[experimental]\ncompute = false\n" });
      const child = path.join(root, "nested");
      yield* fs.makeDirectory(path.join(child, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(child, "supabase/config.json"),
        '{"experimental":{"compute":true}}',
      );
      expect(yield* resolve({ args: ["compute"], cwd: child, env: {} })).toBe(false);
      expect(yield* resolve({ args: ["compute", "--workdir", child], cwd: root, env: {} })).toBe(
        true,
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect("fails closed for invalid values and malformed files", () => {
    return Effect.gen(function* () {
      const root = yield* project({ "supabase/config.json": '{"experimental":{"compute":"yes"}}' });
      const malformed = yield* project({ "supabase/config.toml": "[experimental\ncompute = true" });
      expect(yield* resolve({ args: ["compute"], cwd: root, env: {} })).toBe(false);
      expect(yield* resolve({ args: ["compute"], cwd: malformed, env: {} })).toBe(false);
      expect(
        yield* resolve({
          args: ["compute"],
          cwd: "/missing",
          env: { SUPABASE_EXPERIMENTAL_COMPUTE: "invalid" },
        }),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect("skips filesystem work for version requests", () =>
    Effect.gen(function* () {
      expect(yield* resolve({ args: ["--version"], cwd: "/missing", env: {} })).toBe(false);
    }),
  );

  it("selects the enabled command tree and hides it when disabled", () => {
    const enabled = respondToComplete(rootCommandForFeatures({ computeEnabled: true }), [
      "__complete",
      "compute",
      "",
    ]);
    const disabled = respondToComplete(rootCommandForFeatures({ computeEnabled: false }), [
      "__complete",
      "compute",
      "",
    ]);
    expect(enabled?.candidates.length).toBeGreaterThan(0);
    expect(disabled?.candidates ?? []).toHaveLength(0);
  });
});
