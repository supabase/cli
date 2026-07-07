/**
 * Single home for Go's `Config.Validate` parity (`apps/cli-go/pkg/config/config.go:989-1192`),
 * consolidating the two independent TypeScript ports of that logic:
 *
 * - **D** = `legacy-db-config.toml-read.ts` — raw smol-toml document + `EnvLookup`,
 *   Effect-based, fails with `LegacyDbConfigLoadError`. Feeds ~15 db/migration commands via
 *   `legacy-db-config.layer.ts`.
 * - **L** = `legacy-local-config-values.ts` — decoded `@supabase/config` `ProjectConfig`,
 *   synchronous `node:fs`, throws plain `Error`. Feeds `status/status.values.ts` and
 *   `stop/stop.handler.ts`.
 *
 * **This file is the SINGLE home for `Config.Validate` parity going forward.
 * Per-command reimplementations of any branch below are forbidden** — hoist here instead,
 * per `apps/cli/AGENTS.md`'s "Hoist Before You Duplicate" policy.
 *
 * ## Status of this commit
 *
 * This commit is a MECHANICAL RELOCATION ONLY: it moves the five shared regex patterns and
 * `legacyParseGoBool` (+ its private `GO_BOOL_TRUE`/`GO_BOOL_FALSE` acceptance sets) out of D,
 * verbatim, with no behavior change. **The `legacyValidateResolvedConfig` entry point itself —
 * i.e. the actual porting of the branches tabulated below into one pure, ordered validator —
 * lands in a follow-up commit**, not this one. This header documents the FULL eventual scope of
 * the module up front so the ownership contract is visible starting from commit 1.
 *
 * ## Full eventual scope: every `Config.Validate` branch this module will own
 *
 * In Go's exact `Validate()` order (`config.go:989-1192`), first-failure-wins:
 *
 * | Go line(s)                    | Check |
 * |--------------------------------|-------|
 * | 990-991                        | `project_id` required |
 * | 1006-1027                      | `api.port` / `api.tls.{cert,key}_path` presence (the actual file reads stay per-caller I/O) |
 * | 1031-1062                      | `db.port`, `db.major_version` (0 / 12 / 13-17 switch) |
 * | 1064-1068, pattern @ 1549-1554 | `storage.buckets.*` names vs `LEGACY_BUCKET_NAME_PATTERN` |
 * | 1070-1079                      | `studio.port` / `studio.api_url` (L-only — D has no studio section) |
 * | 1081-1085                      | `local_smtp.port` (L-only) |
 * | 1087-1153                      | `auth.*` sub-sequence, in order: site_url (1088-1090); captcha enum + presence (1099-1109, enum itself decode-time per `auth.go:58-71`); signing_keys read (1110-1116, caller-side I/O); passkey/webauthn (1117-1134); hooks (1136-1138, checks @ 1453-1521, vs `LEGACY_HOOK_SECRET_PATTERN`); mfa (1139-1141, checks @ 1523-1534); email template/notification content-vs-content_path (1293-1323, caller-side I/O) + smtp (1325-1344); third_party (1151-1153, checks @ 1635-1683, vs `LEGACY_CLERK_DOMAIN_PATTERN`) |
 * | 1159-1163, pattern @ 1539-1544 | `functions.*` slugs vs `LEGACY_FUNCTION_SLUG_PATTERN` |
 * | 1164-1173                      | `edge_runtime.deno_version` (0 / 1 / 2 switch) |
 * | (decode-time enum)             | `analytics.backend` must be `postgres`/`bigquery` |
 * | 1175-1187                      | `analytics.gcp_*` fields, gated on `backend === "bigquery"` |
 * | 1846-1854                      | `experimental.webhooks` / `experimental.pgdelta.format_options` |
 *
 * ## Explicitly OUT of scope forever (D-only, NEVER part of this module)
 *
 * - `remotes[*].project_id` pattern (`config.go:997-1001`, vs `LEGACY_PROJECT_REF_PATTERN`) —
 *   D's own remote-merge-phase check (`findInvalidRemoteProjectId`), never shared with L.
 * - `auth.sms` (`config.go:1145-1147`/`1348-1417`) — stays 100% inline in D.
 * - `auth.external` (`config.go:1148-1150`/`1419-1451`) — stays 100% inline in D.
 * - `auth.jwt_secret` length check (`apikeys.go:43-73`, `generateAPIKeys`) — each caller's own
 *   key-generation flow (D and L both already implement this separately), not part of
 *   `Config.Validate`'s pure-check set.
 *
 * `legacyExpandEnv` also stays in D (env-substitution machinery, not a validation leaf).
 *
 * ## Known ordering tradeoff (D only, accepted — do not "fix")
 *
 * Go's real auth-block order is site_url → captcha → signing_keys[IO] → passkey → hooks → mfa →
 * email[IO]+smtp → **sms → external** → third_party. Since sms/external are D-only and never
 * part of this module, but third_party IS shared, D cannot call the eventual
 * `legacyValidateResolvedConfig` in a way that preserves relative ordering across the
 * sms/external ↔ third_party boundary without complex multi-phase calls. Decision: D calls
 * `legacyValidateResolvedConfig` ONCE with the full input (including third_party), positioned
 * after D's own signing-keys and email-template I/O reads; D's inline sms/external checks then
 * run AFTER that single call succeeds. This means: if third_party is broken, its error surfaces
 * (matching Go); D's sms/external checks never run in that case. The only real behavior change
 * from today: for the (untested, unrealistic) case where sms/external AND third_party are BOTH
 * simultaneously broken in the same config.toml, Go/today's-D would report the sms/external
 * error first, but the refactored D reports third_party's error first, since third_party is
 * checked inside the single earlier shared call. This is an accepted, narrow, documented parity
 * gap — the same category of accepted imperfection already sanctioned for the three I/O checks
 * above (their cross-section ordering vs. simultaneous unrelated pure-section failures is
 * similarly not byte-guaranteed).
 */

