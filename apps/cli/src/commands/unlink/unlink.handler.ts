import { Effect, Option, Predicate, Result } from "effect";

import { CommandCredentials } from "../../auth/command-credentials.service.ts";
import { CredentialDeleteError } from "../../auth/errors.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { ProjectRefNotLinkedError } from "../../config/project-ref.errors.ts";
import { PROJECT_NOT_LINKED_MESSAGE } from "../../config/remote-target.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { LegacyProjectState } from "../../command-internal/legacy-project-state.service.ts";
import { currentProjectStateMode } from "../../command-internal/project-state-mode.ts";
import { readProjectLink, removeProjectLink } from "../../command-internal/project-link.ts";
import { UnlinkRefReadError, UnlinkTempRemovalError } from "./unlink.errors.ts";

const readLegacyLinkRef = Effect.fn("unlink.readLegacyRef")(function* (
  legacyState: LegacyProjectState["Service"],
  workdir: string,
) {
  const exists = yield* legacyState
    .exists(workdir, "projectRef")
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return yield* new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE });
  }
  // No trimming needed: `link` writes the ref with no trailing newline, so the raw
  // bytes round-trip exactly for both the stderr message and the keyring key.
  return yield* legacyState.read(workdir, "projectRef").pipe(
    Effect.mapError(
      (cause) =>
        new UnlinkRefReadError({
          message: `failed to load project ref: ${String(cause)}`,
        }),
    ),
  );
});

/** The linked ref, or `undefined` when the link document is malformed and only its removal is possible. */
const readStackLinkRef = Effect.fn("unlink.readStackRef")(function* (workdir: string) {
  const link = yield* readProjectLink(workdir).pipe(
    Effect.catchTags({
      ProjectLinkIoError: (cause) =>
        Effect.fail(
          new UnlinkRefReadError({
            message: `failed to load project ref: ${cause.message}`,
          }),
        ),
      ProjectLinkMalformedError: () => Effect.undefined,
    }),
  );
  if (link === undefined) return undefined;
  if (Option.isNone(link)) {
    return yield* new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE });
  }
  return link.value.active_branch.ref;
});

export const unlink = Effect.fn("unlink")(function* () {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const credentials = yield* CommandCredentials;
  const telemetryState = yield* TelemetryState;
  const legacyState = yield* LegacyProjectState;
  const workdir = cliSettings.workdir;
  const stackState = (yield* currentProjectStateMode) === "stack";

  yield* Effect.gen(function* () {
    // 1. Load the linked project ref. An absent file means not-linked; any other
    // read failure surfaces verbatim.
    const projectRef = stackState
      ? yield* readStackLinkRef(workdir)
      : yield* readLegacyLinkRef(legacyState, workdir);

    yield* output.raw(
      projectRef === undefined
        ? "Unlinking project: unreadable link document, its credential is left in place\n"
        : `Unlinking project: ${projectRef}\n`,
      "stderr",
    );

    // 2. Best-effort: both the temp-dir removal and the credential delete are
    // attempted regardless of either failing; their errors are joined below.
    const collected: Array<UnlinkTempRemovalError | CredentialDeleteError> = [];

    const removed = yield* (
      stackState
        ? removeProjectLink(workdir).pipe(
            Effect.mapError(
              (cause) =>
                new UnlinkTempRemovalError({
                  message: `failed to remove project link: ${cause.message}`,
                }),
            ),
          )
        : legacyState.removeAll(workdir).pipe(
            Effect.mapError(
              (cause) =>
                new UnlinkTempRemovalError({
                  message: `failed to remove temp directory: ${String(cause)}`,
                }),
            ),
          )
    ).pipe(Effect.result);
    if (Result.isFailure(removed)) collected.push(removed.failure);

    if (projectRef !== undefined) {
      const deleted = yield* credentials.deleteProjectCredential(projectRef).pipe(Effect.result);
      if (Result.isFailure(deleted)) collected.push(deleted.failure);
    }

    const [first, ...rest] = collected;
    if (first !== undefined) {
      // Surfaces every collected message, not just the first, while keeping the
      // leading failure's tag (temp removal is attempted before the credential delete).
      if (rest.length === 0) {
        return yield* first;
      }
      const message = collected.map((e) => e.message).join("\n");
      const failure = Predicate.isTagged(first, "UnlinkTempRemovalError")
        ? new UnlinkTempRemovalError({ message })
        : new CredentialDeleteError({ message });
      return yield* failure;
    }

    // 3. Print "Finished supabase unlink." in text mode, or a structured success otherwise.
    if (output.format === "text") {
      yield* output.raw("Finished supabase unlink.\n");
    } else {
      yield* output.success("", { project_ref: projectRef ?? null });
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
