import { Data, Effect, FileSystem, Path, type PlatformError } from "effect";

import { CliConfigValueError } from "../config/cli-config.errors.ts";
import { parseBoolLiteral } from "../shared/config/config-bool.ts";
import { defaultJwtSecret } from "../shared/stack-constants.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityFingerprintId,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { generateAsymmetricLocalJwt, generateLocalJwt, type Jwk } from "./local-jwt.ts";
import { canonicalPathForContainment, isPathContainedInRoot } from "./path-containment.ts";
import { BRANCH_PROJECT_REF_PATTERN } from "./ref-patterns.ts";

export const PROJECT_REF_PATTERN = BRANCH_PROJECT_REF_PATTERN;

export const BUCKET_NAME_PATTERN = /^(\w|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$/;

export const FUNCTION_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const HOOK_SECRET_PATTERN = /^v1,whsec_[A-Za-z0-9+/=]{32,88}$/u;

export const CLERK_DOMAIN_PATTERN =
  /^(clerk([.][a-z0-9-]+){2,}|([a-z0-9-]+[.])+clerk[.]accounts[.]dev)$/u;

/**
 * Raised by the config check units and by the `content_path`/secret resolvers. Does not override
 * `.name` — it stays the inherited `"Error"` — so `instanceof Error` and `.name` checks can't
 * distinguish it from a plain `Error`; only `.message` is meant to be observed.
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

/** Thrown by {@link resolveJwtSecret} when `auth.jwt_secret` is configured but too short to sign with. */
export class InvalidJwtSecretError extends Data.Error<{ readonly message: string }> {
  static readonly [ErrorActionabilityFingerprintId] = "InvalidJwtSecretError";
  constructor() {
    super({ message: "Invalid config for auth.jwt_secret. Must be at least 16 characters" });
    this.name = "InvalidJwtSecretError";
  }
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** Minimum `auth.jwt_secret` length. */
export const MIN_JWT_SECRET_LENGTH = 16;

/**
 * A failure that is not one of this module's config errors (a signing-key error, an unsupported
 * algorithm), keeping the original error's name and message and no actionability.
 */
class LocalConfigValuesError extends Data.Error<{ readonly message: string }> {
  constructor(message: string, name = "Error") {
    super({ message });
    if (name !== "Error") Reflect.defineProperty(this, "name", { value: name, writable: true });
  }
}

/** Every error a config check unit fails with. */
export type ConfigUnitError =
  | ConfigValidateError
  | InvalidJwtSecretError
  | CliConfigValueError
  | LocalConfigValuesError;

/** Classifies a thrown value as a {@link ConfigUnitError}. */
export const thrownError = (cause: unknown): ConfigUnitError =>
  cause instanceof ConfigValidateError ||
  cause instanceof InvalidJwtSecretError ||
  cause instanceof CliConfigValueError
    ? cause
    : cause instanceof Error
      ? new LocalConfigValuesError(cause.message, cause.name)
      : new LocalConfigValuesError(String(cause));

/** Narrows a configured string to one of `allowed`, failing with the codec wording otherwise. */
export const narrowConfigEnum = <const T extends string>(
  path: string,
  configured: string,
  allowed: ReadonlyArray<T>,
): T => {
  const match = allowed.find((candidate) => candidate === configured);
  if (match === undefined) {
    throw new CliConfigValueError({
      path,
      tier: "config",
      expected: `one of ${allowed.join(", ")}`,
      message: `Invalid config for ${path}: "${configured}" must be one of ${allowed
        .map((value) => `"${value}"`)
        .join(", ")}`,
    });
  }
  return match;
};

/**
 * Weakly coerces an unmodeled document value (no `@supabase/config` schema, e.g. custom
 * `auth.external` providers, `auth.passkey`/`auth.webauthn`) to a bool, since an `env(VAR)`
 * substitution there skips normal type coercion and leaves a literal `"true"`/`"false"`
 * string. A number coerces via truthiness (`!= 0`); an unparsable string or any other type
 * throws rather than silently defaulting to `false`.
 */
export function rawUnmodeledBool(value: unknown, dottedFieldPath: string): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const raw = typeof value === "string" ? value : String(value);
  const parsed = typeof value === "string" ? parseBoolLiteral(value) : undefined;
  if (parsed === undefined) {
    throw new CliConfigValueError({
      path: dottedFieldPath,
      tier: "config",
      expected: "a boolean",
      message: `Invalid config for ${dottedFieldPath}: "${raw}" is not a valid boolean`,
    });
  }
  return parsed;
}

/**
 * Resolves the signing secret from the effective `auth.jwt_secret`: empty falls back to
 * {@link defaultJwtSecret}, shorter than {@link MIN_JWT_SECRET_LENGTH} throws
 * {@link InvalidJwtSecretError}.
 */
export function resolveJwtSecret(configured: string | undefined): string {
  if (configured === undefined || configured.length === 0) return defaultJwtSecret;
  if (configured.length < MIN_JWT_SECRET_LENGTH) {
    throw new InvalidJwtSecretError();
  }
  return configured;
}

/** The configured key, else one signed with `signingKey` (asymmetric) or `jwtSecret`. */
export function resolveSignedKey(
  configured: string | undefined,
  jwtSecret: string,
  signingKey: Jwk | undefined,
  role: "anon" | "service_role",
): string {
  if (configured !== undefined && configured.length > 0) return configured;
  return signingKey !== undefined
    ? generateAsymmetricLocalJwt(signingKey, role)
    : generateLocalJwt(jwtSecret, role);
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The `node:fs` error behind a `FileSystem` failure, whose message the config errors quote. */
export const fsErrorCause = (error: PlatformError.PlatformError): unknown =>
  error.reason.cause ?? error.reason.description;

export function validateApiPort(enabled: boolean, port: number): void {
  if (enabled && port === 0) {
    throw new ConfigValidateError("Missing required field in config: api.port");
  }
}

/** Exactly one of the `api.tls` cert/key paths set is invalid config. */
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
  | "invalid_enum"
  | "remote_project_id";

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

/**
 * The canonical path of an email template or notification `content_path`, or `undefined` when
 * there is nothing to read. An absolute path, a `..` escape or a symlink out of `base` fails for
 * every caller; `content` without `content_path` fails too.
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

const emailTemplateCandidatePath = Effect.fnUntraced(function* (
  section: "template" | "notification",
  base: string,
  contentPath: string,
) {
  const path = yield* Path.Path;
  if (section === "notification") return yield* resolveNotificationContentPath(base, contentPath);
  return path.isAbsolute(contentPath) ? contentPath : path.join(base, contentPath);
});

/** Resolves against the project root, falling back to the legacy `supabase/`-relative path only when the root file is confirmed missing. */
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

/** `"unknown"` (a stat failure other than absence) keeps the root path and never selects the legacy twin. */
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

/** `Invalid config for api.tls: failed to load TLS key pair from ${cert} and ${key}: ${msg(cause)}` */
export function apiTlsPairErrorMessage(certPath: string, keyPath: string, cause: unknown): string {
  return `Invalid config for api.tls: failed to load TLS key pair from ${certPath} and ${keyPath}: ${messageOf(cause)}`;
}
