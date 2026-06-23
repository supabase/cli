import { type V1CreateAProjectInput, operationDefinitions } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { LegacyOutputFlag } from "../../shared/legacy/global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";
import { encodeEnv, encodeGoJson, encodeToml, encodeYaml } from "./legacy-go-output.encoders.ts";
import { sanitizeLegacyErrorBody } from "./legacy-http-errors.ts";
import {
  LegacyProjectsCreateNetworkError,
  LegacyProjectsCreateUnexpectedStatusError,
} from "../commands/projects/projects.errors.ts";
import {
  dashboardUrlForProfile,
  readProjectField,
  renderProjectCreateTable,
} from "../commands/projects/projects.format.ts";
import {
  legacyPromptDbPassword,
  legacyPromptOrgId,
  legacyPromptProjectName,
  legacyPromptProjectRegion,
} from "../commands/projects/projects.prompt.ts";

type CreateInput = typeof V1CreateAProjectInput.Type;

export interface LegacyProjectCreateInput {
  readonly name: string;
  readonly orgId: string;
  readonly dbPassword: string;
  readonly region: CreateInput["region"];
  readonly size: CreateInput["desired_instance_size"];
  readonly highAvailability: CreateInput["high_availability"];
  readonly templateUrl: string | undefined;
  /**
   * Standalone `projects create` emits a `--output-format` json/stream-json
   * success result; `bootstrap` suppresses it (it emits its own top-level
   * result), matching Go's `create.Run` which only ever echoes via `-o`.
   */
  readonly emitStructuredResult: boolean;
}

/** Go's `printKeyValue` (`create.go`): `key` + `:` + pad to width 20 + value. */
function printKeyValue(key: string, value: string): string {
  return `${key}:${" ".repeat(Math.max(0, 20 - key.length))}${value}`;
}

/**
 * Ports Go's `create.Run` (`apps/cli-go/internal/projects/create/create.go:16-50`):
 * `promptMissingParams` (prompt for / echo each empty field), `POST /v1/projects`,
 * and the project echo (`Created a new project at …` plus the `-o`/pretty render).
 *
 * Returns the created ref + the resolved db password (Go stores both globally via
 * `flags.ProjectRef` / `viper.Set("DB_PASSWORD", …)`). Does NOT validate required
 * flags (that is the standalone command's cobra PreRunE) and does NOT write the
 * linked-project cache (the caller owns that via `Effect.ensuring`).
 */
export const legacyProjectCreateCore = Effect.fnUntraced(function* (
  input: LegacyProjectCreateInput,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const cliConfig = yield* LegacyCliConfig;

  let name = input.name;
  let orgId = input.orgId;
  let region: CreateInput["region"] = input.region;
  let dbPassword = input.dbPassword;
  const size = input.size;
  const highAvailability = input.highAvailability;

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

  const body: CreateInput = {
    name,
    organization_slug: orgId,
    db_pass: dbPassword,
    ...(region !== undefined ? { region } : {}),
    ...(size !== undefined ? { desired_instance_size: size } : {}),
    ...(highAvailability !== undefined ? { high_availability: highAvailability } : {}),
    ...(input.templateUrl !== undefined ? { template_url: input.templateUrl } : {}),
  };

  const creating = output.format === "text" ? yield* output.task("Creating project...") : undefined;

  // `executeRaw` sends the body with Go-sorted keys (matching `json.Marshal`)
  // and skips output decoding: the 201 response's `ref` can be the cli-e2e
  // `__PROJECT_REF__` placeholder, which the generated schema rejects.
  const response = yield* api.executeRaw(operationDefinitions.v1CreateAProject, body).pipe(
    Effect.tapError(() => creating?.fail() ?? Effect.void),
    Effect.mapError(
      (cause) =>
        new LegacyProjectsCreateNetworkError({ message: `failed to create project: ${cause}` }),
    ),
  );

  if (response.status !== 201) {
    const errorBody = sanitizeLegacyErrorBody(
      yield* response.text.pipe(Effect.orElseSucceed(() => "")),
    );
    yield* creating?.fail() ?? Effect.void;
    return yield* new LegacyProjectsCreateUnexpectedStatusError({
      status: response.status,
      body: errorBody,
      message: `Unexpected error creating project: ${errorBody}`,
    });
  }

  const created = yield* response.json.pipe(Effect.orElseSucceed((): unknown => ({})));
  yield* creating?.clear() ?? Effect.void;

  const id = readProjectField(created, "id");

  // Go prints this to stderr for every output format (`create.go:33-34`).
  const projectUrl = `${dashboardUrlForProfile(cliConfig.profile)}/project/${id}`;
  yield* output.raw(`Created a new project at ${projectUrl}\n`, "stderr");

  const goFmt = Option.getOrUndefined(goOutputFlag);
  if (goFmt === "json") {
    yield* output.raw(encodeGoJson(created));
    return { ref: id, dbPassword };
  }
  if (goFmt === "yaml") {
    yield* output.raw(encodeYaml(created));
    return { ref: id, dbPassword };
  }
  if (goFmt === "toml") {
    yield* output.raw(encodeToml(created) + "\n");
    return { ref: id, dbPassword };
  }
  if (goFmt === "env") {
    yield* output.raw(encodeEnv(created) + "\n");
    return { ref: id, dbPassword };
  }

  if (output.format === "json" || output.format === "stream-json") {
    if (input.emitStructuredResult) {
      const data = typeof created === "object" && created !== null ? created : {};
      yield* output.success("Created project", { ...data });
    }
    return { ref: id, dbPassword };
  }

  yield* output.raw(renderProjectCreateTable(created));
  return { ref: id, dbPassword };
});
