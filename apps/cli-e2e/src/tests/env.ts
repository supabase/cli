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
