import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyBold } from "../../../shared/legacy-colors.ts";
import type { LegacyTestNewFlags } from "./new.command.ts";
import { LegacyTestNewFileExistsError, LegacyTestNewWriteError } from "./new.errors.ts";
import { LEGACY_PGTAP_TEMPLATE } from "./new.template.ts";

const TEMPLATE_CONTENT: Record<"pgtap", string> = {
  pgtap: LEGACY_PGTAP_TEMPLATE,
};

export const legacyTestNew = Effect.fn("legacy.test.new")(function* (flags: LegacyTestNewFlags) {
  const output = yield* Output;
  const cliSettings = yield* LegacyCliSettings;
  const telemetryState = yield* LegacyTelemetryState;
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
        new LegacyTestNewFileExistsError({ path: relPath, message: `${relPath} already exists.` }),
      );
    }

    // `utils.WriteFile` pins the dir to 0755 and the test file to 0644
    // (`internal/utils/misc.go:281,284`).
    yield* fs
      .makeDirectory(path.dirname(target), { recursive: true, mode: 0o755 })
      .pipe(
        Effect.mapError(
          (cause) => new LegacyTestNewWriteError({ path: relPath, message: String(cause) }),
        ),
      );
    yield* fs
      .writeFileString(target, TEMPLATE_CONTENT[template], { mode: 0o644 })
      .pipe(
        Effect.mapError(
          (cause) => new LegacyTestNewWriteError({ path: relPath, message: String(cause) }),
        ),
      );

    if (output.format === "text") {
      yield* output.raw(`Created new ${template} test at ${legacyBold(relPath)}.\n`);
    } else {
      yield* output.success("", { path: relPath, template });
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
