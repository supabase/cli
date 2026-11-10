import { Data, Effect, FileSystem, Path, type PlatformError } from "effect";

import type { CliConfig } from "@supabase/config";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityFingerprintId,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { canonicalPathForContainment, isPathContainedInRoot } from "./path-containment.ts";
import { BRANCH_PROJECT_REF_PATTERN } from "./ref-patterns.ts";
import type { ResolvedAuthExternalProvider } from "./local-config-values.ts";
import { parseUrl } from "./storage-url.ts";

/**
 * Single home for config validation, shared by the two config readers:
 *
 * - **D** = `db-config.read.ts`: raw TOML document, Effect-based, fails with
 *   `DbConfigLoadError`.
 * - **L** = `local-config-values.ts`: decoded `@supabase/config` `CliConfig`, Effect-based,
 *   fails with an `Error`.
 *
 * Per-command reimplementations of any branch {@link validateResolvedConfig} owns are forbidden;
 * hoist here instead. A few branches stay caller-only: `remotes[*].project_id` needs the raw
 * pre-decode document, and `auth.jwt_secret` length lives in each key-generation flow. Each reader
 * calls {@link validateResolvedConfig} once, after its own I/O reads, so an error from a branch
 * here surfaces before a caller-only I/O error. {@link validateAuthSmsProviders} and
 * {@link validateAuthExternalProviders} are separate calls taking already-resolved inputs.
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

/**
 * Raised by {@link validateResolvedConfig} (thrown) and by the `content_path`/secret resolvers
 * (failed). Does not override `.name` — it stays the inherited
 * `"Error"` — so `instanceof Error` and `.name` checks can't distinguish it from a plain
 * `Error`; only `.message` is meant to be observed.
 */
export class ConfigValidateError extends Data.Error<{ readonly message: string }> {
  static readonly [ErrorActionabilityFingerprintId] = "ConfigValidateError";
  constructor(message: string) {
    super({ message });
  }
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
  /** The config file's name for messages that name it; defaults to `config.toml`. */
  readonly configFileName?: string;
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

/** The `node:fs` error behind a `FileSystem` failure, whose message the config errors quote. */
export const fsErrorCause = (error: PlatformError.PlatformError): unknown =>
  error.reason.cause ?? error.reason.description;

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
  const missing = missingApiTlsPath(certPath, keyPath);
  if (missing !== undefined) {
    throw new ConfigValidateError(`Missing required field in config: ${missing}`);
  }
}

/** The `api.tls` path that is unset while its counterpart is set, if any. */
export function missingApiTlsPath(
  certPath: string | undefined,
  keyPath: string | undefined,
): "api.tls.cert_path" | "api.tls.key_path" | undefined {
  const hasCert = certPath !== undefined && certPath.length > 0;
  const hasKey = keyPath !== undefined && keyPath.length > 0;
  if (hasCert && !hasKey) return "api.tls.key_path";
  if (hasKey && !hasCert) return "api.tls.cert_path";
  return undefined;
}

export type ConfigValidationIssueCode =
  | "missing_required"
  | "invalid_value"
  | "invalid_type"
  | "invalid_enum";

/**
 * One validation failure and the config key path it belongs to. `message` is the legacy text the
 * throwing wrappers raise; `reason` and `help` are value-free and meant for `config validate`.
 */
export interface ConfigValidationIssue {
  readonly path: string;
  /** The key path split by segment, when a segment (such as a bucket name) can contain dots. */
  readonly segments?: ReadonlyArray<string>;
  readonly message: string;
  readonly code: ConfigValidationIssueCode;
  readonly reason: string;
  readonly help?: string;
}

const lastSegment = (path: string): string => path.split(".").at(-1) ?? path;
const parentOf = (path: string): string => path.split(".").slice(0, -1).join(".");

const GATE_PATTERNS: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [/^auth\.email\.smtp\./, () => "auth.email.smtp.enabled"],
  [/^auth\.captcha\./, () => "auth.captcha.enabled"],
  [/^auth\.webauthn\./, () => "auth.passkey.enabled"],
  [/^auth\.sms\.(\w+)\./, (match) => `auth.sms.${match[1]}.enabled`],
  [/^auth\.external\.([^.]+)\./, (match) => `auth.external.${match[1]}.enabled`],
  [/^auth\.third_party\.(\w+)\./, (match) => `auth.third_party.${match[1]}.enabled`],
  [/^auth\.hook\.(\w+)\./, (match) => `auth.hook.${match[1]}.enabled`],
  [/^analytics\./, () => "analytics.enabled"],
  [/^api\.tls\./, () => "api.tls.enabled"],
  [/^(api|studio|local_smtp)\.port$/, (match) => `${match[1]}.enabled`],
];

