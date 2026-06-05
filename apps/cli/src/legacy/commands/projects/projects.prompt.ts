import { randomInt } from "node:crypto";

import { Effect } from "effect";

import { LegacyPlatformApi } from "../../auth/legacy-platform-api.service.ts";
import { mapLegacyHttpError } from "../../shared/legacy-http-errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  LegacyProjectsCreateNameEmptyError,
  LegacyProjectsOrgsListNetworkError,
  LegacyProjectsOrgsListUnexpectedStatusError,
} from "./projects.errors.ts";
import { formatRegion } from "./projects.format.ts";

const mapOrgsListError = mapLegacyHttpError({
  networkError: LegacyProjectsOrgsListNetworkError,
  statusError: LegacyProjectsOrgsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to retrieve organizations: ${cause}`,
  statusMessage: (status, body) => `Unexpected error retrieving organizations: ${body} (${status})`,
});

// Region codes offered in the interactive prompt. Mirrors the `supabase`
// profile's `ProjectRegions` (`apps/cli-go/internal/utils/profile.go:37-56`),
// in the same order, which also matches the `--region` enum.
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
 * Reproduces Go's `promptProjectName` (`create.go:87-95`): read a line; a
 * non-empty value is the project name, otherwise fail with "project name
 * cannot be empty".
 */
export const legacyPromptProjectName = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const name = yield* output.promptText("Enter your project name: ");
  if (name.length > 0) {
    return name;
  }
  return yield* new LegacyProjectsCreateNameEmptyError({
    message: "project name cannot be empty",
  });
});

/**
 * Reproduces Go's `promptOrgId` (`create.go:97-115`): list the user's
 * organizations and prompt for one. Go's `PromptItem` uses `Summary: org.Name`,
 * `Details: org.Id` and returns `Details` (the org id), which is then sent as
 * `organization_slug`.
 */
export const legacyPromptOrgId = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
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
 * Reproduces Go's `promptProjectRegion` (`create.go:117-131`): prompt for a
 * region; the selection value is the region code, the display detail is the
 * human-readable name.
 */
export const legacyPromptProjectRegion = Effect.fnUntraced(function* () {
  const output = yield* Output;
  // Go's `PromptItem{Summary: code, Details: human-name}` renders the region
  // code as the primary label and the friendly name as the description
  // (`create.go:117-131`). Mirror that ordering.
  const options = REGION_CODES.map((code) => ({
    value: code,
    label: code,
    hint: formatRegion(code),
  }));
  const chosen = yield* output.promptSelect(
    "Which region do you want to host the project in?",
    options,
  );
  // Narrow the `string` choice back to a region literal so it satisfies the
  // typed create-project input. The chosen value always comes from the options,
  // so the fallback is never reached in practice.
  const matched = REGION_CODES.find((code) => code === chosen);
  return matched ?? "us-east-1";
});

const PASSWORD_LENGTH = 16;
// Go's `config.LowerUpperLettersDigits.ToChar()` is
// "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789"; `db_url.go`
// strips the `:` separators, leaving lower + upper + digits (62 chars).
const PASSWORD_CHARSET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Reproduces Go's blank-password fallback in `flags.PromptPassword`
 * (`db_url.go:238-257`): generate a 16-character password from the
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
 * Reproduces Go's `flags.PromptPassword` (`db_url.go:238-257`): prompt for a
 * masked database password; a blank entry generates one.
 */
export const legacyPromptDbPassword = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const entered = yield* output.promptPassword(
    "Enter your database password (or leave blank to generate one): ",
  );
  return entered.length > 0 ? entered : generateDbPassword();
});
