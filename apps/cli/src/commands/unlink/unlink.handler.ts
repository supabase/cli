import { Effect, FileSystem, Path, Result } from "effect";

import { CommandCredentials } from "../../auth/command-credentials.service.ts";
import { CredentialDeleteError } from "../../auth/errors.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { ProjectRefNotLinkedError } from "../../config/project-ref.errors.ts";
import { PROJECT_NOT_LINKED_MESSAGE } from "../../config/project-ref.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { tempPaths } from "../../command-internal/temp-paths.ts";
import { UnlinkRefReadError, UnlinkTempRemovalError } from "./unlink.errors.ts";

export const unlink = Effect.fn("unlink")(function* () {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const credentials = yield* CommandCredentials;
  const telemetryState = yield* TelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const paths = tempPaths(path, cliSettings.workdir);

  yield* Effect.gen(function* () {
    // 1. Load the linked project ref. An absent file means not-linked; any other
    // read failure surfaces verbatim.
    const exists = yield* fs.exists(paths.projectRef).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return yield* Effect.fail(
        new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }),
      );
    }
    // No trimming needed: `link` writes the ref with no trailing newline, so the raw
    // bytes round-trip exactly for both the stderr message and the keyring key.
    const projectRef = yield* fs.readFileString(paths.projectRef).pipe(
      Effect.mapError(
        (cause) =>
          new UnlinkRefReadError({
            message: `failed to load project ref: ${String(cause)}`,
          }),
      ),
    );

    yield* output.raw(`Unlinking project: ${projectRef}\n`, "stderr");

    // 2. Best-effort: both the temp-dir removal and the credential delete are
    // attempted regardless of either failing; their errors are joined below.
    const collected: Array<UnlinkTempRemovalError | CredentialDeleteError> = [];

    const removed = yield* fs.remove(paths.tempDir, { recursive: true, force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new UnlinkTempRemovalError({
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
      // Surfaces every collected message, not just the first, while keeping the
      // leading failure's tag (temp removal is attempted before the credential delete).
      if (rest.length === 0) {
        return yield* Effect.fail(first);
      }
      const message = collected.map((e) => e.message).join("\n");
      return yield* Effect.fail(
        first._tag === "UnlinkTempRemovalError"
          ? new UnlinkTempRemovalError({ message })
          : new CredentialDeleteError({ message }),
      );
    }

    // 3. Print "Finished supabase unlink." in text mode, or a structured success otherwise.
    if (output.format === "text") {
      yield* output.raw("Finished supabase unlink.\n");
    } else {
      yield* output.success("", { project_ref: projectRef });
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
