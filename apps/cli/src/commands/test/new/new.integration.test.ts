import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { badArgument } from "effect/PlatformError";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { classifyCliCauseActionability } from "../../../shared/telemetry/error-actionability.ts";
import { TestNewInvalidNameError } from "./new.errors.ts";
import { PGTAP_TEMPLATE } from "./new.template.ts";
import { testNew } from "./new.handler.ts";

const tempRoot = useTempWorkdir("supabase-test-new-int-");

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
  const telemetry = mockTelemetryStateTracked();
  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    projectId: Option.none(),
  });
  const layer = Layer.mergeAll(
    out.layer,
    cliSettings,
    telemetry.layer,
    // The failing layer is appended last so it overrides BunServices' FileSystem
    // (duplicate-tag mergeAll is last-wins); Path still comes from BunServices.
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

describe("test new integration", () => {
  it.live("creates a pgtap test file and prints the created path", () => {
    const { layer, out, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* testNew(flags("pet"));
      const target = path.join(workdir, "supabase", "tests", "pet_test.sql");
      expect(yield* fs.exists(target)).toBe(true);
      expect(yield* fs.readFileString(target)).toBe(PGTAP_TEMPLATE);
      expect(out.stdoutText).toContain("Created new pgtap test at ");
      expect(out.stdoutText).toContain("supabase/tests/pet_test.sql");
    }).pipe(Effect.provide(layer));
  });

  it.live("pins the created test file to Go's exact 0644 mode under a permissive umask", () => {
    const { layer, workdir } = setup();
    return Effect.acquireUseRelease(
      Effect.sync(() => process.umask(0)),
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* testNew(flags("modepin"));
          const target = path.join(workdir, "supabase", "tests", "modepin_test.sql");
          const info = yield* fs.stat(target);
          expect(info.mode & 0o777).toBe(0o644);
        }).pipe(Effect.provide(layer)),
      (prevUmask) =>
        Effect.sync(() => {
          process.umask(prevUmask);
        }),
    );
  });

  it.live("defaults the template to pgtap when --template is omitted", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* testNew(flags("nodbtemplate"));
      const target = path.join(workdir, "supabase", "tests", "nodbtemplate_test.sql");
      expect(yield* fs.readFileString(target)).toBe(PGTAP_TEMPLATE);
    }).pipe(Effect.provide(layer));
  });

  it.live("honors an explicit --template pgtap", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* testNew(flags("explicit", "pgtap"));
      expect(yield* fs.exists(path.join(workdir, "supabase", "tests", "explicit_test.sql"))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured success in json mode (no human text)", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* testNew(flags("petjson"));
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
      yield* testNew(flags("petstream"));
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ path: "supabase/tests/petstream_test.sql" });
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with TestNewFileExistsError when the file already exists", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workdir, "supabase", "tests"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir, "supabase", "tests", "dupe_test.sql"),
        "-- existing\n",
      );
      const exit = yield* Effect.exit(testNew(flags("dupe")));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("TestNewFileExistsError");
        expect(causeText).toContain("supabase/tests/dupe_test.sql already exists.");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with TestNewWriteError when the write fails", () => {
    const { layer } = setup({ writeFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testNew(flags("nowrite")));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("TestNewWriteError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with TestNewWriteError when the tests dir cannot be created", () => {
    const { layer } = setup({ mkdirFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(testNew(flags("nomkdir")));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("TestNewWriteError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("creates test files under subdirectories that stay inside the tests directory", () => {
    const { layer, out, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* testNew(flags("sub/foo"));
      yield* testNew(flags("sub/../foo"));
      expect(yield* fs.exists(path.join(workdir, "supabase", "tests", "sub", "foo_test.sql"))).toBe(
        true,
      );
      expect(yield* fs.exists(path.join(workdir, "supabase", "tests", "foo_test.sql"))).toBe(true);
      expect(out.stdoutText).toContain("supabase/tests/sub/foo_test.sql");
      expect(out.stdoutText).toContain("supabase/tests/foo_test.sql");
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a name that escapes the tests directory and writes nothing", () => {
    const { layer, telemetry, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Escapes into a fresh directory inside this test's own temp root, so a guard
      // that ran after makeDirectory would leave `nested/` behind.
      const exit = yield* Effect.exit(testNew(flags("../../nested/x")));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(TestNewInvalidNameError);
          expect(failure.value.message).toContain("must not escape the supabase/tests directory");
        }
        expect(classifyCliCauseActionability(exit.cause)).toMatchObject({
          error_category: "invalid_input",
          suggestion_type: "provide_flags",
        });
      }
      expect(yield* fs.exists(path.join(workdir, "nested"))).toBe(false);
      expect(yield* fs.exists(path.join(workdir, "supabase", "tests"))).toBe(false);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("follows an existing symlink to a shared test directory", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const testsDir = path.join(workdir, "supabase", "tests");
      const sharedDir = path.join(workdir, "shared-tests");
      yield* fs.makeDirectory(testsDir, { recursive: true });
      yield* fs.makeDirectory(sharedDir);
      yield* fs.symlink(sharedDir, path.join(testsDir, "shared"));

      yield* testNew(flags("shared/pet"));

      expect(yield* fs.readFileString(path.join(sharedDir, "pet_test.sql"))).toBe(PGTAP_TEMPLATE);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a name that escapes into a sibling directory sharing the tests prefix", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const exit = yield* Effect.exit(testNew(flags("../tests2/x")));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* fs.exists(path.join(workdir, "supabase", "tests2"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("sanitizes control characters in an invalid-name diagnostic", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const error = yield* testNew(flags("../../\u001b[2Jbad\r\n\t\u009bname")).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TestNewInvalidNameError);
      expect(error.message).toContain('invalid test name: "../../[2Jbad name"');
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry via ensuring", () => {
    const { layer, telemetry } = setup();
    return Effect.gen(function* () {
      yield* testNew(flags("petflush"));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
