import type { CliConfig } from "@supabase/config";
import { Effect, Path, Schema } from "effect";

import { getDocumentValue } from "../config/cli-config-document.ts";
import type { CliConfigUnitIo } from "./config-check-core.ts";
import {
  ConfigValidateError,
  resolveSigningKeysPath,
  signingKeysDecodeErrorMessage,
  signingKeysReadErrorMessage,
} from "./config-validate.ts";
import type { Jwk } from "./local-jwt.ts";

export const SMTP_PATH = ["auth", "email", "smtp"] as const;
export const SMTP_ENABLED_PATH = [...SMTP_PATH, "enabled"] as const;

/** A present `[auth.email.smtp]` table without `enabled` counts as on; the schema default is off. */
export const smtpSwitchOn = (
  writtenEnabled: unknown,
  decodedEnabled: () => unknown,
  tablePresent: () => boolean,
): boolean => (writtenEnabled === undefined ? tablePresent() : decodedEnabled() === true);

/** Whether SMTP is on for the resolved config and the document it was loaded from. */
export const smtpOn = (config: CliConfig, document: Readonly<Record<string, unknown>>): boolean =>
  smtpSwitchOn(
    getDocumentValue(document, SMTP_ENABLED_PATH),
    () => config.auth.email.smtp?.enabled,
    () => getDocumentValue(document, SMTP_PATH) !== undefined,
  );

export const HOOK_TYPE_ORDER = [
  "mfa_verification_attempt",
  "password_verification_attempt",
  "custom_access_token",
  "send_sms",
  "send_email",
  "before_user_created",
] as const;

/** A raw or `env(...)`-resolved `rp_origins` string is comma-split, not dropped. */
export function rawOrigins(raw: unknown): Array<string> | undefined {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  if (typeof raw !== "string") return undefined;
  return raw.length === 0 ? [] : raw.split(",");
}

/** The provider names `auth.external` resolves: the given keys, and `apple`, which the default config.toml registers uncommented. */
export const authExternalProviderNames = (keys: ReadonlyArray<string>): ReadonlyArray<string> =>
  keys.includes("apple") ? keys : [...keys, "apple"];

const JwkSchema = Schema.Struct({
  kty: Schema.String,
  kid: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.String),
  key_ops: Schema.optionalKey(Schema.Array(Schema.String)),
  alg: Schema.optionalKey(Schema.String),
  ext: Schema.optionalKey(Schema.Boolean),
  n: Schema.optionalKey(Schema.String),
  e: Schema.optionalKey(Schema.String),
  d: Schema.optionalKey(Schema.String),
  p: Schema.optionalKey(Schema.String),
  q: Schema.optionalKey(Schema.String),
  dp: Schema.optionalKey(Schema.String),
  dq: Schema.optionalKey(Schema.String),
  qi: Schema.optionalKey(Schema.String),
  crv: Schema.optionalKey(Schema.String),
  x: Schema.optionalKey(Schema.String),
  y: Schema.optionalKey(Schema.String),
});
const decodeJwks = Schema.decodeUnknownEffect(Schema.Array(JwkSchema));
/**
 * Reads and JSON-decodes `signingKeysPath` into an array of {@link Jwk}, keeping a leading BOM
 * (no BOM stripping). Callers must only invoke this when auth is enabled.
 */
export const readSigningKeys = Effect.fnUntraced(function* (
  io: CliConfigUnitIo,
  workdir: string,
  signingKeysPath: string,
) {
  const path = yield* Path.Path;
  const absolutePath = resolveSigningKeysPath(path, workdir, signingKeysPath);
  const contents = yield* io.readText(absolutePath).pipe(
    Effect.flatMap((exit) => exit),
    Effect.mapError(
      (cause) => new ConfigValidateError(signingKeysReadErrorMessage(io.readFailureCause(cause))),
    ),
  );
  const parsed = yield* Effect.try({
    // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Native parser errors are CLI output; schema decoding discards their messages.
    try: (): unknown => JSON.parse(contents),
    catch: (cause) => new ConfigValidateError(signingKeysDecodeErrorMessage(cause)),
  });
  const jwks = yield* decodeJwks(parsed).pipe(
    Effect.mapError((cause) => new ConfigValidateError(signingKeysDecodeErrorMessage(cause))),
  );
  // `Jwk.key_ops` is mutable (required for Node's `createPrivateKey`/`JsonWebKey` input), so
  // it's copied into a fresh array rather than widening the schema's readonly output type.
  return jwks.map((jwk) => ({
    ...jwk,
    key_ops: jwk.key_ops === undefined ? undefined : [...jwk.key_ops],
  })) satisfies ReadonlyArray<Jwk>;
});
