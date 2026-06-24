import type { AuthPresence } from "./config-sync/auth.sync.ts";

/**
 * Which optional `*pointer` sections are actually present in the (merged) config
 * document.
 *
 * Go models `db.ssl_enforcement`, `storage.image_transformation`, and
 * `storage.s3_protocol` as `*pointer` fields that are `nil` unless the user
 * declares them — and `config push` skips them entirely when nil. But
 * `@supabase/config` decodes all three to a defaulted struct (e.g.
 * `{ enabled: false }`) whether or not the section appears, so their presence
 * can't be recovered from the decoded config. We therefore inspect the raw
 * config document (`LoadedProjectConfig.document`, with any matching `[remotes.*]`
 * override already merged in) and check key presence directly, matching Go's
 * nil-pointer skip semantics — including sections introduced by the remote block.
 */
export interface LegacyConfigPushPresence {
  readonly sslEnforcement: boolean;
  readonly imageTransformation: boolean;
  readonly s3Protocol: boolean;
  /** Presence of the optional `[auth.*]` sub-sections Go skips when nil. */
  readonly auth: AuthPresence;
}

type RawDoc = { readonly [key: string]: unknown };

function asRecord(value: unknown): RawDoc | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawDoc)
    : undefined;
}

function authPresenceIn(doc: RawDoc | undefined): AuthPresence {
  const auth = asRecord(doc?.["auth"]);
  const hook = asRecord(auth?.["hook"]);
  const email = asRecord(auth?.["email"]);
  const external = asRecord(auth?.["external"]);
  return {
    captcha: auth?.["captcha"] !== undefined,
    smtp: email?.["smtp"] !== undefined,
    hooks: {
      mfa_verification_attempt: hook?.["mfa_verification_attempt"] !== undefined,
      password_verification_attempt: hook?.["password_verification_attempt"] !== undefined,
      custom_access_token: hook?.["custom_access_token"] !== undefined,
      send_sms: hook?.["send_sms"] !== undefined,
      send_email: hook?.["send_email"] !== undefined,
      before_user_created: hook?.["before_user_created"] !== undefined,
    },
    externalProviders: external === undefined ? [] : Object.keys(external),
  };
}

/**
 * Reports which optional pointer sections are declared in the (already merged)
 * config document. Returns all `false` / empty when `doc` is undefined.
 */
export function legacyPresenceIn(doc: RawDoc | undefined): LegacyConfigPushPresence {
  const db = asRecord(doc?.["db"]);
  const storage = asRecord(doc?.["storage"]);
  return {
    sslEnforcement: db?.["ssl_enforcement"] !== undefined,
    imageTransformation: storage?.["image_transformation"] !== undefined,
    s3Protocol: storage?.["s3_protocol"] !== undefined,
    auth: authPresenceIn(doc),
  };
}