const gateOf = (path: string): string | undefined => {
  for (const [pattern, gate] of GATE_PATTERNS) {
    const match = pattern.exec(path);
    if (match !== null) return gate(match);
  }
  return undefined;
};

/** A required key that is empty or absent; the `enabled` switch that makes it required is inferred from the path. */
export function missingIssue(
  path: string,
  message: string,
  gate: string | undefined = gateOf(path),
): ConfigValidationIssue {
  return gate === undefined
    ? {
        path,
        message,
        code: "missing_required",
        reason: "missing required key",
        help: `set ${path}`,
      }
    : {
        path,
        message,
        code: "missing_required",
        reason: `required when ${gate} = true`,
        help: `set ${lastSegment(path)}, or set ${parentOf(gate) === parentOf(path) ? lastSegment(gate) : gate} = false`,
      };
}

export function invalidIssue(
  path: string,
  message: string,
  reason: string,
  help?: string,
  code: ConfigValidationIssueCode = "invalid_value",
): ConfigValidationIssue {
  return { path, message, code, reason, ...(help === undefined ? {} : { help }) };
}

const SUPPORTED_POSTGRES_MAJOR_VERSIONS: ReadonlyArray<number> = [13, 14, 15, 17];

/**
 * Runs every validation branch this module owns and returns each failure in the established
 * order, so the first issue is the one {@link validateResolvedConfig} throws. Independent checks
 * all report; a check that depends on a failed earlier one in the same chain is skipped.
 * Pure — no I/O, no Effect. Callers own their own per-section I/O reads (signing keys,
 * `api.tls` cert/key, email template/notification content) at the correct position
 * themselves, using the pure helpers exported below.
 */
