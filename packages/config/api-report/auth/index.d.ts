import { Schema } from "effect";
export declare const auth: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly site_url: Schema.withDecodingDefaultKey<Schema.String, never>;
    readonly additional_redirect_urls: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
    readonly jwt_expiry: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly jwt_issuer: Schema.optionalKey<Schema.String>;
    readonly signing_keys_path: Schema.optionalKey<Schema.String>;
    readonly enable_refresh_token_rotation: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly refresh_token_reuse_interval: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly enable_manual_linking: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly enable_anonymous_sign_ins: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly minimum_password_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly password_requirements: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
    readonly publishable_key: Schema.optionalKey<Schema.String>;
    readonly secret_key: Schema.optionalKey<Schema.String>;
    readonly jwt_secret: Schema.optionalKey<Schema.String>;
    readonly anon_key: Schema.optionalKey<Schema.String>;
    readonly service_role_key: Schema.optionalKey<Schema.String>;
    readonly rate_limit: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly email_sent: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly sms_sent: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly anonymous_users: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly token_refresh: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly sign_in_sign_ups: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly token_verifications: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly web3: Schema.withDecodingDefaultKey<Schema.Number, never>;
    }>, never>;
    readonly captcha: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly provider: Schema.optionalKey<Schema.Literals<string[]>>;
        readonly secret: Schema.optionalKey<Schema.String>;
    }>, never>>;
    readonly hook: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly mfa_verification_attempt: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly uri: Schema.optionalKey<Schema.String>;
            readonly secrets: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly password_verification_attempt: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly uri: Schema.optionalKey<Schema.String>;
            readonly secrets: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly custom_access_token: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly uri: Schema.optionalKey<Schema.String>;
            readonly secrets: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly send_sms: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly uri: Schema.optionalKey<Schema.String>;
            readonly secrets: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly send_email: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly uri: Schema.optionalKey<Schema.String>;
            readonly secrets: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly before_user_created: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly uri: Schema.optionalKey<Schema.String>;
            readonly secrets: Schema.optionalKey<Schema.String>;
        }>, never>;
    }>, never>;
    readonly mfa: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly totp: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>;
        readonly phone: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly otp_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly template: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
        }>, never>;
        readonly web_authn: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>;
        readonly max_enrolled_factors: Schema.withDecodingDefaultKey<Schema.Number, never>;
    }>, never>;
    readonly sessions: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly timebox: Schema.optionalKey<Schema.String>;
        readonly inactivity_timeout: Schema.optionalKey<Schema.String>;
    }>, never>>;
    readonly email: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly double_confirm_changes: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly enable_confirmations: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly secure_password_change: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly otp_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly otp_expiry: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly smtp: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly host: Schema.optionalKey<Schema.String>;
            readonly port: Schema.optionalKey<Schema.Number>;
            readonly user: Schema.optionalKey<Schema.String>;
            readonly pass: Schema.optionalKey<Schema.String>;
            readonly admin_email: Schema.optionalKey<Schema.String>;
            readonly sender_name: Schema.optionalKey<Schema.String>;
        }>, never>>;
        readonly template: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
            readonly subject: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly content_path: Schema.withDecodingDefaultKey<Schema.String, never>;
        }>, never>>, never>;
        readonly notification: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly subject: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly content_path: Schema.withDecodingDefaultKey<Schema.String, never>;
        }>, never>>, never>;
    }>, never>;
    readonly sms: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly enable_confirmations: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly template: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly twilio: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly account_sid: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly message_service_sid: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly auth_token: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly twilio_verify: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly account_sid: Schema.optionalKey<Schema.String>;
            readonly message_service_sid: Schema.optionalKey<Schema.String>;
            readonly auth_token: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly messagebird: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly originator: Schema.optionalKey<Schema.String>;
            readonly access_key: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly textlocal: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly sender: Schema.optionalKey<Schema.String>;
            readonly api_key: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly vonage: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly from: Schema.optionalKey<Schema.String>;
            readonly api_key: Schema.optionalKey<Schema.String>;
            readonly api_secret: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly test_otp: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
    }>, never>;
    readonly external: Schema.withDecodingDefaultKey<Schema.Struct<{
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
    readonly web3: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly solana: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>;
        readonly ethereum: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>;
    }>, never>;
    readonly oauth_server: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly authorization_url_path: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly allow_dynamic_registration: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly third_party: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly firebase: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly project_id: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly auth0: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly tenant: Schema.optionalKey<Schema.String>;
            readonly tenant_region: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly aws_cognito: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly user_pool_id: Schema.optionalKey<Schema.String>;
            readonly user_pool_region: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly clerk: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly domain: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly workos: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly issuer_url: Schema.optionalKey<Schema.String>;
        }>, never>;
    }>, never>;
}>, never>;
