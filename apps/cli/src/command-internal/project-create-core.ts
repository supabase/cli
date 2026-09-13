import { type V1CreateAProjectInput, operationDefinitions } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../auth/command-platform-api.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { OutputFlag } from "./global-flags.ts";
import { Output } from "../shared/output/output.service.ts";
import { encodeEnv, encodeGoJson } from "./go-output.encoders.ts";
import { encodeGoToml, encodeGoYaml, goString, goStruct } from "./go-struct-output.encoders.ts";
import { sanitizeErrorBody } from "./http-errors.ts";
import {
  ProjectsCreateNetworkError,
  ProjectsCreateUnexpectedStatusError,
} from "../commands/projects/projects.errors.ts";
import {
  dashboardUrlForProfile,
  readProjectField,
  renderProjectCreateTable,
} from "../commands/projects/projects.format.ts";
import {
  promptDbPassword,
  promptOrgId,
  promptProjectName,
  promptProjectRegion,
} from "../commands/projects/projects.prompt.ts";

type CreateInput = typeof V1CreateAProjectInput.Type;

/** Struct spec driving `-o yaml|toml` key casing for `projects create`'s raw response. */
const GO_PROJECT_RESPONSE = goStruct([
  ["created_at", goString],
  ["id", goString],
  ["name", goString],
  ["organization_id", goString],
  ["organization_slug", goString],
  ["ref", goString],
  ["region", goString],
  ["status", goString],
]);

export interface ProjectCreateInput {
  readonly name: string;
  readonly orgId: string;
  readonly dbPassword: string;
  readonly region: CreateInput["region"];
  readonly size: CreateInput["desired_instance_size"];
  readonly highAvailability: CreateInput["high_availability"];
  readonly releaseChannel: CreateInput["release_channel"];
  readonly postgresEngine: CreateInput["postgres_engine"];
  readonly templateUrl: string | undefined;
  /**
   * Standalone `projects create` emits a `--output-format` json/stream-json success result;
   * `bootstrap` suppresses it since it emits its own top-level result instead.
   */
  readonly emitStructuredResult: boolean;
}

/** Formats `key: value`, padding `key:` to width 20. */
function printKeyValue(key: string, value: string): string {
  return `${key}:${" ".repeat(Math.max(0, 20 - key.length))}${value}`;
}

/**
 * Prompts for any missing project fields, creates the project via `POST /v1/projects`, and
 * echoes the result (`Created a new project at …` plus the `-o`/pretty render).
 *
 * Returns the created ref and the resolved db password. Does not validate required flags
 * (the standalone command's own pre-run does that) and does not write the linked-project
 * cache (the caller owns that via `Effect.ensuring`).
 */
export const projectCreateCore = Effect.fnUntraced(function* (input: ProjectCreateInput) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;

  let name = input.name;
  let orgId = input.orgId;
  let region: CreateInput["region"] = input.region;
  let dbPassword = input.dbPassword;
  const size = input.size;
  const highAvailability = input.highAvailability;
  const releaseChannel = input.releaseChannel;
  const postgresEngine = input.postgresEngine;

  // Prompt for each empty value and echo the resolved value to stderr in text mode.
  if (name.length === 0) {
    name = yield* promptProjectName();
  } else if (output.format === "text") {
    yield* output.raw(printKeyValue("Creating project", name) + "\n", "stderr");
  }
  if (orgId.length === 0) {
    orgId = yield* promptOrgId();
    if (output.format === "text") {
      yield* output.raw(printKeyValue("Selected org-id", orgId) + "\n", "stderr");
    }
  }
  if (region === undefined) {
    const chosenRegion = yield* promptProjectRegion();
    region = chosenRegion;
    if (output.format === "text") {
      yield* output.raw(printKeyValue("Selected region", chosenRegion) + "\n", "stderr");
    }
  }
  if (dbPassword.length === 0) {
    dbPassword = yield* promptDbPassword();
  }

  const body: CreateInput = {
    name,
    organization_slug: orgId,
    db_pass: dbPassword,
    ...(region !== undefined ? { region } : {}),
    ...(size !== undefined ? { desired_instance_size: size } : {}),
    ...(highAvailability !== undefined ? { high_availability: highAvailability } : {}),
    ...(releaseChannel !== undefined ? { release_channel: releaseChannel } : {}),
    ...(postgresEngine !== undefined ? { postgres_engine: postgresEngine } : {}),
    ...(input.templateUrl !== undefined ? { template_url: input.templateUrl } : {}),
  };

  const creating = output.format === "text" ? yield* output.task("Creating project...") : undefined;

  // `executeRaw` skips output decoding: the 201 response's `ref` can be the cli-e2e
  // `__PROJECT_REF__` placeholder, which the generated schema would reject.
  const response = yield* api.executeRaw(operationDefinitions.v1CreateAProject, body).pipe(
    Effect.tapError(() => creating?.fail() ?? Effect.void),
    Effect.mapError(
      (cause) => new ProjectsCreateNetworkError({ message: `failed to create project: ${cause}` }),
    ),
  );

  if (response.status !== 201) {
    const errorBody = sanitizeErrorBody(yield* response.text.pipe(Effect.orElseSucceed(() => "")));
    yield* creating?.fail() ?? Effect.void;
    return yield* new ProjectsCreateUnexpectedStatusError({
      status: response.status,
      body: errorBody,
      message: `Unexpected error creating project: ${errorBody}`,
    });
  }

  const created = yield* response.json.pipe(Effect.orElseSucceed((): unknown => ({})));
  yield* creating?.clear() ?? Effect.void;

  const id = readProjectField(created, "id");

  // Printed to stderr for every output format.
  const projectUrl = `${dashboardUrlForProfile(cliSettings.profile)}/project/${id}`;
  yield* output.raw(`Created a new project at ${projectUrl}\n`, "stderr");

  const goFmt = Option.getOrUndefined(goOutputFlag);
  if (goFmt === "json") {
    yield* output.raw(encodeGoJson(created));
    return { ref: id, dbPassword };
  }
  if (goFmt === "yaml") {
    yield* output.raw(encodeGoYaml(created, GO_PROJECT_RESPONSE));
    return { ref: id, dbPassword };
  }
  if (goFmt === "toml") {
    yield* output.raw(encodeGoToml(created, GO_PROJECT_RESPONSE));
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