export function collectConfigValidationIssues(
  input: ConfigValidationInput,
): ReadonlyArray<ConfigValidationIssue> {
  const issues: Array<ConfigValidationIssue> = [];
  const report = (issue: ConfigValidationIssue): void => {
    issues.push(issue);
  };
  const missing = (path: string, message: string): void => {
    report(missingIssue(path, message));
  };
  if (input.projectId !== undefined && input.projectId.length === 0) {
    missing("project_id", "Missing required field in config: project_id");
  }

  if (input.api?.enabled) {
    const api = input.api;
    if (api.port === 0) missing("api.port", "Missing required field in config: api.port");
    if (api.tls.enabled) {
      const absent = missingApiTlsPath(api.tls.certPath, api.tls.keyPath);
      if (absent !== undefined) missing(absent, `Missing required field in config: ${absent}`);
    }
  }

  if (input.db.port === 0) {
    missing("db.port", "Missing required field in config: db.port");
  }
  if (input.db.majorVersion === 0) {
    missing("db.major_version", "Missing required field in config: db.major_version");
  } else if (input.db.majorVersion === 12) {
    report(
      invalidIssue(
        "db.major_version",
        "Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.",
        "unsupported Postgres version",
        "Postgres 12 is no longer supported; follow https://supabase.com/docs/guides/database#migrating-between-projects",
      ),
    );
  } else if (!SUPPORTED_POSTGRES_MAJOR_VERSIONS.includes(input.db.majorVersion)) {
    report(
      invalidIssue(
        "db.major_version",
        `Failed reading config: Invalid db.major_version: ${input.db.majorVersion}.`,
        "unsupported Postgres version",
        `use one of ${SUPPORTED_POSTGRES_MAJOR_VERSIONS.join(", ")}`,
      ),
    );
  }

  for (const name of input.storageBucketNames) {
    if (!BUCKET_NAME_PATTERN.test(name)) {
      report({
        ...invalidIssue(
          `storage.buckets.${name}`,
          `Invalid Bucket name: ${name}. Only lowercase letters, numbers, dots, hyphens, and spaces are allowed. (${BUCKET_NAME_PATTERN.source})`,
          "invalid bucket name",
          "use lowercase letters, numbers, dots, hyphens and spaces only",
        ),
        segments: ["storage", "buckets", name],
      });
    }
  }

  if (input.studio?.enabled) {
    if (input.studio.port === 0) {
      missing("studio.port", "Missing required field in config: studio.port");
    }
    try {
      parseUrl(input.studio.apiUrl);
    } catch (cause) {
      report(
        invalidIssue(
          "studio.api_url",
          `Invalid config for studio.api_url: ${messageOf(cause)}`,
          "not a valid URL",
          "use a full URL such as http://127.0.0.1:54321",
        ),
      );
    }
  }

  if (input.localSmtp?.enabled && input.localSmtp.port === 0) {
    missing("local_smtp.port", "Missing required field in config: local_smtp.port");
  }

  if (input.auth !== undefined) {
    const auth = input.auth;

    if (auth.siteUrl.length === 0) {
      missing("auth.site_url", "Missing required field in config: auth.site_url");
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
        report(
          invalidIssue(
            "auth.captcha.provider",
            "failed to parse config:\nauth.captcha.provider: must be one of hcaptcha, turnstile",
            "expected one of hcaptcha, turnstile",
            "use hcaptcha or turnstile",
            "invalid_enum",
          ),
        );
      } else if (auth.captcha.enabled) {
        if (auth.captcha.provider === undefined) {
          missing(
            "auth.captcha.provider",
            "Missing required field in config: auth.captcha.provider",
          );
        }
        if (auth.captcha.secret === undefined || auth.captcha.secret.length === 0) {
          missing("auth.captcha.secret", "Missing required field in config: auth.captcha.secret");
        }
      }
    }

    // signing_keys read is caller-side I/O, not part of this function.

    // Caller only builds `passkey` when `[auth.passkey] enabled` is true.
    if (auth.passkey !== undefined) {
      if (!auth.passkey.webauthnPresent) {
        report({
          ...missingIssue("auth.webauthn", "", "auth.passkey.enabled"),
          message:
            "Missing required config section: auth.webauthn (required when auth.passkey.enabled is true)",
          reason: "required when auth.passkey.enabled = true",
          help: "add an [auth.webauthn] section, or set auth.passkey.enabled = false",
        });
      } else {
        if (auth.passkey.rpId === undefined || auth.passkey.rpId.length === 0) {
          missing("auth.webauthn.rp_id", "Missing required field in config: auth.webauthn.rp_id");
        }
        if (auth.passkey.rpOrigins === undefined || auth.passkey.rpOrigins.length === 0) {
          missing(
            "auth.webauthn.rp_origins",
            "Missing required field in config: auth.webauthn.rp_origins",
          );
        }
      }
    }

    // Caller pre-filters to enabled-only hooks, pre-ordered by the fixed hook-type sequence.
    for (const hook of auth.hooks) {
      const hookPath = `auth.hook.${hook.type}`;
      if (hook.uri.length === 0) {
        missing(`${hookPath}.uri`, `Missing required field in config: auth.hook.${hook.type}.uri`);
        continue;
      }
      // Uses `parseUrl`'s stricter semantics (the same port used for `studio.api_url`
      // above) so a malformed URI like an unterminated IPv6 host (`http://[::1`) fails the
      // whole load instead of passing a bare scheme-prefix regex.
      let scheme: string;
      try {
        scheme = parseUrl(hook.uri).scheme;
      } catch (cause) {
        report(
          invalidIssue(
            `${hookPath}.uri`,
            `failed to parse template url: ${messageOf(cause)}`,
            "not a valid URI",
            "use an http(s):// or pg-functions:// URI",
          ),
        );
        continue;
      }
      if (scheme === "http" || scheme === "https") {
        if (hook.secrets.length === 0) {
          missing(
            `${hookPath}.secrets`,
            `Missing required field in config: auth.hook.${hook.type}.secrets`,
          );
        } else if (!hook.secrets.split("|").every((secret) => HOOK_SECRET_PATTERN.test(secret))) {
          report(
            invalidIssue(
              `${hookPath}.secrets`,
              `Invalid hook config: auth.hook.${hook.type}.secrets must be formatted as "v1,whsec_<base64_encoded_secret>" with a minimum length of 32 characters.`,
              "not a valid webhook secret",
              'format it as "v1,whsec_<base64 secret>" with at least 32 characters; separate several with |',
            ),
          );
        }
      } else if (scheme === "pg-functions") {
        if (hook.secrets.length > 0) {
          report(
            invalidIssue(
              `${hookPath}.secrets`,
              `Invalid hook config: auth.hook.${hook.type}.secrets is unsupported for pg-functions URI`,
              "not supported for a pg-functions URI",
              "remove secrets, or use an http(s) URI",
            ),
          );
        }
      } else {
        report(
          invalidIssue(
            `${hookPath}.uri`,
            `Invalid hook config: auth.hook.${hook.type}.uri should be a HTTP, HTTPS, or pg-functions URI`,
            "unsupported URI scheme",
            "use an http(s):// or pg-functions:// URI",
          ),
        );
      }
    }

    for (const factor of auth.mfa) {
      if (factor.enrollEnabled && !factor.verifyEnabled) {
        report(
          invalidIssue(
            `auth.mfa.${factor.label}.enroll_enabled`,
            `Invalid MFA config: auth.mfa.${factor.label}.enroll_enabled requires verify_enabled`,
            "requires verify_enabled = true",
            `set auth.mfa.${factor.label}.verify_enabled = true, or disable enroll_enabled`,
          ),
        );
      }
    }

    // Email template/notification content read + exclusivity check is caller-side, via
    // resolveEmailTemplateContentPath below.

    if (auth.smtp !== undefined && auth.smtp.enabled) {
      const smtpFields: ReadonlyArray<readonly [string, boolean]> = [
        ["host", auth.smtp.host.length === 0],
        ["port", auth.smtp.port === 0],
        ["user", auth.smtp.user.length === 0],
        ["pass", auth.smtp.pass.length === 0],
        ["admin_email", auth.smtp.adminEmail.length === 0],
      ];
      for (const [field, isMissing] of smtpFields) {
        if (isMissing) {
          missing(
            `auth.email.smtp.${field}`,
            `Missing required field in config: auth.email.smtp.${field}`,
          );
        }
      }
    }

    // Caller pre-filters to enabled-only providers, pre-ordered firebase/auth0/cognito/clerk/
    // workos. Each provider's required fields are checked as encountered; "more than one
    // enabled" is checked only after every entry validates individually.
    for (const thirdParty of auth.thirdParty) {
      const base = `auth.third_party.${thirdParty.provider === "cognito" ? "aws_cognito" : thirdParty.provider}`;
      const missingMessage = (field: string) =>
        `Invalid config: auth.third_party.${thirdParty.provider} is enabled but without a ${field}.`;
      switch (thirdParty.provider) {
        case "firebase": {
          if (thirdParty.requiredField.length === 0) {
            missing(`${base}.project_id`, missingMessage("project_id"));
          }
          break;
        }
        case "auth0": {
          if (thirdParty.requiredField.length === 0) {
            missing(`${base}.tenant`, missingMessage("tenant"));
          }
          break;
        }
        case "cognito": {
          if (thirdParty.requiredField.length === 0) {
            missing(`${base}.user_pool_id`, missingMessage("user_pool_id"));
          } else if (
            thirdParty.cognitoUserPoolRegion === undefined ||
            thirdParty.cognitoUserPoolRegion.length === 0
          ) {
            missing(`${base}.user_pool_region`, missingMessage("user_pool_region"));
          }
          break;
        }
        case "clerk": {
          if (thirdParty.requiredField.length === 0) {
            missing(`${base}.domain`, missingMessage("domain"));
          } else if (!CLERK_DOMAIN_PATTERN.test(thirdParty.requiredField)) {
            report(
              invalidIssue(
                `${base}.domain`,
                "Invalid config: auth.third_party.clerk has invalid domain, it usually is like clerk.example.com or example.clerk.accounts.dev. Check https://clerk.com/setup/supabase on how to find the correct value.",
                "not a Clerk domain",
                "use a domain like clerk.example.com or example.clerk.accounts.dev; see https://clerk.com/setup/supabase",
              ),
            );
          }
          break;
        }
        case "workos": {
          if (thirdParty.requiredField.length === 0) {
            missing(`${base}.issuer_url`, missingMessage("issuer_url"));
          }
          break;
        }
      }
    }
    if (auth.thirdParty.length > 1) {
      report(
        invalidIssue(
          "auth.third_party",
          "Invalid config: Only one third_party provider allowed to be enabled at a time.",
          "more than one third-party provider is enabled",
          "enable one auth.third_party provider and set enabled = false on the others",
        ),
      );
    }
  }

  for (const slug of input.functionSlugs) {
    if (!FUNCTION_SLUG_PATTERN.test(slug)) {
      report(
        invalidIssue(
          `functions.${slug}`,
          `Invalid Function name: ${slug}. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (${FUNCTION_SLUG_PATTERN.source})`,
          "invalid function name",
          "start with a letter; use letters, digits, underscores and hyphens only",
        ),
      );
    }
  }

  if (input.edgeRuntimeDenoVersion === 0) {
    missing(
      "edge_runtime.deno_version",
      "Missing required field in config: edge_runtime.deno_version",
    );
  } else if (input.edgeRuntimeDenoVersion !== 1 && input.edgeRuntimeDenoVersion !== 2) {
    report(
      invalidIssue(
        "edge_runtime.deno_version",
        `Failed reading config: Invalid edge_runtime.deno_version: ${input.edgeRuntimeDenoVersion}.`,
        "unsupported Deno version",
        "use 1 or 2",
      ),
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
    report(
      invalidIssue(
        "analytics.backend",
        "failed to parse config:\nanalytics.backend: must be one of postgres, bigquery",
        "expected one of postgres, bigquery",
        "use postgres or bigquery",
        "invalid_enum",
      ),
    );
  } else if (input.analytics.enabled && backend === "bigquery") {
    const missingForBigquery = (path: string, key: string): void => {
      report({
        ...missingIssue(path, `Missing required field in config: ${path}`, "analytics.enabled"),
        reason: "required when analytics.backend = bigquery",
        help: `set ${key}, or set backend = "postgres"`,
      });
    };
    if (input.analytics.gcpProjectId.length === 0) {
      missingForBigquery("analytics.gcp_project_id", "gcp_project_id");
    }
    if (input.analytics.gcpProjectNumber.length === 0) {
      missingForBigquery("analytics.gcp_project_number", "gcp_project_number");
    }
    if (input.analytics.gcpJwtPath.length === 0) {
      report({
        ...missingIssue("analytics.gcp_jwt_path", "", "analytics.enabled"),
        message: `Path to GCP Service Account Key must be provided in config, relative to ${input.configFileName ?? "config.toml"}: analytics.gcp_jwt_path`,
        reason: "required when analytics.backend = bigquery",
        help: "set gcp_jwt_path to the service account key file, relative to supabase/",
      });
    }
  }

  if (input.experimental.webhooksPresent === true && input.experimental.webhooksEnabled !== true) {
    report(
      invalidIssue(
        "experimental.webhooks.enabled",
        "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
        "webhooks cannot be deactivated",
        "set enabled = true, or remove [experimental.webhooks]",
      ),
    );
  }
  if (
    input.experimental.pgdeltaFormatOptions !== "" &&
    !isValidJson(input.experimental.pgdeltaFormatOptions)
  ) {
    report(
      invalidIssue(
        "experimental.pgdelta.format_options",
        "Invalid config for experimental.pgdelta.format_options: must be valid JSON",
        "not valid JSON",
        "use a JSON object string",
      ),
    );
  }

  return issues;
}

