import { lstatSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityFingerprintId,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { BRANCH_PROJECT_REF_PATTERN } from "./ref-patterns.ts";
import { goUrlParse } from "./storage-url.ts";

/**
 * Single home for config validation, shared by the two config readers:
 *
 * - **D** = `db-config.toml-read.ts`: raw TOML document, Effect-based, fails with
 *   `DbConfigLoadError`.
 * - **L** = `local-config-values.ts`: decoded `@supabase/config` `CliConfig`, synchronous,
 *   throws `Error`.
 *
 * Per-command reimplementations of any branch {@link validateResolvedConfig} owns are forbidden;
 * hoist here instead. A few branches stay caller-only: `remotes[*].project_id` and
 * `auth.sms`/`auth.external` need the raw pre-decode document, and `auth.jwt_secret` length lives
 * in each key-generation flow. Each reader calls {@link validateResolvedConfig} once, after its
 * own I/O reads, so an error from a branch here surfaces before a caller-only I/O error.
 */

// Re-exported under this module's established name; `ref-patterns.ts` is the canonical
// definition. The `remotes[*].project_id` check itself stays D-only.
export const PROJECT_REF_PATTERN = BRANCH_PROJECT_REF_PATTERN;

// Storage bucket-name pattern; `.source` is reused verbatim in the error message.
// Shared by D and L, and internally by {@link validateResolvedConfig}'s storage-bucket-names step.
export const BUCKET_NAME_PATTERN = /^(\w|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$/;

// Function-slug pattern; `.source` is reused verbatim in the error message.
// Shared by D and L, and internally by {@link validateResolvedConfig}'s function-slugs step.
export const FUNCTION_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

// Shared by D and L, and internally by {@link validateResolvedConfig}'s hooks step.
export const HOOK_SECRET_PATTERN = /^v1,whsec_[A-Za-z0-9+/=]{32,88}$/u;

// Shared by D and L, and internally by {@link validateResolvedConfig}'s third_party step.
export const CLERK_DOMAIN_PATTERN =
  /^(clerk([.][a-z0-9-]+){2,}|([a-z0-9-]+[.])+clerk[.]accounts[.]dev)$/u;

// Accepted boolean string forms, matching Go's `strconv.ParseBool`; any other value is a
// parse error.
const GO_BOOL_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const GO_BOOL_FALSE = new Set(["0", "f", "F", "FALSE", "false", "False", ""]);

/**
 * Parses a config bool value: accepts the same string forms as `strconv.ParseBool`, returns
 * `undefined` for anything else (surfaced by callers as a `failed to parse config` error).
 * Used by both D and L for `SUPABASE_*` bool-flavored env overrides and TOML bool decoding.
 */
export function parseGoBool(value: string): boolean | undefined {
  if (GO_BOOL_TRUE.has(value)) return true;
  if (GO_BOOL_FALSE.has(value)) return false;
  return undefined;
}

/**
 * Thrown by {@link validateResolvedConfig}. Does not override `.name` — it stays the inherited
 * `"Error"` — so `instanceof Error` and `.name` checks can't distinguish it from a plain
 * `Error`; only `.message` is meant to be observed.
 */
export class ConfigValidateError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "ConfigValidateError";
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** One `[api.tls]` section, post-env-override. See {@link ConfigValidationInput}. */
export interface ApiInput {
  readonly enabled: boolean;
  readonly port: number;
  readonly tls: {
    readonly enabled: boolean;
    readonly certPath: string | undefined;
    readonly keyPath: string | undefined;
  };
}

/** `[db]`, post-env-override. `db.port`/`db.major_version` are always validated, unconditionally. */
export interface DbInput {
  readonly port: number;
  readonly majorVersion: number;
}

/** `[studio]`, post-env-override. L-only — D has no studio section. */
export interface StudioInput {
  readonly enabled: boolean;
  readonly port: number;
  readonly apiUrl: string;
}

/** `[local_smtp]` (`Inbucket`), post-env-override. L-only. */
export interface LocalSmtpInput {
  readonly enabled: boolean;
  readonly port: number;
}

/** `[auth.captcha]`. `provider` is `string | undefined`, not a narrow union: D passes a raw,
 * untyped TOML string (the enum check is live for D), while L's already schema-narrowed
 * `"hcaptcha" | "turnstile" | undefined` value makes the same check a no-op for L.
 */
export interface CaptchaInput {
  readonly enabled: boolean;
  readonly provider: string | undefined;
  readonly secret: string | undefined;
}

/** `[auth.passkey]` + `[auth.webauthn]`. Present iff `passkey.enabled === true`. */
export interface PasskeyInput {
  readonly webauthnPresent: boolean;
  readonly rpId: string | undefined;
  readonly rpOrigins: ReadonlyArray<unknown> | undefined;
}

/** One enabled `[auth.hook.<type>]` entry. Caller pre-filters to enabled-only and pre-orders
 * per the established hook-type iteration order. */
export interface HookInput {
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
export interface MfaFactorInput {
  readonly label: "totp" | "phone" | "web_authn";
  readonly enrollEnabled: boolean;
  readonly verifyEnabled: boolean;
}

/** `[auth.email.smtp]`. Present iff the raw TOML table itself is present (this section's
 * presence-based `enabled` default, not the decoded, always-defaulted value). */
export interface SmtpInput {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly adminEmail: string;
}

/** One enabled `[auth.third_party.<provider>]` entry. Caller pre-filters to enabled-only and
 * pre-orders per the fixed provider order (firebase, auth0, cognito, clerk, workos). */
export interface ThirdPartyInput {
  readonly provider: "firebase" | "auth0" | "cognito" | "clerk" | "workos";
  /** `project_id` / `tenant` / `user_pool_id` / `domain` / `issuer_url`, per provider. */
  readonly requiredField: string;
  /** cognito's second required field only. */
  readonly cognitoUserPoolRegion?: string;
}

/** `[auth]`. Present in {@link ConfigValidationInput} iff auth is enabled — this
 * gate wraps this entire sub-sequence. */
export interface AuthInput {
  readonly siteUrl: string;
  readonly captcha?: CaptchaInput;
  readonly passkey?: PasskeyInput;
  readonly hooks: ReadonlyArray<HookInput>;
  readonly mfa: ReadonlyArray<MfaFactorInput>;
  readonly smtp?: SmtpInput;
  readonly thirdParty: ReadonlyArray<ThirdPartyInput>;
}

/** `[analytics]`, post-env-override. Unconditional entry — internally gated on `enabled` +
 * `backend === "bigquery"`. `backend` is `string | undefined` for the same dead-but-harmless-for-L
 * reason as {@link CaptchaInput.provider} — see divergence #2. */
export interface AnalyticsInput {
  readonly enabled: boolean;
  readonly backend: string | undefined;
  readonly gcpProjectId: string;
  readonly gcpProjectNumber: string;
  readonly gcpJwtPath: string;
}

/** `[experimental]`. Unconditional entry — internally gated. `webhooksPresent`/`webhooksEnabled`
 * hinge on TOML-section presence, not the decoded, always-defaulted `enabled` value. */
export interface ExperimentalInput {
  readonly webhooksPresent?: boolean;
  readonly webhooksEnabled?: boolean;
  readonly pgdeltaFormatOptions: string;
}

/**
 * Normalized post-env-override primitives for validated fields only. Every section is
 * optional — an absent section means this caller doesn't run that branch (e.g. D omits
 * `studio`/`localSmtp` entirely; both D and L omit `auth` when auth is disabled).
 */
export interface ConfigValidationInput {
  /** L only — D doesn't validate `project_id` here. */
  readonly projectId?: string;
  /** L only — D has no `[api]` section. */
  readonly api?: ApiInput;
  /** Both, always validated. */
  readonly db: DbInput;
  /** Both, unconditional (`[]` = none). */
  readonly storageBucketNames: ReadonlyArray<string>;
  /** L only. */
  readonly studio?: StudioInput;
  /** L only. */
  readonly localSmtp?: LocalSmtpInput;
  /** Both, present iff auth is enabled. */
  readonly auth?: AuthInput;
  /** Both, unconditional (`[]` = none). */
  readonly functionSlugs: ReadonlyArray<string>;
  /** Both, unconditional. */
  readonly edgeRuntimeDenoVersion: number;
  /** Both, unconditional entry (internally gated). */
  readonly analytics: AnalyticsInput;
  /** Both, unconditional entry (internally gated). */
  readonly experimental: ExperimentalInput;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The canonical `api.port` branch: an enabled API with a port of `0` is
 * invalid config. Exported so the storage-credentials resolver
 * (`resolveLocalApiConfig`) shares the exact branch and message instead of
 * re-implementing them — config validation has one home (see the module
 * header and `config-validate.parity.unit.test.ts`).
 */
export function validateApiPort(enabled: boolean, port: number): void {
  if (enabled && port === 0) {
    throw new ConfigValidateError("Missing required field in config: api.port");
  }
}

/**
 * The canonical `api.tls` cert/key presence rule: exactly one of the two paths
 * set is invalid config. Exported for the same single-home reason as
 * {@link validateApiPort}; the actual cert/key file reads stay
 * caller-side I/O.
 */
export function validateApiTlsPresence(
  certPath: string | undefined,
  keyPath: string | undefined,
): void {
  const hasCert = certPath !== undefined && certPath.length > 0;
  const hasKey = keyPath !== undefined && keyPath.length > 0;
  if (hasCert && !hasKey) {
    throw new ConfigValidateError("Missing required field in config: api.tls.key_path");
  }
  if (hasKey && !hasCert) {
    throw new ConfigValidateError("Missing required field in config: api.tls.cert_path");
  }
}

/**
 * Runs every validation branch this module owns, in established first-failure-wins order.
 * Pure — no I/O, no Effect. Callers own their own per-section I/O reads (signing keys,
 * `api.tls` cert/key, email template/notification content) at the correct position
 * themselves, using the pure helpers exported below.
 */
export function validateResolvedConfig(input: ConfigValidationInput): void {
  if (input.projectId !== undefined && input.projectId.length === 0) {
    throw new ConfigValidateError("Missing required field in config: project_id");
  }

  // The actual cert/key file reads are caller-side I/O; this only checks the "exactly one of
  // cert/key set" presence rule.
  if (input.api?.enabled) {
    validateApiPort(input.api.enabled, input.api.port);
    if (input.api.tls.enabled) {
      validateApiTlsPresence(input.api.tls.certPath, input.api.tls.keyPath);
    }
  }

  if (input.db.port === 0) {
    throw new ConfigValidateError("Missing required field in config: db.port");
  }
  if (input.db.majorVersion === 0) {
    throw new ConfigValidateError("Missing required field in config: db.major_version");
  }
  if (input.db.majorVersion === 12) {
    throw new ConfigValidateError(
      "Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.",
    );
  }
  if (![13, 14, 15, 17].includes(input.db.majorVersion)) {
    throw new ConfigValidateError(
      `Failed reading config: Invalid db.major_version: ${input.db.majorVersion}.`,
    );
  }

  for (const name of input.storageBucketNames) {
    if (!BUCKET_NAME_PATTERN.test(name)) {
      throw new ConfigValidateError(
        `Invalid Bucket name: ${name}. Only lowercase letters, numbers, dots, hyphens, and spaces are allowed. (${BUCKET_NAME_PATTERN.source})`,
      );
    }
  }

  if (input.studio?.enabled) {
    if (input.studio.port === 0) {
      throw new ConfigValidateError("Missing required field in config: studio.port");
    }
    try {
      goUrlParse(input.studio.apiUrl);
    } catch (cause) {
      throw new ConfigValidateError(`Invalid config for studio.api_url: ${messageOf(cause)}`);
    }
  }

  if (input.localSmtp?.enabled && input.localSmtp.port === 0) {
    throw new ConfigValidateError("Missing required field in config: local_smtp.port");
  }

  if (input.auth !== undefined) {
    const auth = input.auth;

    if (auth.siteUrl.length === 0) {
      throw new ConfigValidateError("Missing required field in config: auth.site_url");
    }

    // The provider enum check runs before the `enabled` check since it's conceptually a
    // decode-time check, reproduced here so both callers see it from one place.
    if (auth.captcha !== undefined) {
      const provider = auth.captcha.provider;
      if (
        provider !== undefined &&
        provider.length > 0 &&
        provider !== "hcaptcha" &&
        provider !== "turnstile"
      ) {
        throw new ConfigValidateError(
          "failed to parse config: decoding failed due to the following error(s):\n\n'auth.captcha.provider' must be one of [hcaptcha turnstile]",
        );
      }
      if (auth.captcha.enabled) {
        if (auth.captcha.provider === undefined) {
          throw new ConfigValidateError("Missing required field in config: auth.captcha.provider");
        }
        if (auth.captcha.secret === undefined || auth.captcha.secret.length === 0) {
          throw new ConfigValidateError("Missing required field in config: auth.captcha.secret");
        }
      }
    }

    // signing_keys read is caller-side I/O, not part of this function.

    // Caller only builds `passkey` when `[auth.passkey] enabled` is true.
    if (auth.passkey !== undefined) {
      if (!auth.passkey.webauthnPresent) {
        throw new ConfigValidateError(
          "Missing required config section: auth.webauthn (required when auth.passkey.enabled is true)",
        );
      }
      if (auth.passkey.rpId === undefined || auth.passkey.rpId.length === 0) {
        throw new ConfigValidateError("Missing required field in config: auth.webauthn.rp_id");
      }
      if (auth.passkey.rpOrigins === undefined || auth.passkey.rpOrigins.length === 0) {
        throw new ConfigValidateError("Missing required field in config: auth.webauthn.rp_origins");
      }
    }

    // Caller pre-filters to enabled-only hooks, pre-ordered by the fixed hook-type sequence.
    for (const hook of auth.hooks) {
      if (hook.uri.length === 0) {
        throw new ConfigValidateError(
          `Missing required field in config: auth.hook.${hook.type}.uri`,
        );
      }
      // Uses `goUrlParse`'s stricter semantics (the same port used for `studio.api_url`
      // above) so a malformed URI like an unterminated IPv6 host (`http://[::1`) fails the
      // whole load instead of passing a bare scheme-prefix regex.
      let scheme: string;
      try {
        scheme = goUrlParse(hook.uri).scheme;
      } catch (cause) {
        throw new ConfigValidateError(`failed to parse template url: ${messageOf(cause)}`);
      }
      if (scheme === "http" || scheme === "https") {
        if (hook.secrets.length === 0) {
          throw new ConfigValidateError(
            `Missing required field in config: auth.hook.${hook.type}.secrets`,
          );
        }
        for (const secret of hook.secrets.split("|")) {
          if (!HOOK_SECRET_PATTERN.test(secret)) {
            throw new ConfigValidateError(
              `Invalid hook config: auth.hook.${hook.type}.secrets must be formatted as "v1,whsec_<base64_encoded_secret>" with a minimum length of 32 characters.`,
            );
          }
        }
      } else if (scheme === "pg-functions") {
        if (hook.secrets.length > 0) {
          throw new ConfigValidateError(
            `Invalid hook config: auth.hook.${hook.type}.secrets is unsupported for pg-functions URI`,
          );
        }
      } else {
        throw new ConfigValidateError(
          `Invalid hook config: auth.hook.${hook.type}.uri should be a HTTP, HTTPS, or pg-functions URI`,
        );
      }
    }

    for (const factor of auth.mfa) {
      if (factor.enrollEnabled && !factor.verifyEnabled) {
        throw new ConfigValidateError(
          `Invalid MFA config: auth.mfa.${factor.label}.enroll_enabled requires verify_enabled`,
        );
      }
    }

    // Email template/notification content read + exclusivity check is caller-side, via
    // resolveEmailTemplateContentPath below.

    if (auth.smtp !== undefined && auth.smtp.enabled) {
      if (auth.smtp.host.length === 0) {
        throw new ConfigValidateError("Missing required field in config: auth.email.smtp.host");
      }
      if (auth.smtp.port === 0) {
        throw new ConfigValidateError("Missing required field in config: auth.email.smtp.port");
      }
      if (auth.smtp.user.length === 0) {
        throw new ConfigValidateError("Missing required field in config: auth.email.smtp.user");
      }
      if (auth.smtp.pass.length === 0) {
        throw new ConfigValidateError("Missing required field in config: auth.email.smtp.pass");
      }
      if (auth.smtp.adminEmail.length === 0) {
        throw new ConfigValidateError(
          "Missing required field in config: auth.email.smtp.admin_email",
        );
      }
    }

    // Caller pre-filters to enabled-only providers, pre-ordered firebase/auth0/cognito/clerk/
    // workos. Each provider's required fields are checked as encountered; "more than one
    // enabled" is checked only after every entry validates individually.
    for (const thirdParty of auth.thirdParty) {
      switch (thirdParty.provider) {
        case "firebase": {
          if (thirdParty.requiredField.length === 0) {
            throw new ConfigValidateError(
              "Invalid config: auth.third_party.firebase is enabled but without a project_id.",
            );
          }
          break;
        }
        case "auth0": {
          if (thirdParty.requiredField.length === 0) {
            throw new ConfigValidateError(
              "Invalid config: auth.third_party.auth0 is enabled but without a tenant.",
            );
          }
          break;
        }
        case "cognito": {
          if (thirdParty.requiredField.length === 0) {
            throw new ConfigValidateError(
              "Invalid config: auth.third_party.cognito is enabled but without a user_pool_id.",
            );
          }
          if (
            thirdParty.cognitoUserPoolRegion === undefined ||
            thirdParty.cognitoUserPoolRegion.length === 0
          ) {
            throw new ConfigValidateError(
              "Invalid config: auth.third_party.cognito is enabled but without a user_pool_region.",
            );
          }
          break;
        }
        case "clerk": {
          if (thirdParty.requiredField.length === 0) {
            throw new ConfigValidateError(
              "Invalid config: auth.third_party.clerk is enabled but without a domain.",
            );
          }
          if (!CLERK_DOMAIN_PATTERN.test(thirdParty.requiredField)) {
            throw new ConfigValidateError(
              "Invalid config: auth.third_party.clerk has invalid domain, it usually is like clerk.example.com or example.clerk.accounts.dev. Check https://clerk.com/setup/supabase on how to find the correct value.",
            );
          }
          break;
        }
        case "workos": {
          if (thirdParty.requiredField.length === 0) {
            throw new ConfigValidateError(
              "Invalid config: auth.third_party.workos is enabled but without a issuer_url.",
            );
          }
          break;
        }
      }
    }
    if (auth.thirdParty.length > 1) {
      throw new ConfigValidateError(
        "Invalid config: Only one third_party provider allowed to be enabled at a time.",
      );
    }
  }

  for (const slug of input.functionSlugs) {
    if (!FUNCTION_SLUG_PATTERN.test(slug)) {
      throw new ConfigValidateError(
        `Invalid Function name: ${slug}. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (${FUNCTION_SLUG_PATTERN.source})`,
      );
    }
  }

  if (input.edgeRuntimeDenoVersion === 0) {
    throw new ConfigValidateError("Missing required field in config: edge_runtime.deno_version");
  }
  if (input.edgeRuntimeDenoVersion !== 1 && input.edgeRuntimeDenoVersion !== 2) {
    throw new ConfigValidateError(
      `Failed reading config: Invalid edge_runtime.deno_version: ${input.edgeRuntimeDenoVersion}.`,
    );
  }

  // Decode-time enum, reproduced here so both callers' env-override paths (which bypass
  // their own decode-time schema guard) see it.
  const backend = input.analytics.backend;
  if (
    backend !== undefined &&
    backend.length > 0 &&
    backend !== "postgres" &&
    backend !== "bigquery"
  ) {
    throw new ConfigValidateError(
      "failed to parse config: decoding failed due to the following error(s):\n\n'analytics.backend' must be one of [postgres bigquery]",
    );
  }
  if (input.analytics.enabled && backend === "bigquery") {
    if (input.analytics.gcpProjectId.length === 0) {
      throw new ConfigValidateError("Missing required field in config: analytics.gcp_project_id");
    }
    if (input.analytics.gcpProjectNumber.length === 0) {
      throw new ConfigValidateError(
        "Missing required field in config: analytics.gcp_project_number",
      );
    }
    if (input.analytics.gcpJwtPath.length === 0) {
      throw new ConfigValidateError(
        "Path to GCP Service Account Key must be provided in config, relative to config.toml: analytics.gcp_jwt_path",
      );
    }
  }

  if (input.experimental.webhooksPresent === true && input.experimental.webhooksEnabled !== true) {
    throw new ConfigValidateError(
      "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
    );
  }
  if (
    input.experimental.pgdeltaFormatOptions !== "" &&
    !isValidJson(input.experimental.pgdeltaFormatOptions)
  ) {
    throw new ConfigValidateError(
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

/** Absolute → verbatim; relative → join(workdir, "supabase", p). */
export function resolveSigningKeysPath(workdir: string, signingKeysPath: string): string {
  return isAbsolute(signingKeysPath) ? signingKeysPath : join(workdir, "supabase", signingKeysPath);
}

/** `failed to read signing keys: ${msg(cause)}` */
export function signingKeysReadErrorMessage(cause: unknown): string {
  return `failed to read signing keys: ${messageOf(cause)}`;
}

/** `failed to decode signing keys: ${msg(cause)}` */
export function signingKeysDecodeErrorMessage(cause: unknown): string {
  return `failed to decode signing keys: ${messageOf(cause)}`;
}
// D only asserts Array.isArray(JSON.parse(text)); L further decodes into Jwk[] to sign
// with the first key — that JWK-specific decode/signing logic stays in L.

/**
 * Whether `candidatePath` resolves inside (or exactly to) `root`. Both
 * arguments must already be canonicalized (see `canonicalPathForContainment`).
 * Only rejects a genuine `..` traversal — a same-level sibling whose name
 * happens to start with two dots (e.g. `..templates`) is a distinct,
 * in-root path and must not be rejected.
 */
function isPathContainedInRoot(root: string, candidatePath: string): boolean {
  const rel = relative(root, candidatePath);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

// `readlinkSync` bypasses the OS's own `ELOOP` symlink-cycle detection when
// manually following a dangling/unsearchable/looping symlink one hop at a
// time (see `canonicalizeExistingPath` below), so that manual follow needs
// its own explicit bound.
const MAX_SYMLINK_FOLLOW_DEPTH = 40;

/**
 * Canonicalizes `path` when it exists (per `lstatSync`), or returns `undefined` so
 * {@link canonicalPathForContainment} keeps walking up to an existing ancestor.
 *
 * `realpathSync` can throw for a path that exists (dangling symlink, `EACCES` target, `ELOOP`),
 * so such a symlink is followed one hop by hand, bounded by {@link MAX_SYMLINK_FOLLOW_DEPTH},
 * and its target canonicalized in turn; a chain still unresolved at the bound returns the lexical
 * path so a loop is rejected rather than accepted. An `lstatSync` failure unrelated to the path
 * itself (unreadable ancestor, over-long name) counts as "doesn't exist yet", so an honest in-root
 * path behind a restricted ancestor isn't falsely rejected.
 */
function canonicalizeExistingPath(path: string, depth: number): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    // Wraps only the `lstatSync` call, not the recursive canonicalization below it: including
    // that would let a deep throw there return the outer symlink's own lexically-in-root path,
    // turning a rejection into an accept.
    let entry: Stats | undefined;
    try {
      entry = lstatSync(path, { throwIfNoEntry: false });
    } catch {
      return undefined;
    }
    if (entry === undefined) return undefined;
    if (entry.isSymbolicLink()) {
      if (depth < MAX_SYMLINK_FOLLOW_DEPTH) {
        const target = readlinkSync(path);
        return canonicalPathForContainment(
          isAbsolute(target) ? target : join(dirname(path), target),
          depth + 1,
        );
      }
      // Must not be treated as "doesn't exist": returning `undefined` here would let the
      // ancestor walk-up canonicalize past the whole unresolvable loop and silently accept it
      // instead of failing closed.
      return path;
    }
    // A non-symlink entry `lstat` can see but `realpath` can't resolve — e.g. a chmod-000
    // directory on Darwin, whose realpath(3) needs search permission on itself, not just its
    // parent. Deferred to the same "doesn't exist yet" ancestor walk-up as a genuinely missing
    // path, since a plain entry can't recurse into a loop.
    return undefined;
  }
}

/**
 * Canonicalizes `path` for the containment check, tolerating a path (or an ancestor of it)
 * that genuinely doesn't exist yet — the normal case for a missing template file, which
 * should surface as a missing-file error, not a containment error. Walks up to the deepest
 * existing ancestor, resolves it with `realpathSync` (dereferencing any symlinks, including a
 * symlinked project root itself), then re-appends the missing tail lexically. The walk-up is
 * iterative, not recursive, so it stays correct against a pathologically long chain of missing
 * ancestors; each ancestor still goes through {@link canonicalizeExistingPath}, so an
 * intermediate dangling/unsearchable/looping symlink is followed rather than lexically
 * skipped.
 */
function canonicalPathForContainment(path: string, depth = 0): string {
  const canonical = canonicalizeExistingPath(path, depth);
  if (canonical !== undefined) return canonical;

  const tail: string[] = [basename(path)];
  let current = dirname(path);
  for (;;) {
    const ancestorCanonical = canonicalizeExistingPath(current, depth);
    if (ancestorCanonical !== undefined) {
      return tail.reduceRight((acc, name) => join(acc, name), ancestorCanonical);
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(tail.reduceRight((acc, name) => join(acc, name), current));
    }
    tail.push(basename(current));
    current = parent;
  }
}

/**
 * Pure exclusivity decision plus the path to read for one template/notification entry. Throws
 * {@link ConfigValidateError} when `contentPath === ""` and `contentPresent` (`content_path`
 * is required instead of `content`). Returns the absolute, canonicalized path to read, or
 * `undefined` when there's nothing to read; a set `contentPath` always wins over `content`
 * silently — "both set" is never rejected as a conflict.
 *
 * The resolved candidate and `base` are both canonicalized and the candidate must resolve
 * inside `base` — an absolute path, a `..` escape, or an in-root symlink pointing outside the
 * project root all throw. This applies unconditionally to every caller (config validation,
 * `config push` content loading, `start`'s pre-Docker containment pass) — there is no opt-out.
 */
export function resolveEmailTemplateContentPath(args: {
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
      throw new ConfigValidateError(
        `Invalid config for auth.email.${args.section}.${args.name}.content: please use content_path instead`,
      );
    }
    return undefined;
  }
  const candidate =
    args.section === "notification"
      ? resolveNotificationContentPath(args.base, args.contentPath)
      : isAbsolute(args.contentPath)
        ? args.contentPath
        : join(args.base, args.contentPath);
  const resolvedCanonical = canonicalPathForContainment(candidate);
  const canonicalBase = canonicalPathForContainment(args.base);
  if (!isPathContainedInRoot(canonicalBase, resolvedCanonical)) {
    // Echoes the declared value, not `resolvedCanonical` — the declared value is already known
    // to the user (it's literally in config.toml or an env override they set), while echoing
    // the symlink-dereferenced target back would let a hostile config probe where it resolves.
    throw new ConfigValidateError(
      `Invalid config for auth.email.${args.section}.${args.name}.content_path: ` +
        `"${args.contentPath}" resolves outside the project root ${args.base} — ` +
        `move the file inside the project, or use a relative path that stays inside it.`,
    );
  }
  return resolvedCanonical;
}

/**
 * Notification `content_path` resolution with a legacy fallback: older scaffolds documented
 * these paths relative to `supabase/` (file at `<root>/supabase/templates/...`, config says
 * `./templates/...`). Project-root resolution is canonical; when that file is confirmed
 * missing but the supabase-relative one exists, the legacy path wins so old configs keep
 * working. An unverifiable candidate at either path never triggers the fallback (see
 * {@link probeFile}). Shared by config validation, `config push` content loading, and the Kong
 * template mount builder so every consumer sees the same file.
 */
function resolveNotificationContentPath(base: string, contentPath: string): string {
  if (isAbsolute(contentPath)) return contentPath;
  const resolved = join(base, contentPath);
  if (probeFile(resolved) === "missing") {
    const fallbackResolved = join(base, "supabase", contentPath);
    if (probeFile(fallbackResolved) === "exists") return fallbackResolved;
  }
  return resolved;
}

/**
 * Tri-state existence probe for the notification legacy-fallback decision above: `"exists"`
 * (a confirmed regular file), `"missing"` (confirmed absent, or a directory at this path), or
 * `"unknown"` (any other stat failure — EACCES, ELOOP, ...). The two call sites need opposite
 * defaults for `"unknown"`: the root-resolved path must stay selected on `"unknown"` (an
 * unreadable file must not be silently abandoned for its legacy twin), while the legacy twin
 * must only be selected on a confirmed `"exists"`. A single boolean can't express both
 * defaults, so the tri-state lets each caller choose.
 */
function probeFile(path: string): "exists" | "missing" | "unknown" {
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats === undefined) return "missing";
    return stats.isFile() ? "exists" : "missing";
  } catch {
    return "unknown";
  }
}

/** `Invalid config for auth.email.${section}.${name}.content_path: ${msg(cause)}` */
export function emailContentPathReadErrorMessage(
  section: "template" | "notification",
  name: string,
  cause: unknown,
): string {
  return `Invalid config for auth.email.${section}.${name}.content_path: ${messageOf(cause)}`;
}

// ── api.tls cert/key (path rule: NO isAbsolute guard) ──

/** Unconditional join(workdir, "supabase", p) — `path.Join` absorbs a leading "/" too. */
export function resolveApiTlsPath(workdir: string, p: string): string {
  return join(workdir, "supabase", p);
}

/** `failed to read TLS cert: ${msg(cause)}` */
export function apiTlsCertReadErrorMessage(cause: unknown): string {
  return `failed to read TLS cert: ${messageOf(cause)}`;
}

/** `failed to read TLS key: ${msg(cause)}` */
export function apiTlsKeyReadErrorMessage(cause: unknown): string {
  return `failed to read TLS key: ${messageOf(cause)}`;
}