// Go's project-ref pattern (`apps/cli-go/pkg/config/config.go:470`): exactly 20 lowercase
// ASCII letters. Exported from this module (was private in D before this relocation) as the
// canonical home; D's `findInvalidRemoteProjectId` is today the only consumer — the
// `remotes[*].project_id` check itself stays D-only forever, see the module header above.
export const LEGACY_PROJECT_REF_PATTERN = /^[a-z]{20}$/;

// Go's storage bucket-name pattern (`apps/cli-go/pkg/config/config.go:1382`).
// `config.Validate` runs `ValidateBucketName` over every `[storage.buckets.*]` key
// during config load (`config.go:898-903`), aborting before any db command when a
// name does not match. The source string is reused verbatim in the error message via
// `.source` so it byte-matches Go's `bucketNamePattern.String()`. Used by both D
// (`legacy-db-config.toml-read.ts`) and L (`legacy-local-config-values.ts`).
export const LEGACY_BUCKET_NAME_PATTERN = /^(\w|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$/;

// Go's function-slug pattern (`apps/cli-go/pkg/config/config.go:1372`). `config.Validate`
// runs `ValidateFunctionSlug` over every `[functions.*]` key during config load
// (`config.go:993-998`), rejecting the config before any db command. `.source` is reused
// in the message so it byte-matches Go's `funcSlugPattern.String()`. Used by both D and L
// (same reason as {@link LEGACY_BUCKET_NAME_PATTERN} above).
export const LEGACY_FUNCTION_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

// Go's `hookSecretPattern` (`apps/cli-go/pkg/config/config.go:1436`). Used by both D and L
// (same reason as {@link LEGACY_BUCKET_NAME_PATTERN} above).
export const LEGACY_HOOK_SECRET_PATTERN = /^v1,whsec_[A-Za-z0-9+/=]{32,88}$/u;

// Go's `clerkDomainPattern` (`apps/cli-go/pkg/config/config.go:1553`). Used by both D and L
// (same reason as {@link LEGACY_BUCKET_NAME_PATTERN} above).
export const LEGACY_CLERK_DOMAIN_PATTERN =
  /^(clerk([.][a-z0-9-]+){2,}|([a-z0-9-]+[.])+clerk[.]accounts[.]dev)$/u;

// Go's `strconv.ParseBool` accepted forms (`go-viper/mapstructure` `decodeBool` under
// viper's forced `WeaklyTypedInput`): a string decodes to bool via ParseBool, an empty
// string is `false`, and any other value is a parse error.
const GO_BOOL_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const GO_BOOL_FALSE = new Set(["0", "f", "F", "FALSE", "false", "False", ""]);

/**
 * Parse a config bool the way Go does (`strconv.ParseBool` via mapstructure's weakly
 * typed decode). Returns the bool, or `undefined` for a malformed value (which Go
 * surfaces as a `failed to parse config` error).
 *
 * Used by both D (`legacy-db-config.toml-read.ts`'s `resolveBool`/`resolveBoolOrFail`) and
 * L (`legacy-local-config-values.ts`'s `legacyEnvOverrideBool`) for their `SUPABASE_*`
 * bool-flavored env overrides and TOML bool decoding.
 */
export function legacyParseGoBool(value: string): boolean | undefined {
  if (GO_BOOL_TRUE.has(value)) return true;
  if (GO_BOOL_FALSE.has(value)) return false;
  return undefined;
}
