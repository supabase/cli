import { randomInt } from "node:crypto";

import { Effect } from "effect";

import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { mapHttpError } from "../../command-internal/http-errors.ts";
import { Output } from "../../shared/output/output.service.ts";
import {
  ProjectsCreateNameEmptyError,
  ProjectsOrgsListNetworkError,
  ProjectsOrgsListUnexpectedStatusError,
} from "./projects.errors.ts";
import { formatRegion } from "./projects.format.ts";

const mapOrgsListError = mapHttpError({
  networkError: ProjectsOrgsListNetworkError,
  statusError: ProjectsOrgsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to retrieve organizations: ${cause}`,
  statusMessage: (status, body) => `Unexpected error retrieving organizations: ${body} (${status})`,
});

// Order matches the `--region` enum choices.
const REGION_CODES = [
  "ap-east-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ca-central-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
] as const;

/**
 * Reads a line; a non-empty value is the project name, otherwise fail with
 * "project name cannot be empty".
 */
export const promptProjectName = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const name = yield* output.promptText("Enter your project name: ");
  if (name.length > 0) {
    return name;
  }
  return yield* new ProjectsCreateNameEmptyError({
    message: "project name cannot be empty",
  });
});

/**
 * Lists the user's organizations and prompts for one. The prompt shows the
 * org name and returns the org id, which is then sent as `organization_slug`.
 */
export const promptOrgId = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const orgs = yield* api.v1.listAllOrganizations().pipe(Effect.catch(mapOrgsListError));
  const options = orgs.map((org) => ({
    value: org.id,
    label: org.name,
    hint: org.id,
  }));
  return yield* output.promptSelect(
    "Which organisation do you want to create the project for?",
    options,
  );
});

/**
 * Prompts for a region; the selection value is the region code, the display
 * detail is the human-readable name.
 */
export const promptProjectRegion = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const options = REGION_CODES.map((code) => ({
    value: code,
    label: code,
    hint: formatRegion(code),
  }));
  const chosen = yield* output.promptSelect(
    "Which region do you want to host the project in?",
    options,
  );
  // Narrows the `string` selection back to a region literal for the typed input; the fallback
  // is unreachable since the choice always comes from `REGION_CODES`.
  const matched = REGION_CODES.find((code) => code === chosen);
  return matched ?? "us-east-1";
});

const PASSWORD_LENGTH = 16;
const PASSWORD_CHARSET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Blank-password fallback: generates a 16-character password from the
 * lower+upper+digits charset using a CSPRNG.
 */
export function generateDbPassword(): string {
  let password = "";
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    password += PASSWORD_CHARSET[randomInt(PASSWORD_CHARSET.length)];
  }
  return password;
}

/**
 * Prompts for a masked database password; a blank entry generates one.
 */
export const promptDbPassword = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const entered = yield* output.promptPassword(
    "Enter your database password (or leave blank to generate one): ",
  );
  return entered.length > 0 ? entered : generateDbPassword();
});
