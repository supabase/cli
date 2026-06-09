import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option } from "effect";
import { badArgument } from "effect/PlatformError";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { LEGACY_PGTAP_TEMPLATE } from "./new.template.ts";
import { legacyTestNew } from "./new.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-test-new-int-");

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  writeFails?: boolean;
  mkdirFails?: boolean;
}

// Wraps the real Bun FileSystem but forces a chosen op to fail, so the
// write-error branches are exercised deterministically regardless of permissions.
function failingFsLayer(op: "writeFileString" | "makeDirectory") {
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      return FileSystem.FileSystem.of({
        ...real,
        [op]: () =>
          Effect.fail(
            badArgument({
              module: "FileSystem",
              method: op,
              description: "operation not permitted",
            }),
          ),
      });
    }),
  ).pipe(Layer.provide(BunServices.layer));
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current, projectId: Option.none() });
  const layer = Layer.mergeAll(
    out.layer,
    cliConfig,
    telemetry.layer,
    // BunServices provides FileSystem + Path; when forcing a failure the failing
    // layer is appended last so it overrides FileSystem (Path still comes from
    // BunServices — duplicate-tag mergeAll is last-wins).
    BunServices.layer,
    ...(opts.writeFails === true ? [failingFsLayer("writeFileString")] : []),
    ...(opts.mkdirFails === true ? [failingFsLayer("makeDirectory")] : []),
  );
  return { layer, out, telemetry, workdir: tempRoot.current };
}

const flags = (name: string, template?: "pgtap") => ({
  name,
  template: template === undefined ? Option.none<"pgtap">() : Option.some(template),
});

describe("legacy test new integration", () => {
  it.live("creates a pgtap test file and prints the created path", () => {
    const { layer, out, workdir } = setup();
    return Effect.gen(function* () {
      yield* legacyTestNew(flags("pet"));
      const target = join(workdir, "supabase", "tests", "pet_test.sql");
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf8")).toBe(LEGACY_PGTAP_TEMPLATE);
      expect(out.stdoutText).toContain("Created new pgtap test at ");
      expect(out.stdoutText).toContain("supabase/tests/pet_test.sql");
    }).pipe(Effect.provide(layer));
  });

  it.live("defaults the template to pgtap when --template is omitted", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      yield* legacyTestNew(flags("nodbtemplate"));
      const target = join(workdir, "supabase", "tests", "nodbtemplate_test.sql");
      expect(readFileSync(target, "utf8")).toBe(LEGACY_PGTAP_TEMPLATE);
    }).pipe(Effect.provide(layer));
  });

  it.live("honors an explicit --template pgtap", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      yield* legacyTestNew(flags("explicit", "pgtap"));
      expect(existsSync(join(workdir, "supabase", "tests", "explicit_test.sql"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured success in json mode (no human text)", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyTestNew(flags("petjson"));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({
        path: "supabase/tests/petjson_test.sql",
        template: "pgtap",
      });
      expect(out.stdoutText).not.toContain("Created new pgtap test at");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured success in stream-json mode", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyTestNew(flags("petstream"));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ path: "supabase/tests/petstream_test.sql" });
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyTestNewFileExistsError when the file already exists", () => {
    const { layer, workdir } = setup();
    mkdirSync(join(workdir, "supabase", "tests"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "tests", "dupe_test.sql"), "-- existing\n");
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyTestNew(flags("dupe")));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyTestNewFileExistsError");
        expect(json).toContain("supabase/tests/dupe_test.sql already exists.");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyTestNewWriteError when the write fails", () => {
    const { layer } = setup({ writeFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyTestNew(flags("nowrite")));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyTestNewWriteError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyTestNewWriteError when the tests dir cannot be created", () => {
    const { layer } = setup({ mkdirFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyTestNew(flags("nomkdir")));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyTestNewWriteError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry via ensuring", () => {
    const { layer, telemetry } = setup();
    return Effect.gen(function* () {
      yield* legacyTestNew(flags("petflush"));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
