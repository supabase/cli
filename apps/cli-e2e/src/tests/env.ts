import type { CLITarget } from "@supabase/cli-test-helpers";

type CliE2eMode = "replay" | "record" | "live";
type CliE2eTargetEnv = "staging" | "supabox";

// Runtime mode. `replay` (default) serves recorded fixtures; `record` proxies to
// staging and captures fixtures; `live` (ADR-0013) bypasses the replay server and
// wires the CLI straight at the real Management API + Docker socket.
// Back-compat: RECORD=true still maps to `record`.
const MODE: CliE2eMode =
  (process.env["CLI_E2E_MODE"] as CliE2eMode | undefined) ??
  (process.env["RECORD"] === "true" ? "record" : "replay");

export const isRecording = MODE === "record";
export const isLive = MODE === "live";

// The replay server + tests/setup.ts key recording off the RECORD env var
// directly. Keep RECORD in sync with MODE in BOTH directions so an explicit
// CLI_E2E_MODE wins over a stale RECORD env — e.g. CLI_E2E_MODE=replay must NOT
// record and wipe fixtures just because RECORD=true lingers in the shell.
if (isRecording) {
  process.env["RECORD"] = "true";
} else {
  delete process.env["RECORD"];
}

// startReplayServer + tests/setup.ts read SUPABASE_STAGING_URL directly as the
// record proxy target. Normalise it from CLI_E2E_API_URL so
// `CLI_E2E_MODE=record CLI_E2E_API_URL=…` works without also setting the legacy var.
if (isRecording && !process.env["SUPABASE_STAGING_URL"] && process.env["CLI_E2E_API_URL"]) {
  process.env["SUPABASE_STAGING_URL"] = process.env["CLI_E2E_API_URL"];
}

// Which backend the live/record suite targets. Only `staging` is wired today;
// `supabox` is a later env swap (CLI_E2E_API_URL + CLI_E2E_PROJECT_HOST + token).
const TARGET_ENV: CliE2eTargetEnv =
  (process.env["CLI_E2E_TARGET_ENV"] as CliE2eTargetEnv | undefined) ?? "staging";

// Base Management API URL for record/live modes (the real API). In live mode the
// harness apiUrl is wired here directly — there is no replay server in front.
// Replay mode never reads this.
export const TARGET_API_URL =
  process.env["CLI_E2E_API_URL"] ??
  process.env["SUPABASE_STAGING_URL"] ??
  "https://api.supabase.green";

// Host used to build the deployed-function invoke URL:
//   https://{ref}.{PROJECT_HOST}/functions/v1
// Environment-specific (staging is not supabase.co), so it is configurable.
export const PROJECT_HOST =
  process.env["CLI_E2E_PROJECT_HOST"] ?? (TARGET_ENV === "staging" ? "supabase.red" : "");

// In replay mode the token never reaches a real API, but the Go CLI validates
// the format before making any request (must match sbp_[a-f0-9]{40}).
// In record/live mode it must be a valid token for the target env. Falls back to
// the live staging secret name so a local `.env.local` works without remapping.
export const ACCESS_TOKEN =
  process.env["SUPABASE_ACCESS_TOKEN"] ??
  process.env["SUPABASE_E2E_CLI_LIVE_STAGING_ACCESS_TOKEN"] ??
  "sbp_0000000000000000000000000000000000000000";

// Whether a real token was supplied (vs the replay placeholder above). Live mode
// must fail fast on a missing token instead of letting every API call 401.
export const isAccessTokenProvided = Boolean(
  process.env["SUPABASE_ACCESS_TOKEN"] ?? process.env["SUPABASE_E2E_CLI_LIVE_STAGING_ACCESS_TOKEN"],
);

// Which target to run. Defaults to "ts-legacy"; set to "go" for recording and as
// the source-of-truth target when authoring live tests.
export const TARGET = (process.env["CLI_HARNESS_TARGET"] ?? "ts-legacy") as CLITarget;

// Optional org for the fresh live project. When unset, live-setup resolves it via
// `orgs list` (which also exercises that command against the real API).
export const ORG_ID_OVERRIDE = process.env["CLI_E2E_ORG_ID"];

// Region for the fresh live project.
export const REGION = process.env["CLI_E2E_REGION"] ?? "us-east-1";

// Skip live-project teardown for debugging.
export const KEEP_PROJECT = process.env["CLI_E2E_KEEP_PROJECT"] === "1";

// In replay mode any 20-char lowercase alpha string normalises to __PROJECT_REF__
// in the fixture key. In record mode supply a real project ref via env.
export const PROJECT_REF = process.env["SUPABASE_TEST_PROJECT_REF"] ?? "aaaaaaaaaaaaaaaaaaaa";

// In replay mode any 20-char lowercase alpha string normalises to __PROJECT_REF__.
// In record mode supply a real org slug via env, or let the resolver derive it.
export const ORG_ID = process.env["SUPABASE_TEST_ORG_ID"] ?? "bbbbbbbbbbbbbbbbbbbb";

// UUID of an existing SAML provider on the staging project.
// In replay mode any UUID normalises to __UUID__ in fixture paths.
// In record mode supply a real provider ID via env.
export const PROVIDER_ID =
  process.env["SUPABASE_TEST_PROVIDER_ID"] ?? "00000000-0000-0000-0000-000000000000";

// UUID of an existing SQL snippet on the staging project.
// In replay mode any UUID normalises to __UUID__ in fixture paths.
// In record mode supply a real snippet UUID via env.
export const SNIPPET_ID =
  process.env["SUPABASE_TEST_SNIPPET_ID"] ?? "00000000-0000-0000-0000-000000000001";

// Unix epoch seconds for a PITR restore timestamp within the staging project's backup window.
// In replay mode the replay server serves responses in order regardless of the request body value.
// In record mode supply a real timestamp (within the backup window) via env.
export const BACKUP_TIMESTAMP = parseInt(
  process.env["SUPABASE_TEST_BACKUP_TIMESTAMP"] ?? "1707407047",
  10,
);
