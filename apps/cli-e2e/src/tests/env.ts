import { Config, ConfigProvider, Effect, Option } from "effect";
import { REPLAY_PROJECT_REF } from "../server/placeholder.ts";

/** Reads an environment variable through `Config`, keeping empty values as set. */
const readEnv = (name: string): string | undefined =>
  Effect.runSync(
    Config.option(Config.String(name))
      .parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))
      .pipe(Effect.map(Option.getOrUndefined)),
  );

// Runtime mode. `replay` (default) serves recorded fixtures; `record` proxies to
// staging and captures fixtures.
// Back-compat: RECORD=true still maps to `record`.
const MODE = readEnv("CLI_E2E_MODE") ?? (readEnv("RECORD") === "true" ? "record" : "replay");

export const isRecording = MODE === "record";

// The record proxy target. Normalised from CLI_E2E_API_URL so
// `CLI_E2E_MODE=record CLI_E2E_API_URL=…` works without also setting the legacy var.
const LEGACY_STAGING_URL = readEnv("SUPABASE_STAGING_URL");
const API_URL = readEnv("CLI_E2E_API_URL");
export const STAGING_URL =
  isRecording && !LEGACY_STAGING_URL && API_URL ? API_URL : LEGACY_STAGING_URL;

// In replay mode the token never reaches a real API, but the CLI validates the
// format before making any request (must match sbp_[a-f0-9]{40}). In record mode
// it must be a valid token for the staging API.
export const ACCESS_TOKEN =
  readEnv("SUPABASE_ACCESS_TOKEN") ?? "sbp_0000000000000000000000000000000000000000";

// Region for the fresh recording project.
export const REGION = readEnv("CLI_E2E_REGION") ?? "us-east-1";

// Recorded fixtures store every project ref and org slug as REPLAY_PROJECT_REF, so replay
// requests use it too. In record mode supply a real project ref via env.
export const PROJECT_REF = readEnv("SUPABASE_TEST_PROJECT_REF") ?? REPLAY_PROJECT_REF;

// In record mode supply a real org slug via env, or let the resolver derive it.
export const ORG_ID = readEnv("SUPABASE_TEST_ORG_ID") ?? REPLAY_PROJECT_REF;

// UUID of an existing SAML provider on the staging project.
// In replay mode any UUID normalises to __UUID__ in fixture paths.
// In record mode supply a real provider ID via env.
export const PROVIDER_ID =
  readEnv("SUPABASE_TEST_PROVIDER_ID") ?? "00000000-0000-0000-0000-000000000000";

// UUID of an existing SQL snippet on the staging project.
// In replay mode any UUID normalises to __UUID__ in fixture paths.
// In record mode supply a real snippet UUID via env.
export const SNIPPET_ID =
  readEnv("SUPABASE_TEST_SNIPPET_ID") ?? "00000000-0000-4000-8000-000000000001";

// Unix epoch seconds for a PITR restore timestamp within the staging project's backup window.
// In replay mode the replay server serves responses in order regardless of the request body value.
// In record mode supply a real timestamp (within the backup window) via env.
export const BACKUP_TIMESTAMP = parseInt(
  readEnv("SUPABASE_TEST_BACKUP_TIMESTAMP") ?? "1707407047",
  10,
);
