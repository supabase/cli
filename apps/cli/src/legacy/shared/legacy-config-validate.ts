import { isAbsolute, join } from "node:path";

import { legacyGoUrlParse } from "./legacy-storage-url.ts";

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
 * {@link legacyValidateResolvedConfig} is now IMPLEMENTED and fully wired into BOTH callers: L
 * (`legacy-local-config-values.ts`'s `legacyResolveLocalConfigValues`) and D
 * (`legacy-db-config.toml-read.ts`'s `legacyReadDbToml`) each build a
 * {@link LegacyConfigValidationInput} from their own decoded config (a `ProjectConfig` + raw
 * `document` for L, a raw smol-toml document + `EnvLookup` for D) and call this function once,
 * at the correct Go position. Wiring D through this module also fixed D's `db.major_version
 * === 0` divergence (D used to fall through to the generic invalid-value message; it now
 * throws the same "Missing required field in config: db.major_version" as Go and as L already
 * did).
 *
 * ## Full eventual scope: every `Config.Validate` branch this module owns
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
 * - `auth.sms` (`config.go:1145-1147`/`1348-1417`) — stays 100% inline in D; L instead relies on
 *   `@supabase/config`'s `sms` schema enforcing the same provider-switch priority at decode time
 *   (`packages/config/src/auth/sms.ts`), since L decodes through that schema and D doesn't.
 * - `auth.external` (`config.go:1148-1150`/`1419-1451`) — inline in BOTH D
 *   (`legacy-db-config.toml-read.ts`'s "B5: external providers") and L
 *   ({@link legacyResolveLocalConfigValues}'s `validateAuthExternalProviders`, called after this
 *   module's shared check, same ordering tradeoff as sms below) — never routed through this
 *   shared module, since it needs the RAW pre-decode document to see provider names
 *   `@supabase/config`'s schema doesn't model.
 * - `auth.jwt_secret` length check (`apikeys.go:43-73`, `generateAPIKeys`) — each caller's own
 *   key-generation flow (D and L both already implement this separately), not part of
 *   `Config.Validate`'s pure-check set.
 *
 * `legacyExpandEnv` also stays in D (env-substitution machinery, not a validation leaf).
 *
 * ## Known ordering tradeoff (accepted — do not "fix")
 *
 * Go's real auth-block order is site_url → captcha → signing_keys[IO] → passkey → hooks → mfa →
 * email[IO]+smtp → **sms → external** → third_party. Since sms/external are D-only and never
 * part of this module, but third_party IS shared, D cannot call
 * {@link legacyValidateResolvedConfig} in a way that preserves relative ordering across the
 * sms/external ↔ third_party boundary without complex multi-phase calls. Decision (applies once
 * D is wired up in a follow-up commit): D calls {@link legacyValidateResolvedConfig} ONCE with
 * the full input (including third_party), positioned after D's own signing-keys and
 * email-template I/O reads; D's inline sms/external checks then run AFTER that single call
 * succeeds. This means: if third_party is broken, its error surfaces (matching Go); D's
 * sms/external checks never run in that case. The only real behavior change from today: for the
 * (untested, unrealistic) case where sms/external AND third_party are BOTH simultaneously
 * broken in the same config.toml, Go/today's-D would report the sms/external error first, but
 * the refactored D reports third_party's error first, since third_party is checked inside the
 * single earlier shared call. This is an accepted, narrow, documented parity gap.
 *
 * The same category of tradeoff now also applies to L: `legacyResolveLocalConfigValues` calls
 * {@link legacyValidateResolvedConfig} exactly ONCE, at the very end, after every value this
 * module needs has been derived — including L's 3 I/O reads (signing keys, `api.tls` cert/key,
 * email template/notification content), which stay at their original textual position (per-caller
 * I/O, same as D's). Every pure check this module owns is therefore checked in Go's exact
 * relative order against every OTHER pure check, but an I/O read that in L's source sits
 * between two pure sections (e.g. the signing-keys read sits between the captcha check and the
 * passkey/hooks/mfa/email/smtp/third_party checks) now effectively runs BEFORE any of those
 * later pure checks, rather than interleaved at its original relative position — the same
 * narrow, accepted, documented tradeoff, not something to "fix" by splitting this function into
 * multiple calls. Every existing test constructs exactly one validation failure at a time, so
 * this has zero effect on any real test.
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
// (`legacy-db-config.toml-read.ts`) and L (`legacy-local-config-values.ts`), and internally by
// {@link legacyValidateResolvedConfig}'s storage-bucket-names step (`config.go:1064-1068`).
export const LEGACY_BUCKET_NAME_PATTERN = /^(\w|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$/;

// Go's function-slug pattern (`apps/cli-go/pkg/config/config.go:1372`). `config.Validate`
// runs `ValidateFunctionSlug` over every `[functions.*]` key during config load
// (`config.go:993-998`), rejecting the config before any db command. `.source` is reused
// in the message so it byte-matches Go's `funcSlugPattern.String()`. Used by both D and L
// (same reason as {@link LEGACY_BUCKET_NAME_PATTERN} above), and internally by
// {@link legacyValidateResolvedConfig}'s function-slugs step (`config.go:1159-1163`).
export const LEGACY_FUNCTION_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

// Go's `hookSecretPattern` (`apps/cli-go/pkg/config/config.go:1436`). Used by both D and L
// (same reason as {@link LEGACY_BUCKET_NAME_PATTERN} above), and internally by
// {@link legacyValidateResolvedConfig}'s hooks step (`config.go:1453-1521`).
export const LEGACY_HOOK_SECRET_PATTERN = /^v1,whsec_[A-Za-z0-9+/=]{32,88}$/u;

// Go's `clerkDomainPattern` (`apps/cli-go/pkg/config/config.go:1553`). Used by both D and L
// (same reason as {@link LEGACY_BUCKET_NAME_PATTERN} above), and internally by
// {@link legacyValidateResolvedConfig}'s third_party step (`config.go:1635-1683`).
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

/**
 * Thrown by {@link legacyValidateResolvedConfig}. Deliberately does NOT override `.name` in a
 * constructor — it stays the inherited `"Error"` — so `.toString()`/`.name`/`instanceof Error`
 * checks are indistinguishable from a plain `new Error(message)`. Both D and L's existing
 * callers/tests observe only `.message` (via `cause instanceof Error ? cause.message : ...` or
 * `.toThrow("substring")`), so swapping their inline `throw new Error(...)` calls for this class
 * is a byte-identical, purely internal refactor.
 */
export class LegacyConfigValidateError extends Error {}

/** One `[api.tls]` section, post-env-override. See {@link LegacyConfigValidationInput}. */
export interface LegacyApiInput {
  readonly enabled: boolean;
  readonly port: number;
  readonly tls: {
    readonly enabled: boolean;
    readonly certPath: string | undefined;
    readonly keyPath: string | undefined;
  };
}

/** `[db]`, post-env-override. Required — Go validates `db.port`/`db.major_version` unconditionally. */
export interface LegacyDbInput {
  readonly port: number;
  readonly majorVersion: number;
}

/** `[studio]`, post-env-override. L-only — D has no studio section. */
export interface LegacyStudioInput {
  readonly enabled: boolean;
  readonly port: number;
  readonly apiUrl: string;
}

/** `[local_smtp]` (Go's `Inbucket`), post-env-override. L-only. */
export interface LegacyLocalSmtpInput {
  readonly enabled: boolean;
  readonly port: number;
}

/** `[auth.captcha]`. `provider` is deliberately `string | undefined`, not a narrow union — see
 * divergence #2 in the module's port plan: D passes a raw, untyped TOML string (the enum check
 * is live for D); L's `@supabase/config`-decoded value is already schema-narrowed to
 * `"hcaptcha" | "turnstile" | undefined` before this function ever sees it, making the branch
 * dead-but-harmless for L specifically, while still needing the same widened type to keep this
 * field honest and reusable across both callers.
 */
export interface LegacyCaptchaInput {
  readonly enabled: boolean;
  readonly provider: string | undefined;
  readonly secret: string | undefined;
}

/** `[auth.passkey]` + `[auth.webauthn]`. Present iff `passkey.enabled === true`. */
export interface LegacyPasskeyInput {
  readonly webauthnPresent: boolean;
  readonly rpId: string | undefined;
  readonly rpOrigins: ReadonlyArray<unknown> | undefined;
}

/** One enabled `[auth.hook.<type>]` entry. Caller pre-filters to enabled-only and pre-orders
 * per Go's fixed hook-type iteration order (`config.go:1453-1485`). */
export interface LegacyHookInput {
  readonly type:
    | "mfa_verification_attempt"
    | "password_verification_attempt"
    | "custom_access_token"
    | "send_sms"
    | "send_email"
    | "before_user_created";
  /** Post-env-expand; `""` = absent. */
  readonly uri: string;
  /** Post-env-expand; `""` = absent. */
  readonly secrets: string;
}

/** One `[auth.mfa.<factor>]` entry. Caller pre-orders totp, phone, web_authn. */
export interface LegacyMfaFactorInput {
  readonly label: "totp" | "phone" | "web_authn";
  readonly enrollEnabled: boolean;
  readonly verifyEnabled: boolean;
}

/** `[auth.email.smtp]`. Present iff the raw TOML table itself is present (Go's presence-based
 * `enabled` default, `config.go:743-748` — NOT the decoded, always-defaulted value). */
export interface LegacySmtpInput {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly adminEmail: string;
}

/** One enabled `[auth.third_party.<provider>]` entry. Caller pre-filters to enabled-only and
 * pre-orders per Go's fixed provider order (firebase, auth0, cognito, clerk, workos). */
export interface LegacyThirdPartyInput {
  readonly provider: "firebase" | "auth0" | "cognito" | "clerk" | "workos";
  /** `project_id` / `tenant` / `user_pool_id` / `domain` / `issuer_url`, per provider. */
  readonly requiredField: string;
  /** cognito's second required field only. */
  readonly cognitoUserPoolRegion?: string;
}

/** `[auth]`. Present in {@link LegacyConfigValidationInput} iff auth is enabled — matches Go's
 * `if c.Auth.Enabled` gate wrapping this entire sub-sequence (`config.go:1087-1153`). */
export interface LegacyAuthInput {
  readonly siteUrl: string;
  readonly captcha?: LegacyCaptchaInput;
  readonly passkey?: LegacyPasskeyInput;
  readonly hooks: ReadonlyArray<LegacyHookInput>;
  readonly mfa: ReadonlyArray<LegacyMfaFactorInput>;
  readonly smtp?: LegacySmtpInput;
  readonly thirdParty: ReadonlyArray<LegacyThirdPartyInput>;
}

/** `[analytics]`, post-env-override. Unconditional entry — internally gated on `enabled` +
 * `backend === "bigquery"`. `backend` is `string | undefined` for the same dead-but-harmless-for-L
 * reason as {@link LegacyCaptchaInput.provider} — see divergence #2. */
export interface LegacyAnalyticsInput {
  readonly enabled: boolean;
  readonly backend: string | undefined;
  readonly gcpProjectId: string;
  readonly gcpProjectNumber: string;
  readonly gcpJwtPath: string;
}

/** `[experimental]`. Unconditional entry — internally gated. `webhooksPresent`/`webhooksEnabled`
 * hinge on TOML-section PRESENCE (not the decoded, always-defaulted `enabled` value) — see
 * `config.go:1846-1854` and the callers' own doc comments for why. */
export interface LegacyExperimentalInput {
  readonly webhooksPresent?: boolean;
  readonly webhooksEnabled?: boolean;
  readonly pgdeltaFormatOptions: string;
}

/**
 * Normalized POST-env-override primitives mirroring Go's decoded config, for VALIDATED fields
 * only. Every section is OPTIONAL — an absent section means "this caller doesn't run that Go
 * branch, skip it" (e.g. D omits `studio`/`localSmtp` entirely; both D and L omit `auth` when
 * auth is disabled). See the module header for the full ported-branch table and out-of-scope
 * list.
 */
export interface LegacyConfigValidationInput {
  /** L only — D's `project_id` isn't part of `Config.Validate`'s shared surface. */
  readonly projectId?: string;
  /** L only — D has no `[api]` section. */
  readonly api?: LegacyApiInput;
  /** Both, unconditional in Go. */
  readonly db: LegacyDbInput;
  /** Both, unconditional (`[]` = none). */
  readonly storageBucketNames: ReadonlyArray<string>;
  /** L only. */
  readonly studio?: LegacyStudioInput;
  /** L only. */
  readonly localSmtp?: LegacyLocalSmtpInput;
  /** Both, present iff auth is enabled. */
  readonly auth?: LegacyAuthInput;
  /** Both, unconditional (`[]` = none). */
  readonly functionSlugs: ReadonlyArray<string>;
  /** Both, unconditional. */
  readonly edgeRuntimeDenoVersion: number;
  /** Both, unconditional entry (internally gated). */
  readonly analytics: LegacyAnalyticsInput;
  /** Both, unconditional entry (internally gated). */
  readonly experimental: LegacyExperimentalInput;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Runs every `Config.Validate` branch this module owns (see the module header's table), in
 * Go's exact order, first-failure-wins. Pure — no I/O, no Effect. Callers own their own
 * per-section I/O reads (signing keys, `api.tls` cert/key, email template/notification content)
 * at the correct Go position themselves, using the pure helpers exported below.
 */
export function legacyValidateResolvedConfig(input: LegacyConfigValidationInput): void {
  // config.go:990-991 — checked FIRST, before every other field.
  if (input.projectId !== undefined && input.projectId.length === 0) {
    throw new LegacyConfigValidateError("Missing required field in config: project_id");
  }

  // config.go:1006-1027 — api.port / api.tls.{cert,key}_path, gated on api.enabled. The actual
  // cert/key file reads are caller-side I/O (see legacyResolveApiTlsPath below); this only
  // checks the "exactly one of cert/key set" presence rule.
  if (input.api?.enabled) {
    if (input.api.port === 0) {
      throw new LegacyConfigValidateError("Missing required field in config: api.port");
    }
    if (input.api.tls.enabled) {
      const hasCert = input.api.tls.certPath !== undefined && input.api.tls.certPath.length > 0;
      const hasKey = input.api.tls.keyPath !== undefined && input.api.tls.keyPath.length > 0;
      if (hasCert && !hasKey) {
        throw new LegacyConfigValidateError("Missing required field in config: api.tls.key_path");
      }
      if (hasKey && !hasCert) {
        throw new LegacyConfigValidateError("Missing required field in config: api.tls.cert_path");
      }
    }
  }

  // config.go:1031-1033 — db.port, unconditional, no `enabled` gate.
  if (input.db.port === 0) {
    throw new LegacyConfigValidateError("Missing required field in config: db.port");
  }
  // config.go:1034-1062 — db.major_version switch: 0 / 12 have dedicated messages, 13/14/15/17
  // are supported, anything else is the generic invalid-value message.
  if (input.db.majorVersion === 0) {
    throw new LegacyConfigValidateError("Missing required field in config: db.major_version");
  }
  if (input.db.majorVersion === 12) {
    throw new LegacyConfigValidateError(
      "Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.",
    );
  }
  if (![13, 14, 15, 17].includes(input.db.majorVersion)) {
    throw new LegacyConfigValidateError(
      `Failed reading config: Invalid db.major_version: ${input.db.majorVersion}.`,
    );
  }

  // config.go:1064-1068, pattern @ 1549-1554 — every [storage.buckets.*] key, unconditional.
  for (const name of input.storageBucketNames) {
    if (!LEGACY_BUCKET_NAME_PATTERN.test(name)) {
      throw new LegacyConfigValidateError(
        `Invalid Bucket name: ${name}. Only lowercase letters, numbers, dots, hyphens, and spaces are allowed. (${LEGACY_BUCKET_NAME_PATTERN.source})`,
      );
    }
  }

  // config.go:1070-1079 — studio.port / studio.api_url, gated on studio.enabled. L-only.
  if (input.studio?.enabled) {
    if (input.studio.port === 0) {
      throw new LegacyConfigValidateError("Missing required field in config: studio.port");
    }
    try {
      legacyGoUrlParse(input.studio.apiUrl);
    } catch (cause) {
      throw new LegacyConfigValidateError(`Invalid config for studio.api_url: ${messageOf(cause)}`);
    }
  }

  // config.go:1081-1085 — local_smtp.port, gated on local_smtp.enabled. L-only.
  if (input.localSmtp?.enabled && input.localSmtp.port === 0) {
    throw new LegacyConfigValidateError("Missing required field in config: local_smtp.port");
  }

  // config.go:1087-1153 — the auth.* sub-sequence, all inside `if c.Auth.Enabled`.
  if (input.auth !== undefined) {
    const auth = input.auth;

    // config.go:1088-1090 — auth.site_url.
    if (auth.siteUrl.length === 0) {
      throw new LegacyConfigValidateError("Missing required field in config: auth.site_url");
    }

    // config.go:1099-1109 + auth.go:58-71 — auth.captcha. The provider enum check runs FIRST,
    // regardless of `enabled` (it's actually a decode-time check in Go, reproduced here so both
    // callers see it from one place); only then does the `enabled`-gated presence check run.
    if (auth.captcha !== undefined) {
      const provider = auth.captcha.provider;
      if (
        provider !== undefined &&
        provider.length > 0 &&
        provider !== "hcaptcha" &&
        provider !== "turnstile"
      ) {
        throw new LegacyConfigValidateError(
          "failed to parse config: decoding failed due to the following error(s):\n\n'auth.captcha.provider' must be one of [hcaptcha turnstile]",
        );
      }
      if (auth.captcha.enabled) {
        if (auth.captcha.provider === undefined) {
          throw new LegacyConfigValidateError(
            "Missing required field in config: auth.captcha.provider",
          );
        }
        if (auth.captcha.secret === undefined || auth.captcha.secret.length === 0) {
          throw new LegacyConfigValidateError(
            "Missing required field in config: auth.captcha.secret",
          );
        }
      }
    }

    // config.go:1110-1116 — signing_keys read is caller-side I/O, not part of this function.

    // config.go:1117-1134 — auth.passkey / auth.webauthn. Caller only builds `passkey` when
    // `[auth.passkey] enabled` is true.
    if (auth.passkey !== undefined) {
      if (!auth.passkey.webauthnPresent) {
        throw new LegacyConfigValidateError(
          "Missing required config section: auth.webauthn (required when auth.passkey.enabled is true)",
        );
      }
      if (auth.passkey.rpId === undefined || auth.passkey.rpId.length === 0) {
        throw new LegacyConfigValidateError(
          "Missing required field in config: auth.webauthn.rp_id",
        );
      }
      if (auth.passkey.rpOrigins === undefined || auth.passkey.rpOrigins.length === 0) {
        throw new LegacyConfigValidateError(
          "Missing required field in config: auth.webauthn.rp_origins",
        );
      }
    }

    // config.go:1136-1138, checks @ 1453-1521 — auth.hook.*, caller pre-filtered to
    // enabled-only and pre-ordered per Go's fixed hook-type iteration order.
    for (const hook of auth.hooks) {
      if (hook.uri.length === 0) {
        throw new LegacyConfigValidateError(
          `Missing required field in config: auth.hook.${hook.type}.uri`,
        );
      }
      // Go calls `url.Parse` before the scheme switch (`config.go:1497-1499`) and fails the
      // whole load on a malformed URI (e.g. an unterminated IPv6 host like `http://[::1`) —
      // a bare scheme-prefix regex would accept that. Reuse `legacyGoUrlParse` (the same
      // `net/url.Parse` port already used for `studio.api_url` above) instead of re-deriving
      // a scheme by hand.
      let scheme: string;
      try {
        scheme = legacyGoUrlParse(hook.uri).scheme;
      } catch (cause) {
        throw new LegacyConfigValidateError(`failed to parse template url: ${messageOf(cause)}`);
      }
      if (scheme === "http" || scheme === "https") {
        if (hook.secrets.length === 0) {
          throw new LegacyConfigValidateError(
            `Missing required field in config: auth.hook.${hook.type}.secrets`,
          );
        }
        for (const secret of hook.secrets.split("|")) {
          if (!LEGACY_HOOK_SECRET_PATTERN.test(secret)) {
            throw new LegacyConfigValidateError(
              `Invalid hook config: auth.hook.${hook.type}.secrets must be formatted as "v1,whsec_<base64_encoded_secret>" with a minimum length of 32 characters.`,
            );
          }
        }
      } else if (scheme === "pg-functions") {
        if (hook.secrets.length > 0) {
          throw new LegacyConfigValidateError(
            `Invalid hook config: auth.hook.${hook.type}.secrets is unsupported for pg-functions URI`,
          );
        }
      } else {
        throw new LegacyConfigValidateError(
          `Invalid hook config: auth.hook.${hook.type}.uri should be a HTTP, HTTPS, or pg-functions URI`,
        );
      }
    }

    // config.go:1139-1141, checks @ 1523-1534 — auth.mfa.*, caller pre-ordered totp/phone/web_authn.
    for (const factor of auth.mfa) {
      if (factor.enrollEnabled && !factor.verifyEnabled) {
        throw new LegacyConfigValidateError(
          `Invalid MFA config: auth.mfa.${factor.label}.enroll_enabled requires verify_enabled`,
        );
      }
    }

    // config.go:1293-1323 — email template/notification content read + exclusivity is
    // caller-side, via legacyResolveEmailTemplateContentPath below.

    // config.go:1325-1344 — auth.email.smtp, gated on the raw table being present AND enabled.
    if (auth.smtp !== undefined && auth.smtp.enabled) {
      if (auth.smtp.host.length === 0) {
        throw new LegacyConfigValidateError(
          "Missing required field in config: auth.email.smtp.host",
        );
      }
      if (auth.smtp.port === 0) {
        throw new LegacyConfigValidateError(
          "Missing required field in config: auth.email.smtp.port",
        );
      }
      if (auth.smtp.user.length === 0) {
        throw new LegacyConfigValidateError(
          "Missing required field in config: auth.email.smtp.user",
        );
      }
      if (auth.smtp.pass.length === 0) {
        throw new LegacyConfigValidateError(
          "Missing required field in config: auth.email.smtp.pass",
        );
      }
      if (auth.smtp.adminEmail.length === 0) {
        throw new LegacyConfigValidateError(
          "Missing required field in config: auth.email.smtp.admin_email",
        );
      }
    }

    // config.go:1151-1153, checks @ 1635-1683 — auth.third_party.*, caller pre-filtered to
    // enabled-only and pre-ordered firebase, auth0, cognito, clerk, workos. Each provider's
    // required field(s) are checked as encountered; the "more than one enabled" check runs only
    // after every entry has individually validated.
    for (const thirdParty of auth.thirdParty) {
      switch (thirdParty.provider) {
        case "firebase": {
          if (thirdParty.requiredField.length === 0) {
            throw new LegacyConfigValidateError(
              "Invalid config: auth.third_party.firebase is enabled but without a project_id.",
            );
          }
          break;
        }
        case "auth0": {
          if (thirdParty.requiredField.length === 0) {
            throw new LegacyConfigValidateError(
              "Invalid config: auth.third_party.auth0 is enabled but without a tenant.",
            );
          }
          break;
        }
        case "cognito": {
          if (thirdParty.requiredField.length === 0) {
            throw new LegacyConfigValidateError(
              "Invalid config: auth.third_party.cognito is enabled but without a user_pool_id.",
            );
          }
          if (
            thirdParty.cognitoUserPoolRegion === undefined ||
            thirdParty.cognitoUserPoolRegion.length === 0
          ) {
            throw new LegacyConfigValidateError(
              "Invalid config: auth.third_party.cognito is enabled but without a user_pool_region.",
            );
          }
          break;
        }
        case "clerk": {
          if (thirdParty.requiredField.length === 0) {
            throw new LegacyConfigValidateError(
              "Invalid config: auth.third_party.clerk is enabled but without a domain.",
            );
          }
          if (!LEGACY_CLERK_DOMAIN_PATTERN.test(thirdParty.requiredField)) {
            throw new LegacyConfigValidateError(
              "Invalid config: auth.third_party.clerk has invalid domain, it usually is like clerk.example.com or example.clerk.accounts.dev. Check https://clerk.com/setup/supabase on how to find the correct value.",
            );
          }
          break;
        }
        case "workos": {
          if (thirdParty.requiredField.length === 0) {
            throw new LegacyConfigValidateError(
              "Invalid config: auth.third_party.workos is enabled but without a issuer_url.",
            );
          }
          break;
        }
      }
    }
    if (auth.thirdParty.length > 1) {
      throw new LegacyConfigValidateError(
        "Invalid config: Only one third_party provider allowed to be enabled at a time.",
      );
    }
  }

  // config.go:1159-1163, pattern @ 1539-1544 — every [functions.*] key, unconditional, not
  // gated on auth.enabled.
  for (const slug of input.functionSlugs) {
    if (!LEGACY_FUNCTION_SLUG_PATTERN.test(slug)) {
      throw new LegacyConfigValidateError(
        `Invalid Function name: ${slug}. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (${LEGACY_FUNCTION_SLUG_PATTERN.source})`,
      );
    }
  }

  // config.go:1164-1173 — edge_runtime.deno_version switch, unconditional, not gated on
  // edge_runtime.enabled.
  if (input.edgeRuntimeDenoVersion === 0) {
    throw new LegacyConfigValidateError(
      "Missing required field in config: edge_runtime.deno_version",
    );
  }
  if (input.edgeRuntimeDenoVersion !== 1 && input.edgeRuntimeDenoVersion !== 2) {
    throw new LegacyConfigValidateError(
      `Failed reading config: Invalid edge_runtime.deno_version: ${input.edgeRuntimeDenoVersion}.`,
    );
  }

  // Decode-time enum (`LogflareBackend.UnmarshalText`, config.go:60-65) — reproduced here so
  // both callers' env-override paths (which bypass their own decode-time schema guard) see it.
  const backend = input.analytics.backend;
  if (
    backend !== undefined &&
    backend.length > 0 &&
    backend !== "postgres" &&
    backend !== "bigquery"
  ) {
    throw new LegacyConfigValidateError(
      "failed to parse config: decoding failed due to the following error(s):\n\n'analytics.backend' must be one of [postgres bigquery]",
    );
  }
  // config.go:1175-1187 — analytics.gcp_*, gated on enabled && backend === "bigquery".
  if (input.analytics.enabled && backend === "bigquery") {
    if (input.analytics.gcpProjectId.length === 0) {
      throw new LegacyConfigValidateError(
        "Missing required field in config: analytics.gcp_project_id",
      );
    }
    if (input.analytics.gcpProjectNumber.length === 0) {
      throw new LegacyConfigValidateError(
        "Missing required field in config: analytics.gcp_project_number",
      );
    }
    if (input.analytics.gcpJwtPath.length === 0) {
      throw new LegacyConfigValidateError(
        "Path to GCP Service Account Key must be provided in config, relative to config.toml: analytics.gcp_jwt_path",
      );
    }
  }

  // config.go:1847-1848 — experimental.webhooks, hinges on TOML-section PRESENCE, not the
  // decoded (always-defaulted) `enabled` value.
  if (input.experimental.webhooksPresent === true && input.experimental.webhooksEnabled !== true) {
    throw new LegacyConfigValidateError(
      "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
    );
  }
  // config.go:1850-1851 — experimental.pgdelta.format_options, must be valid JSON when set.
  if (
    input.experimental.pgdeltaFormatOptions !== "" &&
    !isValidJson(input.experimental.pgdeltaFormatOptions)
  ) {
    throw new LegacyConfigValidateError(
      "Invalid config for experimental.pgdelta.format_options: must be valid JSON",
    );
  }
}

function isValidJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

// ── signing keys (config.go:1110-1116, path rule config.go:877-878 filepath.IsAbs guard) ──

/** Absolute → verbatim; relative → join(workdir, "supabase", p). */
export function legacyResolveSigningKeysPath(workdir: string, signingKeysPath: string): string {
  return isAbsolute(signingKeysPath) ? signingKeysPath : join(workdir, "supabase", signingKeysPath);
}

/** `failed to read signing keys: ${msg(cause)}` */
export function legacySigningKeysReadErrorMessage(cause: unknown): string {
  return `failed to read signing keys: ${messageOf(cause)}`;
}

/** `failed to decode signing keys: ${msg(cause)}` */
export function legacySigningKeysDecodeErrorMessage(cause: unknown): string {
  return `failed to decode signing keys: ${messageOf(cause)}`;
}
// D only asserts Array.isArray(JSON.parse(text)); L further decodes into LegacyJwk[] to sign
// with the first key — that JWK-specific decode/signing logic stays in L, unrelated to parity.

// ── email template / notification (config.go:1293-1323) ──

/**
 * Pure exclusivity decision + path to read for one template/notification entry. Throws
 * {@link LegacyConfigValidateError} with the exclusivity message when `contentPath === ""` and
 * `contentPresent`. Returns the absolute path to read, or `undefined` when there's nothing to
 * read (both `contentPath` and `content` absent — skip, not an error). `contentPath` set (even
 * when `content` is ALSO set) always wins — Go does not reject "both set", `content_path`
 * silently wins/overwrites.
 *
 * `base` is caller-resolved: TEMPLATE section → workdir; NOTIFICATION section →
 * join(workdir, "supabase") (this asymmetry is real, intentional Go behavior — config.go's own
 * FIXME comment flags it, do not "fix" it).
 */
