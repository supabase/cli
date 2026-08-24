import type { CLITarget } from "@supabase/cli-test-helpers";
import { Config, ConfigProvider, Effect, Option, Schema } from "effect";

type CliE2eMode = "replay" | "record";

const environmentLayer = ConfigProvider.layer(ConfigProvider.fromEnv());
export const readEnv = (name: string): string | undefined =>
  Option.getOrUndefined(
    Effect.runSync(Config.option(Config.string(name)).pipe(Effect.provide(environmentLayer))),
  );

// Runtime mode. `replay` (default) serves recorded fixtures; `record` proxies to
// staging and captures fixtures.
// Back-compat: RECORD=true still maps to `record`.
const decodeMode = Schema.decodeUnknownSync(Schema.Literals(["replay", "record"]));
const MODE: CliE2eMode =
  readEnv("CLI_E2E_MODE") === undefined
    ? readEnv("RECORD") === "true"
      ? "record"
      : "replay"
    : decodeMode(readEnv("CLI_E2E_MODE"));

export const isRecording = MODE === "record";

// Base Management API URL for record mode (the real API). Replay mode never reads this.
export const TARGET_API_URL =
  readEnv("CLI_E2E_API_URL") ?? readEnv("SUPABASE_STAGING_URL") ?? "https://api.supabase.green";

// In replay mode the token never reaches a real API, but the Go CLI validates
// the format before making any request (must match sbp_[a-f0-9]{40}).
// In record mode it must be a valid token for the staging API.
export const ACCESS_TOKEN =
  readEnv("SUPABASE_ACCESS_TOKEN") ??
  readEnv("SUPABASE_E2E_CLI_LIVE_STAGING_ACCESS_TOKEN") ??
  "sbp_0000000000000000000000000000000000000000";

// Which target to run. Defaults to "ts-legacy" — the only shipped CLI shell and
// therefore the authoritative target for both recording and live tests. Validated
// eagerly so a stale value (e.g. the retired "go" target) fails with a clear error
// instead of an undefined-command crash inside the harness.
const VALID_TARGETS: ReadonlyArray<CLITarget> = ["ts-legacy", "ts-next"];
const rawTarget = readEnv("CLI_HARNESS_TARGET") ?? "ts-legacy";
const matchedTarget = VALID_TARGETS.find((target) => target === rawTarget);
if (matchedTarget === undefined) {
  throw new Error(
    `Unknown CLI_HARNESS_TARGET "${rawTarget}". Valid targets: ${VALID_TARGETS.join(", ")}. ` +
      `(The "go" target was retired when the Go CLI was trimmed to the proxied subset.)`,
  );
}
export const TARGET = matchedTarget;

// Region for the fresh recording project.
export const REGION = readEnv("CLI_E2E_REGION") ?? "us-east-1";

// In replay mode any 20-char lowercase alpha string normalises to __PROJECT_REF__
// in the fixture key. In record mode supply a real project ref via env.
export const PROJECT_REF = readEnv("SUPABASE_TEST_PROJECT_REF") ?? "aaaaaaaaaaaaaaaaaaaa";

// In replay mode any 20-char lowercase alpha string normalises to __PROJECT_REF__.
// In record mode supply a real org slug via env, or let the resolver derive it.
export const ORG_ID = readEnv("SUPABASE_TEST_ORG_ID") ?? "bbbbbbbbbbbbbbbbbbbb";

// UUID of an existing SAML provider on the staging project.
// In replay mode any UUID normalises to __UUID__ in fixture paths.
// In record mode supply a real provider ID via env.
export const PROVIDER_ID =
  readEnv("SUPABASE_TEST_PROVIDER_ID") ?? "00000000-0000-0000-0000-000000000000";

// UUID of an existing SQL snippet on the staging project.
// In replay mode any UUID normalises to __UUID__ in fixture paths.
// In record mode supply a real snippet UUID via env.
export const SNIPPET_ID =
  readEnv("SUPABASE_TEST_SNIPPET_ID") ?? "00000000-0000-0000-0000-000000000001";

// Unix epoch seconds for a PITR restore timestamp within the staging project's backup window.
// In replay mode the replay server serves responses in order regardless of the request body value.
// In record mode supply a real timestamp (within the backup window) via env.
export const BACKUP_TIMESTAMP = parseInt(
  readEnv("SUPABASE_TEST_BACKUP_TIMESTAMP") ?? "1707407047",
  10,
);
