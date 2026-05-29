import type { V1CreateAProjectInput, V1CreateAProjectOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyProjectsCreateMissingArgError,
  LegacyProjectsCreateNetworkError,
  LegacyProjectsCreateUnexpectedStatusError,
} from "../projects.errors.ts";
import { dashboardUrlForProfile, renderProjectCreateTable } from "../projects.format.ts";
import {
  legacyPromptDbPassword,
  legacyPromptOrgId,
  legacyPromptProjectName,
  legacyPromptProjectRegion,
} from "../projects.prompt.ts";
import type { LegacyProjectsCreateFlags } from "./create.command.ts";

type CreateInput = typeof V1CreateAProjectInput.Type;
type CreatedProject = typeof V1CreateAProjectOutput.Type;

const mapCreateError = mapLegacyHttpError({
  networkError: LegacyProjectsCreateNetworkError,
  statusError: LegacyProjectsCreateUnexpectedStatusError,
  networkMessage: (cause) => `failed to create project: ${cause}`,
  statusMessage: (_status, body) => `Unexpected error creating project: ${body}`,
});

/** Go's `printKeyValue` (`create.go:52-56`): `key` + `:` + pad to width 20 + value. */
function printKeyValue(key: string, value: string): string {
  return `${key}:${" ".repeat(Math.max(0, 20 - key.length))}${value}`;
}

export const legacyProjectsCreate = Effect.fn("legacy.projects.create")(function* (
  flags: LegacyProjectsCreateFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const cliConfig = yield* LegacyCliConfig;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const tty = yield* Tty;

  let createdRef: string | undefined;

  yield* Effect.gen(function* () {
    // Go gates interactivity on `term.IsTerminal(stdin) && interactive`
    // (`projects.go:63`); `--interactive` defaults to true. We additionally
    // require a text-mode `Output` so json/stream-json never prompt.
    const interactive = Option.getOrElse(flags.interactive, () => true);
    const effectiveInteractive = interactive && tty.stdinIsTty && output.interactive;

    let name = Option.getOrElse(flags.name, () => "");
    let orgId = Option.getOrElse(flags.orgId, () => "");
    let region: CreateInput["region"] = Option.getOrUndefined(flags.region);
    let dbPassword = Option.getOrElse(flags.dbPassword, () => "");
    const size = Option.getOrUndefined(flags.size);

    // Non-interactive: Go's PreRunE marks `--org-id`, `--db-password`,
    // `--region` required and the project name positional `ExactArgs(1)`.
    if (!effectiveInteractive) {
      const missing: Array<string> = [];
      if (name.length === 0) missing.push("project name");
      if (orgId.length === 0) missing.push("--org-id");
      if (dbPassword.length === 0) missing.push("--db-password");
      if (region === undefined) missing.push("--region");
      if (missing.length > 0) {
        return yield* new LegacyProjectsCreateMissingArgError({
          message: `non-interactive mode requires the following to be set: ${missing.join(", ")}`,
        });
      }
    }

    // promptMissingParams (`create.go:58-85`): prompt for each empty value and
    // echo the resolved value to stderr in text mode.
    if (name.length === 0) {
      name = yield* legacyPromptProjectName();
    } else if (output.format === "text") {
      yield* output.raw(printKeyValue("Creating project", name) + "\n", "stderr");
    }
    if (orgId.length === 0) {
      orgId = yield* legacyPromptOrgId();
      if (output.format === "text") {
        yield* output.raw(printKeyValue("Selected org-id", orgId) + "\n", "stderr");
      }
    }
    if (region === undefined) {
      const chosenRegion = yield* legacyPromptProjectRegion();
      region = chosenRegion;
      if (output.format === "text") {
        yield* output.raw(printKeyValue("Selected region", chosenRegion) + "\n", "stderr");
      }
    }
    if (dbPassword.length === 0) {
      dbPassword = yield* legacyPromptDbPassword();
    }

    const input: CreateInput = {
      name,
      organization_slug: orgId,
      db_pass: dbPassword,
      ...(region !== undefined ? { region } : {}),
      ...(size !== undefined ? { desired_instance_size: size } : {}),
    };

    const creating =
      output.format === "text" ? yield* output.task("Creating project...") : undefined;
    const created: CreatedProject = yield* api.v1.createAProject(input).pipe(
      Effect.tapError(() => creating?.fail() ?? Effect.void),
      Effect.catch(mapCreateError),
    );
    yield* creating?.clear() ?? Effect.void;
    createdRef = created.id;

    // Go prints this to stderr for every output format (`create.go:33-34`).
    const projectUrl = `${dashboardUrlForProfile(cliConfig.profile)}/project/${created.id}`;
    yield* output.raw(`Created a new project at ${projectUrl}\n`, "stderr");

    const goFmt = Option.getOrUndefined(goOutputFlag);
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(created));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeYaml(created));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeToml(created) + "\n");
      return;
    }
    if (goFmt === "env") {
      yield* output.raw(encodeEnv(created) + "\n");
      return;
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("Created project", { ...created });
      return;
    }

    yield* output.raw(renderProjectCreateTable(created));
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        createdRef === undefined ? Effect.void : linkedProjectCache.cache(createdRef),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
