import type { V1CreateABranchOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { detectGitBranch } from "../../../../shared/git/git-branch.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { legacySuggestUpgrade } from "../../../shared/legacy-upgrade-suggest.ts";
import {
  LegacyBranchesCreateCancelledError,
  LegacyBranchesCreateNetworkError,
  LegacyBranchesCreateUnexpectedStatusError,
} from "../branches.errors.ts";
import { renderBranchesListTable } from "../branches.format.ts";
import type { LegacyBranchesCreateFlags } from "./create.command.ts";

type CreatedBranch = typeof V1CreateABranchOutput.Type;

const mapCreateErrorRaw = mapLegacyHttpError({
  networkError: LegacyBranchesCreateNetworkError,
  statusError: LegacyBranchesCreateUnexpectedStatusError,
  networkMessage: (cause) => `failed to create preview branch: ${cause}`,
  statusMessage: (status, body) => `unexpected create branch status ${status}: ${body}`,
});

export const legacyBranchesCreate = Effect.fn("legacy.branches.create")(function* (
  flags: LegacyBranchesCreateFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  // -----------------------------------------------------------------------
  // Branch-name resolution. Go's `create.go:17-28` defaults to the current
  // git branch when the arg is omitted, prompting Y/N first. The decline
  // path returns `context.Canceled` — we tag-error and short-circuit before
  // resolving the project ref so the linked-project cache write does not fire.
  // -----------------------------------------------------------------------
  let branchName = Option.getOrElse(flags.name, () => "");
  // An explicit `--git-branch` flag takes precedence over the auto-detected
  // branch, mirroring Go's `cmd/branches.go` (the flag sets `body.GitBranch`)
  // and `create.go`'s `if body.GitBranch == nil` guard during auto-detect.
  let gitBranchForBody = Option.getOrUndefined(flags.gitBranch);

  if (branchName.length === 0) {
    const gitBranch = yield* detectGitBranch();
    if (Option.isSome(gitBranch) && gitBranch.value.length > 0) {
      // Go's `create.go:20-25` calls `utils.NewConsole().PromptYesNo(...)`
      // unconditionally — on a TTY it blocks for input, off-TTY it reads stdin
      // with a 100ms timeout and defaults to `true` on EOF. We always fire the
      // confirm; the non-interactive `Output` layer auto-falls-through (via
      // `Effect.orElseSucceed(true)`) which matches Go's EOF-default-true.
      const confirmed = yield* output
        .promptConfirm(`Do you want to create a branch named ${gitBranch.value}?`)
        .pipe(Effect.orElseSucceed(() => true));
      if (!confirmed) {
        return yield* new LegacyBranchesCreateCancelledError({ message: "context canceled" });
      }
      branchName = gitBranch.value;
      if (gitBranchForBody === undefined) {
        gitBranchForBody = gitBranch.value;
      }
    }
  }

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    const creating =
      output.format === "text" ? yield* output.task("Creating branch...") : undefined;

    const created: CreatedBranch = yield* api.v1
      .createABranch({
        ref,
        branch_name: branchName,
        is_default: false,
        ...(gitBranchForBody !== undefined ? { git_branch: gitBranchForBody } : {}),
        ...(Option.isSome(flags.region) ? { region: flags.region.value } : {}),
        ...(Option.isSome(flags.size) ? { desired_instance_size: flags.size.value } : {}),
        ...(Option.isSome(flags.persistent) ? { persistent: flags.persistent.value } : {}),
        ...(Option.isSome(flags.withData) ? { with_data: flags.withData.value } : {}),
        ...(Option.isSome(flags.notifyUrl) ? { notify_url: flags.notifyUrl.value } : {}),
      })
      .pipe(
        Effect.tapError(() => creating?.fail() ?? Effect.void),
        Effect.catch((cause) =>
          // Mirror Go's `create.go:34-37`: on any non-201 status (including
          // gated 4xx), run the entitlement check; `legacySuggestUpgrade`
          // is a no-op for 2xx/5xx itself, so we can call it unconditionally.
          Effect.gen(function* () {
            const status =
              HttpClientError.isHttpClientError(cause) && cause.response !== undefined
                ? cause.response.status
                : 0;
            yield* legacySuggestUpgrade({
              projectRef: ref,
              featureKey: "branching_limit",
              statusCode: status,
            });
            return yield* mapCreateErrorRaw(cause);
          }),
        ),
      );
    yield* creating?.clear() ?? Effect.void;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    // Go writes "Created preview branch:" to stdout (`fmt.Println`), then
    // the table or the encoded payload via EncodeOutput.
    if (goFmt === "json") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeGoJson(created));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeYaml(created));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeToml(created) + "\n");
      return;
    }
    if (goFmt === "env") {
      yield* output.raw("Created preview branch:\n");
      yield* output.raw(encodeEnv(created) + "\n");
      return;
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("Created preview branch", { ...created });
      return;
    }

    yield* output.raw("Created preview branch:\n");
    yield* output.raw(renderBranchesListTable([created]));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