export function legacyResolveEmailTemplateContentPath(args: {
  readonly section: "template" | "notification";
  readonly name: string;
  /** Post-env-expand; `""` = absent. */
  readonly contentPath: string;
  /** Raw `content` key present in the TOML document. */
  readonly contentPresent: boolean;
  readonly base: string;
}): string | undefined {
  if (args.contentPath.length === 0) {
    if (args.contentPresent) {
      throw new LegacyConfigValidateError(
        `Invalid config for auth.email.${args.section}.${args.name}.content: please use content_path instead`,
      );
    }
    return undefined;
  }
  return isAbsolute(args.contentPath) ? args.contentPath : join(args.base, args.contentPath);
}

/** `Invalid config for auth.email.${section}.${name}.content_path: ${msg(cause)}` */
export function legacyEmailContentPathReadErrorMessage(
  section: "template" | "notification",
  name: string,
  cause: unknown,
): string {
  return `Invalid config for auth.email.${section}.${name}.content_path: ${messageOf(cause)}`;
}

// ── api.tls cert/key (config.go:1016-1026, path rule ~961-965, NO isAbsolute guard) ──

/** Unconditional join(workdir, "supabase", p) — Go's path.Join absorbs a leading "/" too. */
export function legacyResolveApiTlsPath(workdir: string, p: string): string {
  return join(workdir, "supabase", p);
}

/** `failed to read TLS cert: ${msg(cause)}` */
export function legacyApiTlsCertReadErrorMessage(cause: unknown): string {
  return `failed to read TLS cert: ${messageOf(cause)}`;
}

/** `failed to read TLS key: ${msg(cause)}` */
export function legacyApiTlsKeyReadErrorMessage(cause: unknown): string {
  return `failed to read TLS key: ${messageOf(cause)}`;
}
