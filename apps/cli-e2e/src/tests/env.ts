import type { CLITarget } from "@supabase/cli-test-helpers";

export const isRecording = process.env["RECORD"] === "true";

// In replay mode the token never reaches a real API, but the Go CLI validates
// the format before making any request (must match sbp_[a-f0-9]{40}).
// In record mode (RECORD=true) it must be a valid staging token.
export const ACCESS_TOKEN =
  process.env["SUPABASE_ACCESS_TOKEN"] ?? "sbp_0000000000000000000000000000000000000000";

// Which target to run. Defaults to "ts-legacy"; set to "go" for recording.
export const TARGET = (process.env["CLI_HARNESS_TARGET"] ?? "ts-legacy") as CLITarget;

// In replay mode any 20-char lowercase alpha string normalises to <PROJECT_REF>
// in the fixture key. In record mode supply a real project ref via env.
export const PROJECT_REF = process.env["SUPABASE_TEST_PROJECT_REF"] ?? "aaaaaaaaaaaaaaaaaaaa";

// In replay mode any 20-char lowercase alpha string normalises to <PROJECT_REF>.
// In record mode supply a real org slug via env, or let the resolver derive it.
export const ORG_ID = process.env["SUPABASE_TEST_ORG_ID"] ?? "bbbbbbbbbbbbbbbbbbbb";

// UUID of an existing SAML provider on the staging project.
// In replay mode any UUID normalises to <UUID> in fixture paths.
// In record mode supply a real provider ID via env.
export const PROVIDER_ID =
  process.env["SUPABASE_TEST_PROVIDER_ID"] ?? "00000000-0000-0000-0000-000000000000";

// UUID of an existing SQL snippet on the staging project.
// In replay mode any UUID normalises to <UUID> in fixture paths.
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
