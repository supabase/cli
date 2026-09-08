import { Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { bold } from "../../../command-internal/colors.ts";
import type { TestNewFlags } from "./new.command.ts";
import { TestNewFileExistsError, TestNewWriteError } from "./new.errors.ts";
import { PGTAP_TEMPLATE } from "./new.template.ts";

const TEMPLATE_CONTENT: Record<"pgtap", string> = {
  pgtap: PGTAP_TEMPLATE,
};

export const testNew = Effect.fn("test.new")(function* (flags: TestNewFlags) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const template = Option.getOrElse(flags.template, () => "pgtap" as const);

  yield* Effect.gen(function* () {
    // Path is relative to the project root (`utils.DbTestsDir` =
    // "supabase/tests") and that relative path is what gets printed; FS ops
    // are rooted at the resolved workdir.
    const relPath = path.join("supabase", "tests", `${flags.name}_test.sql`);
    const target = path.join(cliSettings.workdir, relPath);

    const exists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return yield* Effect.fail(
        new TestNewFileExistsError({ path: relPath, message: `${relPath} already exists.` }),
      );
    }

    // `utils.WriteFile` pins the dir to 0755 and the test file to 0644
    // (`internal/utils/misc.go:281,284`).
    yield* fs
      .makeDirectory(path.dirname(target), { recursive: true, mode: 0o755 })
      .pipe(
        Effect.mapError(
          (cause) => new TestNewWriteError({ path: relPath, message: String(cause) }),
        ),
      );
    yield* fs
      .writeFileString(target, TEMPLATE_CONTENT[template], { mode: 0o644 })
      .pipe(
        Effect.mapError(
          (cause) => new TestNewWriteError({ path: relPath, message: String(cause) }),
        ),
      );

    if (output.format === "text") {
      yield* output.raw(`Created new ${template} test at ${bold(relPath)}.\n`);
    } else {
      yield* output.success("", { path: relPath, template });
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
