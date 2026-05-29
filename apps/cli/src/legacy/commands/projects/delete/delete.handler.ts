import type { V1DeleteAProjectOutput } from "@supabase/api/effect";
import { Effect, FileSystem, Option, Path } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyInvalidProjectRefError } from "../../../config/legacy-project-ref.errors.ts";
import {
  INVALID_PROJECT_REF_MESSAGE,
  LegacyProjectRefResolver,
  PROJECT_REF_PATTERN,
} from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyProjectsDeleteCancelledError,
  LegacyProjectsDeleteNetworkError,
  LegacyProjectsDeleteNotFoundError,
  LegacyProjectsDeleteRefRequiredError,
  LegacyProjectsDeleteUnexpectedStatusError,
} from "../projects.errors.ts";
import type { LegacyProjectsDeleteFlags } from "./delete.command.ts";

type DeletedProject = typeof V1DeleteAProjectOutput.Type;

export const legacyProjectsDelete = Effect.fn("legacy.projects.delete")(function* (
  flags: LegacyProjectsDeleteFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const cliConfig = yield* LegacyCliConfig;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const yes = yield* LegacyYesFlag;
  const tty = yield* Tty;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Captured for the PersistentPostRun-parity cache write — Go's
  // `ensureProjectGroupsCached` caches whatever `flags.ProjectRef` resolved to
  // (`root.go:213-217`), which delete sets from the arg/prompt before deleting.
  let resolvedRef: string | undefined;

  yield* Effect.gen(function* () {
    // Ref resolution (Go `projects.go:117-122`): explicit arg, else prompt on a
    // TTY, else fail. Delete never reads the linked ref file as a source.
    let ref: string;
    if (Option.isSome(flags.ref) && flags.ref.value.length > 0) {
      ref = flags.ref.value;
    } else if (tty.stdinIsTty && output.interactive) {
      // Go passes this exact title (`projects.go:118`).
      ref = yield* resolver.promptProjectRef("Which project do you want to delete?");
    } else {
      return yield* new LegacyProjectsDeleteRefRequiredError({
        message: "accepts 1 arg(s), received 0",
      });
    }
    resolvedRef = ref;

    // delete.PreRun (`delete.go:17-28`): validate the ref, then confirm.
    if (!PROJECT_REF_PATTERN.test(ref)) {
      return yield* new LegacyInvalidProjectRefError({ ref, message: INVALID_PROJECT_REF_MESSAGE });
    }

    const title = `Do you want to delete project ${ref}? This action is irreversible.`;
    let confirmed: boolean;
    if (yes) {
      // Mirror Go's `PromptYesNo` confirm-by-flag UX (`console.go:64-78`): the
      // default is No, so the choices render `[y/N]` and the auto-answer is `y`.
      yield* output.raw(`${title} [y/N] y\n`, "stderr");
      confirmed = true;
    } else if (!tty.stdinIsTty) {
      // Non-TTY with no `--yes`: `PromptYesNo` returns the `false` default.
      confirmed = false;
    } else {
      confirmed = yield* output.promptConfirm(title).pipe(Effect.orElseSucceed(() => false));
    }
    if (!confirmed) {
      return yield* new LegacyProjectsDeleteCancelledError({ message: "context canceled" });
    }

    const mapDeleteError = mapLegacyHttpError({
      networkError: LegacyProjectsDeleteNetworkError,
      statusError: LegacyProjectsDeleteUnexpectedStatusError,
      networkMessage: (cause) => `failed to delete project: ${cause}`,
      statusMessage: (_status, body) => `Failed to delete project ${ref}: ${body}`,
    });

    const deleting =
      output.format === "text" ? yield* output.task("Deleting project...") : undefined;
    const deleted: DeletedProject = yield* api.v1.deleteAProject({ ref }).pipe(
      Effect.tapError(() => deleting?.fail() ?? Effect.void),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          if (
            HttpClientError.isHttpClientError(cause) &&
            cause.response !== undefined &&
            cause.response.status === 404
          ) {
            return yield* new LegacyProjectsDeleteNotFoundError({
              message: `Project does not exist:${ref}`,
            });
          }
          return yield* mapDeleteError(cause);
        }),
      ),
    );
    yield* deleting?.clear() ?? Effect.void;

    // Go best-effort deletes the per-ref keyring credential (`delete.go:46-48`),
    // but Go only ever *stores* the profile-scoped access token in the keyring
    // (`StoreProvider.Set` is only called with `CurrentProfile.Name`, never a
    // ref). So that delete always targets a non-existent entry — a functional
    // no-op for both CLIs. The only thing it can emit is Go's keyring-backend
    // *availability* error ("Keyring is not supported on WSL", e.g. on a
    // headless CI runner with no D-Bus session); that is environment noise the
    // cli-e2e parity harness normalizes away (the TS `@napi-rs/keyring` kernel
    // keyutils backend never hits it). We therefore skip the no-op entirely.

    // Best-effort unlink (`delete.go:49-56`): when the linked ref file matches
    // the deleted ref, remove the `supabase/.temp` directory.
    const tempDir = path.join(cliConfig.workdir, "supabase", ".temp");
    const refPath = path.join(tempDir, "project-ref");
    // Go uses `afero.FileContainsBytes` (substring), but the link file written by
    // `supabase link` holds exactly the ref. Compare against the trimmed content
    // so a corrupt/multi-ref file can't trigger an unintended `.temp` removal.
    const matches = yield* fs
      .readFileString(refPath)
      .pipe(Effect.map((content) => content.trim() === ref))
      .pipe(Effect.orElseSucceed(() => false));
    if (matches) {
      yield* fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore);
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("Deleted project", { name: deleted.name });
      return;
    }
    yield* output.raw(`Deleted project: ${deleted.name}\n`);
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        resolvedRef === undefined ? Effect.void : linkedProjectCache.cache(resolvedRef),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