/** Throws the first issue {@link collectConfigValidationIssues} reports, in established first-failure-wins order. */
export function validateResolvedConfig(input: ConfigValidationInput): void {
  const [first] = collectConfigValidationIssues(input);
  if (first !== undefined) throw new ConfigValidateError(first.message);
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
export function resolveSigningKeysPath(
  path: Path.Path,
  workdir: string,
  signingKeysPath: string,
): string {
  return path.isAbsolute(signingKeysPath)
    ? signingKeysPath
    : path.join(workdir, "supabase", signingKeysPath);
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
 * Exclusivity decision plus the path to read for one template/notification entry. Fails with
 * {@link ConfigValidateError} when `contentPath === ""` and `contentPresent` (`content_path`
 * is required instead of `content`). Returns the absolute, canonicalized path to read, or
 * `undefined` when there's nothing to read; a set `contentPath` always wins over `content`
 * silently — "both set" is never rejected as a conflict.
 *
 * The resolved candidate and `base` are both canonicalized and the candidate must resolve
 * inside `base` — an absolute path, a `..` escape, or an in-root symlink pointing outside the
 * project root all fail. This applies unconditionally to every caller (config validation,
 * `config push` content loading, `start`'s pre-Docker containment pass) — there is no opt-out.
 */
export const resolveEmailTemplateContentPath = (
  args: Parameters<typeof resolveEmailTemplatePaths>[0],
) => resolveEmailTemplatePaths(args).pipe(Effect.map((paths) => paths?.canonical));

/**
 * {@link resolveEmailTemplateContentPath} with the configured candidate it validated, resolved
 * once, which the stack reads per fetch so an in-root link may retarget.
 */
export const resolveEmailTemplatePaths = Effect.fnUntraced(function* (args: {
  readonly section: "template" | "notification";
  readonly name: string;
  /** Post-env-expand; `""` = absent. */
  readonly contentPath: string;
  /** Raw `content` key present in the TOML document. */
  readonly contentPresent: boolean;
  readonly base: string;
}) {
  if (args.contentPath.length === 0) {
    if (args.contentPresent) {
      return yield* new ConfigValidateError(
        `Invalid config for auth.email.${args.section}.${args.name}.content: please use content_path instead`,
      );
    }
    return undefined;
  }
  const path = yield* Path.Path;
  const candidate = yield* emailTemplateCandidatePath(args.section, args.base, args.contentPath);
  const resolvedCanonical = yield* canonicalPathForContainment(candidate);
  const canonicalBase = yield* canonicalPathForContainment(args.base);
  if (!isPathContainedInRoot(path, canonicalBase, resolvedCanonical)) {
    // Echoes the declared value, not `resolvedCanonical` — the declared value is already known
    // to the user (it's literally in config.toml or an env override they set), while echoing
    // the symlink-dereferenced target back would let a hostile config probe where it resolves.
    return yield* new ConfigValidateError(
      `Invalid config for auth.email.${args.section}.${args.name}.content_path: ` +
        `"${args.contentPath}" resolves outside the project root ${args.base} — ` +
        `move the file inside the project, or use a relative path that stays inside it.`,
    );
  }
  return { candidate, canonical: resolvedCanonical };
});

/* A non-empty `content_path` as configured, joined to `base` but not dereferenced, with the
   notification fallback below. */
const emailTemplateCandidatePath = Effect.fnUntraced(function* (
  section: "template" | "notification",
  base: string,
  contentPath: string,
) {
  const path = yield* Path.Path;
  if (section === "notification") return yield* resolveNotificationContentPath(base, contentPath);
  return path.isAbsolute(contentPath) ? contentPath : path.join(base, contentPath);
});

/**
 * Notification `content_path` resolution with a legacy fallback: older scaffolds documented
 * these paths relative to `supabase/` (file at `<root>/supabase/templates/...`, config says
 * `./templates/...`). Project-root resolution is canonical; when that file is confirmed
 * missing but the supabase-relative one exists, the legacy path wins so old configs keep
 * working. An unverifiable candidate at either path never triggers the fallback (see
 * {@link probeFile}). Shared by config validation, `config push` content loading, and the Kong
 * template mount builder so every consumer sees the same file.
 */
const resolveNotificationContentPath = Effect.fnUntraced(function* (
  base: string,
  contentPath: string,
) {
  const path = yield* Path.Path;
  if (path.isAbsolute(contentPath)) return contentPath;
  const resolved = path.join(base, contentPath);
  if ((yield* probeFile(resolved)) === "missing") {
    const fallbackResolved = path.join(base, "supabase", contentPath);
    if ((yield* probeFile(fallbackResolved)) === "exists") return fallbackResolved;
  }
  return resolved;
});

/**
 * Tri-state existence probe for the notification legacy-fallback decision above: `"exists"`
 * (a confirmed regular file), `"missing"` (confirmed absent, or a directory at this path), or
 * `"unknown"` (any other stat failure — EACCES, ELOOP, ...). The two call sites need opposite
 * defaults for `"unknown"`: the root-resolved path must stay selected on `"unknown"` (an
 * unreadable file must not be silently abandoned for its legacy twin), while the legacy twin
 * must only be selected on a confirmed `"exists"`. A single boolean can't express both
 * defaults, so the tri-state lets each caller choose.
 */
const probeFile = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(path).pipe(
    Effect.map((info): "exists" | "missing" | "unknown" =>
      info.type === "File" ? "exists" : "missing",
    ),
    Effect.catchReason(
      "PlatformError",
      "NotFound",
      () => Effect.succeed("missing" as const),
      () => Effect.succeed("unknown" as const),
    ),
  );
});

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
export function resolveApiTlsPath(path: Path.Path, workdir: string, p: string): string {
  return path.join(workdir, "supabase", p);
}

/** `failed to read TLS cert: ${msg(cause)}` */
export function apiTlsCertReadErrorMessage(cause: unknown): string {
  return `failed to read TLS cert: ${messageOf(cause)}`;
}

/** `failed to read TLS key: ${msg(cause)}` */
export function apiTlsKeyReadErrorMessage(cause: unknown): string {
  return `failed to read TLS key: ${messageOf(cause)}`;
}

/**
 * Reports required-field failures for the first enabled provider in the fixed priority order; a
 * later enabled-but-incomplete provider is never checked.
 */
export function collectAuthSmsProviderIssues(
  sms: CliConfig["auth"]["sms"],
): ReadonlyArray<ConfigValidationIssue> {
  const issues: Array<ConfigValidationIssue> = [];
  const requireFields = (
    provider: string,
    fields: ReadonlyArray<readonly [string, string | undefined]>,
  ): void => {
    for (const [field, value] of fields) {
      if (value === undefined || value.length === 0) {
        issues.push(
          missingIssue(
            `auth.sms.${provider}.${field}`,
            `Missing required field in config: auth.sms.${provider}.${field}`,
          ),
        );
      }
    }
  };

  if (sms.twilio.enabled) {
    requireFields("twilio", [
      ["account_sid", sms.twilio.account_sid],
      ["message_service_sid", sms.twilio.message_service_sid],
      ["auth_token", sms.twilio.auth_token],
    ]);
  } else if (sms.twilio_verify.enabled) {
    requireFields("twilio_verify", [
      ["account_sid", sms.twilio_verify.account_sid],
      ["message_service_sid", sms.twilio_verify.message_service_sid],
      ["auth_token", sms.twilio_verify.auth_token],
    ]);
  } else if (sms.messagebird.enabled) {
    requireFields("messagebird", [
      ["originator", sms.messagebird.originator],
      ["access_key", sms.messagebird.access_key],
    ]);
  } else if (sms.textlocal.enabled) {
    requireFields("textlocal", [
      ["sender", sms.textlocal.sender],
      ["api_key", sms.textlocal.api_key],
    ]);
  } else if (sms.vonage.enabled) {
    requireFields("vonage", [
      ["from", sms.vonage.from],
      ["api_key", sms.vonage.api_key],
      ["api_secret", sms.vonage.api_secret],
    ]);
  }
  return issues;
}

/** Throws the first issue {@link collectAuthSmsProviderIssues} reports. */
export function validateAuthSmsProviders(sms: CliConfig["auth"]["sms"]): void {
  const [first] = collectAuthSmsProviderIssues(sms);
  if (first !== undefined) throw new ConfigValidateError(first.message);
}

/**
 * Reports required fields for every enabled `auth.external.<name>` provider, including
 * custom names `@supabase/config`'s schema drops at decode time, so `resolved` must come from
 * `resolveAuthExternalProviders` over the effective document rather than the decoded config.
 */
export function collectAuthExternalProviderIssues(
  resolved: Readonly<Record<string, ResolvedAuthExternalProvider>>,
): ReadonlyArray<ConfigValidationIssue> {
  const issues: Array<ConfigValidationIssue> = [];
  for (const [name, provider] of Object.entries(resolved)) {
    if (!provider.enabled) continue;
    if (provider.clientId.length === 0) {
      issues.push(
        missingIssue(
          `auth.external.${name}.client_id`,
          `Missing required field in config: auth.external.${name}.client_id`,
        ),
      );
    }
    if (
      name !== "apple" &&
      name !== "google" &&
      (provider.secret === undefined || provider.secret.length === 0)
    ) {
      issues.push(
        missingIssue(
          `auth.external.${name}.secret`,
          `Missing required field in config: auth.external.${name}.secret`,
        ),
      );
    }
  }
  return issues;
}

/** Throws the first issue {@link collectAuthExternalProviderIssues} reports. */
export function validateAuthExternalProviders(
  resolved: Readonly<Record<string, ResolvedAuthExternalProvider>>,
): void {
  const [first] = collectAuthExternalProviderIssues(resolved);
  if (first !== undefined) throw new ConfigValidateError(first.message);
}
