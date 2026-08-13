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
import { legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { legacyPromptYesNo } from "../../../../shared/legacy/legacy-prompt-yes-no.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../../shared/output/errors.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { legacyAqua } from "../../../shared/legacy-colors.ts";
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
  // `--yes` OR `SUPABASE_YES` — the env var must auto-confirm too, not just
  // the flag.
  const yes = yield* legacyResolveYes;
  const tty = yield* Tty;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Captured for the cache write in `Effect.ensuring` below — whatever
  // `flags.ProjectRef` resolved to, which delete sets from the arg/prompt
  // before deleting.
  let resolvedRef: string | undefined;

  yield* Effect.gen(function* () {
    // Ref resolution: explicit arg, else prompt on a TTY, else fail. Delete
    // never reads the linked ref file as a source.
    let ref: string;
    if (Option.isSome(flags.ref) && flags.ref.value.length > 0) {
      ref = flags.ref.value;
    } else if (tty.stdinIsTty && output.interactive) {
      ref = yield* resolver.promptProjectRef("Which project do you want to delete?");
    } else {
      return yield* new LegacyProjectsDeleteRefRequiredError({
        message: "accepts 1 arg(s), received 0",
      });
    }
    resolvedRef = ref;

    // Validate the ref, then confirm.
    if (!PROJECT_REF_PATTERN.test(ref)) {
      return yield* new LegacyInvalidProjectRefError({ ref, message: INVALID_PROJECT_REF_MESSAGE });
    }

    // `legacyAqua` mirrors lipgloss's profile detection (plain when stderr
    // is not a TTY).
    const title = `Do you want to delete project ${legacyAqua(ref)}? This action is irreversible.`;
    // Established prompt behavior: `--yes`/`SUPABASE_YES` auto-confirms with
    // the `<title> [y/N] y` stderr echo; a non-TTY stdin still prints the
    // label and scans one piped line (100ms), so
    // `echo y | supabase projects delete <ref>` confirms; empty/unparseable
    // input falls back to the No default.
    const confirmed = yield* legacyPromptYesNo(output, yes, title, false);
    if (!confirmed) {
      return yield* new LegacyProjectsDeleteCancelledError({ message: CONTEXT_CANCELED_MESSAGE });
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

    // The per-ref keyring credential delete is skipped entirely: the access
    // token is only ever *stored* under the profile name, never a ref, so
    // that delete would always target a non-existent entry — a functional
    // no-op. The only thing it could emit is a keyring-backend *availability*
    // error ("Keyring is not supported on WSL", e.g. on a headless CI runner
    // with no D-Bus session), which the TS `@napi-rs/keyring` kernel keyutils
    // backend never hits anyway.

    // Best-effort unlink: when the linked ref file matches the deleted ref,
    // remove the `supabase/.temp` directory.
    const tempDir = path.join(cliConfig.workdir, "supabase", ".temp");
    const refPath = path.join(tempDir, "project-ref");
    // The link file written by `supabase link` holds exactly the ref.
    // Compare against the trimmed content so a corrupt/multi-ref file can't
    // trigger an unintended `.temp` removal.
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
