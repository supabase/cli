import { type ProjectConfigMappingRow } from "./registry-row.ts";
export declare const AUTH_HOOK_NAMES: readonly ["mfa_verification_attempt", "password_verification_attempt", "custom_access_token", "send_sms", "send_email", "before_user_created"];
export declare const authMappingRows: ReadonlyArray<ProjectConfigMappingRow>;
/**
 * API-side GoTrue keys shaped like a secret (suffix `_secret`, `_secrets`,
 * `_auth_token`, `_api_secret`, `_access_key`, or `_api_key`) that have no
 * registry row at all, verified exhaustively against the generated
 * Management API v1 auth-config contract
 * (`packages/api/src/generated/contracts.ts`'s `V1GetAuthServiceConfigOutput`
 * — the authority for this registry's key set, not the legacy hand-mined
 * `auth.sync.ts` interface, which is missing `external_slack` and
 * `nimbus_oauth` entirely) (CLI-2230's `unmappedApiFields` secret-leak
 * finding). Every OTHER secret-shaped GoTrue key already has an `isSecret`
 * row above and is therefore already excluded from `unmappedApiFields` on
 * its own merit; this list exists only for the ones that don't, so an HMAC
 * digest can't leak into that report just because this registry hasn't grown
 * a row for the field yet. `walkUnmapped` (`./project-config.ts`) treats
 * every path here as consumed, same as a row's `apiPath`/`alsoConsumes`.
 *
 * `sms_vonage_api_key` is deliberately excluded despite the `_api_key`
 * suffix: it is NOT `x-secret` on the config side (`../auth/sms.ts:286-292`
 * has no `secret()` wrapper on it — `smsCredentialRows`'s comment) and
 * already has an ordinary `stringRow`.
 *
 * Three orphans found, none with a config-schema counterpart at all:
 *  - `external_figma_secret`: `figma` is a GoTrue provider with no
 *    config-schema counterpart at all (`externalProviderRows`'s comment
 *    above), so it never gets a row of its own, secret or otherwise.
 *  - `external_slack_secret`: distinct from the mapped `slack_oidc` provider
 *    (`EXTERNAL_PROVIDERS`) — plain `slack` has no config-schema counterpart
 *    either.
 *  - `hook_after_user_created_secrets`: distinct from the mapped
 *    `before_user_created` hook (`AUTH_HOOK_NAMES`) — there is no
 *    `hook.after_user_created` config-schema section to target.
 *  - `nimbus_oauth_client_secret`: there is no `nimbus`-named external
 *    provider in the config schema at all.
 *
 * Guarded against regrowing a fourth orphan by
 * `apps/cli/src/shared/config/project-config-auth-contract.unit.test.ts`,
 * which walks the same generated contract's full key set, not just this
 * hand-maintained list.
 */
export declare const unmappedSecretApiPaths: ReadonlyArray<ReadonlyArray<string>>;
