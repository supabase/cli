import type { CLITarget } from "@supabase/cli-test-helpers";

type CliE2eMode = "replay" | "record";

// Runtime mode. `replay` (default) serves recorded fixtures; `record` proxies to
// staging and captures fixtures.
// Back-compat: RECORD=true still maps to `record`.
const MODE: CliE2eMode =
  (process.env["CLI_E2E_MODE"] as CliE2eMode | undefined) ??
  (process.env["RECORD"] === "true" ? "record" : "replay");

export const isRecording = MODE === "record";

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

// In replay mode the token never reaches a real API, but the CLI validates the
// format before making any request (must match sbp_[a-f0-9]{40}). In record mode
// it must be a valid token for the staging API.
export const ACCESS_TOKEN =
  process.env["SUPABASE_ACCESS_TOKEN"] ?? "sbp_0000000000000000000000000000000000000000";

// Which target to run. Defaults to "ts-legacy" — the only shipped CLI shell and
// therefore the authoritative target for replay and recording. Validated
// eagerly so a stale value (e.g. the retired "go" target) fails with a clear error
// instead of an undefined-command crash inside the harness.
const VALID_TARGETS: ReadonlyArray<CLITarget> = ["ts-legacy", "ts-next"];
const rawTarget = process.env["CLI_HARNESS_TARGET"] ?? "ts-legacy";
const matchedTarget = VALID_TARGETS.find((target) => target === rawTarget);
if (matchedTarget === undefined) {
  throw new Error(
    `Unknown CLI_HARNESS_TARGET "${rawTarget}". Valid targets: ${VALID_TARGETS.join(", ")}. ` +
      `(The "go" target was retired when the Go CLI was trimmed to the proxied subset.)`,
  );
}
export const TARGET = matchedTarget;

// Region for the fresh recording project.
export const REGION = process.env["CLI_E2E_REGION"] ?? "us-east-1";

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
