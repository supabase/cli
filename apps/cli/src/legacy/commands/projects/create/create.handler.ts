import type { V1CreateAProjectInput } from "@supabase/api/effect";
import { Effect, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeGoStructJsonBody,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import { sanitizeLegacyErrorBody } from "../../../shared/legacy-http-errors.ts";
import { resolveLegacyAccessToken } from "../../../shared/legacy-resolve-token.ts";
import {
  LegacyProjectsCreateMissingArgError,
  LegacyProjectsCreateNetworkError,
  LegacyProjectsCreateUnexpectedStatusError,
} from "../projects.errors.ts";
import {
  dashboardUrlForProfile,
  readProjectField,
  renderProjectCreateTable,
} from "../projects.format.ts";
import {
  legacyPromptDbPassword,
  legacyPromptOrgId,
  legacyPromptProjectName,
  legacyPromptProjectRegion,
} from "../projects.prompt.ts";
import type { LegacyProjectsCreateFlags } from "./create.command.ts";

type CreateInput = typeof V1CreateAProjectInput.Type;

/** Go's `printKeyValue` (`create.go:52-56`): `key` + `:` + pad to width 20 + value. */
function printKeyValue(key: string, value: string): string {
  return `${key}:${" ".repeat(Math.max(0, 20 - key.length))}${value}`;
}

export const legacyProjectsCreate = Effect.fn("legacy.projects.create")(function* (
  flags: LegacyProjectsCreateFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const cliConfig = yield* LegacyCliConfig;
  const httpClient = yield* HttpClient.HttpClient;
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

    // Bypass the typed client: Go's `json.Marshal` serializes the request body
    // with alphabetically-sorted keys, which `encodeGoStructJsonBody` reproduces
    // for the cli-e2e replay server's byte-compare. The typed client would also
    // reject the `__PROJECT_REF__` placeholder in the response (`ref` schema).
    const tokenOpt = yield* resolveLegacyAccessToken;
    const request = HttpClientRequest.post(`${cliConfig.apiUrl}/v1/projects`).pipe(
      Option.isSome(tokenOpt) ? HttpClientRequest.bearerToken(tokenOpt.value) : (req) => req,
      HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent),
      HttpClientRequest.bodyText(encodeGoStructJsonBody(input), "application/json"),
    );

    const response = yield* httpClient.execute(request).pipe(
      Effect.tapError(() => creating?.fail() ?? Effect.void),
      Effect.mapError(
        (cause) =>
          new LegacyProjectsCreateNetworkError({ message: `failed to create project: ${cause}` }),
      ),
    );

    if (response.status !== 201) {
      const body = sanitizeLegacyErrorBody(
        yield* response.text.pipe(Effect.orElseSucceed(() => "")),
      );
      yield* creating?.fail() ?? Effect.void;
      return yield* new LegacyProjectsCreateUnexpectedStatusError({
        status: response.status,
        body,
        message: `Unexpected error creating project: ${body}`,
      });
    }

    const created = yield* response.json.pipe(Effect.orElseSucceed((): unknown => ({})));
    yield* creating?.clear() ?? Effect.void;

    const id = readProjectField(created, "id");
    createdRef = id.length > 0 ? id : undefined;

    // Go prints this to stderr for every output format (`create.go:33-34`).
    const projectUrl = `${dashboardUrlForProfile(cliConfig.profile)}/project/${id}`;
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
      const data = typeof created === "object" && created !== null ? created : {};
      yield* output.success("Created project", { ...data });
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
