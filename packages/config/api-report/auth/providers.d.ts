import { Schema } from "effect";
/**
 * Go's deprecated `linkedin`/`slack` provider ids (`pkg/config/config.go:1418-
 * 1423`) are intentionally NOT modeled here — only their `_oidc` replacements
 * (`linkedin_oidc`, `slack_oidc`) are, matching Go's `(e external) validate()`,
 * which unconditionally deletes the deprecated keys before anything decodes
 * them. `io.ts`'s `normalizeDeprecatedExternalProviders` strips a config's
 * `linkedin`/`slack` table (warning on stderr when it was `enabled`, same as
 * Go) before this schema ever sees it.
 */
export declare const external: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly apple: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly azure: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly bitbucket: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly discord: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly facebook: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly github: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly gitlab: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly google: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly kakao: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly keycloak: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly linkedin_oidc: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly notion: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly twitch: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly twitter: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly x: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly slack_oidc: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly spotify: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly workos: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly zoom: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly secret: Schema.optionalKey<Schema.String>;
        readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
}>, never>;
