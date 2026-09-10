import type { V1DeleteAProjectOutput } from "@supabase/api/effect";
import { Effect, FileSystem, Option, Path } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { InvalidProjectRefError } from "../../../config/project-ref.errors.ts";
import {
  INVALID_PROJECT_REF_MESSAGE,
  ProjectRefResolver,
  PROJECT_REF_PATTERN,
} from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { resolveYes } from "../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../command-internal/prompt-yes-no.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../shared/output/errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { aqua } from "../../../command-internal/colors.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import {
  ProjectsDeleteCancelledError,
  ProjectsDeleteNetworkError,
  ProjectsDeleteNotFoundError,
  ProjectsDeleteRefRequiredError,
  ProjectsDeleteUnexpectedStatusError,
} from "../projects.errors.ts";
import type { ProjectsDeleteFlags } from "./delete.command.ts";

type DeletedProject = typeof V1DeleteAProjectOutput.Type;

export const projectsDelete = Effect.fn("projects.delete")(function* (flags: ProjectsDeleteFlags) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const cliSettings = yield* CommandSettings;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  // `resolveYes` also honors `SUPABASE_YES`, not just the `--yes` flag.
  const yes = yield* resolveYes;
  const tty = yield* Tty;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Captured so the `Effect.ensuring` cache write below can use whichever ref resolved from
  // the arg or prompt.
  let resolvedRef: string | undefined;

  yield* Effect.gen(function* () {
    // Unlike other commands, delete does not fall back to the linked ref file — only the arg
    // or an interactive prompt resolve the ref.
    let ref: string;
    if (Option.isSome(flags.ref) && flags.ref.value.length > 0) {
      ref = flags.ref.value;
    } else if (tty.stdinIsTty && output.interactive) {
      ref = yield* resolver.promptProjectRef("Which project do you want to delete?");
    } else {
      return yield* new ProjectsDeleteRefRequiredError({
        message: "accepts 1 arg(s), received 0",
      });
    }
    resolvedRef = ref;

    if (!PROJECT_REF_PATTERN.test(ref)) {
      return yield* new InvalidProjectRefError({ ref, message: INVALID_PROJECT_REF_MESSAGE });
    }

    const title = `Do you want to delete project ${aqua(ref)}? This action is irreversible.`;
    // `promptYesNo` echoes `<title> [y/N] <answer>` to stderr even on a non-TTY: it scans one
    // piped line (100ms timeout) so `echo y | supabase projects delete <ref>` confirms;
    // unparseable input falls back to No.
    const confirmed = yield* promptYesNo(output, yes, title, false);
    if (!confirmed) {
      return yield* new ProjectsDeleteCancelledError({ message: CONTEXT_CANCELED_MESSAGE });
    }

    const mapDeleteError = mapHttpError({
      networkError: ProjectsDeleteNetworkError,
      statusError: ProjectsDeleteUnexpectedStatusError,
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
            return yield* new ProjectsDeleteNotFoundError({
              message: `Project does not exist:${ref}`,
            });
          }
          return yield* mapDeleteError(cause);
        }),
      ),
    );
    yield* deleting?.clear() ?? Effect.void;

    // No per-ref keyring credential delete: the access token is stored under the profile
    // name, not the ref, so there is nothing to remove here.

    // Best-effort: removes `supabase/.temp` only when the linked ref matches the deleted
    // project.
    const tempDir = path.join(cliSettings.workdir, "supabase", ".temp");
    const refPath = path.join(tempDir, "project-ref");
    // Compare trimmed content so a corrupt/multi-ref file can't trigger an unintended removal.
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
