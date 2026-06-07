import { Effect, FileSystem, Path, Result } from "effect";

import { LegacyCredentials } from "../../auth/legacy-credentials.service.ts";
import { LegacyCredentialDeleteError } from "../../auth/legacy-errors.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyProjectNotLinkedError } from "../../config/legacy-project-ref.errors.ts";
import { PROJECT_NOT_LINKED_MESSAGE } from "../../config/legacy-project-ref.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { legacyTempPaths } from "../../shared/legacy-temp-paths.ts";
import { LegacyUnlinkRefReadError, LegacyUnlinkTempRemovalError } from "./unlink.errors.ts";

export const legacyUnlink = Effect.fn("legacy.unlink")(function* () {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const credentials = yield* LegacyCredentials;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const paths = legacyTempPaths(path, cliConfig.workdir);

  yield* Effect.gen(function* () {
    // 1. Load the linked project ref. An absent file is `ErrNotLinked`; any other
    // read failure surfaces verbatim (unlink.go:16-19).
    const exists = yield* fs.exists(paths.projectRef).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return yield* Effect.fail(
        new LegacyProjectNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }),
      );
    }
    // Go reads the raw bytes without trimming — `link` writes the ref with no
    // trailing newline, so the value round-trips exactly (used for both the
    // stderr message and the keyring key).
    const projectRef = yield* fs.readFileString(paths.projectRef).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyUnlinkRefReadError({
            message: `failed to load project ref: ${String(cause)}`,
          }),
      ),
    );

    yield* output.raw(`Unlinking project: ${projectRef}\n`, "stderr");

    // 2. Best-effort: remove the temp dir and delete the stored db-password
    // credential. Both are attempted; non-ignored errors are joined (unlink.go:29-41).
    const collected: Array<LegacyUnlinkTempRemovalError | LegacyCredentialDeleteError> = [];

    const removed = yield* fs.remove(paths.tempDir, { recursive: true, force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyUnlinkTempRemovalError({
            message: `failed to remove temp directory: ${String(cause)}`,
          }),
      ),
      Effect.result,
    );
    if (Result.isFailure(removed)) collected.push(removed.failure);

    const deleted = yield* credentials.deleteProjectCredential(projectRef).pipe(Effect.result);
    if (Result.isFailure(deleted)) collected.push(deleted.failure);

    const [first, ...rest] = collected;
    if (first !== undefined) {
      // Mirror Go's `errors.Join(allErrors...)` (unlink.go:41): surface every
      // collected message, not just the first. Keep the leading failure's tag
      // (temp removal precedes the credential delete, matching Go's order).
      if (rest.length === 0) {
        return yield* Effect.fail(first);
      }
      const message = collected.map((e) => e.message).join("\n");
      return yield* Effect.fail(
        first._tag === "LegacyUnlinkTempRemovalError"
          ? new LegacyUnlinkTempRemovalError({ message })
          : new LegacyCredentialDeleteError({ message }),
      );
    }

    // 3. PostRun: `Finished supabase unlink.` to stdout (text), structured success
    // otherwise.
    if (output.format === "text") {
      yield* output.raw("Finished supabase unlink.\n");
    } else {
      yield* output.success("", { project_ref: projectRef });
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
