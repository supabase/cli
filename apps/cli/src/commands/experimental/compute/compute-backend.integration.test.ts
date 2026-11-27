import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Console, Effect, FileSystem, Path } from "effect";
import { respondToComplete } from "../../../cli/complete.ts";
import { rootCommandForFeatures } from "../../../cli/root.ts";
import { resolveComputeEnabled } from "./compute-backend.ts";
import { withConfigEnv } from "../../../../tests/helpers/command-mocks.ts";
import {
  ExperimentalFeatureFlagError,
  WarnedExperimentalDeprecations,
} from "../../../shared/config/experimental-feature.ts";
import { fakeConsole } from "../../../../tests/helpers/mocks.ts";

const resolve = ({
  env,
  ...input
}: Parameters<typeof resolveComputeEnabled>[0] & {
  readonly env: Readonly<Record<string, string>>;
}) => withConfigEnv(env, resolveComputeEnabled(input)).pipe(Effect.provide(BunServices.layer));

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

const resolveWithWarnings = (input: Parameters<typeof resolve>[0]) => {
  const { console, calls } = fakeConsole();
  return resolve(input).pipe(
    Effect.provideService(Console.Console, console),
    Effect.provideService(WarnedExperimentalDeprecations, new Set()),
    Effect.map((enabled) => ({ enabled, calls })),
  );
};

