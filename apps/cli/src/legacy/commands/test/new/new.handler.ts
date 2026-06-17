import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
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
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const template = Option.getOrElse(flags.template, () => "pgtap" as const);

  yield* Effect.gen(function* () {
    // Go builds the path relative to the project root (`utils.DbTestsDir` =
    // "supabase/tests") and prints that relative path; FS ops are rooted at the
    // resolved workdir (`apps/cli-go/internal/test/new/new.go:24`).
    const relPath = path.join("supabase", "tests", `${flags.name}_test.sql`);
    const target = path.join(cliConfig.workdir, relPath);

    const exists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return yield* Effect.fail(
        new LegacyTestNewFileExistsError({ path: relPath, message: `${relPath} already exists.` }),
      );
    }

    yield* fs
      .makeDirectory(path.dirname(target), { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new LegacyTestNewWriteError({ path: relPath, message: String(cause) }),
        ),
      );
    yield* fs
      .writeFileString(target, TEMPLATE_CONTENT[template])
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
