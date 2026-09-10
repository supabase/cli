import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { respondToComplete } from "../../cli/complete.ts";
import { rootCommandForFeatures } from "../../cli/root.ts";
import { resolveComputeEnabled } from "./compute-backend.ts";

const resolve = (input: Parameters<typeof resolveComputeEnabled>[0]) =>
  resolveComputeEnabled(input).pipe(Effect.provide(BunServices.layer));

const project = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "supabase-compute-routing-"));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
};

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
    const root = project({
      "supabase/config.toml": "[experimental]\ncompute = false\n",
      "supabase/config.json": '{"experimental":{"compute":true}}',
    });
    return Effect.gen(function* () {
      expect(yield* resolve({ args: ["compute"], cwd: root, env: {} })).toBe(true);
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("finds a JSON-only ancestor and respects explicit workdirs", () => {
    const root = project({ "supabase/config.json": '{"experimental":{"compute":true}}' });
    const child = join(root, "nested");
    mkdirSync(child);
    const explicit = project({ "supabase/config.toml": "[experimental]\ncompute = false\n" });
    return Effect.gen(function* () {
      expect(yield* resolve({ args: ["compute"], cwd: child, env: {} })).toBe(true);
      expect(
        yield* resolve({ args: ["compute", "--workdir", explicit], cwd: child, env: {} }),
      ).toBe(false);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(root, { recursive: true, force: true });
          rmSync(explicit, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps default workdir selection aligned with the TOML command reader", () => {
    const root = project({ "supabase/config.toml": "[experimental]\ncompute = false\n" });
    const child = join(root, "nested");
    mkdirSync(join(child, "supabase"), { recursive: true });
    writeFileSync(join(child, "supabase/config.json"), '{"experimental":{"compute":true}}');
    return Effect.gen(function* () {
      expect(yield* resolve({ args: ["compute"], cwd: child, env: {} })).toBe(false);
      expect(yield* resolve({ args: ["compute", "--workdir", child], cwd: root, env: {} })).toBe(
        true,
      );
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.effect("fails closed for invalid values and malformed files", () => {
    const root = project({ "supabase/config.json": '{"experimental":{"compute":"yes"}}' });
    const malformed = project({ "supabase/config.toml": "[experimental\ncompute = true" });
    return Effect.gen(function* () {
      expect(yield* resolve({ args: ["compute"], cwd: root, env: {} })).toBe(false);
      expect(yield* resolve({ args: ["compute"], cwd: malformed, env: {} })).toBe(false);
      expect(
        yield* resolve({
          args: ["compute"],
          cwd: "/missing",
          env: { SUPABASE_EXPERIMENTAL_COMPUTE: "invalid" },
        }),
      ).toBe(false);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(root, { recursive: true, force: true });
          rmSync(malformed, { recursive: true, force: true });
        }),
      ),
    );
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