describe("deprecated compute switches", () => {
  it.effect("enables compute from the old env name and warns on stderr", () =>
    Effect.gen(function* () {
      const { enabled, calls } = yield* resolveWithWarnings({
        args: ["compute"],
        cwd: "/missing",
        env: { SUPABASE_EXPERIMENTAL_COMPUTE: "1" },
      });
      expect(enabled).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(
        /^error:.*SUPABASE_EXPERIMENTAL_COMPUTE.*SUPABASE_EXPERIMENTAL_COMPUTE_ENABLED/,
      );
    }),
  );

  it.effect("enables compute from the old config form and warns on stderr", () =>
    Effect.gen(function* () {
      const root = yield* project({ "supabase/config.toml": "[experimental]\ncompute = true\n" });
      const { enabled, calls } = yield* resolveWithWarnings({
        args: ["compute"],
        cwd: root,
        env: {},
      });
      expect(enabled).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^error:.*experimental\.compute = true.*\[experimental\.compute\]/);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("prefers the new env name over the old one without warning", () =>
    Effect.gen(function* () {
      const { enabled, calls } = yield* resolveWithWarnings({
        args: ["compute"],
        cwd: "/missing",
        env: { SUPABASE_EXPERIMENTAL_COMPUTE_ENABLED: "0", SUPABASE_EXPERIMENTAL_COMPUTE: "1" },
      });
      expect(enabled).toBe(false);
      expect(calls).toEqual([]);
    }),
  );
});

describe("resolveComputeEnabled", () => {
  it.effect("uses environment overrides without reading configuration", () =>
    Effect.gen(function* () {
      expect(
        yield* resolve({
          args: ["compute"],
          cwd: "/missing",
          env: { SUPABASE_EXPERIMENTAL_COMPUTE_ENABLED: "1" },
        }),
      ).toBe(true);
      expect(
        yield* resolve({
          args: ["compute"],
          cwd: "/missing",
          env: { SUPABASE_EXPERIMENTAL_COMPUTE_ENABLED: "0" },
        }),
      ).toBe(false);
    }),
  );

  it.effect("reads JSON and prefers it over TOML", () => {
    return Effect.gen(function* () {
      const root = yield* project({
        "supabase/config.toml": "[experimental.compute]\nenabled = false\n",
        "supabase/config.json": '{"experimental":{"compute":{"enabled":true}}}',
      });
      expect(yield* resolve({ args: ["compute"], cwd: root, env: {} })).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect("reads a true TOML setting and lets explicit env values override it", () =>
    Effect.gen(function* () {
      const root = yield* project({
        "supabase/config.toml": "[experimental.compute]\nenabled = true\n",
      });
      expect(yield* resolve({ args: ["compute"], cwd: root, env: {} })).toBe(true);
      expect(
        yield* resolve({
          args: ["compute"],
          cwd: root,
          env: { SUPABASE_EXPERIMENTAL_COMPUTE_ENABLED: "0" },
        }),
      ).toBe(false);
      expect(
        yield* resolve({
          args: ["compute"],
          cwd: root,
          env: { SUPABASE_EXPERIMENTAL_COMPUTE_ENABLED: "1" },
        }),
      ).toBe(true);
      const disabledConfig = yield* project({
        "supabase/config.toml": "[experimental.compute]\nenabled = false\n",
      });
      expect(yield* resolve({ args: ["compute"], cwd: disabledConfig, env: {} })).toBe(false);
      expect(
        yield* resolve({
          args: ["compute"],
          cwd: disabledConfig,
          env: { SUPABASE_EXPERIMENTAL_COMPUTE_ENABLED: "1" },
        }),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("ignores an invalid stack setting when reading compute", () =>
    Effect.gen(function* () {
      const root = yield* project({
        "supabase/config.toml":
          '[experimental]\nstack = "yes"\n\n[experimental.compute]\nenabled = true\n',
      });
      expect(yield* resolve({ args: ["compute"], cwd: root, env: {} })).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("finds a JSON-only ancestor and respects explicit workdirs", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* project({
        "supabase/config.json": '{"experimental":{"compute":{"enabled":true}}}',
      });
      const child = path.join(root, "nested");
      yield* fs.makeDirectory(child);
      const explicit = yield* project({
        "supabase/config.toml": "[experimental.compute]\nenabled = false\n",
      });
      expect(yield* resolve({ args: ["compute"], cwd: child, env: {} })).toBe(true);
      expect(
        yield* resolve({ args: ["compute", "--workdir", explicit], cwd: child, env: {} }),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect("prefers a nested project's config.json over an enclosing config.toml project", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* project({
        "supabase/config.toml": "[experimental.compute]\nenabled = false\n",
      });
      const child = path.join(root, "nested");
      yield* fs.makeDirectory(path.join(child, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(child, "supabase/config.json"),
        '{"experimental":{"compute":{"enabled":true}}}',
      );
      expect(yield* resolve({ args: ["compute"], cwd: child, env: {} })).toBe(true);
      expect(yield* resolve({ args: ["compute", "--workdir", child], cwd: root, env: {} })).toBe(
        true,
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect("fails closed for malformed files and types invalid env values", () => {
    return Effect.gen(function* () {
      const root = yield* project({ "supabase/config.json": '{"experimental":{"compute":"yes"}}' });
      const malformed = yield* project({ "supabase/config.toml": "[experimental\ncompute = true" });
      expect(yield* resolve({ args: ["compute"], cwd: root, env: {} })).toBe(false);
      expect(yield* resolve({ args: ["compute"], cwd: malformed, env: {} })).toBe(false);
      const error = yield* resolve({
        args: ["compute"],
        cwd: "/missing",
        env: { SUPABASE_EXPERIMENTAL_COMPUTE_ENABLED: "invalid" },
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ExperimentalFeatureFlagError);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect.each([
    ["functions", "list"],
    ["logs", "--remote", "--sql", "select 1"],
  ])("ignores compute configuration for unrelated commands %j", (args) =>
    Effect.gen(function* () {
      expect(
        yield* resolve({
          args,
          cwd: "/missing",
          env: { SUPABASE_EXPERIMENTAL_COMPUTE_ENABLED: "invalid" },
        }),
      ).toBe(false);
    }),
  );

  it.effect("returns false without a project or override", () =>
    Effect.gen(function* () {
      expect(yield* resolve({ args: ["compute"], cwd: "/missing", env: {} })).toBe(false);
    }),
  );

  it.effect("skips filesystem work for version requests", () =>
    Effect.gen(function* () {
      expect(yield* resolve({ args: ["--version"], cwd: "/missing", env: {} })).toBe(false);
    }),
  );

  it.effect.each([
    [],
    ["--help"],
    ["--output-format", "json", "--help"],
    ["__complete", "co"],
    ["__completeNoDesc", "co"],
  ])("exposes compute for root/help/completion args %j", (args) =>
    Effect.gen(function* () {
      const root = yield* project({
        "supabase/config.toml": "[experimental.compute]\nenabled = true\n",
      });
      const enabled = yield* resolve({ args, cwd: root, env: {} });
      const completion = respondToComplete(rootCommandForFeatures({ computeEnabled: enabled }), [
        "__complete",
        "co",
      ]);
      expect(enabled).toBe(true);
      expect(completion?.candidates).toContainEqual(expect.objectContaining({ name: "compute" }));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it("hides the compute command when disabled", () => {
    const disabled = respondToComplete(rootCommandForFeatures({ computeEnabled: false }), [
      "__complete",
      "compute",
      "",
    ]);
    expect(disabled?.candidates ?? []).toHaveLength(0);
  });
});
